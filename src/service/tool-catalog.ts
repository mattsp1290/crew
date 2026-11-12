import { z } from "zod";
import { canonicalDigest } from "./canonical-json.ts";
import type { CapabilitySet } from "./capabilities.ts";
import { fetchTarget, hostMatches, hostPattern, type Host, type HostPattern } from "./hosts.ts";

/** The Crew tool catalog (docs/member-capabilities.md): the tools a capability can give a
 * member, and for one call of a tool everything the approval gate will need to decide it. Pure
 * functions: no database, no file system, no network, and nothing here runs a tool.
 *
 * This is the security boundary for standing grants, so every reading is lexical and
 * conservative: input that cannot be put in one canonical form is refused, and a selector is
 * offered or matched only when it can be proved to say no more than it shows. */
export const catalogVersion = 1;
export const toolNames = ["fs_read", "fs_list", "fs_search", "fs_write", "fs_edit", "shell_run", "web_fetch", "web_search"] as const;
export type ToolName = typeof toolNames[number];

export const catalogLimits = {
  pathBytes: 512, segmentBytes: 255, commandBytes: 2048, commandWords: 64, contentBytes: 262_144, editBytes: 65_536,
  queryBytes: 1024, bodyBytes: 65_536, previewBytes: 16_384,
} as const;

/** The arguments were not ones the catalog accepts. The message names the tool and the field,
 * never a value: arguments are private. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

declare const pathBrand: unique symbol;
/** A path inside the workspace in canonical form: segments joined by `/`, none empty, `.` or
 * `..`, no leading or trailing slash. The empty string is the workspace root. Only
 * workspacePath makes one. */
export type WorkspacePath = string & { readonly [pathBrand]: true };

// Control characters, format characters (bidirectional overrides, zero-width characters) and
// line or paragraph separators have no place in a file name a person must be able to read, and
// a backslash is a separator to some tools and not to others.
const refusedInPath = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u;

/** Normalizes a workspace-relative path lexically, or returns null. `.` and empty segments are
 * dropped and `..` removes the segment before it; a path that climbs above the root, an
 * absolute path and a `~` path are refused. The result is what the selector matches, the
 * preview shows and the executor must open, so `a/../b` can only ever mean `b`. Nothing here
 * can see a symbolic link: the executor must resolve the path beneath the workspace root. */
export function workspacePath(input: string): WorkspacePath | null {
  if (typeof input !== "string" || !input.isWellFormed() || Buffer.byteLength(input) > catalogLimits.pathBytes) return null;
  if (refusedInPath.test(input) || input.startsWith("/") || input.startsWith("~")) return null;
  const kept: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!kept.length) return null;
      kept.pop();
    } else if (Buffer.byteLength(segment) > catalogLimits.segmentBytes) return null;
    else kept.push(segment);
  }
  return kept.join("/") as WorkspacePath;
}

/** Whether `path` is `prefix` or lies below it, segment by segment: `src/app` covers
 * `src/app/main.ts` and never `src/application`. The root covers everything. */
export function pathWithin(prefix: WorkspacePath, path: WorkspacePath): boolean {
  return prefix === "" || path === prefix || path.startsWith(prefix + "/");
}

/** The words of a command, or null when the command is anything but plain words separated by
 * spaces. A word may hold only ASCII letters, digits and `_ @ % + = : , . / -`, so there is
 * no quoting, escape, expansion, substitution, glob, redirect, pipe, list operator, comment,
 * tab or newline to interpret. A leading `NAME=value` or `NAME+=value` word (an assignment,
 * not an argument) and a word that starts with `=` (zsh expands it) are refused too. A shell
 * reads such a command as exactly these words; a command this cannot prove simple gets no
 * prefix selector. The first word can still be a shell keyword or builtin (`time`, `exec`,
 * `eval`), so the words say how the command line begins, not which program runs. */
export function simpleCommand(command: string): string[] | null {
  if (typeof command !== "string" || Buffer.byteLength(command) > catalogLimits.commandBytes) return null;
  if (!/^[A-Za-z0-9_@%+=:,.\/ -]+$/.test(command)) return null;
  const words = command.split(" ").filter(word => word !== "");
  if (!words.length || words.length > catalogLimits.commandWords) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[0]) || words.some(word => word.startsWith("="))) return null;
  return words;
}

