import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { collectFiles, liveGroup, stopGroup } from "./member-service-diagnostics.mts";
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
  const [entry] = await readdir(directory);
  assert.ok(entry);
  const artifacts = join(directory, entry);
  const ownership = JSON.parse(await readFile(join(artifacts, "ownership.json"), "utf8"));
  const cleanup = JSON.parse(await readFile(join(artifacts, "cleanup.json"), "utf8"));
  const { stdout } = await run("docker", ["ps", "-aq", "--filter", "name=^/" + ownership.container + "$"], { timeout: 2_000, killSignal: "SIGKILL" });
  assert.equal(stdout.trim(), "", "Owned container remains");
  for (const { pid } of ownership.processes) assert.equal(await liveGroup(pid), false, `Owned group ${pid} remains`);
  return { artifacts, ownership, cleanup };
}

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

test("remote passing body fails when required capture fails and close stays stable", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `
    const first=s.close(), second=s.close();
    if (first !== second) throw new Error('close promise changed');
    const results=await Promise.allSettled([first,second]);
    if (results.some(r=>r.status!=='rejected')) throw new Error('capture failure did not fail close');
    await s.child(process.execPath,['-e','process.exit(0)']).then(()=>{throw new Error('allocated after close')},e=>{if(!e.message.includes('Fixture is closing')) throw e});
    await first;
  `);
  assert.equal(result.code, 1, result.output);
  const receipt = await fixtureReceipt(dir);
  assert.match(JSON.stringify(receipt.cleanup.failures), /Lifecycle SQL capture failed/);
  await assert.rejects(stat(receipt.ownership.directory), { code: "ENOENT" });
});

test("remote concurrent close and SIGTERM share teardown and return 143", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `
    await s.child(process.execPath,['-e','setInterval(()=>{},1000)']);
    const first=s.close(); void first.catch(()=>{});
    process.kill(process.pid,'SIGTERM'); process.kill(process.pid,'SIGTERM');
    await new Promise(()=>{});
  `);
  assert.equal(result.code, 143, result.output);
  const receipt = await fixtureReceipt(dir);
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
