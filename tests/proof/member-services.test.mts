import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { boundedCommand, collectFiles, liveGroup, now, stopGroup } from "./member-service-diagnostics.mts";
import { run, until } from "./member-services.mts";

const diagnostics = resolve("tests/proof/member-service-diagnostics.mts");
async function node(args: string[], env = process.env, timeout = 20_000) {
  const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString(); });
  const timer = setTimeout(() => { if (child.pid) void stopGroup(child.pid); }, timeout);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { ...result, output };
  } finally { clearTimeout(timer); if (child.pid) await stopGroup(child.pid); }
}

test("local capture preserves exit 23 and marker, including a failed destination", async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "command.log");
  const source = "console.error('unique-exit-23-marker'); process.exitCode = 23";
  const result = await node([diagnostics, "--command", log, process.execPath, "-e", source]);
  assert.equal(result.code, 23, result.output);
  assert.match(await readFile(log, "utf8"), /unique-exit-23-marker/);
  const failed = await node([diagnostics, "--command", join(dir, "missing", "command.log"), process.execPath, "-e", source]);
  assert.equal(failed.code, 23, failed.output);
  assert.match(failed.output, /unique-exit-23-marker/);
  assert.match(failed.output, /ENOENT/);
  const passed = await node([diagnostics, "--command", join(dir, "missing", "passed.log"), process.execPath, "-e", "process.exitCode=0"]);
  assert.equal(passed.code, 1, passed.output);
  const ordinaryDeadlineCode = join(dir, "ordinary-124.log");
  const ordinary = await node([diagnostics, "--command", ordinaryDeadlineCode, process.execPath, "-e", "process.exitCode=124"]);
  assert.equal(ordinary.code, 124, ordinary.output);
  assert.equal(JSON.parse(await readFile(ordinaryDeadlineCode + ".result.json", "utf8")).deadlineExceeded, false);
});

test("local capture drains oversized output and retains a finite log", async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "command.log");
  const result = await node([diagnostics, "--command", log, process.execPath, "-e", "process.stdout.write(Buffer.alloc(10*1024*1024, 120))"]);
  assert.equal(result.code, 0, result.output.slice(-1024));
  assert.equal((await stat(log)).size, 8 * 1024 * 1024);
  const report = JSON.parse(await readFile(log + ".result.json", "utf8"));
  assert.equal(report.truncated, true);
  assert.equal(report.received, 10 * 1024 * 1024);
});

test("local bounded command retains at most 128 KiB of multibyte output and drains the rest", { timeout: 8_000 }, async t => {
  let pid: number | undefined;
  t.after(async () => {
    if (pid !== undefined) {
      await stopGroup(pid);
      assert.equal(await liveGroup(pid), false, `Owned output group ${pid} remains`);
    }
  });
  const repetitions = 128 * 1024;
  const source = `process.stdout.write('\u{1f600}'.repeat(${repetitions}))`;
  const result = await boundedCommand(process.execPath, ["-e", source], now() + 4_000).catch((error: unknown) => {
    if (error instanceof Error && "pid" in error && typeof error.pid === "number" && Number.isSafeInteger(error.pid) && error.pid > 0) {
      pid = error.pid;
      t.diagnostic(`Owned process group ${pid}`);
    }
    throw error;
  });
  pid = result.pid;
  if (pid !== undefined) t.diagnostic(`Owned process group ${pid}`);
  t.diagnostic(JSON.stringify({ receivedBytes: result.received, retainedUtf8Bytes: Buffer.byteLength(result.output, "utf8") }));
  assert.equal(result.received, repetitions * 4, "Command output was not fully drained");
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 128 * 1024, "Retained output exceeds its byte limit");
  assert.match(result.output, /^(?:\u{1f600})+$/u, "Retained output contains a split UTF-8 character");
  if (pid !== undefined) assert.equal(await liveGroup(pid), false, `Owned output group ${pid} remains`);
});