const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = typeof methods[number];
const readMethods: readonly Method[] = ["GET", "HEAD"];

/** What a call touches, in the terms a selector matches. */
export type Scope =
  | { kind: "path"; path: WorkspacePath }
  /** `argv` is null when simpleCommand could not prove the command simple. */
  | { kind: "command"; cwd: WorkspacePath; argv: string[] | null }
  | { kind: "url"; scheme: "https" | "http"; host: Host; port: number; method: Method }
  | { kind: "search" };

/** What a standing grant or a policy rule may be scoped to. A selector always goes with one
 * tool name, which this type does not repeat. */
export type Selector =
  /** This call again: the same tool, catalog version and arguments (for fs_edit, the same prior file). */
  | { kind: "exact"; argumentDigest: string }
  /** A simple command whose words begin with these words. Longer commands match too, and the working directory is not bound. */
  | { kind: "command_prefix"; argv: string[] }
  /** This path or anything below it. */
  | { kind: "path_prefix"; prefix: WorkspacePath }
  /** GET or HEAD over https on port 443 to a host the pattern matches. Never another method, scheme or port. */
  | { kind: "host"; pattern: HostPattern }
  /** Every call of the tool. */
  | { kind: "tool" };

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commandWord = z.string().regex(/^[A-Za-z0-9_@%+=:,.\/-]+$/);
/** Parses a stored selector. One that is not in canonical form is refused, not repaired. */
export const selectorSchema: z.ZodType<Selector> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact"), argumentDigest: sha256 }),
  z.strictObject({ kind: z.literal("command_prefix"), argv: z.array(commandWord).min(1).max(catalogLimits.commandWords) })
    .refine(selector => simpleCommand(selector.argv.join(" "))?.length === selector.argv.length, { message: "Expected the words of a simple command" }),
  z.strictObject({ kind: z.literal("path_prefix"), prefix: z.string() })
    .refine(selector => workspacePath(selector.prefix) === selector.prefix, { message: "Expected a canonical workspace path" })
    .transform(selector => ({ kind: selector.kind, prefix: selector.prefix as WorkspacePath })),
  z.strictObject({ kind: z.literal("host"), pattern: z.string() })
    .refine(selector => hostPattern(selector.pattern) === selector.pattern, { message: "Expected a canonical host pattern" })
    .transform(selector => ({ kind: selector.kind, pattern: selector.pattern as HostPattern })),
  z.strictObject({ kind: z.literal("tool") }),
]);

export interface Preview {
  /** A fixed sentence chosen by the tool and the call's kind. */
  summary: string;
  /** What the call would do, rendered by Crew from the arguments alone. The lines that say
   * what is acted on (command, working directory, path, method and URL, query) are always
   * complete; only file content and request bodies are cut to fit. */
  text: string;
  /** Whether content was cut. */
  truncated: boolean;
}

export interface Classified<T extends ToolName = ToolName> {
  tool: T;
  catalogVersion: typeof catalogVersion;
  kind: "read" | "effect";
  scope: Scope;
  /** Normalized: canonical paths and URL, every default filled in. The executor must run these and nothing else. */
  arguments: ToolArguments[T];
  /** For fs_edit: the SHA-256 of the file the edit was read against. */
  priorSha256?: string;
  /** SHA-256 of the canonical JSON of the tool, the catalog version, the normalized arguments and, for fs_edit, the file's prior hash. */
  argumentDigest: string;
  preview: Preview;
  /** The one standing selector a card for this call may offer; null when none can be proved safe. */
  selector: Selector | null;
}

export interface ToolArguments {
  fs_read: { path: WorkspacePath; startLine: number; lineCount: number };
  fs_list: { path: WorkspacePath; depth: number };
  fs_search: { path: WorkspacePath; query: string };
  fs_write: { path: WorkspacePath; content: string };
  fs_edit: { path: WorkspacePath; oldText: string; newText: string };
  shell_run: { command: string; cwd: WorkspacePath; timeoutSeconds: number };
  web_fetch: { url: string; method: Method; body?: string };
  web_search: { query: string; maxResults: number };
}

