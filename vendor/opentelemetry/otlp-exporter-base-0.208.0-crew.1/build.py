#!/usr/bin/env python3
"""Rebuild the fixed Crew OTLP repair from reviewed inputs, without acquisition."""

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import zlib

HERE = Path(__file__).resolve().parent
PACKAGE = Path('experimental/packages/otlp-exporter-base')
MODES = ('src', 'esm', 'esnext')
NOTICE = b' * Modified by Crew to bound HTTP responses and export lifetimes.\n'
MESSAGE = NOTICE.decode().strip(' *\n')
DECLARATION_NOTICE = ('/* ' + MESSAGE + ' */\n').encode()
JAVASCRIPT_NOTICE = (' /* ' + MESSAGE + ' */').encode()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def integrity(data):
    return 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()


def load(file):
    return json.loads(file.read_bytes())


def write(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open('xb') as stream:
        stream.write(data)


def dump(file, value):
    write(file, (json.dumps(value, indent=2, sort_keys=True) + '\n').encode())


def relative(name):
    require(isinstance(name, str) and name and '\\' not in name,
            'Invalid relative path')
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts
            and path.as_posix() == name, 'Unsafe path ' + name)
    return Path(name)


def inventory(root):
    result = {}
    for file in sorted(root.rglob('*')):
        name = file.relative_to(root).as_posix()
        if file.is_symlink():
            require(file.resolve().is_relative_to(root.resolve()), 'Escaping symlink ' + name)
            result[name] = 'link:' + os.readlink(file)
        elif file.is_file():
            result[name] = digest(file.read_bytes())
        else:
            require(file.is_dir(), 'Special file ' + name)
    return result


def authenticated_package(archive, pin):
    data = archive.read_bytes()
    require(len(data) == pin['bytes'] and digest(data) == pin['sha256']
            and integrity(data) == pin['integrity'], 'Registry archive identity differs')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as stream:
        for member in stream:
            require(member.isfile() and member.name.startswith('package/'),
                    'Unexpected registry archive member')
            name = member.name.removeprefix('package/')
            relative(name)
            require(name not in files, 'Duplicate registry member ' + name)
            files[name] = stream.extractfile(member).read()
    require(len(files) == 327 and sum(map(len, files.values())) == 615209,
            'Registry inventory differs')
    require(set(name for name in files if not name.startswith('build/'))
            == {'package.json', 'LICENSE', 'README.md'}, 'Package metadata set differs')
    metadata = json.loads(files['package.json'])
    require(metadata['name'] == '@opentelemetry/otlp-exporter-base'
            and metadata['version'] == '0.208.0', 'Package identity differs')
    return files


def recover_sources(files, records):
    sources, copies = {}, {}
    for name, data in files.items():
        if not name.endswith('.js.map'):
            continue
        mapping = json.loads(data)
        require(mapping['version'] == 3 and mapping['sourceRoot'] == ''
                and len(mapping['sources']) == len(mapping['sourcesContent']) == 1,
                'Unexpected registry map ' + name)
        source = posixpath.normpath(posixpath.join(posixpath.dirname(name), mapping['sources'][0]))
        require(source in records, 'Unlisted map source ' + source)
        content = mapping['sourcesContent'][0].encode()
        require(sources.setdefault(source, content) == content, 'Conflicting source copies ' + source)
        copies[source] = copies.get(source, 0) + 1
    require(set(sources) == set(records) and set(copies.values()) == {3},
            'Expected 36 sources copied into 108 maps')
    require(all(digest(data) == records[name]['originalSHA256']
                for name, data in sources.items()), 'Source preimages differ')
    return sources


