import { writeSync } from "node:fs";

type Field = string | number | boolean | null | undefined;

// JWTs (also cut or unsigned ones), other three-part tokens, bearer values, passwords in URLs, values of
// credential-named keys (also inside escaped JSON), and long opaque runs such as API or refresh tokens.
// A UUID (36 characters) and a file path stay readable.
const secretShapes: [RegExp, string][] = [
  [/eyJ[\w-]{4,}(?:\.[\w-]*){0,2}/g, "[redacted]"],
  // Without the lookbehind this shape is retried inside every long word, which costs quadratic time.
  [/(?<![\w-])[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[redacted]"],
  [/\b(bearer|basic)(\s+)[^\s"',;]+/gi, "$1$2[redacted]"],
  [/(\/\/[^\s/:@]*:)[^\s/@]+@/g, "$1[redacted]@"],
  // The value runs to the next space or quote. A backslash belongs to it unless it escapes the closing quote.
  [/(token|secret|password|passwd|api[_-]?key|\bkey|authorization|credential)((?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?:[^\s"',;\\]|\\(?!["']))+/gi,
    "$1$2[redacted]"],
  [/[\w+-]{40,}=*/g, "[redacted]"],
];
// Longer text is cut before the shapes run, so one huge message cannot stall the process that logs it.
const scannedChars = 16_384;

/**
 * One line of at most `limit` characters with token-shaped text removed.
 * `keep` chooses which part of a longer line survives. A process reports why it stopped at the end of its output.
 */
export function redact(text: string, limit = 512, keep: "start" | "end" = "start") {
  let raw = String(text);
  const cut = raw.length > scannedChars;
  if (cut) raw = keep === "end" ? raw.slice(-scannedChars) : raw.slice(0, scannedChars);
  let line = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");
  // The cut can leave part of a token that no longer looks like one, so the cut word goes.
  if (cut) line = keep === "end" ? line.slice(line.indexOf(" ") + 1 || line.length) : line.slice(0, Math.max(0, line.lastIndexOf(" ")));
  line = line.trim();
  for (const [shape, replacement] of secretShapes) line = line.replace(shape, replacement);
  if (line.length <= limit) return line;
  return keep === "end" ? "…" + line.slice(-limit) : line.slice(0, limit) + "…";
}

/** The class, error code and a redacted message of a caught value. It never throws. */
export function errorSummary(error: unknown): Record<string, Field> {
  try {
    if (!(error instanceof Error)) return { error: typeof error };
    const { code, reason } = error as { code?: unknown; reason?: unknown };
    return {
      error: redact(String(error.name), 64),
      ...((typeof code === "string" || typeof code === "number") && { code: redact(String(code), 64) }),
      ...(typeof reason === "string" && { reason: redact(reason, 64) }),
      message: redact(String(error.message), 300),
    };
  } catch {
    return { error: "unreadable error" };
  }
}

let write = (line: string) => { try { writeSync(2, line + "\n"); } catch {} };

/** A turn runner has no stderr, so it sends its warnings to the supervisor host, which writes them. */
export function forwardWarnings(to: (line: string) => void) {
  write = to;
}

const fixedKeys = new Set(["level", "logger", "event"]);
const fieldName = /^[A-Za-z]{1,32}$/;

/**
 * Writes one JSON line on stderr. String fields are redacted again here, so a caller's mistake cannot leak a token.
 * A failure path calls this before it answers, so it never throws.
 */
export function warn(event: string, fields: Record<string, Field> = {}) {
  try {
    const clean = Object.entries(fields).flatMap(([key, value]): [string, Field][] => {
      if (fixedKeys.has(key) || !fieldName.test(key)) return [];
      if (typeof value === "string") return [[key, redact(value, 1024)]];
      return typeof value === "number" || typeof value === "boolean" || value === null ? [[key, value]] : [];
    });
    write(JSON.stringify({ level: "warn", logger: "birbcrew", event, ...Object.fromEntries(clean) }));
  } catch {}
}

/**
 * Writes a line that warn() built in a turn runner. The supervisor host cleans it again and adds the turn it
 * belongs to, so the runner's text reaches the log only as bounded fields of one line.
 */
export function relayWarning(line: string, turn: Record<string, Field>) {
  try {
    if (line.length > 8192) return;
    const { event, ...fields } = JSON.parse(line);
    if (typeof event === "string" && /^[a-z_]{1,64}$/.test(event)) warn(event, { ...fields, ...turn });
  } catch {}
}