/** An edit is approved against one version of the file, so its caller must supply that file's hash. */
export type ToolCall =
  | { tool: "fs_edit"; arguments: unknown; priorSha256: string }
  | { tool: Exclude<ToolName, "fs_edit">; arguments: unknown };

const text = (bytes: number) => z.string().refine(value => value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= bytes,
  { message: `Expected well-formed text of at most ${bytes} bytes without NUL` });
const path = z.string().refine(value => workspacePath(value) !== null, { message: "Expected a path inside the workspace" })
  .transform(value => workspacePath(value)!);
const file = path.refine(value => value !== "", { message: "Expected a file path, not the workspace root" });
const whole = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);

const schemas = {
  fs_read: z.strictObject({ path: file, startLine: whole(1, 1_000_000).default(1), lineCount: whole(1, 10_000).default(2000) }),
  fs_list: z.strictObject({ path: path.default("" as WorkspacePath), depth: whole(1, 8).default(1) }),
  fs_search: z.strictObject({ path: path.default("" as WorkspacePath), query: text(catalogLimits.queryBytes).min(1) }),
  fs_write: z.strictObject({ path: file, content: text(catalogLimits.contentBytes) }),
  fs_edit: z.strictObject({ path: file, oldText: text(catalogLimits.editBytes).min(1), newText: text(catalogLimits.editBytes) })
    .refine(edit => edit.oldText !== edit.newText, { message: "Expected newText to differ from oldText" }),
  shell_run: z.strictObject({ command: text(catalogLimits.commandBytes).min(1), cwd: path.default("" as WorkspacePath),
    timeoutSeconds: whole(1, 600).default(60) }),
  web_fetch: z.strictObject({
    url: z.string().refine(value => fetchTarget(value) !== null, { message: "Expected an absolute http or https URL without credentials" }),
    method: z.enum(methods).default("GET"), body: text(catalogLimits.bodyBytes).optional(),
  }).refine(request => request.body === undefined || ["POST", "PUT", "PATCH"].includes(request.method), { message: "Expected a body only with POST, PUT or PATCH" }),
  web_search: z.strictObject({ query: text(catalogLimits.queryBytes).min(1), maxResults: whole(1, 20).default(10) }),
} satisfies { [T in ToolName]: z.ZodType };

/** Printable ASCII and the letters and digits of every script are shown as they are, and so is
 * a combining mark that follows a letter outside ASCII. Every other character (controls,
 * invisible and reordering characters, other spaces, symbols that can pass for a slash or a
 * dot, and a mark placed over ASCII text) is shown as `\u{hex}`, so the reader sees every
 * character that is there. Text that already spells `\u{...}` is shown unchanged. */
function visible(value: string): string {
  let shown = "", marks = false;
  for (const character of value) {
    const plain = /^[\x20-\x7e]$/.test(character), letter = !plain && /^\p{L}$/u.test(character);
    const mark: boolean = marks && /^\p{M}$/u.test(character);
    shown += plain || letter || mark || /^\p{N}$/u.test(character) ? character : "\\u{" + character.codePointAt(0)!.toString(16) + "}";
    marks = letter || mark;
  }
  return shown;
}
const shownPath = (value: WorkspacePath) => value === "" ? "." : visible(value);

/** `header` lines in full, then as many `mark`-prefixed lines of each block as fit the budget.
 * Every content line carries its mark, so content cannot pass for a header line. */
function render(header: string[], blocks: { mark: string; content: string }[] = []): Pick<Preview, "text" | "truncated"> {
  const lines = [...header];
  // The last 64 bytes are kept for the line that says how much was cut.
  const budget = catalogLimits.previewBytes - 64;
  let used = Buffer.byteLength(lines.join("\n")), truncated = false, hidden = 0;
  for (const { mark, content } of blocks) {
    let shown = 0;
    for (const raw of truncated ? [] : content.split("\n")) {
      const line = mark + visible(raw), cost = Buffer.byteLength(line) + 1;
      if (used + cost > budget) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += cost;
      shown += Buffer.byteLength(raw) + 1;
    }
    if (truncated) hidden += Math.max(0, Buffer.byteLength(content) - shown);
  }
  if (truncated) lines.push(`... ${hidden} more bytes not shown`);
  return { text: lines.join("\n"), truncated };
}