def apply_patch(sources, patch, records):
    lines = patch.decode().splitlines(keepends=True)
    result, seen, index = dict(sources), set(), 0
    while index < len(lines):
        require(lines[index].startswith('--- a/'), 'Unexpected patch header')
        name = lines[index][6:].rstrip('\n')
        require(name in sources and name not in seen, 'Unexpected patch path ' + name)
        require(lines[index + 1] == '+++ b/' + name + '\n', 'Patch paths differ')
        seen.add(name)
        before, after, cursor = sources[name].decode().splitlines(keepends=True), [], 0
        index += 2
        while index < len(lines) and lines[index].startswith('@@ '):
            hunk = re.fullmatch(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n', lines[index])
            require(hunk is not None, 'Unexpected patch hunk')
            start = int(hunk[1]) - 1
            require(start >= cursor, 'Overlapping patch hunks')
            after.extend(before[cursor:start])
            require(len(after) == int(hunk[3]) - 1, 'Patch output offset differs')
            cursor, old, new = start, 0, 0
            index += 1
            while index < len(lines) and not lines[index].startswith(('@@ ', '--- a/')):
                line = lines[index]
                require(line[0] in ' +-', 'Unsupported patch control')
                if line[0] in ' -':
                    require(cursor < len(before) and before[cursor] == line[1:], 'Patch preimage differs')
                    cursor, old = cursor + 1, old + 1
                if line[0] in ' +':
                    after.append(line[1:])
                    new += 1
                index += 1
            require(old == int(hunk[2] or 1) and new == int(hunk[4] or 1), 'Patch hunk counts differ')
        result[name] = ''.join(after + before[cursor:]).encode()
    require(seen == {name for name, record in records.items() if record['changed']}
            and len(seen) == 6, 'Changed source set differs')
    require(all(digest(data) == records[name]['noticedSHA256']
                for name, data in result.items()), 'Source postimages differ')
    return result


def compile_variant(root, variant, sources, files, node, frozen):
    package = root / variant / PACKAGE
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC',
                   'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'),
                   'CREW_BUILD_ROOT': str(root), 'CREW_INPUT_MANIFEST': str(root / 'inputs.json')}
    reads = {}
    for mode in MODES:
        report = root / ('reads-' + variant + '-' + mode + '.json')
        environment['CREW_READ_REPORT'] = str(report)
        command = [str(node), '--require', str(root / 'compiler-inputs.cjs'),
                   str(root / 'toolchain/node_modules/typescript/lib/tsc.js'),
                   '--project', 'qualification.' + mode + '.json', '--pretty', 'false']
        subprocess.run(command, cwd=package, env=environment, check=True, timeout=120)
        observed = load(report)
        require(observed and all(frozen[name] == value for name, value in observed.items()),
                'Unaccounted compiler inputs')
        require(all((Path(variant) / PACKAGE / source).as_posix() in observed for source in sources),
                'Compiler did not read every source')
        reads[mode] = observed
    published = {name for name in files if name.startswith('build/')}
    extras = {'build/' + mode + '/' + source[4:-3] + '.d.ts.map'
              for mode in MODES for source in sources}
    extras.update('build/' + mode + '.tsbuildinfo' for mode in MODES)
    generated = {'build/' + name: value for name, value in inventory(package / 'build').items()}
    require(set(generated) == published | extras and len(published) == 324 and len(extras) == 111,
            'Compiler output inventory differs')
    for name in published:
        if name.endswith('.js.map'):
            mapping = load(package / name)
            source = posixpath.normpath(posixpath.join(posixpath.dirname(name), mapping['sources'][0]))
            require(mapping['version'] == 3 and mapping['sourceRoot'] == ''
                    and mapping['file'] == Path(name).name.removesuffix('.map')
                    and len(mapping['sources']) == 1
                    and mapping['sourcesContent'] == [sources[source].decode()], 'Source map mismatch ' + name)
    return {name: generated[name] for name in sorted(published)}, reads


