#!/usr/bin/env python3
"""Check docs/schemas and docs/contract.md against each other.

Schemas and examples are discovered by convention under docs/schemas/, so
adding a schema or an example needs no edit here:

  Schemas    Every *.json under docs/schemas/ outside examples/. A schema's
             stem is its file name without .json (tools/pointer.input.json has
             stem "pointer.input", wire/jsonrpc-error.json has stem
             "jsonrpc-error"). Stems must be unique. Each schema must declare
             Draft 2020-12, have an $id ending in its path relative to
             docs/schemas/, and every $ref must resolve locally (no network).
             Every "format" a schema uses must be one the validator asserts.
  defs.json  The shared definitions library. It is the only schema that needs
             no valid and no invalid example.
  tools/     Tool schemas <tool>.input.json and <tool>.output.json. They must
             also survive the tools/list bundling rule (contract 3.2); input
             schemas must be closed objects with no top-level combinators.
  wire/      Schemas of whole JSON-RPC messages and of method results.
  Examples   examples/<stem>.<name>.json must validate against the schema
             with the longest matching stem. Every schema outside wire/ except
             defs.json needs at least one. A schema's own "examples" keyword
             must validate too.
  Invalid    examples/invalid/<stem>.<name>.json must be rejected. Every schema
             except defs.json needs at least one.
  Required   Dropping any one member from a valid example, wire message, call
             argument or tool result must make it invalid, unless the member is
             listed in OPTIONAL_MEMBERS. So a `required` that is deleted from a
             schema fails here, and a new optional member is declared there.
  Wire       examples/wire/*.json are whole JSON-RPC 2.0 messages. Each name
             must match one of the conventions in WIRE_RULES and is validated
             against the wire/ schemas, and tools/call arguments and
             structuredContent against tools/<tool>.*.json. Every wire/ schema
             needs a valid instance: a wire example, a JSON block of the
             contract, its own "examples", or the tools/list result this script
             builds from the tool schemas and the 3.2 table.
  Prose      docs/contract.md: the error codes (9.3), states (10), stale-frame
             reasons (8.3), conditions (11), JSON-RPC error codes (9.4) and
             per-tool codes (9.3 "Tools") match the schemas both ways; the
             9.2 tool_error tables match the schema's if/then rules; the
             constants of section 16 match every schema keyword, example
             `limits` and prose figure that carries them, wherever the figure
             is repeated; the HTTP status and JSON-RPC code pairs of 2.3 and
             2.4 match 9.4; a status result's state heads its active_states for
             every state; the header's versions match every contract_version
             and protocol version; every JSON block validates; every intra-doc
             #anchor resolves.

Date-time formats are asserted (rfc3339-validator), so 29 February of a common
year fails. Any other JSON file under examples/ is an error, so nothing is
silently skipped. Exits 1 and prints one line per failure.
"""

import argparse
import copy
import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError, best_match
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

DRAFT = "https://json-schema.org/draft/2020-12/schema"
DEFS = "defs.json"
TOOLS_DIR = "tools"
WIRE_DIR = "wire"
EXAMPLE_NAME = re.compile(r"^[a-z0-9-]+$")
PROTOCOL_META = "io.modelcontextprotocol/protocolVersion"
FORMAT_CHECKER = FormatChecker()

REQUEST = f"{WIRE_DIR}/jsonrpc-request.json"
NOTIFICATION = f"{WIRE_DIR}/jsonrpc-notification.json"
RESPONSE = f"{WIRE_DIR}/jsonrpc-response.json"
ERROR = f"{WIRE_DIR}/jsonrpc-error.json"
RESULTS = {
    "server/discover": f"{WIRE_DIR}/server-discover-result.json",
    "tools/list": f"{WIRE_DIR}/tools-list-result.json",
    "tools/call": f"{WIRE_DIR}/tools-call-result.json",
}
METHOD_SLUGS = {"server-discover": "server/discover", "tools-list": "tools/list"}

# examples/wire/ file names. A file that matches none of these fails the check.
WIRE_RULES = [
    (re.compile(r"^(server-discover|tools-list)\.request\.json$"), "request"),
    (re.compile(r"^(server-discover|tools-list)\.response\.json$"), "response"),
    (re.compile(r"^tools-call\.([a-z0-9_]+)\.[a-z0-9-]+\.request\.json$"), "call-request"),
    (re.compile(r"^tools-call\.([a-z0-9_]+)\.[a-z0-9-]+\.response\.json$"), "call-response"),
    (re.compile(r"^error\.[a-z0-9-]+\.response\.json$"), "error"),
    (re.compile(r"^[a-z0-9-]+\.notification\.json$"), "notification"),
]

# Members that a valid instance may lack, by schema: a path from the root of
# the instance, with * for an array index. Every other member of every valid
# instance must be required: dropping it must make the instance invalid. An
# isError result is looked up under TOOL_ERROR whatever the tool. An entry that
# no instance uses fails too, so the list cannot go stale.
TOOL_ERROR = "tool_error"
OPTIONAL_MEMBERS = {
    "tools/keyboard.input.json": {"permitted_apps", "action/modifiers", "action/hold_ms"},
    "tools/lease.input.json": {"ttl_ms"},
    "tools/pointer.input.json": {"permitted_apps", "action/button", "action/count", "action/modifiers",
                                 "action/duration_ms"},
    "tools/screenshot.input.json": {"display_id", "region", "format", "max_long_edge"},
    "tools/status.input.json": {"holder_id", "operation"},
    "tools/pointer.output.json": {"measured/drag_end"},
    "tools/status.output.json": {"operation"},
    TOOL_ERROR: {"operation_id", "operation", "replayed", "measured", "measured/drag_end", "details/point_index"},
    REQUEST: {"params/arguments"},
    ERROR: {"error/data", "error/data/detail", "error/data/header"},
}
# Members whose contents another schema checks. The drop-one walk stops there.
OPAQUE_MEMBERS = {
    REQUEST: {"params/arguments"},
    RESPONSE: {"result"},
    RESULTS["tools/call"]: {"structuredContent"},
    RESULTS["tools/list"]: {"tools/*/inputSchema", "tools/*/outputSchema"},
}

NUM = r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?"

