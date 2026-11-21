import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const inheritedEnvironment = new Set([
  "PATH", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
]);

/** Drop runner secrets before a text-engine SDK or child can read process.env or /proc/pid/environ. */
export function scrubTextEngineEnvironment() {
  for (const key of Object.keys(process.env)) if (!inheritedEnvironment.has(key)) delete process.env[key];
}

// A worker can leave a directory its host cannot list (mode 0300) or a tree deeper than PATH_MAX, which
// defeat Node's rm. GNU chmod and rm walk with descriptors; the worker has exited and could make no symlinks.
export async function removePrivate(directory: string) {
  try { await rm(directory, { recursive: true, force: true }); return; }
  catch { /* retried below */ }
  const run = promisify(execFile);
  await run("/bin/chmod", ["-R", "u+rwx", "--", directory]).catch(() => undefined);
  await run("/bin/rm", ["-rf", "--one-file-system", "--", directory]);
}

export class TextTurnFailed extends Error {
  constructor() {
    super("Text engine turn failed");
    this.name = "TextTurnFailed";
  }
}
