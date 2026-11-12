# Member capabilities

**No engine runs any of these tools yet.** A member with capabilities behaves
exactly like a member without them: Claude, Codex and Pi are offered the same
tools as before, and nothing reads a file, runs a command or fetches a URL for a
member. This page describes the foundation that later work builds on.

Members are meant to get the tools of a coding agent: files in a workspace, a
shell, web fetch and web search. Crew will run every such tool itself, outside the
model's sandbox, behind one approval gate. Migrations 32 and 33 add the three
things that gate needs before it can exist:

- a **capability set**: which tools a member may be offered at all, fixed at spawn
  inside a ceiling the operator sets;
- a **tool catalog**: for one call of a tool, whether it reads or has an effect,
  what it touches, a digest that pins it, a preview a person can trust, and the
  standing selector a card may offer;
- a **tool-call ledger**: a durable row for each decided call, from its verdict to
  the delivery of its outcome, so that Crew knows what happened when a worker dies.

## Capability sets

A capability set is a small versioned JSON object.

| Key | Gives the member | Values |
| --- | --- | --- |
| `version` | | `1` |
| `workspace.files` | `fs_read`, `fs_list`, `fs_search`; with `"write"` also `fs_write` and `fs_edit` | `"read"` or `"write"` |
| `workspace.shell` | `shell_run` | `{ "network": "off" }` or `{ "network": "proxied" }` |
| `webFetch.hosts` | `web_fetch` | `"any"`, or 1 to 32 host patterns |
| `webSearch` | `web_search` | `{}` |

A shell is written inside `workspace` and only with `"files": "write"`. A shell can
write anything in its workspace, so a read-only workspace with a shell would be a
false promise. The TypeScript type has no place for a shell elsewhere, validation
answers `A shell needs a writable workspace: set files to "write"`, and a CHECK
refuses such a row.

