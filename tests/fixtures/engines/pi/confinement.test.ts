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
import { piLaunch } from "../../../../src/service/pi-launch.ts";
import { runPiTurn } from "../../../../src/service/pi.ts";
import { createPiFixtureOptions } from "./index.mts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

test("the confined Pi worker cannot read outside its code, change other files, open a socket, start a process or signal its host", { timeout: 20_000 }, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "birb-pi-scope-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const directory = join(scope, "conversation");
  await mkdir(directory, { mode: 0o700 });
  const sibling = join(scope, "other-owner.txt");
  await writeFile(sibling, "private fixture sentinel");
  let connections = 0;
  const server = createServer((socket) => { connections++; socket.destroy(); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const paths = { sibling, checkout: fileURLToPath(import.meta.url), host: `/proc/${process.pid}/environ`,
    code: join(root, "src/service/pi-worker.ts") };
  const probe = `
    const fs = require("node:fs");
    const attempt = (action) => { try { action(); return "allowed"; } catch (error) { return error.code; } };
    const paths = ${JSON.stringify(paths)};
    const result = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, attempt(() => fs.readFileSync(path))]));
    result.private = attempt(() => fs.writeFileSync("scratch", "own state"));
    result.signal = attempt(() => process.kill(process.ppid, 0));
    result.mode = attempt(() => fs.chmodSync(${JSON.stringify(scope)}, 0o700));
    result.times = attempt(() => fs.utimesSync(${JSON.stringify(sibling)}, 0, 0));
    result.process = require("node:child_process").spawnSync(process.execPath, ["-e", "0"]).error?.code ?? "allowed";
    const done = (tcp) => { fs.writeSync(3, JSON.stringify({ ...result, tcp }) + "\\n"); process.exit(0); };
    require("node:net").connect(${address.port}, "127.0.0.1").once("connect", () => done("allowed")).once("error", (error) => done(error.code));
  `;
  const launch = piLaunch(directory, ["-e", probe]);
  const child = spawn(launch.command, launch.args, launch.options);
  let output = "";
  child.stdio[3]!.on("data", (chunk: Buffer) => { output += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  // Landlock denies reads outside the code and the private directory; seccomp denies the socket, the new
  // process, the signal to the host and metadata changes to files the same user owns.
  assert.deepEqual(JSON.parse(output), { sibling: "EACCES", checkout: "EACCES", host: "EACCES", code: "allowed", private: "allowed",
    signal: "EPERM", mode: "EPERM", times: "EPERM", process: "EPERM", tcp: "EPERM" });
  assert.equal(connections, 0);

  const unconfined = piLaunch(directory, ["-e", "0"]);
  const refused = spawn(unconfined.command, unconfined.args, { ...unconfined.options, stdio: "ignore" });
  assert.deepEqual(await once(refused, "exit"), [126, null], "The launcher must refuse a Pi worker without its channel");
});

function processStatus(pid: number) {
  return Object.fromEntries(readFileSync(`/proc/${pid}/status`, "utf8").trim().split("\n").map((line) => line.split(":\t")));
}

test("a Pi turn runs in a launcher-confined worker with no inherited environment", { timeout: 20_000 }, async (t) => {
  const seen: { status: Record<string, string>; command: string[]; environment: string[] }[] = [];
  const profile = await createPiFixtureOptions(() => {
    const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/);
    for (const pid of children.map(Number)) {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!command.at(-1)?.endsWith("/src/service/pi-worker.ts")) continue;
      const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => entry.split("=")[0]!);
      seen.push({ status: processStatus(pid), command, environment });
    }
  });
  process.env.BIRBCREW_PI_TEST_SENTINEL = randomUUID();
  t.after(() => { delete process.env.BIRBCREW_PI_TEST_SENTINEL; });
  const turn = await runPiTurn({ threadId: randomUUID(), runId: randomUUID(), text: "remember cedar", checkpoint: null, signal: t.signal }, profile);
  assert.equal(turn.text, "stored cedar");
  assert.equal(seen.length, 1);
  const [worker] = seen;
  assert.equal(worker.status.NoNewPrivs, "1");
  assert.equal(worker.status.Seccomp, "2");
  const filters = Number(processStatus(process.pid).Seccomp_filters);
  assert.ok(Number.isInteger(filters));
  assert.equal(Number(worker.status.Seccomp_filters), filters + 1);
  assert.deepEqual(worker.command, [process.execPath, join(root, "src/service/pi-worker.ts")]);
  assert.deepEqual(worker.environment.sort(), ["HOME", "TMPDIR"]);
});

test("the linked client exposes compiled schemas without exposing package source or allowing writes", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "birb-pi-client-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    compiled: join(root, "packages/client/dist/contract.js"),
    manifest: join(root, "packages/client/package.json"),
    source: join(root, "packages/client/src/contract.ts"),
    readme: join(root, "packages/client/README.md"),
  };
  const probe = `
    const fs = require("node:fs");
    const attempt = (action) => { try { action(); return "allowed"; } catch (error) { return error.code; } };
    const paths = ${JSON.stringify(paths)};
    const result = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, attempt(() => fs.readFileSync(path))]));
    result.write = attempt(() => fs.closeSync(fs.openSync(paths.compiled, "a")));
    result.neighborWrite = attempt(() => fs.closeSync(fs.openSync(${JSON.stringify(join(root, "package.json"))}, "a")));
    fs.writeSync(3, JSON.stringify(result));
  `;
  const launch = piLaunch(directory, ["-e", probe]);
  const child = spawn(launch.command, launch.args, launch.options);
  let output = "";
  child.stdio[3]!.on("data", (chunk: Buffer) => { output += chunk; });
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.deepEqual(JSON.parse(output), { compiled: "allowed", manifest: "allowed", source: "EACCES", readme: "EACCES", write: "EACCES", neighborWrite: "EACCES" });
});