test("local subprocess timeout lets its payload stop a detached descendant before returning", { timeout: 14_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-helper-timeout-"));
  const ready = join(dir, "ready.json"), receipt = join(dir, "cancel.txt");
  const identity = z.object({ payload: z.number().int().positive(), descendant: z.number().int().positive() });
  const groups = new Set<number>();
  async function readReady() {
    try { return identity.parse(JSON.parse(await readFile(ready, "utf8"))); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  function own(pids: z.infer<typeof identity>) {
    for (const pid of [pids.payload, pids.descendant]) {
      if (!groups.has(pid)) t.diagnostic(`Owned process group ${pid}`);
      groups.add(pid);
    }
  }
  const source = `import {spawn} from 'node:child_process';
    import {writeFileSync,renameSync} from 'node:fs';
    import {stopGroup} from ${JSON.stringify("file://" + diagnostics)};
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    process.on('SIGTERM',()=>{void stopGroup(child.pid).then(()=>{
      writeFileSync(${JSON.stringify(receipt)},'SIGTERM');process.exit(143);
    },error=>{console.error(error);process.exit(1)})});
    writeFileSync(${JSON.stringify(ready + ".tmp")},JSON.stringify({payload:process.pid,descendant:child.pid}));
    renameSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)});
    setInterval(()=>{},1000);`;
  const pending = (async (): Promise<
    { kind: "returned"; result: Awaited<ReturnType<typeof node>> } | { kind: "failed"; error: unknown }
  > => {
    try { return { kind: "returned", result: await node(["--input-type=module", "-e", source], process.env, 1_000) }; }
    catch (error) { return { kind: "failed", error }; }
  })();
  t.after(async () => {
    await pending;
    const failures: unknown[] = [];
    try { const pids = await readReady(); if (pids) own(pids); }
    catch (error) { failures.push(error); }
    const stopped = await Promise.allSettled([...groups].map(async pid => {
      await stopGroup(pid);
      assert.equal(await liveGroup(pid), false, `Owned timeout group ${pid} remains`);
    }));
    for (const outcome of stopped) if (outcome.status === "rejected") failures.push(outcome.reason);
    try { await rm(dir, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Timeout test process cleanup failed");
  });
  own(await until(readReady, "timeout payload and detached descendant readiness", 3_000));
  const outcome = await pending;
  if (outcome.kind === "failed") throw outcome.error;
  t.diagnostic("Timeout return group liveness " + JSON.stringify(await Promise.all([...groups].map(async group => ({ group, live: await liveGroup(group) })))));
  assert.notEqual(outcome.result.code, 0, outcome.result.output);
  assert.notEqual(outcome.result.signal, "SIGKILL", "Timeout prevented catchable payload cancellation");
  assert.equal(await readFile(receipt, "utf8"), "SIGTERM");
  for (const group of groups) assert.equal(await liveGroup(group), false, `Owned timeout group ${group} remains at helper return`);
});

test("local diagnostic files reject secrets and symlinks and record bounds", async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-files-")), dest = join(dir, "retained"), source = join(dir, "fixture");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(source);
  await writeFile(join(source, "gateway.json"), "FORBIDDEN_SECRET_SENTINEL");
  await writeFile(join(source, "worker.log"), Buffer.alloc(300 * 1024, 120));
  await writeFile(join(source, "pi-observer-a.jsonl.messages.json"), "client messages");
  await symlink(join(source, "gateway.json"), join(source, "temporal.log"));
  await mkdir(join(source, "gateway-1.log"));
  for (let i = 0; i < 70; i++) await writeFile(join(source, `recovery-${i}.log`), Buffer.alloc(300 * 1024, 121));
  await collectFiles(source, dest);
  const files = await readdir(dest);
  assert.ok(!files.includes("gateway.json") && !files.includes("temporal.log") && !files.includes("gateway-1.log"));
  const manifest = JSON.parse(await readFile(join(dest, "files.json"), "utf8"));
  assert.ok(manifest.bytes <= 16 * 1024 * 1024 && manifest.count <= 64);
  assert.match(JSON.stringify(manifest), /truncated/);
  assert.match(JSON.stringify(manifest), /omitted/);
  for (const file of files) {
    const data = await readFile(join(dest, file));
    assert.ok(!data.includes("FORBIDDEN_SECRET_SENTINEL"));
    if (file !== "files.json") assert.ok(data.length <= 256 * 1024);
  }
});

test("local cleanup kills a live descendant after its leader exited", async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-group-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "descendant");
  const source = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); c.unref()`;
  const leader = spawn(process.execPath, ["-e", source], { detached: true, stdio: "ignore" });
  assert.ok(leader.pid);
  const group = leader.pid;
  t.diagnostic(`Owned process group ${group}`);
  t.after(() => stopGroup(group));
  await new Promise<void>((resolve, reject) => { leader.once("exit", () => resolve()); leader.once("error", reject); });
  const descendant = Number(await readFile(pidFile, "utf8"));
  process.kill(descendant, 0);
  assert.equal(await liveGroup(group), true);
  await stopGroup(group);
  assert.equal(await liveGroup(group), false);
});


test("local stalled collector is killed within its whole-operation bound", { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-collector-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = `import {captureDiagnostics} from ${JSON.stringify("file://" + diagnostics)};
    process.env.NODE_OPTIONS='--inspect-brk=127.0.0.1:0';
    try { await captureDiagnostics(${JSON.stringify(dir)},${JSON.stringify(dir)},'birb-proof-00000000'); }
    catch(error) { console.error(error); process.exitCode=1; }`;
  const start = Date.now();
  const result = await node(["--input-type=module", "-e", source], process.env, 16_000);
  assert.equal(result.code, 1, result.output);
  assert.ok(Date.now() - start < 16_000);
  const report = JSON.parse(await readFile(join(dir, "collector.json"), "utf8"));
  assert.ok(report.failures.length > 0);
  assert.equal(await liveGroup(report.pid), false);
});

test("local catchable cancellation lets descendants finish after their leader exits", { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ready = join(dir, "ready"), completed = join(dir, "completed"), log = join(dir, "command.log");
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(completed)},'disposed');process.exit(0)},300)); fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000)`;
  const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const wrapper = spawn(process.execPath, [diagnostics, "--command", log, process.execPath, "-e", leader], { detached: true, stdio: "ignore" });
  assert.ok(wrapper.pid);
  const group = wrapper.pid;
  t.diagnostic(`Owned process group ${group}`);
  t.after(() => stopGroup(group));
  const exited = new Promise<number | null>((resolve, reject) => { wrapper.once("exit", resolve); wrapper.once("error", reject); });
  await until(async () => readFile(ready, "utf8").catch(() => undefined), "descendant signal handler", 5_000);
  wrapper.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.equal(await readFile(completed, "utf8"), "disposed");
  const report = JSON.parse(await readFile(log + ".result.json", "utf8"));
  assert.equal(report.interrupted, "SIGTERM");
  assert.equal(await liveGroup(report.pid), false);
});