/** The directory a file is in, or the file itself when it sits in the workspace root: a card
 * never offers the whole workspace. */
function around(target: WorkspacePath): Selector {
  const cut = target.lastIndexOf("/");
  return { kind: "path_prefix", prefix: (cut === -1 ? target : target.slice(0, cut)) as WorkspacePath };
}

type Reading<T extends ToolName> = { kind: "read" | "effect"; scope: Scope; summary: string; selector: Selector | null }
  & Pick<Preview, "text" | "truncated"> & { arguments: ToolArguments[T] };

const readers: { [T in ToolName]: (args: z.output<(typeof schemas)[T]>, prior?: string) => Reading<T> } = {
  fs_read: args => ({ kind: "read", scope: { kind: "path", path: args.path }, summary: "Read a file", selector: around(args.path), arguments: args,
    ...render([`path: ${shownPath(args.path)}`, `lines: ${args.lineCount} from line ${args.startLine}`]) }),
  fs_list: args => ({ kind: "read", scope: { kind: "path", path: args.path }, summary: "List a directory",
    selector: args.path === "" ? { kind: "tool" } : { kind: "path_prefix", prefix: args.path }, arguments: args,
    ...render([`path: ${shownPath(args.path)}`, `depth: ${args.depth}`]) }),
  fs_search: args => ({ kind: "read", scope: { kind: "path", path: args.path }, summary: "Search files",
    selector: args.path === "" ? { kind: "tool" } : { kind: "path_prefix", prefix: args.path }, arguments: args,
    ...render([`path: ${shownPath(args.path)}`, `query: ${visible(args.query)}`]) }),
  fs_write: args => ({ kind: "effect", scope: { kind: "path", path: args.path }, summary: "Write a file", selector: around(args.path), arguments: args,
    ...render([`path: ${shownPath(args.path)}`, `bytes: ${Buffer.byteLength(args.content)}`], [{ mark: "+ ", content: args.content }]) }),
  fs_edit: (args, prior) => ({ kind: "effect", scope: { kind: "path", path: args.path }, summary: "Edit a file", selector: around(args.path), arguments: args,
    ...render([`path: ${shownPath(args.path)}`, `file sha256: ${prior}`], [{ mark: "- ", content: args.oldText }, { mark: "+ ", content: args.newText }]) }),
  shell_run: args => {
    const argv = simpleCommand(args.command);
    return { kind: "effect", scope: { kind: "command", cwd: args.cwd, argv }, summary: "Run a shell command",
      selector: argv && { kind: "command_prefix", argv }, arguments: args,
      ...render([`command: ${visible(args.command)}`, `cwd: ${shownPath(args.cwd)}`, `timeout: ${args.timeoutSeconds} s`]) };
  },
  web_fetch: args => {
    const target = fetchTarget(args.url)!;
    const read = readMethods.includes(args.method);
    return { kind: read ? "read" : "effect", scope: { kind: "url", scheme: target.scheme, host: target.host, port: target.port, method: args.method },
      summary: read ? "Fetch a URL" : "Send an HTTP request",
      // A host selector covers reads over https on port 443 only, so only such a call offers one.
      selector: read && target.scheme === "https" && target.port === 443 ? { kind: "host", pattern: target.host as string as HostPattern } : null,
      arguments: { url: target.href, method: args.method, ...(args.body !== undefined && { body: args.body }) },
      ...render([`${args.method} ${visible(target.href)}`, ...(args.body === undefined ? [] : [`body bytes: ${Buffer.byteLength(args.body)}`])],
        args.body === undefined ? [] : [{ mark: "> ", content: args.body }]) };
  },
  web_search: args => ({ kind: "read", scope: { kind: "search" }, summary: "Search the web", selector: { kind: "tool" }, arguments: args,
    ...render([`query: ${visible(args.query)}`, `results: ${args.maxResults}`]) }),
};

function read<T extends ToolName>(tool: T, input: unknown, prior?: string): Reading<T> {
  const parsed = schemas[tool].safeParse(input);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".");
    throw new ToolArgumentError(`Invalid arguments for ${tool}${where ? ` at ${where}` : ""}`);
  }
  return readers[tool](parsed.data as never, prior);
}