def build_once(root, toolchain, node, files, original, candidate, pins):
    root.mkdir()
    shutil.copytree(toolchain, root / 'toolchain', symlinks=True)
    require(inventory(root / 'toolchain') == pins['toolchainFiles'], 'Copied toolchain differs')
    write(root / 'compiler-inputs.cjs', (HERE / 'compiler-inputs.cjs').read_bytes())
    for name in ('home', 'tmp'):
        (root / name).mkdir()
    for variant, sources in [('original', original), ('candidate', candidate)]:
        shutil.copytree(HERE / 'upstream', root / variant)
        package = root / variant / PACKAGE
        write(package / 'package.json', files['package.json'])
        for name, data in sources.items():
            write(package / relative(name), data)
        (package / 'node_modules').symlink_to(os.path.relpath(root / 'toolchain/node_modules', package))
        for mode in MODES:
            dump(package / ('qualification.' + mode + '.json'), {
                'extends': '../../../tsconfig.base' + ('' if mode == 'src' else '.' + mode) + '.json',
                'compilerOptions': {'rootDir': '.' if mode == 'src' else 'src',
                                    'outDir': 'build' if mode == 'src' else 'build/' + mode,
                                    'tsBuildInfoFile': 'build/' + mode + '.tsbuildinfo'},
                'include': ['src/**/*.ts'], 'files': [], 'references': []})
    frozen = inventory(root)
    dump(root / 'inputs.json', frozen)
    before, original_reads = compile_variant(root, 'original', original, files, node, frozen)
    require(before == {name: digest(files[name]) for name in before}, 'Original published bytes differ')
    after, candidate_reads = compile_variant(root, 'candidate', candidate, files, node, frozen)
    require(after == pins['candidateRawFiles'], 'Candidate compiler output differs from reviewed pins')
    staged = dict(files)
    for name in after:
        data = (root / 'candidate' / PACKAGE / name).read_bytes()
        if digest(data) != digest(files[name]):
            if name.endswith('.js.map'):
                mapping = json.loads(data)
                require('x_crew_modification' not in mapping and MESSAGE in mapping['sourcesContent'][0],
                        'Changed map lacks source notice')
                end = data.rfind(b'}')
                require(end >= 0 and not data[end + 1:].strip(), 'Unexpected map JSON suffix')
                updated = data[:end] + b',"x_crew_modification":' + json.dumps(MESSAGE).encode() + data[end:]
                fields = json.loads(updated)
                require(fields.pop('x_crew_modification') == MESSAGE and fields == mapping,
                        'Source map fields changed')
                data = updated
            elif name.endswith('.d.ts') and NOTICE not in data:
                data = DECLARATION_NOTICE + data
            elif name.endswith('/transport/http-transport-utils.js') and NOTICE not in data:
                first_line, newline, remainder = data.partition(b'\n')
                expected = b'"use strict";' if name.startswith('build/src/') else b"import * as zlib from 'zlib';"
                require(newline and first_line == expected and MESSAGE.encode() not in data,
                        'Unexpected first statement for JavaScript notice')
                updated = first_line + JAVASCRIPT_NOTICE + newline + remainder
                require(updated.replace(JAVASCRIPT_NOTICE, b'', 1) == data,
                        'JavaScript notice changed compiler output')
                data = updated
            else:
                require(data.count(NOTICE) == 1 and data.index(NOTICE) < data.index(b' */\n'),
                        'Changed output lacks leading notice ' + name)
        staged[name] = data
    published = {name: digest(data) for name, data in sorted(staged.items())}
    require(published == pins['candidatePublishedFiles'], 'Published candidate differs from reviewed pins')
    for name in ('package.json', 'LICENSE', 'README.md'):
        require(staged[name] == files[name], 'Upstream metadata changed')
    for name, expected in frozen.items():
        file = root / relative(name)
        actual = 'link:' + os.readlink(file) if file.is_symlink() else digest(file.read_bytes())
        require(actual == expected, 'Build input changed ' + name)
    archive = io.BytesIO()
    with gzip.GzipFile(fileobj=archive, mode='wb', filename='', mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            for name, data in sorted(staged.items()):
                member = tarfile.TarInfo('package/' + name)
                member.size, member.mode, member.uid, member.gid, member.mtime = len(data), 0o644, 0, 0, 0
                member.uname = member.gname = ''
                tar.addfile(member, io.BytesIO(data))
    return archive.getvalue(), {'inputs': frozen, 'originalFiles': before, 'candidateRawFiles': after,
                               'publishedFiles': published,
                               'compilerReads': {'original': original_reads, 'candidate': candidate_reads}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--toolchain', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    pins = load(HERE / 'pins.json')
    require(pins['schema'] == 1 and pins['status'] == 'reviewed', 'Complete and review pins.json before building')
    require(all(isinstance(pins[key], dict) and pins[key] for key in
                ('recipeFiles', 'toolchainFiles', 'candidateRawFiles', 'candidatePublishedFiles')),
            'Missing reviewed input or output pins')
    require(set(pins['recipeFiles']) == {'build.py', 'compiler-inputs.cjs', 'source.patch',
                                       'source-pins.json', 'toolchain/package.json',
                                       'toolchain/package-lock.json'}, 'Recipe inventory differs')
    for name, expected in pins['recipeFiles'].items():
        require(digest((HERE / relative(name)).read_bytes()) == expected, 'Recipe identity differs ' + name)
    require(inventory(HERE / 'upstream') == pins['upstreamFiles'], 'Upstream inputs differ')
    patch = (HERE / 'source.patch').read_bytes()
    require(digest(patch) == pins['sourcePatchSHA256'], 'Source patch identity differs')
    toolchain, node, output = args.toolchain.resolve(), args.node.resolve(), args.output.absolute()
    require(not output.exists() and not output.is_symlink(), 'Output must be a new directory')
    require({entry.name for entry in toolchain.iterdir()} == {'package.json', 'package-lock.json', 'node_modules'},
            'Toolchain root must contain only package files and node_modules')
    require(inventory(toolchain) == pins['toolchainFiles'], 'Supplied toolchain differs')
    require((toolchain / 'package.json').read_bytes() == (HERE / 'toolchain/package.json').read_bytes(),
            'Toolchain package recipe differs')
    require((toolchain / 'package-lock.json').read_bytes() == (HERE / 'toolchain/package-lock.json').read_bytes()
            and digest((toolchain / 'package-lock.json').read_bytes()) == pins['toolchainLockSHA256'],
            'Toolchain lock differs')
    lock = load(toolchain / 'package-lock.json')
    require(lock['lockfileVersion'] == 3, 'Expected npm lockfile version 3')
    for name, expected in pins['toolArchives'].items():
        require(lock['packages']['node_modules/' + name]['integrity'] == expected['integrity'],
                'Tool integrity differs ' + name)
    require(digest(node.read_bytes()) == pins['node']['sha256'], 'Node binary differs')
    version = subprocess.check_output([str(node), '--version'], env={'PATH': '/usr/bin:/bin'}, timeout=10).decode().strip()
    require(version == pins['node']['version'], 'Node version differs')
    files = authenticated_package(args.registry, pins['registry'])
    source_records = load(HERE / 'source-pins.json')
    records = {record['path']: record for record in source_records}
    require(len(records) == len(source_records) == 36, 'Source pin inventory differs')
    original = recover_sources(files, records)
    candidate = apply_patch(original, patch, records)
    output.mkdir()
    first, evidence = build_once(output / 'first', toolchain, node, files, original, candidate, pins)
    second, repeated = build_once(output / 'second', toolchain, node, files, original, candidate, pins)
    require(first == second and evidence == repeated, 'Independent fresh builds differ')
    require(digest(first) == pins['archive']['sha256'] and integrity(first) == pins['archive']['integrity'],
            'Archive differs from reviewed pin')
    require(digest(node.read_bytes()) == pins['node']['sha256']
            and inventory(toolchain) == pins['toolchainFiles'], 'External inputs changed during build')
    filename = pins['archive']['filename']
    require(filename == 'opentelemetry-otlp-exporter-base-0.208.0-crew.1.tgz', 'Archive name differs')
    write(output / filename, first)
    dump(output / 'provenance.json', {
        'pins': pins, 'pinsSHA256': digest((HERE / 'pins.json').read_bytes()), 'sources': source_records,
        'build': evidence, 'archiveBytes': len(first), 'independentBuilds': 2,
        'host': {'node': version, 'python': sys.version, 'zlib': zlib.ZLIB_RUNTIME_VERSION},
        'qualification': 'Build identity only. Runtime, clean install, and worker gates remain separate.'})
    print(output / filename)


if __name__ == '__main__':
    main()
