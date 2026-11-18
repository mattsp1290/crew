import { z } from "zod";
import { canonicalDigest, hasProtoKey } from "./canonical-json.ts";
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

// Control characters, format characters (bidirectional overrides, zero-width characters),
// characters that render as nothing (default-ignorable code points such as the Hangul fillers)
// and line or paragraph separators have no place in a file name a person must be able to
// read, and a backslash is a separator to some tools and not to others.
const refusedInPath = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\\]/u;

/** Normalizes a workspace-relative path lexically, or returns null. `.` and empty segments are
 * dropped and `..` removes the segment before it; a path that climbs above the root, an
 * absolute path and a path whose first segment starts with `~` once normalized are refused.
 * The result is what the selector matches, the preview shows and the executor must open, so
 * `a/../b` can only ever mean `b`, and normalizing it again returns it unchanged. Nothing here
 * can see a symbolic link: the executor must resolve the path beneath the workspace root. */
export function workspacePath(input: string): WorkspacePath | null {
  if (typeof input !== "string" || !input.isWellFormed() || Buffer.byteLength(input) > catalogLimits.pathBytes) return null;
  if (refusedInPath.test(input) || input.startsWith("/")) return null;
  const kept: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!kept.length) return null;
      kept.pop();
    } else if (Buffer.byteLength(segment) > catalogLimits.segmentBytes) return null;
    else kept.push(segment);
  }
  // Checked on the result: `./~/x` and `a/../~x` must be refused like `~/x`.
  if (kept[0]?.startsWith("~")) return null;
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
 * tab or newline to interpret. Also refused, because some shell reads them as something other
 * than a plain word:
 * - a first word that holds `=`: an assignment, not a program (`A=1 cmd`, `A+=1 cmd`, and in
 *   zsh `1=2 cmd`, which assigns a positional parameter and then runs `cmd`);
 * - a first word that starts with `-` or `+`: `sh -c` reads it as shell options;
 * - a word that starts with `=`, or holds `==` or `:=`: zsh replaces `=name` with the path
 *   of a command there, at the start of a word and in the value of an assignment argument.
 *
 * sh, dash, bash and zsh, run with no startup files and default options, read such a command
 * as exactly these words. A command this cannot prove simple gets no prefix selector. The
 * first word can still be a shell keyword, a builtin or a wrapper (`time`, `exec`, `eval`,
 * `env`), so the words say how the command line begins, not which program runs. */
export function simpleCommand(command: string): string[] | null {
  if (typeof command !== "string" || Buffer.byteLength(command) > catalogLimits.commandBytes) return null;
  if (!/^[A-Za-z0-9_@%+=:,.\/ -]+$/.test(command)) return null;
  const words = command.split(" ").filter(word => word !== "");
  if (!words.length || words.length > catalogLimits.commandWords) return null;
  if (/[=]|^[-+]/.test(words[0])) return null;
  if (words.some(word => word.startsWith("=") || word.includes("==") || word.includes(":="))) return null;
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
export const selectorSchema: z.ZodType<Selector> = z.custom<unknown>(value => !hasProtoKey(value), { message: "Unknown key __proto__" }).pipe(z.discriminatedUnion("kind", [
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
]));

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

/** As much of `value` as fits in `room` bytes once made visible, and how many of its bytes that
 * is. Printable ASCII is shown as it is. Every other character is spelled `\u{hex}`: controls,
 * invisible and reordering characters, and every letter, digit, mark or symbol outside ASCII,
 * since any of them can pass for shell syntax or for another name. A backslash that would
 * itself read as the start of such an escape is spelled out too, so two different texts are
 * never spelled the same. So is every space after the first `plainSpaces` in a run. The result
 * never ends inside an escape.
 *
 * With `endVisibly`, for a content line, the result never ends in a plain space either: nothing
 * after it would show that it is there, and `\` before a line break means something else than
 * `\`, a space and a line break. The spaces that end the value are spelled out, and where the
 * cut falls inside a run of plain spaces they are left with the part that is not shown. */
function visiblePrefix(value: string, room: number, plainSpaces = Infinity, endVisibly = false): { shown: string; bytes: number; whole: boolean } {
  const characters = [...value];
  let ending = characters.length;
  if (endVisibly) while (ending > 0 && characters[ending - 1] === " ") ending--;
  let shown = "", bytes = 0, run = 0;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    run = character === " " ? run + 1 : 0;
    const startsEscape = character === "\\" && characters[index + 1] === "u" && characters[index + 2] === "{";
    const piece = !startsEscape && run <= plainSpaces && index < ending && /^[\x20-\x7e]$/.test(character) ? character
      : "\\u{" + character.codePointAt(0)!.toString(16) + "}";
    if (shown.length + piece.length > room) {
      if (endVisibly) while (shown.endsWith(" ")) { shown = shown.slice(0, -1); bytes--; }
      return { shown, bytes, whole: false };
    }
    shown += piece;
    bytes += Buffer.byteLength(character);
  }
  return { shown, bytes, whole: true };
}
const visible = (value: string) => visiblePrefix(value, Infinity).shown;
/** A value on a header line. A space at either end, and every space after the first in a run,
 * is spelled out, so padding cannot push the rest of the line out of sight unnoticed. */
const field = (value: string) => visible(value).replace(/^ | $|(?<= ) /g, "\\u{20}");
const shownPath = (value: WorkspacePath) => value === "" ? "." : field(value);

