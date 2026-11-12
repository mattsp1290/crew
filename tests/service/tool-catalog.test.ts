import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { capabilitySchema, type CapabilityInput } from "../../src/service/capabilities.ts";
import { canonical } from "../../src/service/canonical-json.ts";
import { hostPattern } from "../../src/service/hosts.ts";
import { capabilityPermits, catalogLimits, catalogVersion, classify, pathWithin, selectorMatches, selectorSchema, simpleCommand,
  ToolArgumentError, toolNames, toolsFor, workspacePath, type Classified, type Selector, type ToolCall, type ToolName } from "../../src/service/tool-catalog.ts";

const prior = "a".repeat(64);
const at = (text: string) => { const value = workspacePath(text); assert.notEqual(value, null, text); return value!; };
const shell = (command: string, more: Record<string, unknown> = {}) => classify({ tool: "shell_run", arguments: { command, ...more } });
const fetching = (url: string, more: Record<string, unknown> = {}) => classify({ tool: "web_fetch", arguments: { url, ...more } });
const refused = (call: ToolCall) => assert.throws(() => classify(call), ToolArgumentError, JSON.stringify(call).slice(0, 200));
/** Whether a selector held for the call's own tool, unless another is named, covers the call. */
const covers = (selector: Selector, call: Classified, tool: ToolName = call.tool) => selectorMatches(tool, selector, call);

test("a command is split only when it is plain words; anything a shell would interpret yields no words", () => {
  for (const [command, words] of [
    ["ls", ["ls"]], ["git status", ["git", "status"]], ["  npm   test  ", ["npm", "test"]],
    ["node --max-old-space-size=4096 build.js", ["node", "--max-old-space-size=4096", "build.js"]],
    ["python3 -m pytest tests/unit/test_a.py::TestA::test_b", ["python3", "-m", "pytest", "tests/unit/test_a.py::TestA::test_b"]],
    ["make -j4 CFLAGS=-O2", ["make", "-j4", "CFLAGS=-O2"]], ["date +%s", ["date", "+%s"]], ["npm i pkg@1.2.3", ["npm", "i", "pkg@1.2.3"]],
    ["./scripts/build.sh a,b", ["./scripts/build.sh", "a,b"]], ["1=2 x", ["1=2", "x"]],
  ] as const) assert.deepEqual(simpleCommand(command), words, command);

  // Every ASCII character outside the word alphabet, wherever it appears.
  const allowed = /[A-Za-z0-9_@%+=:,.\/ -]/;
  for (let code = 0; code < 128; code++) {
    const character = String.fromCharCode(code);
    if (allowed.test(character)) continue;
    for (const command of [`echo a${character}b`, `${character}echo`, `echo ${character}`, `echo${character}`]) {
      assert.equal(simpleCommand(command), null, JSON.stringify(command));
    }
  }
  for (const command of [
    "ls; rm -rf /", "ls;rm", "ls && rm -rf /", "ls || rm", "ls | sh", "ls & rm", "ls > /etc/passwd", "ls >> x", "cat < x", "cat <<EOF", "ls 2>&1",
    "echo $(id)", "echo `id`", "echo $HOME", "echo ${HOME}", "echo $((1+1))", "cat <(id)", "ls *", "ls ?", "ls [a-z]", "echo {a,b}", "echo {1..3}",
    "ls ~", "ls ~root", "cd ~/x", "echo 'a b'", 'echo "a b"', "echo a\\ b", "echo \\$HOME", "ls\nrm -rf /", "ls\r\nrm", "ls\rrm", "ls\trm", "ls\vrm", "ls\frm",
    "ls #comment", "!!", "echo !$", "echo a^b", "^ls^rm", "ls\0", "ls\u007f",
    // An assignment before the command is not an argument, and zsh expands a word that starts with =.
    "FOO=bar ls", "FOO= ls", "_x=1 ls", "PATH=. ls", "LD_PRELOAD=./x.so ls", "FOO=bar", "a=b c=d ls", "PATH+=:. ls", "FOO+=bar ls",
    "ls =cat", "=ls", "ls -la =(id)",
    // Whitespace and letters that only look like ASCII.
    "ls\u00a0-la", "ls\u3000-la", "ls\u2003-la", "ls\u200b", "ls\u2028rm", "ls\u0085rm", "ｌｓ", "l\u0455", "echo \u202egnp.exe", "echo caf\u00e9",
    "", " ", "    ", "a".repeat(catalogLimits.commandBytes + 1), Array.from({ length: catalogLimits.commandWords + 1 }, () => "a").join(" "),
  ]) assert.equal(simpleCommand(command), null, JSON.stringify(command));
  for (const input of [null, undefined, 7, ["ls"], { command: "ls" }]) assert.equal(simpleCommand(input as never), null);
  assert.deepEqual(simpleCommand(Array.from({ length: catalogLimits.commandWords }, () => "a").join(" "))?.length, catalogLimits.commandWords);
});

