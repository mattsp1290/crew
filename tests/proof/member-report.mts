import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { run, type Engine } from "./member-services.mts";

export async function evidenceOutputs(env: NodeJS.ProcessEnv = process.env) {
  const source = await realpath(process.cwd());
  async function outside(value: string | undefined) {
    if (value === undefined) return;
    const path = resolve(value);
    const output = join(await realpath(dirname(path)), basename(path));
    const fromSource = relative(source, output);
    if (!(fromSource === ".." || fromSource.startsWith(".." + sep) || isAbsolute(fromSource))) {
      throw new Error("Choose an evidence file outside the checkout");
    }
    const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (existing && !existing.isFile()) throw new Error("Choose a regular evidence file");
    return output;
  }
  const fixture = await outside(env.BIRBCREW_FIXTURE_EVIDENCE);
  const replay = await outside(env.BIRBCREW_REPLAY_EVIDENCE);
  if (fixture && fixture === replay) throw new Error("Use distinct fixture and replay evidence files");
  return { fixture, replay };
}

const roots = ["src/service", "native", "scripts", "tests/service", "tests/proof", "tests/fixtures/engines",
  "packages", "vendor/ag-ui", "vendor/switchboard", "clients"];
const files = [".gitattributes", "package.json", "package-lock.json", ".node-version", "tsconfig.json"];
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const revision = z.string().regex(/^[a-f0-9]{40}$/);
// git archive substitutes the commit hash; unpacked archives need no .git directory.
const archiveStamp = "$Format:%H:%T$";
async function archiveTreeMatches(expected: string) {
  const dir = await mkdtemp(join(tmpdir(), "birb-proof-tree-"));
  const gitDir = join(dir, "index.git");
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => run("git", ["--git-dir", gitDir, "--work-tree", process.cwd(), ...args], { env });
  try {
    await run("git", ["init", "-q", "--bare", gitDir], { env });
    await git("add", "--all", "--", ".");
    const report = "tests/proof/member-report.mts";
    const original = (await readFile(report, "utf8")).replace(archiveStamp, "$" + "Format:%H:%T$");
    const object = join(dir, "unexpanded-report");
    await writeFile(object, original);
    const { stdout } = await git("hash-object", "-w", object);
    await git("update-index", "--cacheinfo", "100644," + stdout.trim() + "," + report);
    return (await git("write-tree")).stdout.trim() === expected;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function sourceFingerprint() {
  const input: string[] = [...files];
  async function collect(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "__pycache__", ".git", "dist", ".proof"].includes(item.name)) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) await collect(path);
      else if (item.isFile()) input.push(path);
    }
  }
  for (const root of roots) await collect(root);
  const manifest = [];
  for (const path of input.sort()) {
    const bytes = await readFile(path);
    const normalized = path === "tests/proof/member-report.mts" && /^[a-f0-9]{40}:[a-f0-9]{40}$/.test(archiveStamp)
      ? bytes.toString("utf8").replace(archiveStamp, "$" + "Format:%H:%T$") : bytes;
    manifest.push({ path, sha256: hash(normalized) });
  }
  const sourceSha256 = hash(JSON.stringify(manifest));
  const git = (...args: string[]) => run("git", args, { env: { PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  let gitRevision: string | undefined;
  try {
    if ((await git("rev-parse", "--show-toplevel")).stdout.trim() === process.cwd()) {
      gitRevision = revision.parse((await git("rev-parse", "HEAD")).stdout.trim());
    }
  }
  catch { /* A source archive can be run without a Git checkout. */ }
  const external = process.env.BIRBCREW_SOURCE_REVISION;
  if (external) revision.parse(external);
  const archive = /^([0-9a-f]{40}):([0-9a-f]{40})$/.exec(archiveStamp);
  if (gitRevision) {
    const status = (await git("status", "--porcelain", "--untracked-files=all", "--", ...roots, ...files)).stdout.trim();
    if (external && external !== gitRevision) throw new Error("Supplied source revision differs from the checkout");
    return { revision: gitRevision, state: status ? "modified" : "clean", sourceSha256, manifest };
  }
  if (archive) {
    if (external && archive[1] !== external) throw new Error("Supplied source revision differs from archive");
    return { revision: archive[1], state: await archiveTreeMatches(archive[2]) ? "git-archive" : "modified", sourceSha256, manifest };
  }
  const attested = external && process.env.BIRBCREW_SOURCE_SHA256 === sourceSha256;
  return { revision: external ?? null, state: attested ? "external-attestation" : "unattributed", sourceSha256, manifest };
}

export function attributable(source: Awaited<ReturnType<typeof sourceFingerprint>>) {
  return source.revision !== null && !["modified", "unattributed"].includes(source.state);
}

export async function lockedPackages(engines: Engine[]) {
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const native = ["@temporalio/worker", "@ag-ui/core", "@ag-ui/client", "@ag-ui/encoder", "@operatorworks/switchboard",
    ...(engines.includes("codex") ? ["@openai/codex", "@openai/codex-linux-" + process.arch] : []),
    ...(engines.includes("claude") ? ["@ag-ui/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-linux-" + process.arch] : []),
    ...(engines.includes("pi") ? ["@ag-ui/pi", "@earendil-works/pi-coding-agent", "@birbcrew/pi-subagents"] : [])];
  return native.map((name) => {
    const { version, integrity } = z.object({ version: z.string(), integrity: z.string().startsWith("sha512-") })
      .parse(lock.packages["node_modules/" + name]);
    return { name, version, integrity };
  });
}
export async function fixtureReport(engines: Engine[], path?: string) {
  const initial = await sourceFingerprint();
  const packages = await lockedPackages(engines);
  const stages: { name: string; status: "VERIFIED" }[] = [];
  return {
    pass(name: string) { stages.push({ name, status: "VERIFIED" }); },
    async finish(passed: boolean) {
      const final = await sourceFingerprint();
      const reproducible = JSON.stringify(final) === JSON.stringify(initial) && attributable(final);
      const { manifest, ...sourceInfo } = final;
      const report = { mode: "fixture", engines, status: !passed ? "NOT VERIFIED" : reproducible ? "VERIFIED" : "INCONCLUSIVE",
        processExit: passed && (reproducible || !path) ? 0 : 1, source: sourceInfo, stableDuringRun: initial.sourceSha256 === final.sourceSha256,
        node: process.version, architecture: process.arch, temporalCli: "1.10.0", packages,
        nativeLauncherSha256: hash(await readFile(".proof/bin/member-launch")), stages };
      if (path) {
        const tmp = path + "." + randomUUID() + ".tmp";
        try {
          await writeFile(tmp, JSON.stringify({ ...report, ...(reproducible && { sourceManifest: manifest }) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await rename(tmp, path);
        } finally { await rm(tmp, { force: true }); }
      }
      console.log(JSON.stringify(report));
      if (passed && path && !reproducible) throw new Error("A release evidence file requires stable, attributable source");
    },
  };
}