/** `header` lines in full, then each block's lines with its mark. Every content line carries
 * its mark, so content cannot pass for a header line, and keeps its indentation: only the
 * spaces after the sixteenth in a run are spelled out, so padding cannot hide the rest of a
 * line, and the spaces that end a line, so no line ends in a character that cannot be seen.
 * The blocks share what is left of the budget evenly; a block that does not fit is cut,
 * inside a line if need be, and a line that starts with `...`, which no header or content line
 * can, says how much of it is not shown. A line break counts as shown once the line after it
 * is, so the shown lines of a block that reports no cut join back to the whole of it. */
function render(header: string[], blocks: { mark: string; content: string }[] = []): Pick<Preview, "text" | "truncated"> {
  const lines = [...header];
  // 64 bytes for each block are kept for the line that says how much was cut.
  let left = catalogLimits.previewBytes - Buffer.byteLength(lines.join("\n")) - 64 * blocks.length, truncated = false;
  blocks.forEach(({ mark, content }, index) => {
    const share = Math.floor(left / (blocks.length - index)), rows = content.split("\n");
    let used = 0, shown = 0;
    for (let row = 0; row < rows.length; row++) {
      const room = share - used - mark.length - 1;
      if (room < 0) break;
      const piece = visiblePrefix(rows[row], room, 16, true);
      if (piece.whole || piece.shown !== "") {
        lines.push(mark + piece.shown);
        used += mark.length + piece.shown.length + 1;
        shown += piece.bytes + (row > 0 ? 1 : 0);
      }
      if (!piece.whole) break;
    }
    const hidden = Buffer.byteLength(content) - shown;
    if (hidden > 0) {
      lines.push(`... ${hidden} more bytes of "${mark.trim()}" lines not shown`);
      truncated = true;
    }
    left -= used;
  });
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
    ...render([`path: ${shownPath(args.path)}`, `query: ${field(args.query)}`]) }),
  fs_write: args => ({ kind: "effect", scope: { kind: "path", path: args.path }, summary: "Write a file", selector: around(args.path), arguments: args,
    ...render([`path: ${shownPath(args.path)}`, `bytes: ${Buffer.byteLength(args.content)}`], [{ mark: "+ ", content: args.content }]) }),
  fs_edit: (args, prior) => ({ kind: "effect", scope: { kind: "path", path: args.path }, summary: "Edit a file", selector: around(args.path), arguments: args,
    ...render([`path: ${shownPath(args.path)}`, `file sha256: ${prior}`, `old bytes: ${Buffer.byteLength(args.oldText)}`, `new bytes: ${Buffer.byteLength(args.newText)}`],
      [{ mark: "- ", content: args.oldText }, { mark: "+ ", content: args.newText }]) }),
  shell_run: args => {
    const argv = simpleCommand(args.command);
    return { kind: "effect", scope: { kind: "command", cwd: args.cwd, argv }, summary: "Run a shell command",
      selector: argv && { kind: "command_prefix", argv }, arguments: args,
      ...render([`command: ${field(args.command)}`, `cwd: ${shownPath(args.cwd)}`, `timeout: ${args.timeoutSeconds} s`]) };
  },
  web_fetch: args => {
    const target = fetchTarget(args.url)!;
    const read = readMethods.includes(args.method);
    return { kind: read ? "read" : "effect", scope: { kind: "url", scheme: target.scheme, host: target.host, port: target.port, method: args.method },
      summary: read ? "Fetch a URL" : "Send an HTTP request",
      // A host selector covers reads over https on port 443 only, so only such a call offers one.
      selector: read && target.scheme === "https" && target.port === 443 ? { kind: "host", pattern: target.host as string as HostPattern } : null,
      arguments: { url: target.href, method: args.method, ...(args.body !== undefined && { body: args.body }) },
      ...render([`${args.method} ${field(target.href)}`, ...(args.body === undefined ? [] : [`body bytes: ${Buffer.byteLength(args.body)}`])],
        args.body === undefined ? [] : [{ mark: "> ", content: args.body }]) };
  },
  web_search: args => ({ kind: "read", scope: { kind: "search" }, summary: "Search the web", selector: { kind: "tool" }, arguments: args,
    ...render([`query: ${field(args.query)}`, `results: ${args.maxResults}`]) }),
};

function read<T extends ToolName>(tool: T, input: unknown, prior?: string): Reading<T> {
  // zod drops an own `__proto__` key without refusing it; an unknown argument must be refused.
  if (hasProtoKey(input, 0)) throw new ToolArgumentError(`Invalid arguments for ${tool}`);
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
  if (typeof call !== "object" || call === null) throw new ToolArgumentError("Unknown tool");
  // Each field is read once, so a call object cannot answer differently the second time.
  const { tool, arguments: input } = call, given: unknown = "priorSha256" in call ? call.priorSha256 : undefined;
  if (typeof tool !== "string" || !toolNames.includes(tool)) throw new ToolArgumentError("Unknown tool");
  const edited = sha256.safeParse(given);
  if (tool === "fs_edit" && !edited.success) throw new ToolArgumentError("fs_edit needs the SHA-256 of the file it edits");
  const prior = tool === "fs_edit" ? edited.data : undefined;
  const { summary, text: shown, truncated, ...reading } = read(tool, input, prior);
  return {
    tool, catalogVersion, kind: reading.kind, scope: reading.scope, arguments: reading.arguments, ...(prior !== undefined && { priorSha256: prior }),
    argumentDigest: argumentDigest({ tool, catalogVersion, arguments: reading.arguments, priorSha256: prior }),
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