test("a command prefix matches simple commands that begin with its words and nothing a shell would read differently", () => {
  const status: Selector = { kind: "command_prefix", argv: ["git", "status"] };
  for (const command of ["git status", "git status --short", "git  status   -sb", " git status "]) {
    assert.equal(covers(status, shell(command)), true, command);
  }
  for (const command of [
    "git", "git log", "git statusx", "git status-all", "gitx status", "GIT status", "git Status", "git stat us", "status git", "git -C /tmp status",
    "git status; rm -rf /", "git status;rm -rf /", "git status && rm -rf /", "git status || true", "git status | sh", "git status > x",
    "git status\nrm -rf /", "git status\r\nrm", "git status\trm", "git status $(rm -rf /)", "git status `id`", "git status $HOME", "git status *",
    "git 'status'", 'git "status"', "git st\\atus", "g\\it status", "git status #", "git status ~", "git status {a,b}",
    "env git status", "sudo git status", "FOO=1 git status", "PATH=. git status", "command git status", "git status\u00a0--short", "git\u00a0status",
    "git statu\u0455", "ｇｉｔ status",
  ]) assert.equal(covers(status, shell(command)), false, JSON.stringify(command));
  // The prefix is words, not characters, and it does not end the command: longer commands match.
  const remove: Selector = { kind: "command_prefix", argv: ["rm", "-rf", "build"] };
  assert.equal(covers(remove, shell("rm -rf build")), true);
  assert.equal(covers(remove, shell("rm -rf build dist")), true, "a prefix covers the same words followed by more");
  assert.equal(covers(remove, shell("rm -rf build", { cwd: "packages/a" })), true, "and it does not bind the working directory");
  for (const command of ["rm -rf builds", "rm -rf build/", "rm -rf", "rm -r -f build", "rm -rf ./build", "rm  -rf build; ls"]) {
    assert.equal(covers(remove, shell(command)), false, command);
  }
  assert.equal(covers({ kind: "command_prefix", argv: [] }, shell("ls")), false, "an empty prefix covers nothing");
  assert.equal(covers(status, classify({ tool: "fs_read", arguments: { path: "git/status" } })), false);
  assert.equal(covers(status, fetching("https://git.example/status")), false);
});

test("a workspace path normalizes to one form and never leaves the workspace", () => {
  for (const [input, expected] of [
    ["src/app.ts", "src/app.ts"], ["./src//app.ts", "src/app.ts"], ["src/./a/../b", "src/b"], ["a/b/..", "a"], ["a/..", ""], ["", ""], [".", ""], ["./", ""],
    ["src/", "src"], ["src///", "src"], ["a/b/../../c", "c"], ["a/./././b", "a/b"],
    ["r\u00e9sum\u00e9.md", "r\u00e9sum\u00e9.md"], ["\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.txt", "\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.txt"],
    ["my file.txt", "my file.txt"], [".hidden", ".hidden"], ["...", "..."], ["a..b", "a..b"], ["..a/b..", "..a/b.."], ["a/.../b", "a/.../b"],
    ["-rf", "-rf"], ["a:b", "a:b"], ["$HOME/x", "$HOME/x"], ["a*b", "a*b"],
  ]) assert.equal(workspacePath(input), expected, JSON.stringify(input));
  for (const input of [
    // Above the root, by any route.
    "..", "../x", "./..", "a/../..", "a/../../x", "a/b/../../../x", "a/./../../x", "../../../../etc/passwd", "src/../../etc/passwd", "a/..//../x",
    // Not relative to the workspace.
    "/", "/etc/passwd", "//x", "/workspace/src", "/proc/self/root/etc/passwd", "~", "~/x", "~root/x", "~/.ssh/id_rsa",
    // A second kind of separator, and characters a reader cannot see or that reorder what is shown.
    "a\\b", "..\\x", "a\\..\\..\\x", "C:\\x", "a\0b", "a\0", "a\nb", "a\rb", "a\tb", "a\u001bb", "a\u007fb", "a\u0085b", "a\u200bb", "a\u200db", "a\u202eb",
    "\u2066a", "a\u2028b", "a\u2029b", "a\ufeffb", "a\u00adb", "a\u061cb", "a\ud800", "\udc00a",
    "a".repeat(catalogLimits.pathBytes + 1), "a".repeat(catalogLimits.segmentBytes + 1), "x/" + "\u00e9".repeat(128),
    Array.from({ length: 200 }, () => "ab").join("/"),
  ]) assert.equal(workspacePath(input), null, JSON.stringify(input));
  for (const input of [null, undefined, 7, ["a"], { path: "a" }]) assert.equal(workspacePath(input as never), null);
  assert.equal(workspacePath("a".repeat(catalogLimits.segmentBytes)), "a".repeat(catalogLimits.segmentBytes));
  // Normalizing is idempotent.
  for (const input of ["./src//app.ts", "a/b/../../c", "src/", ""]) assert.equal(workspacePath(at(input)), at(input));
  // Characters that only look like a slash or a dot are part of a name, never a separator or a step up.
  assert.equal(workspacePath("a\u2215b"), "a\u2215b");
  assert.equal(workspacePath("\uff0e\uff0e/x"), "\uff0e\uff0e/x");
  assert.equal(workspacePath("a/\u2025/b"), "a/\u2025/b");
});

test("a path prefix covers its own path and what lies below it, by whole segments", () => {
  const prefix = at("src/app");
  for (const path of ["src/app", "src/app/main.ts", "src/app/a/b/c", "src/app/./x", "src//app/x", "src/app/x/../y", "./src/app/"]) {
    assert.equal(pathWithin(prefix, at(path)), true, path);
  }
  for (const path of ["src/application", "src/app.ts", "src/app2/x", "src/ap", "src", "", "srcx/app", "other/src/app", "SRC/app/x", "src/App/x",
    // Each of these normalizes to a path outside the prefix before it is compared.
    "src/app/../x", "src/app/../../etc/passwd", "src/app/../app2/x", "src/app/..", "src/app/x/../../y",
    "src/app\u2215x", "src/app\uff0fx", "src\u2215app/x"]) {
    assert.equal(pathWithin(prefix, at(path)), false, path);
  }
  // No Unicode normalization: two spellings of one visible name are two names.
  assert.equal(pathWithin(at("caf\u00e9"), at("cafe\u0301/x")), false);
  assert.equal(pathWithin(at("caf\u00e9"), at("caf\u00e9/x")), true);
  // The root covers the workspace, and only the root does.
  for (const path of ["", "a", "a/b"]) assert.equal(pathWithin(at(""), at(path)), true);
  const selector: Selector = { kind: "path_prefix", prefix };
  assert.equal(covers(selector, classify({ tool: "fs_write", arguments: { path: "src/app/a.ts", content: "" } })), true);
  assert.equal(covers(selector, classify({ tool: "fs_write", arguments: { path: "src/app/../../.git/config", content: "" } })), false);
  assert.equal(covers(selector, classify({ tool: "fs_list", arguments: { path: "src" } })), false);
  assert.equal(covers(selector, shell("cat src/app/a.ts")), false, "a path selector never covers a command");
  assert.equal(covers(selector, fetching("https://example.com/src/app/a.ts")), false);
});