test("local repeated cancellation keeps the first signal and does not extend cleanup", { timeout: 12_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-cancel-bound-"));
  const ready = join(dir, "ready"), log = join(dir, "command.log");
  const source = `const fs=require('node:fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  const wrapper = spawn(process.execPath, [diagnostics, "--command", log, process.execPath, "-e", source],
    { detached: true, stdio: "ignore" });
  assert.ok(wrapper.pid);
  const wrapperPid = wrapper.pid;
  let payloadPid: number | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    wrapper.once("error", reject); wrapper.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    await Promise.all([stopGroup(wrapperPid), ...(payloadPid ? [stopGroup(payloadPid)] : [])]);
    await rm(dir, { recursive: true, force: true });
  });
  payloadPid = await until(async () => {
    try { return Number(await readFile(ready, "utf8")); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  }, "signal-ignoring payload readiness", 3_000);
  t.diagnostic(`Owned process group ${wrapperPid}`);
  t.diagnostic(`Owned process group ${payloadPid}`);
  const started = Date.now();
  process.kill(wrapperPid, "SIGINT");
  const second = setTimeout(() => process.kill(wrapperPid, "SIGTERM"), 1_000);
  try { assert.deepEqual(await exited, { code: 130, signal: null }); }
  finally { clearTimeout(second); }
  assert.ok(Date.now() - started < 7_000, "Later signal extended the cancellation window");
  const report = JSON.parse(await readFile(log + ".result.json", "utf8"));
  assert.equal(report.interrupted, "SIGINT");
  assert.equal(report.deadlineExceeded, false);
  assert.equal(await liveGroup(payloadPid), false);
});

test("local workflow entry PID relays cancellation and finishes before runner escalation", { timeout: 14_000 }, async t => {
  const workflow = await readFile(resolve(".github/workflows/integration-api.yml"), "utf8");
  const step = workflow.split("      - name: test:api:service\n")[1]?.split("\n      - ")[0];
  assert.ok(step, "Actual API proof workflow step is missing");
  const body = /^        run: \|\n((?:          .*\n)+)/m.exec(step)?.[1]?.replace(/^          /gm, "");
  assert.ok(body, "Actual API proof workflow run body is missing");
  const command = "npm run test:api:service";
  assert.equal(body.split(command).length, 2, "Expected exactly one API proof command to replace");
  const directory = await mkdtemp(join(tmpdir(), "crew-workflow-entry-"));
  const ready = join(directory, "ready.json"), receipt = join(directory, "signal.txt");
  const payload = join(directory, "payload.mjs"), script = join(directory, "entry.sh");
  await writeFile(payload, `import {writeFileSync} from 'node:fs';
    process.on('SIGINT',()=>{writeFileSync(${JSON.stringify(receipt)},'SIGINT');process.exit(130)});
    process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(receipt)},'SIGTERM');process.exit(143)});
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,ppid:process.ppid}));
    setInterval(()=>{},1000);`);
  await writeFile(script, body.replace(command, '"$CREW_ENTRY_NODE" "$CREW_ENTRY_PAYLOAD"'));
  const entry = spawn("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: dirname(process.execPath) + ":" + process.env.PATH,
      BIRBCREW_PROOF_ARTIFACTS: directory, CREW_ENTRY_NODE: process.execPath, CREW_ENTRY_PAYLOAD: payload },
  });
  let output = "";
  entry.stdout.on("data", (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString(); });
  entry.stderr.on("data", (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString(); });
  let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  entry.once("exit", (code, signal) => { result = { code, signal }; });
  entry.once("error", error => { spawnError = error; });
  const groups = new Set<number>();
  if (entry.pid) groups.add(entry.pid);
  async function identity(pid: number) {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const [, parent, group] = text.slice(text.lastIndexOf(")") + 2).split(" ");
    assert.ok(parent && group && Number.isSafeInteger(Number(parent)) && Number.isSafeInteger(Number(group)));
    return { pid, parent: Number(parent), group: Number(group) };
  }
  async function optionalFile(path: string) {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  t.after(async () => {
    const failures: unknown[] = [];
    const processes = await readdir("/proc").then(names => Promise.all(names.filter(name => /^\d+$/.test(name)).map(async name => {
      try { return await identity(Number(name)); }
      catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return undefined;
        throw error;
      }
    }))).catch(error => { failures.push(error); return []; });
    const descendants = new Set(entry.pid ? [entry.pid] : []);
    for (let size = -1; size !== descendants.size;) {
      size = descendants.size;
      for (const proc of processes) if (proc && descendants.has(proc.parent)) descendants.add(proc.pid);
    }
    for (const proc of processes) if (proc && descendants.has(proc.pid) && descendants.has(proc.group)) groups.add(proc.group);
    const stopped = await Promise.allSettled([...groups].map(stopGroup));
    for (const outcome of stopped) if (outcome.status === "rejected") failures.push(outcome.reason);
    if (entry.pid && !spawnError) {
      try { await until(async () => result ? true : undefined, "workflow entry reaping", 1_000); }
      catch (error) { failures.push(error); }
    }
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Workflow test process cleanup failed");
  });
  assert.ok(entry.pid, "Workflow Bash entry has no PID");
  const readyText = await until(async () => {
    if (spawnError) throw spawnError;
    assert.equal(result, undefined, output);
    return optionalFile(ready);
  }, "workflow payload readiness", 3_000);
  const child = z.object({ pid: z.number().int().positive(), ppid: z.number().int().positive() }).parse(JSON.parse(readyText));
  const lineage = [await identity(child.pid)];
  assert.equal(lineage[0]?.parent, child.ppid);
  while (lineage.at(-1)?.pid !== entry.pid) {
    const parent = lineage.at(-1)?.parent;
    assert.ok(parent && parent > 1 && !lineage.some(proc => proc.pid === parent), "Payload is not owned by the workflow entry");
    lineage.push(await identity(parent));
  }
  for (const proc of lineage) {
    assert.ok(lineage.some(owner => owner.pid === proc.group), "Refusing to own an unrelated process group");
    groups.add(proc.group);
  }
  t.diagnostic("Owned workflow process ancestry " + JSON.stringify(lineage));
  const started = Date.now();
  process.kill(entry.pid, "SIGINT");
  const log = join(directory, "api.stdout.log");
  const captured = await until(async () => {
    const [signal, report] = await Promise.all([optionalFile(receipt), optionalFile(log + ".result.json")]);
    return result && signal && report ? { result, signal, report } : undefined;
  }, "workflow entry cancellation, child signal receipt, and supervisor result", 6_500);
  assert.ok(Date.now() - started < 7_000, "Workflow entry exceeded the runner cancellation window");
  assert.deepEqual(captured.result, { code: 130, signal: null }, output);
  assert.equal(captured.signal, "SIGINT");
  const report = z.object({ pid: z.number().int().positive(), interrupted: z.string(),
    outcome: z.object({ kind: z.string(), code: z.number() }), failures: z.array(z.string()) }).parse(JSON.parse(captured.report));
  assert.equal(report.pid, child.pid);
  assert.equal(report.interrupted, "SIGINT");
  assert.deepEqual(report.outcome, { kind: "exited", code: 130 });
  assert.deepEqual(report.failures, []);
  for (const group of groups) assert.equal(await liveGroup(group), false, `Owned workflow group ${group} remains`);
});

async function contractDirectory(t: TestContext) {
  const root = process.env.BIRBCREW_PROOF_ARTIFACTS ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "crew-contract-"));
  if (!process.env.BIRBCREW_PROOF_ARTIFACTS) t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixtureRun(directory: string, body: string) {
  const source = `import { withServices, until } from './tests/proof/member-services.mts';
    import { mkdir, chmod, writeFile, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { exitStatus } from './tests/proof/member-service-diagnostics.mts';
    await withServices({label:'contract'}, async s => { ${body} }).catch(error=>{console.error(error);process.exitCode=exitStatus(error)});`;
  return node(["--input-type=module", "-e", source], { ...process.env, BIRBCREW_PROOF_ARTIFACTS: directory }, 100_000);
}
async function fixtureReceipt(directory: string) {
  const entries = await readdir(directory);
  assert.equal(entries.length, 1, "Expected one fixture lifetime and cleanup receipt");
  const [entry] = entries;
  assert.ok(entry);
  const artifacts = join(directory, entry);
  const ownership = JSON.parse(await readFile(join(artifacts, "ownership.json"), "utf8"));
  const cleanup = JSON.parse(await readFile(join(artifacts, "cleanup.json"), "utf8"));
  const { stdout } = await run("docker", ["ps", "-aq", "--filter", "name=^/" + ownership.container + "$"], { timeout: 2_000, killSignal: "SIGKILL" });
  assert.equal(stdout.trim(), "", "Owned container remains");
  for (const { pid } of ownership.processes) assert.equal(await liveGroup(pid), false, `Owned group ${pid} remains`);
  return { artifacts, ownership, cleanup };
}

test("remote raw services disposal before schema creation needs no proof capture", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const source = `import {services} from './tests/proof/member-services.mts';
    import {exitStatus} from './tests/proof/member-service-diagnostics.mts';
    try {
      const s=await services();
      const first=s.close(), second=s.close();
      if(first!==second) throw new Error('raw disposal promise changed');
      await s.child(process.execPath,['-e','process.exit(0)']).then(()=>{throw new Error('allocated after close')},e=>{if(!e.message.includes('Fixture is closing')) throw e});
      await first;
      console.log('raw-before-schema-disposed');
    } catch(error) { console.error(error);process.exitCode=exitStatus(error); }`;
  const result = await node(["--input-type=module", "-e", source], { ...process.env, BIRBCREW_PROOF_ARTIFACTS: dir }, 100_000);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /raw-before-schema-disposed/);
  const receipt = await fixtureReceipt(dir);
  assert.deepEqual(receipt.cleanup.failures, []);
  assert.equal("outcome" in receipt.cleanup, false, "Raw disposal must not claim a proof outcome");
  assert.equal(receipt.cleanup.resources.container, "absent");
  assert.equal(receipt.cleanup.resources.directory, "absent");
  await assert.rejects(stat(receipt.ownership.directory), { code: "ENOENT" });
});

test("remote fixture preserves assertion across capture and directory cleanup failures", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `
    await s.child(process.execPath,['-e','setInterval(()=>{},1000)']);
    const locked=join(s.directory,'locked'); await mkdir(locked); await writeFile(join(locked,'file'),'owned'); await chmod(locked,0);
    throw new Error('primary-assertion-marker');
  `);
  assert.equal(result.code, 1, result.output);
  const receipt = await fixtureReceipt(dir);
  t.after(async () => { await chmod(join(receipt.ownership.directory, "locked"), 0o700); await rm(receipt.ownership.directory, { recursive: true, force: true }); });
  assert.match(await readFile(join(receipt.artifacts, "first-failure.txt"), "utf8"), /primary-assertion-marker/);
  assert.match(receipt.cleanup.outcome.error, /primary-assertion-marker/);
  assert.ok(receipt.cleanup.failures.length >= 2, JSON.stringify(receipt.cleanup));
});

test("remote passing body fails when managed finish cannot capture required SQL", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `
    if ('close' in s) throw new Error('Managed callback exposes disposal');
    console.log('managed-body-passed');
  `);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /managed-body-passed/);
  const receipt = await fixtureReceipt(dir);
  assert.equal(receipt.cleanup.outcome.kind, 'passed');
  assert.match(JSON.stringify(receipt.cleanup.failures), /Lifecycle SQL capture failed/);
  await assert.rejects(stat(receipt.ownership.directory), { code: "ENOENT" });
});

test("remote concurrent managed finish and SIGTERM share teardown and return 143", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `
    await s.child(process.execPath,['-e','setInterval(()=>{},1000)']);
    const started=Date.now();
    setTimeout(()=>{process.kill(process.pid,'SIGTERM');process.kill(process.pid,'SIGTERM')},50);
    process.on('exit',()=>console.log('managed-finish-ms='+(Date.now()-started)));
  `);
  assert.equal(result.code, 143, result.output);
  const elapsed = /managed-finish-ms=(\d+)/.exec(result.output);
  assert.ok(elapsed, result.output);
  assert.ok(Number(elapsed[1]) < 6_000, result.output);
  const receipt = await fixtureReceipt(dir);
  assert.equal(receipt.cleanup.outcome.status, 143);
  assert.match(await readFile(join(receipt.artifacts, "first-failure.txt"), "utf8"), /SIGTERM/);
  await assert.rejects(stat(receipt.ownership.directory), { code: "ENOENT" });
});


test("remote observation child retains exit 23 at the entry boundary", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `await s.execute(process.execPath,['-e',"console.error('observation-exit-23-marker'); process.exitCode=23"]);`);
  assert.equal(result.code, 23, result.output);
  const receipt = await fixtureReceipt(dir);
  assert.equal(receipt.cleanup.outcome.status, 23);
  assert.match(await readFile(join(receipt.artifacts, "observation.log"), "utf8"), /observation-exit-23-marker/);
  await assert.rejects(stat(receipt.ownership.directory), { code: "ENOENT" });
});


test("remote passing proof fails on a real directory cleanup failure", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `
    await s.startTemporal(); await s.worker('pi');
    await until(async()=>{try{return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.v1'") === '1' || undefined}catch{return undefined}},'fixture schema');
    const locked=join(s.directory,'locked'); await mkdir(locked); await writeFile(join(locked,'file'),'owned'); await chmod(locked,0);
  `);
  assert.equal(result.code, 1, result.output);
  const receipt = await fixtureReceipt(dir);
  t.after(async () => { await chmod(join(receipt.ownership.directory, "locked"), 0o700); await rm(receipt.ownership.directory, { recursive: true, force: true }); });
  assert.equal(receipt.cleanup.outcome.kind, "passed");
  assert.match(JSON.stringify(receipt.cleanup.failures), /Permission denied/);
  const capture = JSON.parse(await readFile(join(receipt.artifacts, "collector.json"), "utf8"));
  assert.deepEqual(capture.failures, []);
});