# Where each constant of contract section 16 appears in a schema:
# (schema, JSON pointer, keyword, part). part is the value, default, min or max
# of the constant, "neg" for minus the value, or "list" for an enum.
CONSTANT_SITES = {
    "MAX_LONG_EDGE": [
        ("tools/screenshot.input.json", "/properties/max_long_edge", "maximum", "value"),
        ("tools/screenshot.input.json", "/properties/max_long_edge", "default", "value"),
        ("tools/screenshot.output.json",
         "/$defs/screenshot_result/properties/output_pixel_size/properties/width", "maximum", "value"),
        ("tools/screenshot.output.json",
         "/$defs/screenshot_result/properties/output_pixel_size/properties/height", "maximum", "value"),
        ("tools/status.output.json", "/$defs/limits/properties/max_long_edge", "const", "value"),
    ],
    "MIN_LONG_EDGE": [
        ("tools/screenshot.input.json", "/properties/max_long_edge", "minimum", "value"),
        ("tools/status.output.json", "/$defs/limits/properties/min_long_edge", "const", "value"),
    ],
    "MAX_PIXELS": [
        ("tools/status.output.json", "/$defs/limits/properties/max_pixels", "const", "value"),
    ],
    "MAX_IMAGE_BYTES": [
        ("tools/screenshot.output.json", "/$defs/screenshot_result/properties/image_bytes", "maximum", "value"),
        ("tools/status.output.json", "/$defs/limits/properties/max_image_bytes", "const", "value"),
    ],
    "JPEG_QUALITY_STEPS": [
        ("tools/screenshot.output.json", "/$defs/screenshot_result/properties/jpeg_quality", "enum", "list"),
    ],
    "FRAME_MAX_AGE_MS": [
        ("tools/screenshot.output.json", "/$defs/screenshot_result/properties/max_age_ms", "minimum", "min"),
        ("tools/screenshot.output.json", "/$defs/screenshot_result/properties/max_age_ms", "maximum", "max"),
        ("tools/status.output.json", "/$defs/limits/properties/frame_max_age_ms", "minimum", "min"),
        ("tools/status.output.json", "/$defs/limits/properties/frame_max_age_ms", "maximum", "max"),
    ],
    "USER_ACTIVITY_LOOKBACK_MS": [
        ("tools/status.output.json", "/$defs/limits/properties/user_activity_lookback_ms", "const", "value"),
    ],
    "LEASE_TTL_MS": [
        ("tools/lease.input.json", "/properties/ttl_ms", "minimum", "min"),
        ("tools/lease.input.json", "/properties/ttl_ms", "maximum", "max"),
        ("tools/lease.input.json", "/properties/ttl_ms", "default", "default"),
        ("tools/status.output.json", "/$defs/limits/properties/lease_ttl_min_ms", "const", "min"),
        ("tools/status.output.json", "/$defs/limits/properties/lease_ttl_max_ms", "const", "max"),
    ],
    "KEYBOARD_MAX_TEXT_LENGTH": [
        ("tools/keyboard.input.json", "/$defs/keyboard_type/properties/text", "maxLength", "value"),
        ("tools/status.output.json", "/$defs/limits/properties/keyboard_max_text_length", "const", "value"),
    ],
    "KEY_HOLD_MAX_MS": [
        ("tools/keyboard.input.json", "/$defs/keyboard_press/properties/hold_ms", "maximum", "value"),
    ],
    "DRAG_DURATION_MAX_MS": [
        ("tools/pointer.input.json", "/$defs/pointer_drag/properties/duration_ms", "maximum", "value"),
    ],
    "DRAG_MAX_POINTS": [
        ("tools/pointer.input.json", "/$defs/pointer_drag/properties/path", "maxItems", "value"),
    ],
    "SCROLL_MAX_DELTA": [
        ("tools/pointer.input.json", "/$defs/pointer_scroll/properties/dx", "maximum", "value"),
        ("tools/pointer.input.json", "/$defs/pointer_scroll/properties/dx", "minimum", "neg"),
        ("tools/pointer.input.json", "/$defs/pointer_scroll/properties/dy", "maximum", "value"),
        ("tools/pointer.input.json", "/$defs/pointer_scroll/properties/dy", "minimum", "neg"),
    ],
    "DISCOVERY_TTL_MS": [
        (f"{WIRE_DIR}/server-discover-result.json", "/properties/ttlMs", "const", "value"),
        (f"{WIRE_DIR}/tools-list-result.json", "/properties/ttlMs", "const", "value"),
    ],
}
# Section 16 constants that no schema carries. A new constant must be added to
# CONSTANT_SITES or here, so none is silently unchecked.
UNSCHEMATIZED_CONSTANTS = {
    "MAX_VISUAL_TOKENS", "PATCH_SIZE", "PATCH_CHANNEL_TOLERANCE", "PATCH_MAX_CHANGED_FRACTION",
    "PATCH_CHECK_MAX_AGE_MS", "DRAG_POLICY_SAMPLE_PX", "USER_ACTIVITY_POLL_MS", "USER_ACTIVITY_ABORT_MS",
    "DEADLINE_BOUND_MS", "ALLOWANCE_CACHE_MAX_MS", "ALLOWANCE_SKEW_TOLERANCE_MS", "ACTIONS_PER_MINUTE",
    "GATED_ENDS_ARMING", "BIND_RETRY_MS", "OPERATION_RETENTION_MS", "OPERATION_MAX_RECORDS",
    "MAX_REQUEST_BODY_BYTES", "MAX_REQUEST_HEADER_BYTES", "MAX_RESPONSE_BODY_BYTES", "CONNECTION_MAX_AGE",
}
# status.limits members whose name is not the constant's name in lower case.
LIMIT_PARTS = {"lease_ttl_min_ms": ("LEASE_TTL_MS", "min"), "lease_ttl_max_ms": ("LEASE_TTL_MS", "max")}

# Large figures that a section may quote although section 16 does not give
# them: (section number, unit, value) -> how many times. Amendment 1 was
# approved with 3,750,000 pixels, and section 7 names the pixel count of a
# 2560 x 1440 display. One more occurrence than listed fails.
OTHER_FIGURES = {
    ("7.", "pixels", 3686400): 1,
    ("17.", "pixels", 3750000): 1,
    ("17.1", "pixels", 3750000): 1,
}

# Prose that restates a constant: (section heading prefix, regex, parts). Each
# regex group is compared with (constant, part); None skips a group, and every
# match in the section is compared. A site that is not found fails, so
# rewording the prose means updating this list.
PROSE_SITES = [
    ("2.4 ", rf"Header block is at most ({NUM}) bytes", [("MAX_REQUEST_HEADER_BYTES", "value")]),
    ("2.4 ", rf"Body is at most ({NUM}) bytes", [("MAX_REQUEST_BODY_BYTES", "value")]),
    ("2.5 ", rf"\| Request header block \| ({NUM}) bytes", [("MAX_REQUEST_HEADER_BYTES", "value")]),
    ("2.5 ", rf"\| Request body \| ({NUM}) bytes", [("MAX_REQUEST_BODY_BYTES", "value")]),
    ("2.5 ", rf"\(`MAX_IMAGE_BYTES`\) \| ({NUM}) bytes", [("MAX_IMAGE_BYTES", "value")]),
    ("2.5 ", rf"\(`MAX_RESPONSE_BODY_BYTES`\) \| ({NUM}) bytes", [("MAX_RESPONSE_BODY_BYTES", "value")]),
    ("2.5 ", rf"never sends a response body over ({NUM}) bytes", [("MAX_RESPONSE_BODY_BYTES", "value")]),
    ("3. ", rf'deskhand sends `"ttlMs": ({NUM})`', [("DISCOVERY_TTL_MS", "value")]),
    ("5.1 ", rf"`ttl_ms` is ({NUM}) to ({NUM}) and defaults to ({NUM})",
     [("LEASE_TTL_MS", "min"), ("LEASE_TTL_MS", "max"), ("LEASE_TTL_MS", "default")]),
    ("6.4 ", rf"`path` has ({NUM}) to ({NUM}) points", [None, ("DRAG_MAX_POINTS", "value")]),
    ("6.4 ", rf"`duration_ms` is ({NUM}) to ({NUM})\.", [None, ("DRAG_DURATION_MAX_MS", "value")]),
    ("6.4 ", rf"Each is ({NUM}) to ({NUM})\.", [("SCROLL_MAX_DELTA", "neg"), ("SCROLL_MAX_DELTA", "value")]),
    ("6.5 ", rf"`hold_ms` is ({NUM}) to ({NUM})\.", [None, ("KEY_HOLD_MAX_MS", "value")]),
    ("6.5 ", rf"`text` is ({NUM}) to ({NUM}) Unicode code points", [None, ("KEYBOARD_MAX_TEXT_LENGTH", "value")]),
    ("8.3 ", rf"between ({NUM}) and ({NUM}) with a default of ({NUM})",
     [("FRAME_MAX_AGE_MS", "min"), ("FRAME_MAX_AGE_MS", "max"), ("FRAME_MAX_AGE_MS", "default")]),
    ("9.3 ", rf"`image_too_large` \|[^\n]*? over ({NUM}) bytes", [("MAX_IMAGE_BYTES", "value")]),
    ("17.1 ", rf"long edge of at most ({NUM}) px and to at most ({NUM}) pixels",
     [("MAX_LONG_EDGE", "value"), ("MAX_PIXELS", "value")]),
    ("17.1 ", rf"down to ({NUM}) px", [("MIN_LONG_EDGE", "value")]),
    ("19. ", rf"an image has at most ({NUM}) pixels", [("MAX_PIXELS", "value")]),
]