test("each tool classifies as a read or an effect from its arguments, with a scope and normalized arguments", () => {
  const read = classify({ tool: "fs_read", arguments: { path: "./src//a/../main.ts" } });
  assert.deepEqual([read.tool, read.catalogVersion, read.kind, read.scope, read.arguments, read.selector, read.preview],
    ["fs_read", 1, "read", { kind: "path", path: "src/main.ts" }, { path: "src/main.ts", startLine: 1, lineCount: 2000 },
      { kind: "path_prefix", prefix: "src" }, { summary: "Read a file", text: "path: src/main.ts\nlines: 2000 from line 1", truncated: false }]);
  assert.deepEqual(classify({ tool: "fs_read", arguments: { path: "README.md" } }).selector, { kind: "path_prefix", prefix: "README.md" });

  const list = classify({ tool: "fs_list", arguments: {} });
  assert.deepEqual([list.kind, list.scope, list.arguments, list.selector, list.preview.text],
    ["read", { kind: "path", path: "" }, { path: "", depth: 1 }, { kind: "tool" }, "path: .\ndepth: 1"]);
  assert.deepEqual(classify({ tool: "fs_list", arguments: { path: "src/", depth: 3 } }).selector, { kind: "path_prefix", prefix: "src" });

  const search = classify({ tool: "fs_search", arguments: { query: "TODO", path: "docs" } });
  assert.deepEqual([search.kind, search.scope, search.arguments, search.selector],
    ["read", { kind: "path", path: "docs" }, { path: "docs", query: "TODO" }, { kind: "path_prefix", prefix: "docs" }]);
  assert.deepEqual(classify({ tool: "fs_search", arguments: { query: "x" } }).selector, { kind: "tool" });

  const write = classify({ tool: "fs_write", arguments: { path: "src/app/main.ts", content: "a\nb" } });
  assert.deepEqual([write.kind, write.scope, write.arguments, write.selector, write.preview],
    ["effect", { kind: "path", path: "src/app/main.ts" }, { path: "src/app/main.ts", content: "a\nb" }, { kind: "path_prefix", prefix: "src/app" },
      { summary: "Write a file", text: "path: src/app/main.ts\nbytes: 3\n+ a\n+ b", truncated: false }]);
  assert.deepEqual(classify({ tool: "fs_write", arguments: { path: "notes.txt", content: "" } }).selector, { kind: "path_prefix", prefix: "notes.txt" },
    "a file in the root offers itself, never the whole workspace");

  const edit = classify({ tool: "fs_edit", arguments: { path: "src/a.ts", oldText: "let x", newText: "const x" }, priorSha256: prior });
  assert.deepEqual([edit.kind, edit.scope, edit.selector, edit.preview],
    ["effect", { kind: "path", path: "src/a.ts" }, { kind: "path_prefix", prefix: "src" },
      { summary: "Edit a file", text: `path: src/a.ts\nfile sha256: ${prior}\n- let x\n+ const x`, truncated: false }]);

  // A shell command is an effect whatever it says.
  for (const command of ["ls", "cat README.md", "true", "echo hi", "git status"]) assert.equal(shell(command).kind, "effect", command);
  const run = shell("npm  test", { cwd: "./packages/a/" });
  assert.deepEqual([run.scope, run.arguments, run.selector, run.preview],
    [{ kind: "command", cwd: "packages/a", argv: ["npm", "test"] }, { command: "npm  test", cwd: "packages/a", timeoutSeconds: 60 },
      { kind: "command_prefix", argv: ["npm", "test"] }, { summary: "Run a shell command", text: "command: npm  test\ncwd: packages/a\ntimeout: 60 s", truncated: false }]);
  const piped = shell("cat a | sh");
  assert.deepEqual([piped.kind, piped.scope, piped.selector], ["effect", { kind: "command", cwd: "", argv: null }, null],
    "a command that is not provably simple offers no standing selector");

  const get = fetching("HTTPS://Docs.Example.com:443/a?b#c");
  assert.deepEqual([get.kind, get.scope, get.arguments, get.selector, get.preview],
    ["read", { kind: "url", scheme: "https", host: "docs.example.com", port: 443, method: "GET" }, { url: "https://docs.example.com/a?b", method: "GET" },
      { kind: "host", pattern: "docs.example.com" }, { summary: "Fetch a URL", text: "GET https://docs.example.com/a?b", truncated: false }]);
  assert.equal(fetching("https://example.com/", { method: "HEAD" }).kind, "read");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const sent = fetching("https://example.com/items", { method });
    assert.deepEqual([sent.kind, sent.selector, sent.preview.summary], ["effect", null, "Send an HTTP request"], method);
  }
  const post = fetching("https://example.com/items", { method: "POST", body: "{\"a\":1}\nsecond" });
  assert.deepEqual([post.arguments, post.preview.text],
    [{ url: "https://example.com/items", method: "POST", body: "{\"a\":1}\nsecond" }, "POST https://example.com/items\nbody bytes: 14\n> {\"a\":1}\n> second"]);
  // A host selector says https on 443, so a call on another scheme or port offers none.
  for (const url of ["http://example.com/", "https://example.com:8443/", "http://example.com:443/"]) assert.equal(fetching(url).selector, null, url);

  const web = classify({ tool: "web_search", arguments: { query: "landlock udp" } });
  assert.deepEqual([web.kind, web.scope, web.arguments, web.selector, web.preview.text],
    ["read", { kind: "search" }, { query: "landlock udp", maxResults: 10 }, { kind: "tool" }, "query: landlock udp\nresults: 10"]);
  assert.deepEqual(toolNames, ["fs_read", "fs_list", "fs_search", "fs_write", "fs_edit", "shell_run", "web_fetch", "web_search"]);
});

