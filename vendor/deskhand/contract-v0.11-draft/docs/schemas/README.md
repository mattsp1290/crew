# Contract schemas

JSON Schema Draft 2020-12 files for the wire contract in
[`docs/contract.md`](../contract.md). The contract's
[schema index](../contract.md#19-schema-index) says what each file holds.

## Checking

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements-contract.txt
.venv/bin/python scripts/check-contract.py
```

The `Contract schemas` job in `.github/workflows/docs.yml` runs the same check.
It prints one `FAIL` line per problem and exits non-zero if there are any.

## Layout convention

The checker finds schemas and examples by where they live and how they are
named. Adding a file in the right place is enough; the script has no list to
update.

| Path | Rule |
| --- | --- |
| `**/*.json` outside `examples/` | A schema. It declares Draft 2020-12, has an `$id` ending in its path under `docs/schemas/`, and every `$ref` resolves locally. Its stem is the file name without `.json` and must be unique. Every `format` it uses must be asserted; `date-time` needs `rfc3339-validator`, which the requirements file pins. |
| `defs.json` | Shared definitions. The only schema that needs no example and no invalid example. |
| `tools/<tool>.input.json`, `tools/<tool>.output.json` | Tool schemas, always in pairs. They must survive the `tools/list` bundling rule (contract 3.2); input schemas are closed objects with no top-level combinators. |
| `wire/*.json` | JSON-RPC messages (`jsonrpc-request`, `jsonrpc-notification`, `jsonrpc-response`, `jsonrpc-error`) and method results (`server-discover-result`, `tools-list-result`, `tools-call-result`). |
| `examples/<stem>.<name>.json` | Must validate against the schema with the longest matching stem. Every schema outside `wire/` except `defs.json` needs at least one. |
| `examples/invalid/<stem>.<name>.json` | Must be rejected by that schema. Every schema except `defs.json` needs at least one. |
| `examples/wire/*.json` | A whole JSON-RPC 2.0 message, named by one of the conventions below. |

`<name>` uses `a-z`, `0-9` and `-`. For example, `tools/pointer.input.json` has
stem `pointer.input`, so `examples/pointer.input.click.json` is checked against
it; a new `allowance.json` has stem `allowance` and its examples are
`examples/allowance.<name>.json`. Any other JSON file or directory under
`examples/` fails the check, and so does an empty or missing `invalid/` or
`wire/`. A schema's own `examples` keyword must validate too.

## Required members

The checker drops each member of every valid instance in turn: every example,
wire message, set of call arguments and tool result. The instance must then be
rejected, unless the member is listed in `OPTIONAL_MEMBERS` in the script. So
deleting a `required` from a schema fails the check, and a new optional member
is declared in that list. An entry that no instance uses fails too. The walk
does not go inside a member that another schema checks (`OPAQUE_MEMBERS`).

## Wire examples

| File name | Checked against |
| --- | --- |
| `server-discover.request.json`, `tools-list.request.json` | `jsonrpc-request`, with that method. |
| `server-discover.response.json`, `tools-list.response.json` | `jsonrpc-response`, and the result against that method's result schema. `supportedVersions` is the contract's MCP revision only. |
| `tools-call.<tool>.<name>.request.json` | `jsonrpc-request` with method `tools/call` and `params.name` `<tool>`; `arguments` (default `{}`) against `tools/<tool>.input.json`. |
| `tools-call.<tool>.<name>.response.json` | `jsonrpc-response`; the result against `tools-call-result` and `structuredContent` against `tools/<tool>.output.json`. The text block holds the `structuredContent` JSON. A successful `screenshot` has exactly one image block, first, whose `mimeType` equals `structuredContent.mime_type`; no other result has one. |
| `error.<name>.response.json` | `jsonrpc-error`. |
| `<name>.notification.json` | `jsonrpc-notification`. |

Any other name fails. A request and a response that share a name before
`.request`/`.response` must share an `id`, and every request's
`params._meta["io.modelcontextprotocol/protocolVersion"]` is the contract's MCP
revision. A `wire/` schema needs one valid instance: a wire example, a JSON
block in the contract, its own `examples`, or, for `tools-list-result`, the
result the checker builds from the tool schemas and the table in contract 3.2.

## Contract prose

The checker also compares `docs/contract.md` with the schemas:

- Name lists, both ways: the error codes in 9.3, the states in 10, the
  stale-frame reasons in 8.3, the conditions in 11, the JSON-RPC codes in 9.4,
  and each tool's codes from the "Tools" column of 9.3.
- The 9.2 tables and rules (which codes carry `details` and which members,
  which carry `operation`, `retry_after_ms` or `measured`, and that a state's
  code carries that state) against the `if`/`then` rules of `tool_error`.
- Every constant in section 16 against each schema keyword that carries it
  (`CONSTANT_SITES` in the script), against `limits` in the examples, and
  against the prose that restates it (`PROSE_SITES`, every match in the
  section). A new constant must be added to `CONSTANT_SITES` or
  `UNSCHEMATIZED_CONSTANTS`.
- Every figure of a million or more that is given in bytes, pixels or
  characters, anywhere in the document, against `MAX_IMAGE_BYTES`,
  `MAX_RESPONSE_BODY_BYTES` and `MAX_PIXELS`. `OTHER_FIGURES` lists the few
  that a section may quote for another reason.
- The HTTP status and JSON-RPC code pairs of 2.3 and 2.4 against the 9.4
  table.
- For every state, that a `status` result whose `active_states` does not
  begin with its `state` is rejected. The instances are built from a valid
  example.
- The header's document version against `contract_version` in every schema and
  example, and its MCP revision against `mcp_protocol_version`.
- Every `json` code block validates against the matching schema, and every
  `#anchor` link resolves to a heading.

`scripts/check-mac-session-gate.sh`, run in the `swift-format lint` job of
`.github/workflows/swift.yml`, is the Swift-side counterpart: it fails when a
test names `.requiresMacSession` without `.macSessionTestsEnabled` or the
reverse.