A host pattern is a host name, an IP address, or `*.` and a domain of at least two
labels. [Selectors](#selectors) describes what a pattern matches.

### The operator sets a ceiling

The ceiling is the `capabilities` field of a `MemberProfile`, in the trusted
profile module the worker loads. No request can set it.

```ts
const proxy = await createProxyProfile({ engine: "claude", protocol: "anthropic-messages", model, accountId, endpoint, resolveCredential });
export const profiles = new Map([["claude-tools.v1", {
  ...proxy.profile,
  capabilities: {
    version: 1,
    workspace: { files: "write", shell: { network: "off" } },
    webFetch: { hosts: ["docs.example.com", "*.example.org"] },
  },
}]]);
```

`registerProfiles` stores the ceiling with the profile registration. A profile
without `capabilities`, or with `{ "version": 1 }`, has no ceiling. As for tools, a
worker that registers a different ceiling under a name that is already registered
is refused, and a registration without a ceiling never gains one. To change a
ceiling, register a new profile name.

**A ceiling with a shell needs a relay credential.** A shell runs commands for the
model, and a provider key in the member's environment would be within its reach.
Before this change nothing distinguished a proxy profile: `MemberProfile` carried no
mark, and for Claude the direct and the proxy options have the same fields. So
`createProxyProfile` now records the engine options it builds, and
`registerProfiles` refuses a ceiling with a shell unless every engine of the
profile has such options. The mark is the object identity of those options. A copy
of them, or options written by hand, are refused. Spreading the profile to add
`capabilities`, as above, keeps them. The check runs in every process that
registers profiles, which the worker and each native runner do before a member is
launched. The database row records the ceiling and not the credential, so the
check holds for registrations made by this code and cannot be read back from
PostgreSQL.

### An owner picks a set at spawn

`POST /v1/members` (and `POST /members`) takes an optional `capabilities`:

```json
{
  "requestId": "92090532-d939-43d9-847e-0e439eb74f6c",
  "engine": "claude",
  "profile": "claude-tools.v1",
  "capabilities": { "version": 1, "workspace": { "files": "read" }, "webFetch": { "hosts": ["docs.example.com"] } }
}
```

| Request | Result |
| --- | --- |
| No `capabilities`, or `{ "version": 1 }` | `201`. The member has none. The response, the listing and the audit row are exactly as before this change. |
| A set within the ceiling | `201`. The response has `capabilities` in canonical form. |
| A set above the ceiling, or any set when the profile has no ceiling | `400` `{"error":"capabilities_exceed_profile"}`. Nothing is written. |
| A malformed set, an unknown key (`__proto__` included), another version | `400` `{"error":"invalid_input"}`. |
| A retry with the same `requestId` and the same set, however it is spelled | `201` with the same member. |
| A retry with the same `requestId` that differs in engine, profile or set | `409` `{"error":"conflict"}`, whatever it asks for. Only a new request is checked against the ceiling. |

The absence of a field never means more. A request that names no capabilities gets
none, even when the profile has a ceiling.

A requested set is within a ceiling when the ceiling allows everything it allows:

- `workspace`: the ceiling has a workspace; `"write"` needs `"write"`; a shell
  needs a shell; `"proxied"` needs `"proxied"`.
- `webFetch`: the ceiling has `webFetch`. A ceiling of `"any"` allows every list. A
  request of `"any"` needs a ceiling of `"any"`. Otherwise every requested pattern
  must be covered by one ceiling pattern: the same host, a host below a wildcard,
  or a wildcard at or below a wildcard.
- `webSearch`: the ceiling has `webSearch`.

`capabilitiesWithin` in `src/service/capabilities.ts` is the only place that
decides this. `store.spawn` calls it in the transaction that inserts the member, so
the operator CLI's `spawn` is checked the same way.

The set is fixed for the member's life, like its engine and profile. Nothing
narrows or widens it later.

### Where a set is reported

- `POST /v1/members` and `GET /v1/members` return `capabilities` for a member that
  has some, and no such key for a member that has none.
- The `member.spawned` audit event carries `capabilityDigest` for a member that has
  some: the SHA-256 of the canonical JSON of its set. The trail never holds the set.
- `GET /v1/capabilities` has a `memberCapabilities` entry: the version, the field
  names, the kinds, and `"toolExecution": "not-implemented"`.

The canonical form has the keys above and nothing else, host patterns in lower
case, punycode, without a trailing dot, sorted and without duplicates. Two
spellings of one set have one digest. Two sets that list different patterns are
different sets, even when the patterns cover the same hosts.

### Storage

Migration 32 adds a nullable `capabilities` column to `profiles` and a table
`member_capabilities` with one row for each member that has capabilities. NULL and
no row mean none. A CHECK on both requires an object at version 1 that holds at
least one capability and no other key, each capability an object, a workspace that
says `read` or `write`, a shell only in a writable workspace, a fetch that names
its hosts, and at most 16 KiB. The shell's network and the host patterns are
validated in TypeScript only.

Triggers hold the rest:

- A stored ceiling or set never changes.
- A registration that has a ceiling is never deleted, truncated or renamed. A
  member is checked against its ceiling once, at spawn; if the registration could
  be removed, the same name could be registered again with a narrower ceiling, or
  with none and a provider key, under members that keep their sets. A registration
  without a ceiling can still be deleted.
- A member's row is refused unless the member belongs to the row's owner and its
  profile registration has a ceiling.

Whether the set is within the ceiling is decided in TypeScript only, as for
standing grants.

## The tool catalog

`src/service/tool-catalog.ts` is pure: no database, no file system, no network.
`classify` reads one call and returns everything the gate needs. A call it cannot
read (an unknown tool, an unknown argument, a path outside the workspace) raises
`ToolArgumentError`, whose message names the tool and the field and never a value.

| Tool | Needs | Arguments | Kind | Scope | Selector a card may offer |
| --- | --- | --- | --- | --- | --- |
| `fs_read` | `workspace` | `path`, `startLine` (1), `lineCount` (2000) | read | the path | `path_prefix`: the file's directory |
| `fs_list` | `workspace` | `path` (root), `depth` (1) | read | the path | `path_prefix`: the directory; `tool` for the root |
| `fs_search` | `workspace` | `query`, `path` (root) | read | the path | `path_prefix`: the directory; `tool` for the root |
| `fs_write` | `files: "write"` | `path`, `content` | effect | the path | `path_prefix`: the file's directory |
| `fs_edit` | `files: "write"` | `path`, `oldText`, `newText` | effect | the path | `path_prefix`: the file's directory |
| `shell_run` | `workspace.shell` | `command`, `cwd` (root), `timeoutSeconds` (60) | **always an effect** | the working directory and the command's words | `command_prefix`: all the words, or none |
| `web_fetch` | `webFetch`, and the host | `url`, `method` (`GET`), `body` | read for `GET` and `HEAD`, effect for `POST`, `PUT`, `PATCH`, `DELETE` | scheme, host, port, method | `host`: the exact host, for a read over https on port 443; otherwise none |
| `web_search` | `webSearch` | `query`, `maxResults` (10) | read | none | `tool` |

Defaults are in parentheses. For a file directly in the workspace root the
directory selector would be the whole workspace, so the card offers the file's own
path instead. No card offers a write, an edit or a command over the whole
workspace, a wildcard host, or a prefix of a command that is not provably simple.
Listing or searching the root offers `tool`, which for those two reads is the
whole workspace.

Limits: a path is at most 512 bytes and a segment 255; a command 2,048 bytes; file
content 262,144 bytes; `oldText` and `newText` 65,536 bytes each; a query 1,024
bytes; a URL 4,096 bytes; a request body 65,536 bytes, only with `POST`, `PUT` or
`PATCH`. Text must be well-formed and hold no NUL. `web_fetch` takes no headers
from the model.

### One reading of every call

`classify` normalizes the arguments: a path becomes its canonical form, a URL
becomes the URL as it will be requested, and every default is filled in. The
selector matches, the preview shows and the executor must run the normalized
arguments and nothing else. Normalized arguments read back as themselves.

The **argument digest** is the SHA-256 of the canonical JSON of the tool name, the
catalog version (1), the normalized arguments and, for `fs_edit`, `priorSha256`:
the hash of the file the edit was read against, which the caller supplies. It uses
the same canonical JSON as the trusted lane (`src/service/canonical-json.ts`).
Every spelling of one call has one digest, and the same edit of another version of
the file is another call. The digest does not cover the kind or the scope, which
follow from the arguments: `verifyStored` in `src/service/tool-calls.ts` classifies
a stored call again and refuses it unless digest, kind, scope and catalog version
match, and the ledger does the same before it stores a call.

### The preview

The model never writes the preview. Crew renders it from the arguments.

- **It is printable ASCII.** Every other character is spelled `\u{hex}`: control
  characters, invisible and reordering characters, and every letter, digit, mark
  or symbol outside ASCII. A letter such as U+02BC passes for a quote and U+01C0
  for a pipe, so `echo ʼ; curl … ǀ sh; echo ʼ` would otherwise read as one quoted
  string. A path such as `café.md` is shown as `caf\u{e9}.md`.
- **The spelling is one-to-one.** A backslash that would itself read as the start
  of an escape is spelled `\u{5c}`, so a real newline (`\u{a}`) and the six
  characters `\u{a}` (`\u{5c}u{a}`) never look the same. Two different texts
  never have the same preview.
- The lines that say what is acted on (command, working directory, path, method
  and URL, query) are always complete. A command cannot add a line. On those
  lines a space at either end, and every space after the first in a run, is
  spelled `\u{20}`, so padding cannot push the rest of a line out of sight.
- File content and request bodies follow, each line with a mark (`+ `, `- `,
  `> `), so content cannot pass for one of the lines above. The whole preview is
  at most 16 KiB. The blocks of an edit share the room evenly, so a long removal
  cannot hide what is written. A block that does not fit is cut, inside a line if
  need be; then `truncated` is true and a line starting with `...`, which no other
  line can, says how many bytes of that block are not shown.

A card that shows this text raw is safe. A card may show a friendlier rendering
beside it, and must not show one instead of it.

## Selectors

A selector scopes a standing grant, and later a policy rule, to some calls of
**one tool**. `selectorMatches(tool, selector, call)` never covers a call of
another tool: leave to read a directory is not leave to write it.

| Selector | Matches | Never matches |
| --- | --- | --- |
| `exact` | A call with the same argument digest: this tool, catalog version and arguments again and, for an edit, the same file version | Any other argument, default, path spelling that names another file, or file version |
| `command_prefix` | A simple command whose words begin with the selector's words. A longer command matches too. The working directory is not bound. | A command that is not simple (see below); a command whose words differ in spelling or case |
| `path_prefix` | The path itself or a path below it, by whole segments | `src/application` for `src/app`; a path that normalizes elsewhere, such as `src/app/../x`; a command or URL that names the path |
| `host` | `GET` or `HEAD` over **https on port 443** to a host the pattern matches | Any other method, scheme or port; a host that merely contains or ends with the name; an address for a wildcard |
| `tool` | Every call of the tool | |

### Commands

`simpleCommand` returns the words of a command, or nothing. A word may hold only
ASCII letters, digits and `_ @ % + = : , . / -`, and words are separated by spaces.
Nothing else is accepted, so none of these can appear: quotes, a backslash, `$`,
backquotes, `* ? [ ] { } ~ !`, `#`, `^`, `; & | < > ( )`, a tab, a newline, a
control character, or any character outside ASCII, including spaces and letters
that only look like ASCII. At most 64 words. Three more forms are refused because
some shell reads them as something other than a plain word:

- A first word that holds `=`. It is an assignment, not a program: `A=1 cmd`,
  `A+=1 cmd`, and in zsh `1=2 cmd`, which assigns a positional parameter and then
  runs `cmd`. A card for the no-op `1=2` would otherwise offer a prefix that covers
  every command.
- A first word that starts with `-` or `+`. `sh -c` reads it as shell options.
- A word that starts with `=`, or holds `==` or `:=`. zsh replaces `=name` with the
  path of a command at the start of a word and in the value of an assignment
  argument (`export a==ls`). This also refuses `pip install pkg==1.2.3`, which
  therefore gets a card each time.

A command that is not simple gets **no** prefix selector and matches none. It
always needs a card. sh, dash, bash and zsh, run with no startup files and default
options, read a simple command as exactly its words. A test runs generated simple
commands through dash and bash, and through zsh where it is installed, and
compares the words the program receives. That is evidence, not a proof for every
shell and option.

What a prefix does not say:

- It does not end the command. `rm -rf build` as a prefix also covers
  `rm -rf build dist`.
- It does not say which program runs. The first word can be a shell keyword or a
  builtin such as `time`, `exec` or `eval`, or a wrapper such as `env`, `nohup` or
  `xargs`. A prefix that ends at such a word covers every program.
- It does not bind the working directory. A prefix `./build.sh` covers a
  `build.sh` in any directory of the workspace, including one the member wrote.

### Paths

`workspacePath` normalizes a path relative to the workspace root, lexically. It
drops `.` and empty segments, and `..` removes the segment before it. It refuses:

- a path that climbs above the root by any route (`..`, `a/../..`);
- an absolute path, and a path whose first segment starts with `~` once it is
  normalized (`~/x`, and also `./~/x` and `a/../~x`);
- a backslash, which is a separator to some tools and not to others;
- control characters, format characters (bidirectional overrides, zero-width
  characters, a soft hyphen), characters that render as nothing (the Hangul
  fillers, variation selectors) and line or paragraph separators;
- text that is not well-formed, a path over 512 bytes, a segment over 255 bytes.

The result is what the selector matches and what the executor must open, so
`a/../b` can only mean `b`, and normalizing a result again returns it unchanged.
Names are compared byte for byte: no case folding and no Unicode normalization, so
two spellings of one visible name are two names. A character that only looks like
a slash or a dot is part of a name. A name may start with `-`.

**Nothing here can see a symbolic link.** A link inside the workspace that points
outside it is invisible to a lexical check. The executor must resolve every path
beneath the workspace root and refuse one that leaves it.

### Hosts

`canonicalHost` and `fetchTarget` in `src/service/hosts.ts` read a host the way
the request will be made, using the WHATWG URL parser, and refuse what they cannot
put in one form.

- Case, IDNA and a trailing dot are folded: `EXAMPLE.com.` is `example.com`, and
  `bücher.example` is `xn--bcher-kva.example`. Characters that IDNA maps or drops
  (full-width letters, a zero-width space) name the host they map to.
- Every spelling of an IPv4 address is one host: `127.1`, `0x7f000001` and
  `2130706433` are `127.0.0.1`. An IPv6 address keeps its brackets. An IPv4-mapped
  IPv6 address is another host than the IPv4 address.
- A host must be a strict DNS name (letters, digits and inner hyphens, labels of 1
  to 63, at most 253 in all) or an address. An underscore is refused.
- A URL is refused when it has userinfo (`https://example.com@evil.test/` would
  read as `example.com`), an escape or an `@` in the authority, no `//` or an empty
  authority, a scheme other than http or https, port 0, whitespace, a control
  character or a backslash.
- The port is the explicit port or the scheme's default. The fragment is dropped.

A pattern `example.com` matches that host only. `*.example.com` matches every name
below `example.com` at any depth and never `example.com` itself, a name that only
ends with those letters (`badexample.com`), or an address. The wildcard needs a
base of at least two labels. No public-suffix list is consulted, so `*.co.uk` is
accepted.

A `host` selector covers reads only. A grant made from a `GET` therefore never
covers a `POST` to the same host. An effect through `web_fetch` offers no standing
selector in this version.

## The tool-call ledger

`tool_calls` (migration 33) has one row for each call the gate decided. Its
arguments and result are private: they are never audited, published or logged.

### Verdict

| Verdict | Decided by | Starts in phase |
| --- | --- | --- |
| `allow` | `default` (reads only), or `grant` with the grant's id | `ready` |
| `ask` | `default` | `waiting` |
| `deny` | `capability`, `budget` or `credential_scan` | `refused` |

Nothing allows an effect by default. The store refuses it and so does a CHECK. The
verdict is fixed by the first record of an identity, as a standing grant's decision
is: a retry reads the stored call back whatever verdict it brings.

An `ask` is recorded and stays `waiting`. The card and the owner's answer belong to
the gate, which is not built. Until then only an allowed call can be admitted.

### Phases

```
waiting                                  (ask; nothing leaves it yet)
ready ──► admitted ──► completed         (a result)
              ├──────► failed            (a failure code)
              └──────► uncertain         (effects only)
ready ──────────────► uncertain          (effects only, when a restored installation resumes)
refused                                  (deny; an outcome from the start)
```

`completed`, `failed`, `uncertain` and `refused` are outcomes. An outcome is
delivered to the model once, and a delivered call never changes again.

### Operations

`ToolCallStore` in `src/service/tool-calls.ts` is the only writer. A call's
identity is the owner, member, conversation, request, invocation and the engine's
call id, as for `deferred_calls`.

| Operation | Does | Repeating it |
| --- | --- | --- |
| `record(key, call, verdict)` | Classifies the call again and stores what the catalog says it is, with its verdict. A call that claims another kind, scope, digest or catalog version than its arguments give is `conflict`, and so is a grant that is not this member's | Returns the stored call. Another tool or digest under the same identity is `conflict`. |
| `admit(key, executionId)` | `ready` to `admitted`, held by this execution. Returns `run: true` | The same execution gets `run: true` again. Another execution gets `run: true` for a read, which it takes over, and `run: false` for an effect. |
| `complete(key, executionId, result)` | Stores the result, a JSON object of at most 65,536 bytes | The same execution with the same result reads it back. Another result is `conflict`. Another execution is `stale`. |
| `fail(key, executionId, code)` | Stores a failure code such as `timeout` | As `complete`. |
| `classifyLost(key)` | Says what to do after the worker was lost | The same answer. |
| `deliver(key)` | Marks the outcome delivered | Returns the delivered call. A call without an outcome is `conflict`. |

`toolCallKey(record)` gives a record's key for the next operation. `recordLocked`
is `record` inside the caller's transaction, which must be `READ COMMITTED`, as
every Crew transaction is.

An admitted call names its execution, a UUID the executor chooses. Only that
execution can finish the call. This is what makes a retried `admit` safe: an
execution that asks again is told to run, and any other execution is told not to
run an effect, because that effect may already have happened. **The execution id
must be made fresh for each attempt, in memory, and never kept across a restart.**
An id that a retried activity or a restarted process could present again, such as
one derived from a workflow run and activity id, would be told to run an admitted
effect a second time.

A result must be text PostgreSQL can store: a string or key with a NUL or an
unpaired surrogate is refused before it is sent. An executor must turn output that
is not text, such as the bytes of a binary file, into text first. A result over the
limit, including one that is small as JSON and large as PostgreSQL prints it, is
`input_limit`, and the call stays `admitted`.

A database error that leaves the store has had the fields that quote the failing
row or parameter removed, because they hold arguments and results.

### After a worker is lost

| The call is | `classifyLost` answers | Why |
| --- | --- | --- |
| `completed`, `failed`, `uncertain` or `refused`, not delivered | `deliver` | The outcome is stored. Give it to the model. |
| `admitted`, a read | `rerun` | Running a read again is safe. The next `admit` takes it over and the lost execution becomes `stale`. |
| `admitted`, an effect | `deliver`, after making it `uncertain` | It may or may not have happened. It is never run again. |
| `ready` | `start` | Nothing ran. |
| `waiting` | `wait` | Nobody has answered. |
| delivered | `done` | |

Call `classifyLost` only when the worker is known to be gone. An admitted effect
becomes `uncertain` there and then, and a completion that arrives afterwards from
its execution is refused as `stale`: the ledger keeps `uncertain`.

### What the database enforces

A row trigger and CHECK constraints hold these whoever writes:

- A row is bound to a conversation of its own owner and member, to a turn of that
  conversation, and to a grant only of that owner and member (and that
  conversation, for a conversation grant).
- A call starts `ready`, `waiting` or `refused`, as its verdict says, and nowhere
  later.
- Identity, tool, kind, scope, arguments, digest and verdict never change.
- The phase moves only along the arrows above. Only a read can be taken over. A
  read is never `uncertain`.
- A result exists exactly when the call is `completed`, a failure code when
  `failed`, a reason when `uncertain`.
- Only an outcome is delivered, on its own, once.
- A request holds at most 256 calls. An advisory lock serializes the count.
- No row is deleted, and the table is not truncated.

### Recovery

Both new tables carry the `recovery_write_barrier` trigger, and the recovery
manifest counts their rows. A held installation refuses every ledger write and
every spawn with capabilities.

A member's capabilities are fixed at spawn and nothing revokes them, so a restore
has nothing to settle for them.

A restore rewinds the ledger to its recovery point. An effect that was allowed
there but not finished may have run afterwards, on the timeline the restore
discards. So when a restored installation resumes, **every effect that is `ready`
or `admitted` becomes `uncertain`** with reason `recovery_restore`, in the
transaction that activates the installation. It is never run. The model is given
the uncertainty, and a new call goes through the gate again; the grant that allowed
the old one was revoked by the same restore. Reads are left to run again, outcomes
are left to be delivered, and an `ask` stays `waiting`. A held source that resumes
without a restore keeps its calls as they were; calls that were `admitted` when its
workers were stopped are classified as after any lost worker.

## Upgrade

Migration 32 takes `ACCESS EXCLUSIVE` on `profiles` (a nullable column and a
`NOT VALID` CHECK: no rewrite, no scan) and `SHARE ROW EXCLUSIVE` on `members`.
Migration 33 takes `SHARE ROW EXCLUSIVE` on `members`, `turns` and `tool_grants`
for its foreign keys and alters no table. Both take their locks together with
`NOWAIT` and retry for up to 60 seconds, as migrations 25 and 26 do, so neither
waits in a lock queue. A running native turn holds no conflicting lock. The
member's set is a table of its own because a column on `members` would need
`ACCESS EXCLUSIVE` there and wait for every running turn.

The two usually apply in one transaction. Migration 32 therefore takes migration
33's locks with its own, so that 33 never retries while 32 holds `profiles`
exclusively. While that lock is held, spawns, profile registrations and anything
else that reads `profiles` wait until `migrate()` commits. Applied after other
pending migrations in one transaction, 32 retries while it holds their locks, as
migration 26 describes for 25. If the locks cannot be had within 60 seconds,
`migrate()` fails with `55P03` and applies nothing.

Stop every process of the previous release first, as for the earlier migrations. A
worker of the previous release registers profiles without the ceiling column and
would accept a registration this release made with one.

A database from before migration 32 upgrades with no capabilities anywhere. Its
members replay their spawn requests unchanged.

## Not built

- **No engine offers or runs any tool in the catalog.** Nothing calls `classify`,
  `ToolCallStore` or `capabilityPermits` outside tests.
- The gate: capability check, budgets, credential scan, standing grants for these
  tools, the default verdict. `tool_grants` still covers `record_work_item` only.
  The ledger checks that a grant a verdict names belongs to the member, and
  nothing more.
- Cards for these tools, the owner's answer to an `ask`, and expiry. A `waiting`
  call has no way forward.
- Audit event types for tool calls. The ledger writes no audit row. The slice that
  adds the gate must append one when it marks an effect `uncertain`.
- The executor, the workspace, the sandbox, the egress proxy, and any limit on
  shell seconds or fetched bytes.
- Policy rules, the browser, MCP connectors, delegation and skills.
- A bound on how often a read is run again. The workflow that calls `classifyLost`
  must bound it.
- Erasure of stored arguments and results. They stay with the row.

## What later work must hold to

The executor:

- Run the normalized arguments from the ledger, after `verifyStored`. Never the
  model's original text.
- Open every path beneath the workspace root and refuse a symbolic link that
  leaves it. The catalog's path checks are lexical.
- Pass every path and query to a program after `--` or as the value of an option.
  A path may start with `-`, and a search tool would read `--pre=./x` as an
  option. Such a call is a read.
- Run shell commands as `sh -c -- "$command"` with one fixed shell, no startup
  files, no aliases, default options, and a fixed `IFS` and `PATH`.
- Compute `priorSha256` from the file. Never take it from the model, and compare
  it again just before writing. Otherwise an `exact` grant made against one
  version of a file covers every version.
- Send a `web_fetch` to the canonical URL. Check the address the name resolves to,
  treating `0.0.0.0` as local, and resolve the name as fully qualified: the
  catalog drops a trailing dot and never resolves a name.
- Do not follow a redirect without checking the new URL as a new call. A `GET` to
  an allowed host that redirects elsewhere would otherwise pass both the
  capability check and a `host` selector.

The gate:

- Decide what a capability host pattern covers. Today `webFetch.hosts` names hosts
  only, so a listed host is reachable on every scheme and port, and a `GET` there
  is a read, which the design allows without a card. Either a pattern should mean
  https on port 443 unless it says otherwise, or no fetch should be allowed by
  default.
- Before it offers `shell_run`, check again that the member's set is within its
  registration's ceiling and that the running process holds a relay credential.
  The database keeps a ceiling from changing, but it cannot see the credential.
- Do not offer a `command_prefix` that ends at a wrapper or a shell keyword, or
  say plainly on the card that it covers every program.
- Decide whether a path inside the workspace needs protecting. A `path_prefix`
  selector does not treat `.git`, `.github/workflows` or `.husky` specially, and
  anything outside the sandbox that later runs what a member wrote there would
  trust it. One approved write to such a directory offers a selector for all of it.
- Decide what a restore does with a `waiting` call before a card can be answered.
  Its owner may have answered it on the discarded timeline.
- Fail closed when Claude ignores a deferral (see the next section).

## SDK assumptions

The design listed assumptions about the engine SDKs "to be tested, not trusted".
They were read in the installed packages inside the Linux container: Claude Agent
SDK 0.3.306 (bundled Claude Code 2.1.306), `@openai/codex` and `@openai/codex-sdk`
0.167.1, `@earendil-works/pi-coding-agent` and `pi-agent-core` 1.5.2, and the
vendored AG-UI adapters. Paths are below `node_modules/`. The Claude and Codex
binaries have no line numbers, so their strings are quoted. Nothing in this slice
depends on these answers.

| Assumption | Answer | Read at | Still open |
| --- | --- | --- | --- |
| Claude's PreToolUse hook fires for MCP tools | **Confirmed** by the types and by the vendored adapter, which depends on it | `@anthropic-ai/claude-agent-sdk/sdk.d.ts:2792` (`mcp_server` on the hook input), `:1251` (it names `sdk`, an in-process server), `:4856` (`mcp__server__tool_name`); `@ag-ui/claude-agent-sdk/dist/index.mjs:1722` returns `permissionDecision: "defer"` for its in-process `mcp__ag_ui__` tools | Not run on 0.3.306: the adapter's README (`:125`) names 0.3.296 as its tested baseline |
| The hook can defer one call and not another | **Confirmed** by the types: the hook is called for each call and may answer `defer` | `sdk.d.ts:1001` (`HookPermissionDecision = 'allow' \| 'deny' \| 'ask' \| 'defer'`), `:2797`, `:6050` (`deferred_tool_use` on the result) | The Claude binary holds `returned permissionDecision=defer in interactive mode; ignoring (defer is print-mode only)`. Whether an SDK `query()` counts as print mode is **unknown**: run one with a hook that defers and check for `stop_reason: "tool_deferred"` |
| Several calls in one batch can be denied while one is deferred | **Refuted** | The Claude binary (`@anthropic-ai/claude-agent-sdk-linux-arm64/claude`) holds `returned permissionDecision=defer but ... tool calls are in this batch; ignoring (defer is solo-only — siblings would be orphaned on resume)`. The count is of the `tool_use` blocks in the assistant message, so denying the siblings does not help. `@ag-ui/claude-agent-sdk/README.md:142`: "Durable deferral supports **one tool call at a time**, not parallel calls." | What the ignored deferral falls through to. The handler of a gated tool must refuse to run when no decision reached it |
| A deferred call of an in-process SDK MCP tool can be resumed | **Refuted** | The binary holds `tool_deferred_unavailable`; `@ag-ui/claude-agent-sdk/dist/index.mjs:2309` throws "This SDK cannot restore a deferred in-process MCP tool before startup"; `README.md:141`: such servers "register too late for replay" | This is why the design uses a loopback MCP server for Claude |
| The Codex app-server can hold a dynamic tool call | **Confirmed** for the protocol: `item/tool/call` is a request with an id that the client answers. It is experimental and is not reachable through `@openai/codex-sdk` | Types generated from the installed binary with `codex app-server generate-ts --experimental`: `ServerRequest.ts`, `v2/DynamicToolCallParams.ts`, `v2/ThreadStartParams.ts` (`dynamicTools`). `@openai/codex-sdk/dist/index.js:178` runs `exec --experimental-json`, and the binary holds `dynamic tool calls are not supported in exec mode`. Crew's trusted lane already uses the app-server: `src/service/trusted-codex.ts:134-136` | |
| The Codex app-server has no timeout shorter than Crew's | **Unknown** | No timeout field is on any dynamic tool type, and the binary holds only `dynamic tool call was cancelled before receiving a response`; a duration constant would not show as text. Crew waits 45 s for a live approval (`src/service/codex-live.ts:35`) and lets a live call last at most 170 s (`src/service/codex-calls.ts:59`) | Hold an `item/tool/call` for 46 s, 151 s and 171 s against a local fake provider and watch the turn. No test in the repository holds one that long |
| Pi has no blocking hook for built-in tools | **Refuted**: Pi has one | `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:999` ("Fired before a tool executes. Can block."), `:1109` (`ToolCallEventResult` with `block`), `:1266` (`on("tool_call", ...)`); `docs/extensions.md:975`, `:3253` ("`tool_call` errors block the tool (fail-safe)"); `@earendil-works/pi-agent-core/dist/types.d.ts:279` (`beforeToolCall`) | Whether a handler that waits for minutes is cut off |
| Landlock does not restrict UDP | **Confirmed** for the launcher and for one kernel | `native/member-launch.c:82` handles network rights `3` (TCP bind and connect) for Codex and none for Claude; its seccomp filter refuses only `setsid` and `setpgid`. A probe on Linux 6.8.0 (Landlock ABI 4) with those rights handled and no rule: TCP connect failed with `EACCES`; UDP bind, send, receive and connect succeeded | Other kernels. The executor's sandbox must refuse UDP itself, as the design says |

The vendored adapters do not hide these seams. `@ag-ui/claude-agent-sdk` passes the
host's `hooks`, `canUseTool`, `mcpServers` and tool lists through and adds its own
PreToolUse hook; its README (`:123`) warns against a second unconditional deferral
hook for the same call. `@ag-ui/pi` only translates events (`README.md:67`): the
host creates the Pi session and owns its tools.

Three answers change the design's reasons, not its direction:

- Pi can intercept its built-in tools, so "interception is confirmed only for
  Claude" no longer holds. Pi's built-ins would still run unsandboxed in the
  runner process.
- Claude defers only a call that is alone in its message. A model that asks for
  two gated tools at once cannot be paused durably.
- A dynamic tool call needs the Codex app-server, not the SDK that members use
  today.

## Validation

Use Node 22.23.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases. `npm run test:recovery` also needs PostgreSQL 17 `pg_dump` and
`pg_restore` (`BIRBCREW_PG_BIN`).

```sh
npm ci
npm run typecheck
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:capabilities
npm run test:recovery
npm run test:api && npm run test:audit && npm run test:memories
```

`npm run test:capabilities` runs four files against real PostgreSQL:

- `hosts.test.ts`: canonical hosts, patterns, and URLs with userinfo, missing
  slashes, other schemes and stripped characters.
- `capabilities.test.ts`: the schema and its illegal states, the subset check
  against an independent reading of 50 sets, the digest, spawn through the HTTP
  gateway (unchanged for a client that names none, within, above, invalid, empty,
  retried, raced), the database's own refusals including a registration that
  cannot be deleted or renamed, registration and the relay rule, migration 32 on a
  version-26 database with a running native turn, and capture, hold and restore.
- `tool-catalog.test.ts`: the command splitter against every ASCII character
  outside its alphabet and a list of shell constructs, generated simple commands
  run through the installed shells, path traversal and invisible characters with
  idempotence over every path of a small grammar, each tool's classification, the
  digest, each selector including what it must not match, that every offered
  selector can be stored and covers its call, and the preview: ASCII only,
  one-to-one, and complete where it must be at its size limits.
- `tool-calls.test.ts`: every operation and its retry, a call that claims a kind
  or scope it does not have, results PostgreSQL cannot store, the answers after a
  lost worker, owner isolation, about a hundred illegal updates written directly
  in SQL, the 256-call limit under a race, migration 33 with a running native
  turn, and a held, resumed and restored installation.

`recovery.test.ts` restores a real `pg_dump` archive holding member capabilities
and ledger rows, completes an effect on the source after the recovery point, and
checks that the resumed target marks it `uncertain` and refuses to run it.

Not run for this change: the service proofs (`scripts/verify-members`,
`tests/proof/*.mts`), which need Temporal, Docker and Landlock together. This
change adds no workflow or native launch behaviour. The Temporal workflow bundle
was built without a server and contains none of the new modules.