test("arguments the catalog does not accept are refused, and the refusal never repeats a value", () => {
  for (const call of [
    { tool: "fs_delete", arguments: { path: "a" } }, { tool: "record_work_item", arguments: {} }, { tool: "__proto__", arguments: {} },
    { tool: "toString", arguments: {} }, { tool: "", arguments: {} },
    { tool: "fs_read", arguments: null }, { tool: "fs_read", arguments: "a" }, { tool: "fs_read", arguments: [] }, { tool: "fs_read", arguments: {} },
    { tool: "fs_read", arguments: { path: "a", mode: "raw" } }, { tool: "fs_read", arguments: { path: 7 } }, { tool: "fs_read", arguments: { path: "" } },
    { tool: "fs_read", arguments: { path: "." } }, { tool: "fs_read", arguments: { path: "a/.." } }, { tool: "fs_read", arguments: { path: "/etc/passwd" } },
    { tool: "fs_read", arguments: { path: "../secret" } }, { tool: "fs_read", arguments: { path: "a/../../secret" } }, { tool: "fs_read", arguments: { path: "~/.ssh/id_rsa" } },
    { tool: "fs_read", arguments: { path: "a\\..\\b" } }, { tool: "fs_read", arguments: { path: "a\u202eb" } }, { tool: "fs_read", arguments: { path: "a", startLine: 0 } },
    { tool: "fs_read", arguments: { path: "a", lineCount: 10_001 } }, { tool: "fs_read", arguments: { path: "a", lineCount: 1.5 } },
    { tool: "fs_list", arguments: { path: "..", depth: 1 } }, { tool: "fs_list", arguments: { depth: 9 } }, { tool: "fs_list", arguments: { path: null } },
    { tool: "fs_search", arguments: {} }, { tool: "fs_search", arguments: { query: "" } }, { tool: "fs_search", arguments: { query: "a".repeat(catalogLimits.queryBytes + 1) } },
    { tool: "fs_search", arguments: { query: "a\0b" } }, { tool: "fs_search", arguments: { query: "a\ud800" } },
    { tool: "fs_write", arguments: { path: "a" } }, { tool: "fs_write", arguments: { path: "", content: "x" } }, { tool: "fs_write", arguments: { path: "/a", content: "x" } },
    { tool: "fs_write", arguments: { path: "a", content: "x".repeat(catalogLimits.contentBytes + 1) } }, { tool: "fs_write", arguments: { path: "a", content: "x\0" } },
    { tool: "fs_write", arguments: { path: "a", content: "x", mode: "0777" } }, { tool: "fs_write", arguments: { path: "a", content: ["x"] } },
    { tool: "fs_edit", arguments: { path: "a", oldText: "", newText: "x" }, priorSha256: prior }, { tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "x" }, priorSha256: prior },
    { tool: "fs_edit", arguments: { path: "a", oldText: "x" }, priorSha256: prior }, { tool: "fs_edit", arguments: { path: "../a", oldText: "x", newText: "y" }, priorSha256: prior },
    { tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" } }, { tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" }, priorSha256: "A".repeat(64) },
    { tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" }, priorSha256: "abc" }, { tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y", priorSha256: prior } },
    { tool: "shell_run", arguments: {} }, { tool: "shell_run", arguments: { command: "" } }, { tool: "shell_run", arguments: { command: ["ls"] } },
    { tool: "shell_run", arguments: { command: "ls", cwd: "/tmp" } }, { tool: "shell_run", arguments: { command: "ls", cwd: ".." } }, { tool: "shell_run", arguments: { command: "ls", cwd: "~" } },
    { tool: "shell_run", arguments: { command: "ls", env: { PATH: "." } } }, { tool: "shell_run", arguments: { command: "ls", timeoutSeconds: 0 } },
    { tool: "shell_run", arguments: { command: "ls", timeoutSeconds: 601 } }, { tool: "shell_run", arguments: { command: "x".repeat(catalogLimits.commandBytes + 1) } },
    { tool: "shell_run", arguments: { command: "ls\0" } }, { tool: "shell_run", arguments: { command: "ls", network: true } },
    { tool: "web_fetch", arguments: {} }, { tool: "web_fetch", arguments: { url: "example.com" } }, { tool: "web_fetch", arguments: { url: "https://example.com@evil.test/" } },
    { tool: "web_fetch", arguments: { url: "https://user:pass@example.com/" } }, { tool: "web_fetch", arguments: { url: "file:///etc/passwd" } },
    { tool: "web_fetch", arguments: { url: "https://example.com/", method: "get" } }, { tool: "web_fetch", arguments: { url: "https://example.com/", method: "CONNECT" } },
    { tool: "web_fetch", arguments: { url: "https://example.com/", method: "TRACE" } }, { tool: "web_fetch", arguments: { url: "https://example.com/", body: "x" } },
    { tool: "web_fetch", arguments: { url: "https://example.com/", method: "DELETE", body: "x" } }, { tool: "web_fetch", arguments: { url: "https://example.com/", headers: { Authorization: "x" } } },
    { tool: "web_fetch", arguments: { url: "https://example.com/", method: "POST", body: "x".repeat(catalogLimits.bodyBytes + 1) } },
    { tool: "web_search", arguments: {} }, { tool: "web_search", arguments: { query: "" } }, { tool: "web_search", arguments: { query: "x", maxResults: 21 } },
    { tool: "web_search", arguments: { query: "x", site: "example.com" } },
  ]) refused(call as ToolCall);

  const secret = "hunter2-" + "s".repeat(20);
  for (const call of [{ tool: "fs_write", arguments: { path: "../" + secret, content: secret } }, { tool: "shell_run", arguments: { command: secret, cwd: "/" + secret } },
    { tool: "web_fetch", arguments: { url: "https://" + secret + "@example.com/" } }, { tool: secret, arguments: {} }] as unknown as ToolCall[]) {
    assert.throws(() => classify(call), (error: unknown) => error instanceof ToolArgumentError && !error.message.includes(secret) && !("cause" in error));
  }
  assert.throws(() => classify({ tool: "fs_read", arguments: { path: "../x" } }), { message: "Invalid arguments for fs_read at path" });
});

