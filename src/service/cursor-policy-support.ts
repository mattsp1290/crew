import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { warn } from "./diagnostics.ts";

export const cursorPolicyProbeToken = "cursor-text-v1/sdk-1.4.2\n";

export class CursorPolicyUnsupportedError extends Error {
  readonly code = "cursor_policy_unsupported";
  constructor() {
    super("Cursor text policy is unsupported");
    this.name = "CursorPolicyUnsupportedError";
    this.stack = "CursorPolicyUnsupportedError: Cursor text policy is unsupported";
  }
}

const metadata = z.object({ name: z.string().optional(), version: z.string().optional() });

function installedPackage(entry: string) {
  let directory = dirname(realpathSync(fileURLToPath(entry)));
  for (let depth = 0; depth < 8; depth += 1, directory = dirname(directory)) {
    let source: string;
    try { source = readFileSync(join(directory, "package.json"), "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const parsed = metadata.parse(JSON.parse(source));
    if (parsed.name !== undefined) return { ...parsed, root: directory };
  }
  throw new CursorPolicyUnsupportedError();
}

/** Installation/export check only. The parent never imports the SDK or receives an availability promise. */
export async function assertCursorPolicySupport(stateDirectory: string): Promise<void> {
  let directory: string | undefined;
  try {
    if (!isAbsolute(stateDirectory) || process.versions.node !== "24.22.3") throw new CursorPolicyUnsupportedError();
    const sdk = installedPackage(import.meta.resolve("@cursor/sdk"));
    const adapterEntry = import.meta.resolve("@operatorworks/switchboard/cursor");
    const adapter = installedPackage(adapterEntry);
    const adapterSdk = installedPackage(pathToFileURL(createRequire(adapterEntry).resolve("@cursor/sdk")).href);
    if (sdk.name !== "@cursor/sdk" || sdk.version !== "1.4.2"
      || adapter.name !== "@operatorworks/switchboard" || adapter.version !== "0.0.0"
      || adapterSdk.root !== sdk.root) throw new CursorPolicyUnsupportedError();
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(await realpath(stateDirectory), ".cursor-policy-"));
    const probeDirectory = directory;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./cursor-policy-probe.ts", import.meta.url))], {
        cwd: probeDirectory, detached: true,
        env: {
          HOME: probeDirectory, TMPDIR: probeDirectory, CURSOR_DATA_DIR: probeDirectory,
          PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC",
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      let failed = false;
      const killGroup = () => {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
        }
      };
      const stop = () => {
        failed = true;
        killGroup();
        child.stdout.destroy();
      };
      const timer = setTimeout(stop, 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (output.length + chunk.length > cursorPolicyProbeToken.length) stop();
        else output += chunk;
      });
      child.stdout.on("error", stop);
      child.on("error", () => { failed = true; });
      child.on("close", (code) => {
        clearTimeout(timer);
        killGroup();
        if (!failed && code === 0 && output === cursorPolicyProbeToken) resolve();
        else reject(new CursorPolicyUnsupportedError());
      });
    });
  } catch {
    warn("cursor_policy_unsupported");
    throw new CursorPolicyUnsupportedError();
  } finally {
    if (directory !== undefined) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch { warn("cursor_policy_unsupported"); throw new CursorPolicyUnsupportedError(); }
    }
  }
}
