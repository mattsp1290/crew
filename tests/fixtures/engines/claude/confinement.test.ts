import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { claudeWorkerLaunch, runClaudeTurn } from "../../../../src/service/claude.ts";
import { startClaudeFixtureProvider } from "./index.mts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
// Landlock and this launcher are Linux-only. Darwin cannot compile member-launch.c
// or apply a ruleset, so the probes skip here. Linux needs Landlock ABI 4.
const linux = process.platform === "linux";

test("the confined Claude worker can read its code, write its directory and start a process, and cannot read outside or leave its session", { skip: !linux, timeout: 20_000 }, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "birb-claude-scope-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const directory = join(scope, "conversation");
  await mkdir(join(directory, "tmp"), { recursive: true, mode: 0o700 });
  const sibling = join(scope, "other-owner.txt");
  await writeFile(sibling, "private fixture sentinel");
  let connections = 0;
  const server = createServer((socket) => { connections++; socket.destroy(); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const launcher = join(root, ".proof/bin/member-launch");
  const paths = {
    sibling, checkout: fileURLToPath(import.meta.url), host: `/proc/${process.pid}/environ`,
    code: join(root, "src/service/claude-worker.ts"), docs: join(root, "docs/verification.md"),
    compiled: join(root, "packages/client/dist/contract.js"), source: join(root, "packages/client/src/contract.ts"),
    module: join(root, "node_modules/zod/package.json"),
    launcher,
  };
  const nestedScript = `
    const fs = require("node:fs");
    const attempt = (path) => { try { fs.readFileSync(path); return "allowed"; } catch (error) { return error.code; } };
    process.stdout.write(JSON.stringify({ sibling: attempt(${JSON.stringify(sibling)}), code: attempt(${JSON.stringify(join(root, "src/service/claude-worker.ts"))}) }));
  `;
  // Network stays open. The vendored adapter binds an ephemeral loopback MCP port after the
  // ruleset is sealed, so C2a cannot name a TCP allow rule. Network confinement moves to C2b.
  const probe = `
    const fs = require("node:fs");
    const childProcess = require("node:child_process");
    const attempt = (action) => { try { action(); return "allowed"; } catch (error) { return error.code; } };
    const paths = ${JSON.stringify(paths)};
    const result = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, attempt(() => fs.readFileSync(path))]));
    result.private = attempt(() => fs.writeFileSync("scratch", "own state"));
    result.outside = attempt(() => fs.writeFileSync(paths.sibling, "overwrite"));
    result.docsWrite = attempt(() => fs.appendFileSync(paths.docs, "\\n"));
    result.codeWrite = attempt(() => fs.appendFileSync(paths.code, "\\n"));
    result.moduleWrite = attempt(() => fs.appendFileSync(paths.module, "\\n"));
    result.compiledWrite = attempt(() => fs.appendFileSync(paths.compiled, "\\n"));
    fs.writeFileSync("planted.sh", "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
    const planted = childProcess.spawnSync("./planted.sh");
    result.planted = planted.error?.code ?? (planted.status === 0 ? "allowed" : String(planted.status));
    const nested = childProcess.spawnSync(${JSON.stringify(launcher)}, [String(process.pid), process.execPath, "-e", ${JSON.stringify(nestedScript)}], { cwd: process.cwd(), encoding: "utf8" });
    result.nested = nested.status === 0 ? JSON.parse(nested.stdout) : (nested.error?.code ?? String(nested.status));
    // detached calls setsid. setpgid is the same seccomp deny and has no Node spawn flag.
    const session = childProcess.spawnSync(process.execPath, ["-e", "process.exit(0)"], { detached: true });
    result.setsid = session.error?.code ?? (session.status === 0 ? "allowed" : String(session.status));
    const finish = (tcp) => { process.send({ ...result, tcp }, () => process.exit(0)); };
    require("node:net").connect(${address.port}, "127.0.0.1").once("connect", () => finish("allowed")).once("error", (error) => finish(error.code));
  `;
  const launch = claudeWorkerLaunch(directory, ["-e", probe]);
  const child = spawn(launch.command, launch.args, { ...launch.options, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
  let message: unknown;
  child.on("message", (value) => { message = value; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.deepEqual(message, {
    sibling: "EACCES", checkout: "EACCES", host: "EACCES", code: "allowed", docs: "EACCES",
    compiled: "allowed", source: "EACCES", module: "allowed", launcher: "allowed", private: "allowed",
    outside: "EACCES", docsWrite: "EACCES", codeWrite: "EACCES", moduleWrite: "EACCES", compiledWrite: "EACCES",
    planted: "EACCES", nested: { sibling: "EACCES", code: "EACCES" }, setsid: "EPERM", tcp: "allowed",
  });
  assert.equal(connections, 1);

  const refused = spawn(launch.command, launch.args, { ...launch.options, stdio: "ignore" });
  assert.deepEqual(await once(refused, "exit"), [126, null], "The launcher must refuse a Claude worker without its channel");
});

function processStatus(pid: number) {
  return Object.fromEntries(readFileSync(`/proc/${pid}/status`, "utf8").trim().split("\n").map((line) => line.split(":\t")));
}

test("a Claude turn runs in a launcher-confined worker", { skip: !linux, timeout: 90_000 }, async (t) => {
  const sentinel = `BIRBCREW_CLAUDE_SENTINEL_${randomUUID()}`;
  process.env[sentinel] = "1";
  t.after(() => { delete process.env[sentinel]; });
  const seen = new Map<number, { status: Record<string, string>; command: string[]; names: string[]; cliFilters: number[] }>();
  const provider = await startClaudeFixtureProvider(undefined, () => {
    const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    for (const pid of children.map(Number)) {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!command.at(-1)?.endsWith("/src/service/claude-worker.ts")) continue;
      const names = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => entry.split("=")[0]!);
      const cliFilters: number[] = [];
      const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      for (const childPid of kids.map(Number)) cliFilters.push(Number(processStatus(childPid).Seccomp_filters));
      const previous = seen.get(pid);
      if (!previous || cliFilters.length >= previous.cliFilters.length) {
        seen.set(pid, { status: processStatus(pid), command, names, cliFilters });
      }
    }
  });
  t.after(() => provider.close());
  const stateDir = await mkdtemp(join(tmpdir(), "birb-claude-confined-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const turn = await runClaudeTurn({
    threadId: randomUUID(), runId: randomUUID(), text: "remember cedar", checkpoint: null, signal: t.signal,
  }, {
    stateDir, ownerId: "owner", memberId: randomUUID(), model: "claude-sonnet-4-6",
    apiKey: "synthetic", baseUrl: provider.url,
  });
  assert.equal(turn.text, "stored cedar");
  assert.equal(seen.size, 1);
  const [worker] = [...seen.values()];
  assert.ok(worker);
  assert.equal(worker.status.NoNewPrivs, "1");
  assert.equal(worker.status.Seccomp, "2");
  const filters = Number(processStatus(process.pid).Seccomp_filters);
  assert.ok(Number.isInteger(filters));
  assert.equal(Number(worker.status.Seccomp_filters), filters + 1);
  assert.ok(worker.cliFilters.length >= 1);
  for (const count of worker.cliFilters) assert.ok(count >= Number(worker.status.Seccomp_filters) + 1);
  assert.deepEqual(worker.command, [process.execPath, join(root, "src/service/claude-worker.ts")]);
  for (const name of ["BIRBCREW_CLAUDE_WORKER", "BIRBCREW_NATIVE_SOURCE", "BIRBCREW_NATIVE_CHANNEL", sentinel]) {
    assert.equal(worker.names.includes(name), false);
  }
  for (const name of ["HOME", "TMPDIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]) {
    assert.equal(worker.names.includes(name), true);
  }
});