/** The digest that pins one call: what a card approves, an exact selector repeats and the
 * ledger stores. Whoever runs a stored call recomputes it from the stored fields first. */
export function argumentDigest(call: { tool: string; catalogVersion: number; arguments: unknown; priorSha256?: string }): string {
  return canonicalDigest({ tool: call.tool, catalogVersion: call.catalogVersion, arguments: call.arguments,
    ...(call.priorSha256 !== undefined && { priorSha256: call.priorSha256 }) });
}

/** Reads one call: its kind, scope, normalized arguments, digest, preview and the selector a
 * card may offer. Throws ToolArgumentError for an unknown tool or arguments the catalog does
 * not accept; such a call must be denied, never run. Normalized arguments read back as
 * themselves, so a stored call classifies to the digest it was stored with. */
export function classify(call: ToolCall): Classified {
  if (!toolNames.includes(call.tool)) throw new ToolArgumentError("Unknown tool");
  const prior = call.tool === "fs_edit" ? call.priorSha256 : undefined;
  if (call.tool === "fs_edit" && !sha256.safeParse(prior).success) throw new ToolArgumentError("fs_edit needs the SHA-256 of the file it edits");
  const { summary, text: shown, truncated, ...reading } = read(call.tool, call.arguments, prior);
  return {
    tool: call.tool, catalogVersion, kind: reading.kind, scope: reading.scope, arguments: reading.arguments, ...(prior !== undefined && { priorSha256: prior }),
    argumentDigest: argumentDigest({ tool: call.tool, catalogVersion, arguments: reading.arguments, priorSha256: prior }),
    preview: { summary, text: shown, truncated }, selector: reading.selector,
  };
}

/** Whether a selector held for `tool` covers the call. Another tool's call is never covered,
 * and neither is a call whose scope is not of the selector's kind. */
export function selectorMatches(tool: ToolName, selector: Selector, call: Pick<Classified, "tool" | "scope" | "argumentDigest">): boolean {
  if (tool !== call.tool) return false;
  const { scope } = call;
  switch (selector.kind) {
    case "exact": return selector.argumentDigest === call.argumentDigest;
    case "tool": return true;
    case "path_prefix": return scope.kind === "path" && pathWithin(selector.prefix, scope.path);
    case "command_prefix": {
      if (scope.kind !== "command" || scope.argv === null || selector.argv.length === 0 || scope.argv.length < selector.argv.length) return false;
      const { argv } = scope;
      return selector.argv.every((word, index) => word === argv[index]);
    }
    case "host": return scope.kind === "url" && scope.scheme === "https" && scope.port === 443 && readMethods.includes(scope.method)
      && hostMatches(selector.pattern, scope.host);
  }
}

function gives(capabilities: CapabilitySet | null, tool: ToolName): boolean {
  const workspace = capabilities?.workspace;
  switch (tool) {
    case "fs_read": case "fs_list": case "fs_search": return workspace !== undefined;
    case "fs_write": case "fs_edit": return workspace?.files === "write";
    case "shell_run": return workspace?.files === "write" && workspace.shell !== undefined;
    case "web_fetch": return capabilities?.webFetch !== undefined;
    case "web_search": return capabilities?.webSearch !== undefined;
  }
}

/** The tools a capability set gives a member, in catalog order. No set gives none. */
export function toolsFor(capabilities: CapabilitySet | null): ToolName[] {
  return toolNames.filter(tool => gives(capabilities, tool));
}

/** Whether a member with this capability set may make the call at all: the gate's first
 * check. The set must give the tool, and a fetch must go to a host the set allows. */
export function capabilityPermits(capabilities: CapabilitySet | null, call: Pick<Classified, "tool" | "scope">): boolean {
  if (!gives(capabilities, call.tool)) return false;
  if (call.tool !== "web_fetch") return true;
  const allowed = capabilities?.webFetch?.hosts, { scope } = call;
  if (allowed === undefined || scope.kind !== "url") return false;
  return allowed === "any" || allowed.some(pattern => hostMatches(pattern, scope.host));
}
