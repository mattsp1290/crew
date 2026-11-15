import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ownRoot = fileURLToPath(new URL('../', import.meta.url));
const argument = process.argv.indexOf('--root');
const root = argument < 0 ? ownRoot : resolve(process.argv[argument + 1]);
const canonical = (path) => existsSync(path) ? realpathSync(path) : resolve(path);
const protectedRoot = canonical(join(root, 'src/service/deskhand'));
const tests = new Set(['tests/service/deskhand-results.test.ts', 'tests/service/deskhand-results.types.ts'].map((path) => canonical(join(root, path))));
const inside = (path) => path === protectedRoot || path.startsWith(`${protectedRoot}${sep}`);
const configFile = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
if (configFile.error) throw new Error('boundary-config');
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const files = [];
function collect(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.next', 'coverage'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
}
for (const directory of ['src', 'packages', 'clients', 'scripts', 'tests']) collect(join(root, directory));
const violations = [];
function report(path, kind) { violations.push({ file: relative(root, path), reason: kind }); }
for (const file of files) {
  const importer = canonical(file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function edge(specifier) {
    if (!ts.isStringLiteralLike(specifier)) return;
    const resolved = ts.resolveModuleName(specifier.text, file, config.options, ts.sys).resolvedModule?.resolvedFileName;
    const direct = specifier.text.startsWith('.') || isAbsolute(specifier.text) ? resolve(dirname(file), specifier.text) : undefined;
    const target = resolved ? canonical(resolved) : direct && existsSync(direct) ? canonical(direct) : undefined;
    if (!target) return;
    if (inside(target) && !inside(importer) && !tests.has(importer)) report(file, 'private-edge');
    if (tests.has(target) && !tests.has(importer)) report(file, 'private-test-edge');
  }
  function visit(node) {
    if (tests.has(importer) && (ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
      ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))) report(file, 'private-test-export');
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) edge(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) edge(node.argument.literal);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) edge(node.moduleReference.expression);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments.length >= 1) edge(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (violations.length) {
  process.stderr.write(`${JSON.stringify({ violations })}\n`);
  process.exitCode = 1;
} else process.stdout.write(`${JSON.stringify({ boundary: 'private', files: files.length })}\n`);