def number(text: str):
    text = text.replace(",", "")
    return float(text) if "." in text else int(text)


def pointer_get(node, pointer: str):
    for part in pointer.split("/")[1:]:
        part = part.replace("~1", "/").replace("~0", "~")
        node = node[int(part)] if isinstance(node, list) else node[part]
    return node


def find_key(node, key: str):
    """Every value of `key` anywhere in a JSON instance."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            yield from find_key(v, key)
    elif isinstance(node, list):
        for v in node:
            yield from find_key(v, key)


class Checker:
    def __init__(self, docs: Path):
        self.docs = docs
        self.root = docs / "schemas"
        self.fails: list[str] = []
        self.counts = dict.fromkeys(
            ("schemas", "refs", "valid", "invalid", "wire", "dropped", "bundled", "blocks", "constants"), 0)
        self.covered: set[str] = set()  # schemas with a valid instance of any kind
        self.covered_examples: set[str] = set()  # schemas with a valid file under examples/
        self.covered_invalid: set[str] = set()
        self.instances: list[tuple[str, object]] = []  # valid tool outputs, for the version and limits checks
        self.optional_used: set[tuple[str, str]] = set()
        self.kinds: dict[str, str] = {}  # tool -> Kind column of contract 3.2

    def fail(self, msg: str) -> None:
        self.fails.append(msg)

    def rel(self, p: Path) -> str:
        return p.relative_to(self.root).as_posix()

    def load(self, p: Path):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError) as e:
            self.fail(f"{self.rel(p)}: cannot read JSON: {e}")
            return None

    # Contract text

    def load_contract(self) -> None:
        path = self.docs / "contract.md"
        try:
            self.md = path.read_text(encoding="utf-8")
        except OSError as e:
            self.fail(f"contract.md: {e}")
            self.md = ""
        self.header = {}
        for label, value in re.findall(r"^\| (.+?) \| `([^`]+)` \|$", self.md.split("\n## ", 1)[0], re.M):
            self.header[label] = value
        self.doc_version = self.header.get("Document version")
        self.mcp_revision = self.header.get("MCP protocol revision")
        if self.md and not (self.doc_version and self.mcp_revision):
            self.fail("contract.md: header table lacks 'Document version' or 'MCP protocol revision'")

    def section(self, prefix: str) -> str:
        m = re.search(rf"^#+ {re.escape(prefix)}.*?$(.*?)(?=^#+ |\Z)", self.md, re.S | re.M)
        if not m:
            self.fail(f"contract.md: section '{prefix}' not found")
            return ""
        return m.group(1)

    @staticmethod
    def table(text: str) -> list[list[str]]:
        """Body rows of every pipe table in text, as stripped cells."""
        rows = []
        for line in text.splitlines():
            if line.startswith("|") and not re.match(r"^\|[\s:|-]+\|$", line):
                rows.append([c.strip() for c in line.strip().strip("|").split(" | ")])
        return rows

    # Schemas

    def load_schemas(self) -> None:
        self.schemas: dict[str, dict] = {}  # relative path -> schema
        self.by_stem: dict[str, str] = {}  # stem -> relative path
        paths = sorted(p for p in self.root.rglob("*.json") if "examples" not in p.relative_to(self.root).parts)
        for p in paths:
            rel = self.rel(p)
            s = self.load(p)
            if not isinstance(s, dict):
                if s is not None:
                    self.fail(f"{rel}: schema root is not an object")
                continue
            self.counts["schemas"] += 1
            if s.get("$schema") != DRAFT:
                self.fail(f"{rel}: $schema must be {DRAFT}")
            if not str(s.get("$id", "")).endswith("/" + rel):
                self.fail(f"{rel}: $id {s.get('$id')!r} does not end with /{rel}")
            try:
                Draft202012Validator.check_schema(s)
            except SchemaError as e:
                self.fail(f"{rel}: not a valid Draft 2020-12 schema: {e.message}")
                continue
            stem = p.name.removesuffix(".json")
            if stem in self.by_stem:
                self.fail(f"{rel}: stem {stem!r} also used by {self.by_stem[stem]}")
                continue
            self.schemas[rel] = s
            self.by_stem[stem] = rel
        if DEFS not in self.schemas:
            self.fail(f"{DEFS}: missing or invalid; nothing else can be checked")
            return
        self.registry = Registry().with_resources(
            (s["$id"], Resource.from_contents(s, default_specification=DRAFT202012))
            for s in self.schemas.values()
            if "$id" in s
        )
        self.validators = {
            rel: Draft202012Validator(s, registry=self.registry, format_checker=FORMAT_CHECKER)
            for rel, s in self.schemas.items()
        }
        for rel, s in self.schemas.items():
            self.check_refs(rel, s)
            self.check_formats(rel, s)

    def check_refs(self, rel: str, schema: dict) -> None:
        # Validators resolve $ref lazily, so a ref on a path no example reaches would go unnoticed.
        resolver = self.registry.resolver(base_uri=schema.get("$id", ""))

        def walk(node, where):
            if isinstance(node, dict):
                ref = node.get("$ref")
                if isinstance(ref, str):
                    self.counts["refs"] += 1
                    try:
                        resolver.lookup(ref)
                    except Unresolvable:
                        self.fail(f"{rel}: $ref {ref!r} at {where or '/'} does not resolve")
                for k, v in node.items():
                    walk(v, f"{where}/{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, f"{where}/{i}")

        walk(schema, "")

    def check_formats(self, rel: str, schema: dict) -> None:
        # jsonschema skips a format it has no checker for, silently; date-time needs rfc3339-validator.
        def walk(node, where):
            if isinstance(node, dict):
                fmt = node.get("format")
                if isinstance(fmt, str) and fmt not in FORMAT_CHECKER.checkers:
                    self.fail(f"{rel}: format {fmt!r} at {where or '/'} is not asserted "
                              "(install scripts/requirements-contract.txt)")
                for k, v in node.items():
                    if k not in ("const", "enum", "default", "examples"):
                        walk(v, f"{where}/{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, f"{where}/{i}")

        walk(schema, "")

    def check_tools(self) -> None:
        """The tools/list serving rule (contract 3.2) and the flat-input rule."""
        defs = self.schemas[DEFS].get("$defs", {})
        for rel, s in self.schemas.items():
            parts = rel.split("/")
            if parts[0] != TOOLS_DIR:
                continue
            m = re.fullmatch(r"([a-z0-9_-]+)\.(input|output)\.json", parts[-1])
            if len(parts) != 2 or not m:
                self.fail(f"{rel}: tool schemas are named tools/<tool>.<input|output>.json")
                continue
            tool, direction = m.groups()
            other = f"{TOOLS_DIR}/{tool}.{'output' if direction == 'input' else 'input'}.json"
            if other not in self.schemas:
                self.fail(f"{rel}: no matching {other}")
            b = copy.deepcopy(s)
            b.pop("$id", None)
            local = b.setdefault("$defs", {})
            clash = set(local) & set(defs)
            if clash:
                self.fail(f"{rel}: $defs names clash with {DEFS}: {sorted(clash)}")
            local.update(copy.deepcopy(defs))
            text = json.dumps(b).replace(f"../{DEFS}#/$defs/", "#/$defs/")
            if DEFS in text:
                self.fail(f"{rel}: a {DEFS} reference survives bundling")
            b = json.loads(text)
            try:
                Draft202012Validator.check_schema(b)
                self.bundled[rel] = Draft202012Validator(b, format_checker=FORMAT_CHECKER)
                self.bundled_schemas[rel] = b
                self.counts["bundled"] += 1
            except SchemaError as e:
                self.fail(f"{rel}: bundled form is not a valid schema: {e.message}")
            if direction == "input":
                for kw in ("oneOf", "anyOf", "allOf", "if", "not", "dependentRequired"):
                    if kw in s:
                        self.fail(f"{rel}: top-level {kw} (input schemas stay flat)")
                if s.get("type") != "object" or s.get("additionalProperties") is not False:
                    self.fail(f"{rel}: input schema must be a closed object")
            elif s.get("type") != "object":
                self.fail(f"{rel}: output schema root type must be object")

    # Examples

    def schema_for(self, filename: str) -> str | None:
        name = filename.removesuffix(".json")
        best = None
        for stem in self.by_stem:
            rest = name[len(stem) + 1 :]
            if name.startswith(stem + ".") and EXAMPLE_NAME.match(rest) and (best is None or len(stem) > len(best)):
                best = stem
        return self.by_stem.get(best) if best else None

    def errors(self, rel: str, instance) -> list[str | None]:
        out = []
        for label, v in (("", self.validators[rel]), (" [bundled]", self.bundled.get(rel))):
            if v is None:
                continue
            err = best_match(v.iter_errors(instance))
            out.append(f"{label} at /{'/'.join(map(str, err.path))}: {err.message[:200]}" if err else None)
        return out

    def expect_valid(self, where: str, rel: str, instance) -> bool:
        """Fail unless instance validates against rel; records rel as covered."""
        if rel not in self.validators:
            self.fail(f"{where}: no schema {rel}")
            return False
        ok = True
        for e in self.errors(rel, instance):
            if e:
                self.fail(f"{where}: should validate against {rel} but fails{e}")
                ok = False
        if ok:
            self.covered.add(rel)
        return ok

    def drop_one(self, where: str, rel: str, instance) -> None:
        """Every member of a valid instance is required or is listed in OPTIONAL_MEMBERS."""
        if rel not in self.validators:
            return
        key = rel
        if rel.startswith(TOOLS_DIR + "/") and rel.endswith(".output.json") and "code" in instance:
            key = TOOL_ERROR
        optional, opaque = OPTIONAL_MEMBERS.get(key, set()), OPAQUE_MEMBERS.get(rel, set())

        def label(path) -> str:
            return "/".join("*" if isinstance(x, int) else x for x in path)

        def walk(node, path):
            if isinstance(node, dict):
                for k, v in node.items():
                    yield path + (k,)
                    if label(path + (k,)) not in opaque:
                        yield from walk(v, path + (k,))
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    yield from walk(v, path + (i,))

        for path in list(walk(instance, ())):
            mutant = copy.deepcopy(instance)
            parent = mutant
            for part in path[:-1]:
                parent = parent[part]
            del parent[path[-1]]
            self.counts["dropped"] += 1
            if all(e is not None for e in self.errors(rel, mutant)):
                continue
            if label(path) in optional:
                self.optional_used.add((key, label(path)))
            else:
                self.fail(f"{where}: still validates against {rel} without /{'/'.join(map(str, path))}; "
                          "make it required or add it to OPTIONAL_MEMBERS")

    def check_optional_members(self) -> None:
        for key, names in sorted(OPTIONAL_MEMBERS.items()):
            for name in sorted(names):
                if (key, name) not in self.optional_used:
                    self.fail(f"OPTIONAL_MEMBERS lists {key} {name}, which no valid instance can lack "
                              "(remove the entry, or add an example that has the member)")

    def check_examples(self) -> None:
        ex = self.root / "examples"
        known = {ex, ex / "invalid", ex / "wire"}
        for d in sorted(known - {ex}):
            if not d.is_dir() or not any(d.glob("*.json")):
                self.fail(f"{self.rel(d)}: missing or has no examples")
        for p in sorted(ex.rglob("*")):
            if p.is_dir() and p not in known:
                self.fail(f"{self.rel(p)}: unknown examples directory (use examples/, invalid/ or wire/)")
            elif p.is_file() and p.parent not in known:
                self.fail(f"{self.rel(p)}: example outside examples/, invalid/ or wire/")
        for folder, want_valid in ((ex, True), (ex / "invalid", False)):
            for p in sorted(folder.glob("*.json")):
                rel = self.schema_for(p.name)
                if rel is None:
                    self.fail(f"{self.rel(p)}: name is not <schema stem>.<name>.json for any schema "
                              f"(stems: {', '.join(sorted(self.by_stem))})")
                    continue
                inst = self.load(p)
                if inst is None:
                    continue
                if want_valid:
                    if self.expect_valid(self.rel(p), rel, inst):
                        self.covered_examples.add(rel)
                        self.drop_one(self.rel(p), rel, inst)
                        if rel.startswith(TOOLS_DIR + "/") and rel.endswith(".output.json"):
                            self.instances.append((self.rel(p), inst))
                    self.counts["valid"] += 1
                else:
                    for e in self.errors(rel, inst):
                        if e is None:
                            self.fail(f"{self.rel(p)}: should be rejected by {rel} but validates")
                    self.covered_invalid.add(rel)
                    self.counts["invalid"] += 1
        for rel, s in self.schemas.items():
            for i, inst in enumerate(s.get("examples", [])):
                self.expect_valid(f"{rel} examples/{i}", rel, inst)

    def check_coverage(self) -> None:
        for rel in sorted(set(self.schemas) - {DEFS}):
            if rel.startswith(WIRE_DIR + "/"):
                if rel not in self.covered:
                    self.fail(f"{rel}: no valid instance (wire example, contract JSON block or its own examples)")
            elif rel not in self.covered_examples:
                self.fail(f"{rel}: no valid example under examples/")
            if rel not in self.covered_invalid:
                self.fail(f"{rel}: no invalid example under examples/invalid/")

    # Wire

    def check_request(self, where: str, doc, method: str | None = None) -> None:
        if self.expect_valid(where, REQUEST, doc):
            self.drop_one(where, REQUEST, doc)
        if not isinstance(doc, dict):
            return
        if method is not None and doc.get("method") != method:
            self.fail(f"{where}: method is {doc.get('method')!r}, the file name says {method!r}")
        params = doc.get("params")
        meta = params.get("_meta") if isinstance(params, dict) else None
        version = meta.get(PROTOCOL_META) if isinstance(meta, dict) else None
        if version is not None and self.mcp_revision and version != self.mcp_revision:
            self.fail(f"{where}: protocol version {version!r} is not the contract's {self.mcp_revision!r}")

    def check_result(self, where: str, method: str, result, tool: str | None = None) -> None:
        rel = RESULTS[method]
        if not self.expect_valid(where, rel, result):
            return
        self.drop_one(where, rel, result)
        if method == "server/discover":
            if self.mcp_revision and result["supportedVersions"] != [self.mcp_revision]:
                self.fail(f"{where}: supportedVersions {result['supportedVersions']} is not "
                          f"[{self.mcp_revision!r}]")
            return
        if method != "tools/call" or tool is None:
            return
        out = f"{TOOLS_DIR}/{tool}.output.json"
        inst = result["structuredContent"]
        if out not in self.schemas:
            self.fail(f"{where}: no schema {out}")
        elif self.expect_valid(f"{where} structuredContent", out, inst):
            self.instances.append((where, inst))
            self.drop_one(f"{where} structuredContent", out, inst)
        content = result["content"]
        try:
            if json.loads(content[-1]["text"]) != inst:
                self.fail(f"{where}: the text block does not hold the structuredContent JSON")
        except ValueError as e:
            self.fail(f"{where}: the text block is not JSON: {e}")
        images = [c for c in content if c.get("type") == "image"]
        if tool == "screenshot" and not result["isError"]:
            if len(images) != 1:
                self.fail(f"{where}: a successful screenshot has exactly one image block before the text block")
            elif images[0]["mimeType"] != inst.get("mime_type"):
                self.fail(f"{where}: image mimeType {images[0]['mimeType']!r} is not "
                          f"structuredContent.mime_type {inst.get('mime_type')!r}")
        elif images:
            self.fail(f"{where}: only a successful screenshot carries an image block")

    def check_wire(self) -> None:
        pairs: dict[str, dict[str, object]] = {}
        for p in sorted((self.root / "examples" / "wire").glob("*.json")):
            name = self.rel(p)
            doc = self.load(p)
            if doc is None:
                continue
            self.counts["wire"] += 1
            for rule, kind in WIRE_RULES:
                m = rule.match(p.name)
                if m:
                    break
            else:
                self.fail(f"{name}: name matches no wire convention (<method>.request.json, "
                          "<method>.response.json, tools-call.<tool>.<name>.<request|response>.json, "
                          "error.<name>.response.json, <name>.notification.json)")
                continue
            if kind in ("request", "call-request"):
                pairs.setdefault(p.name.removesuffix(".request.json"), {})["request"] = doc
            elif kind in ("response", "call-response", "error"):
                pairs.setdefault(p.name.removesuffix(".response.json"), {})["response"] = doc
            if kind == "request":
                self.check_request(name, doc, METHOD_SLUGS[m.group(1)])
            elif kind == "call-request":
                tool = m.group(1)
                self.check_request(name, doc, "tools/call")
                params = doc.get("params") if isinstance(doc, dict) else None
                if not isinstance(params, dict):
                    continue
                if params.get("name") != tool:
                    self.fail(f"{name}: params.name is {params.get('name')!r}, the file name says {tool!r}")
                args = params.get("arguments", {})
                rel = f"{TOOLS_DIR}/{tool}.input.json"
                if rel not in self.schemas:
                    self.fail(f"{name}: no schema {rel}")
                elif self.expect_valid(f"{name} arguments", rel, args):
                    self.drop_one(f"{name} arguments", rel, args)
            elif kind in ("response", "call-response"):
                if not self.expect_valid(name, RESPONSE, doc):
                    continue
                self.drop_one(name, RESPONSE, doc)
                if kind == "response":
                    self.check_result(f"{name} result", METHOD_SLUGS[m.group(1)], doc["result"])
                else:
                    self.check_result(f"{name} result", "tools/call", doc["result"], m.group(1))
            elif kind == "error":
                if self.expect_valid(name, ERROR, doc):
                    self.drop_one(name, ERROR, doc)
            elif self.expect_valid(name, NOTIFICATION, doc):
                self.drop_one(name, NOTIFICATION, doc)
        for key, pair in sorted(pairs.items()):
            req, resp = pair.get("request"), pair.get("response")
            if isinstance(req, dict) and isinstance(resp, dict) and req.get("id") != resp.get("id"):
                self.fail(f"examples/wire/{key}: response id {resp.get('id')!r} is not the request id {req.get('id')!r}")

    def check_tools_list(self) -> None:
        """Build the tools/list result that contract 3.2 describes and validate it."""
        text = self.section("3.2 ")
        m = re.search(r"The result is\s+`(\{[^`]*\})`", text)
        if not m:
            self.fail("contract.md 3.2: the inline tools/list result is not found")
            return
        try:
            result = json.loads(m.group(1).replace("[...]", "[]"))
        except ValueError as e:
            self.fail(f"contract.md 3.2: the inline tools/list result is not JSON: {e}")
            return
        rows = self.table(text)
        if not rows or rows[0][:3] != ["Tool", "Title", "Kind"]:
            self.fail("contract.md 3.2: tool table not found")
            return
        head = [c.strip("`") for c in rows[0]]
        order = re.findall(r"`([a-z]+)`", (re.search(r"in the order ((?:`[a-z]+`,?\s*)+)", text) or [""])[0])
        names = [r[0].strip("`") for r in rows[1:]]
        if order != names:
            self.fail(f"contract.md 3.2: tool order {order} differs from the table {names}")
        tools = sorted({rel.split("/")[1].split(".")[0] for rel in self.schemas if rel.startswith(TOOLS_DIR + "/")})
        if sorted(names) != tools:
            self.fail(f"contract.md 3.2: table tools {sorted(names)} differ from tool schemas {tools}")
        self.kinds = {}
        for row in rows[1:]:
            cells = dict(zip(head, row))
            name = cells["Tool"].strip("`")
            self.kinds[name] = cells.get("Kind")
            entry = {"name": name, "title": cells.get("Title")}
            inp, out = f"{TOOLS_DIR}/{name}.input.json", f"{TOOLS_DIR}/{name}.output.json"
            if inp not in self.bundled_schemas or out not in self.bundled_schemas:
                continue
            entry["description"] = self.schemas[inp].get("description")
            entry["inputSchema"] = self.bundled_schemas[inp]
            entry["outputSchema"] = self.bundled_schemas[out]
            hints = {}
            for hint in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"):
                v = cells.get(hint, "").strip("`")
                if v not in ("true", "false"):
                    self.fail(f"contract.md 3.2: {name} {hint} is {v!r}, not true or false")
                hints[hint] = v == "true"
            entry["annotations"] = hints
            result["tools"].append(entry)
        where = "tools/list result built from contract 3.2"
        if self.expect_valid(where, RESULTS["tools/list"], result):
            self.drop_one(where, RESULTS["tools/list"], result)

    def check_contract_blocks(self) -> None:
        for m in re.finditer(r"^```json\n(.*?)^```", self.md, re.S | re.M):
            line = self.md.count("\n", 0, m.start()) + 1
            where = f"contract.md line {line} JSON block"
            try:
                doc = json.loads(m.group(1))
            except ValueError as e:
                self.fail(f"{where}: not JSON: {e}")
                continue
            self.counts["blocks"] += 1
            if not isinstance(doc, dict):
                self.fail(f"{where}: not an object")
            elif "method" in doc:
                if "id" in doc:
                    self.check_request(where, doc)
                else:
                    self.expect_valid(where, NOTIFICATION, doc)
            elif "error" in doc:
                self.expect_valid(where, ERROR, doc)
            elif "result" in doc:
                if self.expect_valid(where, RESPONSE, doc):
                    res = doc["result"]
                    method = ("tools/call" if "structuredContent" in res else
                              "tools/list" if "tools" in res else "server/discover")
                    self.check_result(f"{where} result", method, res)
            elif "resultType" in doc:
                self.check_result(where, "tools/call", doc)
            elif {"version", "mac"} <= set(doc):
                self.expect_valid(where, "allowance.json", doc)
            else:
                self.fail(f"{where}: shape matches no schema")

    # Enums and prose

    def check_enums(self) -> None:
        d = self.schemas[DEFS].get("$defs", {})
        try:
            states = d["state"]["enum"]
            if d["blocking_state"]["enum"] != states[:-1] or states[-1] != "ok":
                self.fail(f"{DEFS}: blocking_state must equal state without the final ok, same order")
            if not set(states[:-1]) <= set(d["error_code"]["enum"]):
                self.fail(f"{DEFS}: every non-ok state must also be an error_code")
        except (KeyError, TypeError) as e:
            self.fail(f"{DEFS}: missing enum {e}")
        for name, node in d.items():
            vals = node.get("enum") if isinstance(node, dict) else None
            if isinstance(vals, list) and len(vals) != len({json.dumps(v) for v in vals}):
                self.fail(f"{DEFS}: duplicate values in {name}")

    def check_status_states(self) -> None:
        """A status result's state is the first of its active_states, for every state."""
        rel = f"{TOOLS_DIR}/status.output.json"
        base = next((i for _, i in self.instances if isinstance(i, dict) and i.get("state") == "ok"
                     and "active_states" in i), None)
        if rel not in self.validators or base is None:
            self.fail(f"{rel}: no valid example with state ok to derive the state rules from")
            return
        blocking = self.schemas[DEFS].get("$defs", {}).get("blocking_state", {}).get("enum", [])

        def valid(state, active) -> bool:
            return all(e is None for e in self.errors(rel, {**base, "state": state, "active_states": active}))

        for i, state in enumerate(blocking):
            other = blocking[(i + 1) % len(blocking)]
            if not valid(state, [state]):
                self.fail(f"{rel}: state {state} with active_states [{state}] must validate")
            for active in ([], [other], [other, state]):
                if valid(state, active):
                    self.fail(f"{rel}: state {state} with active_states {active} must be rejected")
            if valid("ok", [state]):
                self.fail(f"{rel}: state ok with active_states [{state}] must be rejected")

    def check_http_codes(self) -> None:
        """The HTTP status and JSON-RPC code pairs of 2.3 and 2.4 against the 9.4 table."""
        table = {(int(code), int(http)) for code, http in
                 re.findall(r"^\| `(-\d+)`[^|]*\| `(\d{3})` \|", self.section("9.4 JSON-RPC errors"), re.M)}
        if not table:
            self.fail("contract.md 9.4: no rows of the form | `<code>` ... | `<HTTP status>` |")
            return
        used = set()
        for prefix in ("2.3 ", "2.4 "):
            pairs = {(int(code), int(http)) for http, code in
                     re.findall(r"`(\d{3})`, (?:JSON-RPC )?`(-\d+)`", self.section(prefix))}
            if not pairs:
                self.fail(f"contract.md {prefix.strip()}: no `<HTTP status>`, `<code>` pairs found")
            for code, http in sorted(pairs - table):
                self.fail(f"contract.md {prefix.strip()}: says {http} with {code}, which the 9.4 table does not list")
            used |= pairs
        codes = {code for code, _ in used}
        for code, http in sorted(table - used):
            if code in codes:
                self.fail(f"contract.md 9.4: lists {http} with {code}, which no check of 2.3 or 2.4 returns")

    def check_prose(self) -> None:
        if not self.md:
            return
        d = self.schemas[DEFS].get("$defs", {})

        def enum(name: str) -> list:
            return d.get(name, {}).get("enum", [])

        def first_col(text: str) -> list[str]:
            return re.findall(r"^\| `([a-z_]+)` \|", text, re.M)

        def compare(where: str, doc: list, name: str, schema: list | None = None, src: str = DEFS) -> None:
            schema = enum(name) if schema is None else schema
            if doc == schema:
                return
            only_doc = sorted(set(map(str, doc)) - set(map(str, schema)))
            only_schema = sorted(set(map(str, schema)) - set(map(str, doc)))
            detail = f"only in prose {only_doc}, only in {src} {only_schema}" if only_doc or only_schema else "order differs"
            self.fail(f"contract.md {where} does not match {src} {name}: {detail}")

        def slug(h: str) -> str:
            h = re.sub(r"[`*]", "", h.strip().lower())
            return re.sub(r"[^\w\- ]", "", h).replace(" ", "-")

        anchors = {slug(h) for h in re.findall(r"^#+ (.+)$", self.md, re.M)}
        for a in re.findall(r"\]\(#([^)]+)\)", self.md):
            if a not in anchors:
                self.fail(f"contract.md: broken anchor #{a}")

        codes_text = self.section("9.3 Tool error codes")
        compare("9.3 error code table", first_col(codes_text), "error_code")
        compare("section 10 state table", re.findall(r"^\| \d+ \| `([a-z_]+)` \|", self.section("10. States"), re.M),
                "state")
        compare("8.3 reason table", [r for r in first_col(self.section("8.3 Frame staleness")) if r != "reason"],
                "stale_frame_reason")
        compare("section 11 condition table", first_col(self.section("11. Conditions")), "condition")
        rpc = [number(c) for c in re.findall(rf"^\| `({NUM})` ", self.section("9.4 JSON-RPC errors"), re.M)]
        error_schema = self.schemas.get(ERROR, {})
        try:
            rpc_schema = error_schema["properties"]["error"]["properties"]["code"]["enum"]
        except (KeyError, TypeError):
            rpc_schema = []
        compare("9.4 JSON-RPC error table", sorted(set(rpc)), "error.code", sorted(rpc_schema), ERROR)

        self.check_tool_codes(codes_text)
        self.check_http_codes()
        self.check_error_rules(d)
        self.check_constants()
        self.check_versions()

    def check_tool_codes(self, text: str) -> None:
        """The "Tools" column of 9.3 against each tool's output schema."""
        tools = sorted(getattr(self, "kinds", {}))
        effects = [t for t, k in getattr(self, "kinds", {}).items() if k == "effect"]
        want: dict[str, list[str]] = {t: [] for t in tools}
        for row in self.table(text)[1:]:
            code, who = row[0].strip("`"), row[1]
            named = re.findall(r"`([a-z]+)`", who)
            if who == "all":
                members = tools
            elif who.startswith("all but "):
                members = [t for t in tools if t not in named]
            elif who == "effects":
                members = effects
            elif named and set(named) <= set(tools):
                members = named
            else:
                self.fail(f"contract.md 9.3: cannot read the Tools cell {who!r} of {code}")
                continue
            for t in members:
                want[t].append(code)
        for t in tools:
            rel = f"{TOOLS_DIR}/{t}.output.json"
            err = self.schemas.get(rel, {}).get("$defs", {}).get(f"{t}_error", {})
            got = None
            for part in err.get("allOf", []):
                got = part.get("properties", {}).get("code", {}).get("enum", got)
            if got is None:
                self.fail(f"{rel}: no $defs/{t}_error with a code enum")
                continue
            if sorted(got) != sorted(want[t]):
                self.fail(f"{rel}: error codes differ from contract.md 9.3 'Tools': "
                          f"only in prose {sorted(set(want[t]) - set(got))}, only in schema {sorted(set(got) - set(want[t]))}")

    def check_error_rules(self, d: dict) -> None:
        """The 9.2 tables and rules against the if/then blocks of tool_error."""
        te = d.get("tool_error", {})
        shape = self.section("9.2 The")
        blocks = []  # (codes, extra if-conditions, then)
        for b in te.get("allOf", []):
            cond = b.get("if", {})
            code = cond.get("properties", {}).get("code", {})
            codes = [code["const"]] if "const" in code else code.get("enum", [])
            extra = set(cond.get("properties", {})) - {"code"}
            blocks.append((codes, extra, b.get("then", {}), b.get("else")))

        def requires(code: str, unconditional: bool = True) -> tuple[set, set]:
            top, det = set(), set()
            for codes, extra, then, _ in blocks:
                if code in codes and (not extra or not unconditional):
                    top |= set(then.get("required", []))
                    det |= set(then.get("properties", {}).get("details", {}).get("required", []))
            return top, det

        detail_rows = [r for r in self.table(shape) if len(r) == 2 and r[0].startswith("`")]
        table_codes = []
        for code_cell, members in detail_rows:
            code = code_cell.strip("`")
            table_codes.append(code)
            base, _, also = members.partition("; also ")
            base_names = set(re.findall(r"`([a-z_]+)`", base.split(":")[0]))
            top, det = requires(code)
            if "details" not in top or det != base_names:
                self.fail(f"{DEFS} tool_error: {code} must require details {sorted(base_names)} (contract.md 9.2), "
                          f"schema requires {sorted(det) if 'details' in top else 'no details'}")
            if also:
                member, _, when = also.partition(" when ")
                names = set(re.findall(r"`([a-z_]+)`", member))
                if re.search(r"`[a-z_]+`", when) and not names <= requires(code, False)[1]:
                    self.fail(f"{DEFS} tool_error: {code} must require details {sorted(names)} "
                              f"when {when.strip()} (contract.md 9.2)")
        forbid = [codes for codes, extra, then, other in blocks
                  if not extra and not then and other == {"not": {"required": ["details"]}}]
        if len(forbid) != 1 or sorted(forbid[0]) != sorted(table_codes):
            self.fail(f"{DEFS} tool_error: the rule that only {sorted(table_codes)} carry details "
                      f"(contract.md 9.2) is missing or lists {forbid}")

        members = {r[0].strip("`"): r[1] for r in self.table(shape) if len(r) == 3 and r[0].startswith("`")}
        for p in te.get("properties", {}):
            if p not in members:
                self.fail(f"contract.md 9.2 member table lacks tool_error.{p}")
        for p in members:
            if p not in te.get("properties", {}):
                self.fail(f"contract.md 9.2 member table names {p}, which tool_error does not have")
        codes_enum = set(d.get("error_code", {}).get("enum", []))
        for member, presence in members.items():
            if presence == "always":
                if member not in te.get("required", []):
                    self.fail(f"{DEFS} tool_error: {member} must be required (contract.md 9.2 says always)")
                continue
            for code in re.findall(r"`([a-z_]+)`", presence.split(" other than ")[0]):
                if code in codes_enum and member not in requires(code)[0]:
                    self.fail(f"{DEFS} tool_error: {code} must require {member} (contract.md 9.2)")
        details = {m for _, row in detail_rows for m in re.findall(r"`([a-z_]+)`", row.split(" when ")[0])
                   if m not in ("policy", "permitted_apps")}
        schema_details = set(te.get("properties", {}).get("details", {}).get("properties", {}))
        if details != schema_details:
            self.fail(f"contract.md 9.2 details keys differ from {DEFS}: only in prose {sorted(details - schema_details)}, "
                      f"only in {DEFS} {sorted(schema_details - details)}")

        flat = re.sub(r"\s+", " ", shape)
        rules = re.findall(r"((?:`[a-z_]+`(?:, | and )?)+) always carry ((?:`[a-z_]+`(?: and )?)+)", flat)
        rules += [(c, f"`{m}`") for c, m, _ in
                  re.findall(r"((?:`[a-z_]+`(?:, | and )?)+) always have `([a-z_]+)` `(true|false)`", flat)]
        if not rules:
            self.fail("contract.md 9.2: the 'always carry' rules are not found")
        for codes, needed in rules:
            for code in re.findall(r"`([a-z_]+)`", codes):
                missing = set(re.findall(r"`([a-z_]+)`", needed)) - requires(code)[0]
                if missing:
                    self.fail(f"{DEFS} tool_error: {code} must require {sorted(missing)} (contract.md 9.2)")
        for state in d.get("blocking_state", {}).get("enum", []):
            if not any(codes == [state] and then.get("properties", {}).get("state", {}).get("const") == state
                       for codes, extra, then, _ in blocks):
                self.fail(f"{DEFS} tool_error: code {state} must force state {state} (contract.md 9.2)")

    def check_constants(self) -> None:
        rows = self.table(self.section("16. Constants"))
        consts: dict[str, dict] = {}
        for row in rows[1:]:
            if len(row) != 3:
                continue
            names, value, kind = row
            parsed = {"kind": kind}
            if re.fullmatch(rf"(?:{NUM})(?:, (?:{NUM}))+", value):
                parsed["list"] = [number(v) for v in value.split(", ")]
            else:
                if m := re.search(rf"default ({NUM})", value):
                    parsed["default"] = number(m.group(1))
                if m := re.search(rf"({NUM}) to ({NUM})", value):
                    parsed["min"], parsed["max"] = number(m.group(1)), number(m.group(2))
                if "default" not in parsed and (m := re.search(rf"(?<![\w.]){NUM}", value)):
                    parsed["value"] = number(m.group(0))
                if m := re.search(rf"\(= ({NUM}) × ({NUM})\)", value):
                    if number(m.group(1)) * number(m.group(2)) != parsed.get("value"):
                        self.fail(f"contract.md 16: {names} {value!r} does not multiply out")
            for name in re.findall(r"^`([A-Z_]+)`|, `([A-Z_]+)`", names):
                consts[name[0] or name[1]] = parsed
        if not consts:
            self.fail("contract.md 16: constants table not found")
            return
        self.counts["constants"] = len(consts)
        self.consts = consts
        for name in sorted(set(consts) - set(CONSTANT_SITES) - UNSCHEMATIZED_CONSTANTS):
            self.fail(f"contract.md 16: {name} is in neither CONSTANT_SITES nor UNSCHEMATIZED_CONSTANTS "
                      "of scripts/check-contract.py")
        for name in sorted((set(CONSTANT_SITES) | UNSCHEMATIZED_CONSTANTS) - set(consts)):
            self.fail(f"scripts/check-contract.py names {name}, which contract.md 16 does not list")

        def want(name: str, part: str):
            c = consts.get(name, {})
            if part == "neg":
                return -c["value"] if "value" in c else None
            return c.get(part)

        for name, sites in CONSTANT_SITES.items():
            if name not in consts:
                continue
            for rel, ptr, kw, part in sites:
                expected = want(name, part)
                if expected is None:
                    self.fail(f"contract.md 16: {name} has no {part} to compare with {rel}#{ptr}/{kw}")
                    continue
                try:
                    got = pointer_get(self.schemas[rel], ptr)[kw]
                except (KeyError, IndexError, TypeError):
                    self.fail(f"{rel}: no {kw} at {ptr} for {name} (update CONSTANT_SITES if it moved)")
                    continue
                if got != expected:
                    self.fail(f"{rel}#{ptr}/{kw} is {got}, contract.md 16 says {name} {part} is {expected}")

        for prefix, pattern, parts in PROSE_SITES:
            text = re.sub(r"[ \t]*\n[ \t]*(?![|#])", " ", self.section(prefix))
            found = list(re.finditer(pattern, text))
            if not found:
                self.fail(f"contract.md {prefix.strip()}: prose site /{pattern}/ not found (update PROSE_SITES)")
            for m in found:
                for group, part in zip(m.groups(), parts):
                    if part and number(group) != want(*part):
                        self.fail(f"contract.md {prefix.strip()}: says {group} where section 16 gives "
                                  f"{part[0]} {part[1]} {want(*part)}")
        self.check_figures(want)
        for name, value in re.findall(rf"`([A-Z][A-Z_]+)` = ({NUM})", self.md):
            if name in consts and number(value) != want(name, "value"):
                self.fail(f"contract.md: `{name}` = {value}, section 16 gives {want(name, 'value')}")

        limits_schema = pointer_get(self.schemas.get(f"{TOOLS_DIR}/status.output.json", {}),
                                    "/$defs/limits/properties") if f"{TOOLS_DIR}/status.output.json" in self.schemas else {}
        for key in limits_schema:
            name, _ = LIMIT_PARTS.get(key, (key.upper(), "value"))
            if name not in consts:
                self.fail(f"tools/status.output.json: limits.{key} has no constant {name} in contract.md 16")
        for name, c in consts.items():
            reported = name.lower() in limits_schema or any(n == name for n, _ in LIMIT_PARTS.values())
            if c["kind"].startswith("configured") and "not reported by `status`" not in c["kind"] and not reported:
                self.fail(f"contract.md 16: configured {name} is not reported by status.limits")
        for where, inst in self.instances:
            for limits in find_key(inst, "limits"):
                if not isinstance(limits, dict):
                    continue
                for key, got in limits.items():
                    name, part = LIMIT_PARTS.get(key, (key.upper(), "value"))
                    c = consts.get(name)
                    if c is None:
                        continue
                    exp = c.get(part) if part != "value" else c.get("value")
                    if exp is not None and got != exp:
                        self.fail(f"{where}: limits.{key} is {got}, contract.md 16 says {name} {part} is {exp}")
                    elif exp is None and "min" in c and not c["min"] <= got <= c["max"]:
                        self.fail(f"{where}: limits.{key} {got} is outside {name} {c['min']} to {c['max']}")

    def check_figures(self, want) -> None:
        """Every figure of a million or more that is given in bytes, pixels or characters, anywhere."""
        image, body = want("MAX_IMAGE_BYTES", "value"), want("MAX_RESPONSE_BODY_BYTES", "value")
        pixels = want("MAX_PIXELS", "value")
        if None in (image, body, pixels):
            return
        allowed = {
            "bytes": {image: "MAX_IMAGE_BYTES", body: "MAX_RESPONSE_BODY_BYTES"},
            "pixels": {pixels: "MAX_PIXELS"},
            "characters": {image * 4 // 3: "MAX_IMAGE_BYTES in base64"},
        }
        flat = re.sub(r"[ \t]*\n[ \t]*(?=[^\s|#])", " ", self.md)  # joins wrapped lines, keeps headings apart
        left = dict(OTHER_FIGURES)
        for m in re.finditer(r"(?<![\d,.])(\d{1,3}(?:,\d{3}){2,}) (?:base64 )?(bytes|pixels|characters)\b", flat):
            value, unit = number(m.group(1)), m.group(2)
            heading = (re.findall(r"^#+ (.+)$", flat[:m.start()], re.M) or [""])[-1]
            other = (heading.split(" ")[0], unit, value)
            if value in allowed[unit]:
                continue
            if left.get(other, 0) > 0:
                left[other] -= 1
                continue
            self.fail(f"contract.md '{heading}': says {m.group(1)} {unit}; section 16 gives "
                      + ", ".join(f"{v} ({n})" for v, n in allowed[unit].items())
                      + (" (OTHER_FIGURES allows it fewer times)" if other in OTHER_FIGURES else ""))
        for (section, unit, value), count in sorted(left.items()):
            if count:
                self.fail(f"OTHER_FIGURES lists {value} {unit} in section {section} {count} more time(s) than "
                          "contract.md has it")

    def check_versions(self) -> None:
        if not self.doc_version:
            return
        reported = self.header.get("`contract_version` reported by `status`")
        if reported != self.doc_version:
            self.fail(f"contract.md header: contract_version {reported!r} differs from document version "
                      f"{self.doc_version!r}")

        def walk(node, rel, where=""):
            if isinstance(node, dict):
                for key, want in (("contract_version", self.doc_version), ("mcp_protocol_version", self.mcp_revision)):
                    sub = node.get("properties", {}).get(key) if isinstance(node.get("properties"), dict) else None
                    if isinstance(sub, dict) and "const" in sub and sub["const"] != want:
                        self.fail(f"{rel}{where}/properties/{key} const {sub['const']!r} is not {want!r}")
                for k, v in node.items():
                    walk(v, rel, f"{where}/{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, rel, f"{where}/{i}")

        for rel, s in self.schemas.items():
            walk(s, rel)
        for where, inst in self.instances:
            for key, want in (("contract_version", self.doc_version), ("mcp_protocol_version", self.mcp_revision)):
                for got in find_key(inst, key):
                    if got != want:
                        self.fail(f"{where}: {key} {got!r} is not the contract's {want!r}")

    def run(self) -> int:
        self.bundled: dict[str, Draft202012Validator] = {}
        self.bundled_schemas: dict[str, dict] = {}
        if "date-time" not in FORMAT_CHECKER.checkers:
            self.fail("the date-time format is not asserted: install scripts/requirements-contract.txt")
        self.load_contract()
        self.load_schemas()
        if DEFS in self.schemas:
            self.check_tools()
            self.check_examples()
            self.check_wire()
            if self.md:
                self.check_tools_list()
                self.check_contract_blocks()
            self.check_coverage()
            self.check_optional_members()
            self.check_status_states()
            self.check_enums()
            self.check_prose()
        summary = ", ".join(f"{k} {v}" for k, v in self.counts.items())
        if self.fails:
            for f in self.fails:
                print(f"FAIL {f}", file=sys.stderr)
            print(f"check-contract: {len(self.fails)} failure(s) ({summary})", file=sys.stderr)
            return 1
        print(f"check-contract: ok ({summary})")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--docs", type=Path, default=Path(__file__).resolve().parent.parent / "docs",
                    help="docs directory holding contract.md and schemas/ (default: %(default)s)")
    args = ap.parse_args()
    return Checker(args.docs).run()


if __name__ == "__main__":
    sys.exit(main())