// Compile-time only: an edit cannot be classified without the hash of the file it edits.
function typeChecks() {
  // @ts-expect-error fs_edit needs priorSha256
  classify({ tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" } });
  // @ts-expect-error a plain string is not a workspace path
  pathWithin("src", "src/a");
  // @ts-expect-error a selector's prefix is a workspace path, not any string
  const selector: Selector = { kind: "path_prefix", prefix: "../x" };
  return selector;
}
void typeChecks;

test("the argument digest is the canonical SHA-256 of tool, catalog version and normalized arguments, and binds an edit to its file", () => {
  const digestOf = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  const write = classify({ tool: "fs_write", arguments: { path: "src/a.ts", content: "x" } });
  // The executor can recompute it from what the ledger stores.
  assert.equal(write.argumentDigest, digestOf({ tool: "fs_write", catalogVersion, arguments: write.arguments }));
  assert.equal(write.argumentDigest, digestOf({ arguments: { content: "x", path: "src/a.ts" }, catalogVersion: 1, tool: "fs_write" }));
  const edit = classify({ tool: "fs_edit", arguments: { path: "src/a.ts", oldText: "x", newText: "y" }, priorSha256: prior });
  assert.equal(edit.argumentDigest, digestOf({ tool: "fs_edit", catalogVersion, arguments: edit.arguments, priorSha256: prior }));
  assert.notEqual(edit.argumentDigest, classify({ tool: "fs_edit", arguments: { path: "src/a.ts", oldText: "x", newText: "y" }, priorSha256: "b".repeat(64) }).argumentDigest,
    "the same edit of another version of the file is another call");

  // Every spelling of one call has one digest.
  const same = (a: ToolCall, b: ToolCall) => assert.equal(classify(a).argumentDigest, classify(b).argumentDigest, JSON.stringify([a, b]));
  same({ tool: "fs_write", arguments: { path: "src/a.ts", content: "x" } }, { tool: "fs_write", arguments: { content: "x", path: "./src//b/../a.ts" } });
  same({ tool: "fs_read", arguments: { path: "a" } }, { tool: "fs_read", arguments: { path: "a", startLine: 1, lineCount: 2000 } });
  same({ tool: "fs_list", arguments: {} }, { tool: "fs_list", arguments: { path: ".", depth: 1 } });
  same({ tool: "shell_run", arguments: { command: "ls" } }, { tool: "shell_run", arguments: { command: "ls", cwd: "./", timeoutSeconds: 60 } });
  same({ tool: "web_fetch", arguments: { url: "https://example.com/a" } }, { tool: "web_fetch", arguments: { url: "HTTPS://EXAMPLE.COM.:443/a#top", method: "GET" } });
  same({ tool: "web_search", arguments: { query: "x" } }, { tool: "web_search", arguments: { query: "x", maxResults: 10 } });

  // Any other call has another digest: all of these are distinct.
  const calls: ToolCall[] = [
    { tool: "fs_write", arguments: { path: "a", content: "x" } }, { tool: "fs_write", arguments: { path: "a", content: "x " } },
    { tool: "fs_write", arguments: { path: "b", content: "x" } }, { tool: "fs_write", arguments: { path: "a/b", content: "x" } },
    { tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "" }, priorSha256: prior }, { tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" }, priorSha256: prior },
    { tool: "fs_read", arguments: { path: "a" } }, { tool: "fs_read", arguments: { path: "a", lineCount: 10 } }, { tool: "fs_list", arguments: { path: "a" } },
    { tool: "fs_search", arguments: { path: "a", query: "x" } },
    { tool: "shell_run", arguments: { command: "ls" } }, { tool: "shell_run", arguments: { command: "ls " } }, { tool: "shell_run", arguments: { command: "ls", cwd: "a" } },
    { tool: "shell_run", arguments: { command: "ls", timeoutSeconds: 61 } }, { tool: "shell_run", arguments: { command: "ls\n" } },
    { tool: "web_fetch", arguments: { url: "https://example.com/a" } }, { tool: "web_fetch", arguments: { url: "http://example.com/a" } },
    { tool: "web_fetch", arguments: { url: "https://example.com/a", method: "HEAD" } }, { tool: "web_fetch", arguments: { url: "https://example.com/a", method: "POST" } },
    { tool: "web_fetch", arguments: { url: "https://example.com/a", method: "POST", body: "" } }, { tool: "web_fetch", arguments: { url: "https://example.com/a?" } },
    { tool: "web_fetch", arguments: { url: "https://example.com:8443/a" } }, { tool: "web_fetch", arguments: { url: "https://example.com/A" } },
    { tool: "web_search", arguments: { query: "ls" } }, { tool: "web_search", arguments: { query: "ls", maxResults: 5 } },
  ];
  const digests = calls.map(call => classify(call).argumentDigest);
  assert.equal(new Set(digests).size, calls.length);
  for (const digest of digests) assert.match(digest, /^[0-9a-f]{64}$/);
  for (const call of calls) assert.equal(canonical(classify(call).arguments).includes("undefined"), false);
});

test("the selector a card may offer covers its own call, and exact and tool selectors mean what they say", () => {
  const calls = [
    classify({ tool: "fs_read", arguments: { path: "src/a.ts" } }), classify({ tool: "fs_read", arguments: { path: "a.ts" } }),
    classify({ tool: "fs_list", arguments: {} }), classify({ tool: "fs_list", arguments: { path: "src" } }), classify({ tool: "fs_search", arguments: { query: "x" } }),
    classify({ tool: "fs_write", arguments: { path: "src/app/a.ts", content: "x" } }), classify({ tool: "fs_write", arguments: { path: "a.ts", content: "x" } }),
    classify({ tool: "fs_edit", arguments: { path: "src/a.ts", oldText: "x", newText: "y" }, priorSha256: prior }),
    shell("git status"), shell("git status | cat"), fetching("https://example.com/a"), fetching("https://example.com/a", { method: "POST" }),
    fetching("http://example.com/a"), classify({ tool: "web_search", arguments: { query: "x" } }),
  ];
  for (const call of calls) {
    if (call.selector) {
      assert.equal(covers(call.selector, call), true, call.preview.text);
      assert.deepEqual(selectorSchema.parse(JSON.parse(JSON.stringify(call.selector))), call.selector, "an offered selector is in canonical form");
    }
    // No card offers the whole workspace, a wildcard host or a shell prefix of an unproved command.
    assert.notDeepEqual(call.selector, { kind: "path_prefix", prefix: "" });
    if (call.selector?.kind === "host") assert.equal(call.selector.pattern.startsWith("*"), false);
    if (call.tool === "shell_run") assert.equal(call.selector === null, call.scope.kind === "command" && call.scope.argv === null);
    for (const other of calls) {
      assert.equal(covers({ kind: "exact", argumentDigest: call.argumentDigest }, other), other === call);
      assert.equal(covers({ kind: "tool" }, other), true);
    }
  }
  assert.deepEqual(calls.filter(call => call.selector === null).map(call => call.preview.text.split("\n")[0]),
    ["command: git status | cat", "POST https://example.com/a", "GET http://example.com/a"]);
});

test("a selector held for one tool never covers a call of another tool", () => {
  const read = classify({ tool: "fs_read", arguments: { path: "src/a.ts" } });
  const write = classify({ tool: "fs_write", arguments: { path: "src/a.ts", content: "" } });
  const edit = classify({ tool: "fs_edit", arguments: { path: "src/a.ts", oldText: "x", newText: "y" }, priorSha256: prior });
  const prefix: Selector = { kind: "path_prefix", prefix: at("src") };
  assert.equal(selectorMatches("fs_read", prefix, read), true);
  // Leave to read a directory is not leave to write it.
  for (const call of [write, edit]) assert.equal(selectorMatches("fs_read", prefix, call), false);
  assert.equal(selectorMatches("fs_write", prefix, read), false);
  assert.equal(selectorMatches("fs_write", prefix, edit), false);
  const calls = [read, write, edit, shell("ls"), fetching("https://example.com/"), classify({ tool: "web_search", arguments: { query: "x" } })];
  for (const tool of toolNames) for (const call of calls) {
    assert.equal(selectorMatches(tool, { kind: "tool" }, call), tool === call.tool, `${tool} / ${call.tool}`);
    assert.equal(selectorMatches(tool, { kind: "exact", argumentDigest: call.argumentDigest }, call), tool === call.tool);
  }
  assert.equal(selectorMatches("unknown_tool" as ToolName, { kind: "tool" }, read), false);
});

test("a host selector covers reads over https on port 443 to its hosts, and never an effect, another scheme or another port", () => {
  const exact: Selector = { kind: "host", pattern: hostPattern("docs.example.com")! };
  const wildcard: Selector = { kind: "host", pattern: hostPattern("*.example.com")! };
  for (const [url, more] of [["https://docs.example.com/"], ["https://DOCS.Example.Com./a?b#c"], ["https://docs.example.com:443/x"],
    ["https://docs.example.com/", { method: "HEAD" }]] as [string, Record<string, unknown>?][]) {
    assert.equal(covers(exact, fetching(url, more)), true, url);
    assert.equal(covers(wildcard, fetching(url, more)), true, url);
  }
  for (const [url, more] of [
    ["https://docs.example.com/", { method: "POST" }], ["https://docs.example.com/", { method: "PUT" }], ["https://docs.example.com/", { method: "PATCH" }],
    ["https://docs.example.com/", { method: "DELETE" }],
    ["http://docs.example.com/"], ["https://docs.example.com:8443/"], ["https://docs.example.com:80/"], ["http://docs.example.com:443/"],
    ["https://evil.test/docs.example.com"], ["https://evil.test/?docs.example.com"], ["https://evil.test/#docs.example.com"],
    ["https://docs.example.com.evil.test/"], ["https://evildocs.example.com.evil.test/"], ["https://docs-example.com/"], ["https://docs.example.co/"],
    ["https://127.0.0.1/"], ["https://[::1]/"], ["https://docs.example.com.test/"],
  ] as [string, Record<string, unknown>?][]) {
    assert.equal(covers(exact, fetching(url, more)), false, url + JSON.stringify(more ?? {}));
    assert.equal(covers(wildcard, fetching(url, more)), false, url + JSON.stringify(more ?? {}));
  }
  assert.equal(covers(exact, fetching("https://a.docs.example.com/")), false, "an exact host is not its subdomains");
  assert.equal(covers(wildcard, fetching("https://a.b.example.com/")), true);
  assert.equal(covers(wildcard, fetching("https://example.com/")), false, "a wildcard is not its base");
  assert.equal(covers(exact, shell("curl https://docs.example.com/")), false, "a host selector never covers a command that names the host");
  assert.equal(covers(exact, classify({ tool: "web_search", arguments: { query: "docs.example.com" } })), false);
  // An address is matched as written by the parser: every spelling of 127.0.0.1 is one host.
  const loopback: Selector = { kind: "host", pattern: hostPattern("127.0.0.1")! };
  for (const url of ["https://127.0.0.1/", "https://127.1/", "https://0x7f000001/", "https://2130706433/", "https://0177.0.0.1/"]) {
    assert.equal(covers(loopback, fetching(url)), true, url);
  }
  for (const url of ["https://127.0.0.2/", "https://[::ffff:127.0.0.1]/", "https://127.0.0.1.example.com/"]) assert.equal(covers(loopback, fetching(url)), false, url);
});

test("a stored selector is accepted only in canonical form", () => {
  for (const selector of [{ kind: "exact", argumentDigest: prior }, { kind: "command_prefix", argv: ["git", "status"] }, { kind: "command_prefix", argv: ["make", "X=1"] },
    { kind: "path_prefix", prefix: "src/app" }, { kind: "path_prefix", prefix: "" }, { kind: "host", pattern: "docs.example.com" },
    { kind: "host", pattern: "*.example.com" }, { kind: "host", pattern: "127.0.0.1" }, { kind: "tool" }]) {
    assert.deepEqual(selectorSchema.parse(selector), selector);
  }
  for (const selector of [
    null, "tool", {}, { kind: "regex", pattern: ".*" }, { kind: "tool", tool: "shell_run" }, { kind: "exact" }, { kind: "exact", argumentDigest: "A".repeat(64) },
    { kind: "exact", argumentDigest: "abc" },
    { kind: "command_prefix", argv: [] }, { kind: "command_prefix", argv: "git status" }, { kind: "command_prefix", argv: ["git status"] }, { kind: "command_prefix", argv: ["git", ""] },
    { kind: "command_prefix", argv: ["git", "status;rm"] }, { kind: "command_prefix", argv: ["git", "*"] }, { kind: "command_prefix", argv: ["FOO=1", "git"] },
    { kind: "command_prefix", argv: ["git", "=x"] }, { kind: "command_prefix", argv: ["git", "$HOME"] }, { kind: "command_prefix", argv: ["git", "a\nb"] },
    { kind: "command_prefix", argv: Array.from({ length: catalogLimits.commandWords + 1 }, () => "a") },
    { kind: "path_prefix" }, { kind: "path_prefix", prefix: "/" }, { kind: "path_prefix", prefix: "/src" }, { kind: "path_prefix", prefix: "src/" }, { kind: "path_prefix", prefix: "./src" },
    { kind: "path_prefix", prefix: "src//app" }, { kind: "path_prefix", prefix: "src/../etc" }, { kind: "path_prefix", prefix: ".." }, { kind: "path_prefix", prefix: "." },
    { kind: "path_prefix", prefix: "a\\b" }, { kind: "path_prefix", prefix: "~" }, { kind: "path_prefix", prefix: 7 }, { kind: "path_prefix", prefix: "a‮b" },
    { kind: "host" }, { kind: "host", pattern: "Example.com" }, { kind: "host", pattern: "example.com." }, { kind: "host", pattern: "example.com:443" },
    { kind: "host", pattern: "https://example.com" }, { kind: "host", pattern: "*" }, { kind: "host", pattern: "*.com" }, { kind: "host", pattern: "*.*.example.com" },
    { kind: "host", pattern: "user@example.com" }, { kind: "host", pattern: "127.1" }, { kind: "host", pattern: "b\u00fccher.example" },
  ]) assert.equal(selectorSchema.safeParse(selector).success, false, JSON.stringify(selector));
});

test("a preview shows every character that is there, keeps what is acted on complete and marks content so it cannot pass for it", () => {
  // Invisible, reordering and line-breaking characters are spelled out.
  const sneaky = shell("echo ok\u202e ; rm -rf ~ \u2066#\u200b\nrm -rf /\r\u0007\u001b[2K\tx");
  assert.equal(sneaky.preview.text,
    "command: echo ok\\u{202e} ; rm -rf ~ \\u{2066}#\\u{200b}\\u{a}rm -rf /\\u{d}\\u{7}\\u{1b}[2K\\u{9}x\ncwd: .\ntimeout: 60 s");
  assert.equal(sneaky.preview.text.split("\n").length, 3, "a command cannot add a line to its own preview");
  assert.equal(shell("ls\ncwd: /safe\ntimeout: 1 s").preview.text, "command: ls\\u{a}cwd: /safe\\u{a}timeout: 1 s\ncwd: .\ntimeout: 60 s");
  // A combining mark is shown as written only after a letter outside ASCII, so none can strike through or cover ASCII text.
  assert.equal(shell("ls̶ -la").preview.text.split("\n")[0], "command: ls\\u{336} -la");
  assert.equal(shell("echo é 1⃝").preview.text.split("\n")[0], "command: echo e\\u{301} 1\\u{20dd}");
  assert.equal(shell("echo नमस्ते é́").preview.text.split("\n")[0], "command: echo नमस्ते é́");
  // Symbols that pass for a slash or a dot are spelled out; letters of any script are not.
  const lookalike = classify({ tool: "fs_write", arguments: { path: "src\u2215..\u2215x/\uff0e\uff0e/caf\u00e9/\u65e5\u672c.txt", content: "" } });
  assert.equal(lookalike.preview.text.split("\n")[0], "path: src\\u{2215}..\\u{2215}x/\\u{ff0e}\\u{ff0e}/caf\u00e9/\u65e5\u672c.txt");
  // Content lines carry their mark, so content cannot forge a header line.
  const forged = classify({ tool: "fs_write", arguments: { path: "a.txt", content: "x\npath: /etc/passwd\nbytes: 0\n\ncommand: rm -rf /" } });
  assert.deepEqual(forged.preview.text.split("\n"), ["path: a.txt", "bytes: 47", "+ x", "+ path: /etc/passwd", "+ bytes: 0", "+ ", "+ command: rm -rf /"]);
  const body = fetching("https://example.com/", { method: "POST", body: "a\nGET https://evil.test/" });
  assert.deepEqual(body.preview.text.split("\n"), ["POST https://example.com/", "body bytes: 24", "> a", "> GET https://evil.test/"]);

  // What is acted on is always complete, even at the size limits with characters that expand most.
  const worstCommand = shell("\u0001".repeat(catalogLimits.commandBytes), { cwd: "\u00a1".repeat(126) + "/" + "\u00a1".repeat(126) });
  assert.equal(worstCommand.preview.truncated, false);
  assert.ok(worstCommand.preview.text.startsWith("command: " + "\\u{1}".repeat(catalogLimits.commandBytes) + "\ncwd: \\u{a1}"));
  assert.ok(worstCommand.preview.text.endsWith("\ntimeout: 60 s"));
  assert.ok(Buffer.byteLength(worstCommand.preview.text) <= catalogLimits.previewBytes);
  const widest = shell("\u001f".repeat(catalogLimits.commandBytes), { cwd: "\u07ff".repeat(127) + "/" + "\u07ff".repeat(127) });
  assert.equal(widest.preview.truncated, false);
  assert.ok(Buffer.byteLength(widest.preview.text) <= catalogLimits.previewBytes, String(Buffer.byteLength(widest.preview.text)));

  // Content is cut to fit, and the preview says so and by how much.
  const content = Array.from({ length: 5000 }, (_, i) => "line " + i).join("\n");
  const big = classify({ tool: "fs_write", arguments: { path: "big.txt", content } });
  assert.equal(big.preview.truncated, true);
  assert.ok(Buffer.byteLength(big.preview.text) <= catalogLimits.previewBytes);
  const lines = big.preview.text.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["path: big.txt", `bytes: ${Buffer.byteLength(content)}`, "+ line 0"]);
  const shownBytes = lines.slice(2, -1).reduce((sum, line) => sum + Buffer.byteLength(line.slice(2)) + 1, 0);
  assert.ok(shownBytes > catalogLimits.previewBytes / 2, "most of the budget goes to content");
  assert.equal(lines.at(-1), `... ${Buffer.byteLength(content) - shownBytes} more bytes not shown`);
  const oneLine = classify({ tool: "fs_write", arguments: { path: "min.js", content: "x".repeat(catalogLimits.contentBytes) } });
  assert.deepEqual(oneLine.preview.text.split("\n"), ["path: min.js", `bytes: ${catalogLimits.contentBytes}`, `... ${catalogLimits.contentBytes} more bytes not shown`]);
  const edit = classify({ tool: "fs_edit", arguments: { path: "a", oldText: "o\n".repeat(20_000), newText: "n\n".repeat(20_000) }, priorSha256: prior });
  assert.equal(edit.preview.truncated, true);
  assert.ok(Buffer.byteLength(edit.preview.text) <= catalogLimits.previewBytes);
  assert.match(edit.preview.text, /^path: a\nfile sha256: a{64}\n- o\n/);
  for (const call of [sneaky, lookalike, forged, body, worstCommand, big, oneLine, edit]) {
    assert.doesNotMatch(call.preview.text, /[^\n\x20-\x7e\p{L}\p{N}\p{M}]/u, "nothing but printable ASCII, letters, digits and marks reaches the reader");
  }
});

test("a capability set permits only the tools it gives, and a fetch only to a host it allows", () => {
  const set = (input: CapabilityInput) => capabilitySchema.parse(input);
  const calls: Record<ToolName, Classified> = {
    fs_read: classify({ tool: "fs_read", arguments: { path: "a" } }), fs_list: classify({ tool: "fs_list", arguments: {} }),
    fs_search: classify({ tool: "fs_search", arguments: { query: "x" } }), fs_write: classify({ tool: "fs_write", arguments: { path: "a", content: "" } }),
    fs_edit: classify({ tool: "fs_edit", arguments: { path: "a", oldText: "x", newText: "y" }, priorSha256: prior }), shell_run: shell("ls"),
    web_fetch: fetching("https://docs.example.com/"), web_search: classify({ tool: "web_search", arguments: { query: "x" } }),
  };
  const files = ["fs_read", "fs_list", "fs_search"], writes = [...files, "fs_write", "fs_edit"];
  for (const [capabilities, tools] of [
    [null, []], [{ version: 1 }, []],
    [{ version: 1, workspace: { files: "read" } }, files], [{ version: 1, workspace: { files: "write" } }, writes],
    [{ version: 1, workspace: { files: "write", shell: { network: "off" } } }, [...writes, "shell_run"]],
    [{ version: 1, webFetch: { hosts: "any" } }, ["web_fetch"]], [{ version: 1, webFetch: { hosts: ["docs.example.com"] } }, ["web_fetch"]],
    [{ version: 1, webSearch: {} }, ["web_search"]],
    [{ version: 1, workspace: { files: "write", shell: { network: "proxied" } }, webFetch: { hosts: "any" }, webSearch: {} }, [...toolNames]],
  ] as [CapabilityInput | null, string[]][]) {
    const held = capabilities && set(capabilities);
    assert.deepEqual(toolsFor(held), tools, JSON.stringify(capabilities));
    assert.deepEqual(toolNames.filter(tool => capabilityPermits(held, calls[tool])), tools, JSON.stringify(capabilities));
  }
  const listed = set({ version: 1, webFetch: { hosts: ["docs.example.com", "*.example.org"] } });
  for (const [url, permitted] of [["https://docs.example.com/", true], ["http://docs.example.com:8080/", true], ["https://a.example.org/", true],
    ["https://example.org/", false], ["https://evil.test/", false], ["https://docs.example.com.evil.test/", false], ["https://127.0.0.1/", false]] as const) {
    assert.equal(capabilityPermits(listed, fetching(url)), permitted, url);
    assert.equal(capabilityPermits(listed, fetching(url, { method: "POST" })), permitted, url);
  }
  // A call whose scope does not belong to its tool is never permitted.
  assert.equal(capabilityPermits(listed, { tool: "web_fetch", scope: { kind: "search" } }), false);
});
