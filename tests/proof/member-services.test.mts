import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { before, boundedCommand, collectFiles, CommandFailure, describe, liveGroup, now, stopGroup } from "./member-service-diagnostics.mts";
import { run, until } from "./member-services.mts";

const diagnostics = resolve("tests/proof/member-service-diagnostics.mts");
const processSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(),
  group: z.number().int().positive(), startTime: z.string().regex(/^\d+$/), state: z.string() });
type ProcessIdentity = z.infer<typeof processSchema>;
function parseProcess(pid: number, text: string): ProcessIdentity {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return processSchema.parse({ pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), startTime: fields[19] });
}
function missingProcess(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
async function processIdentity(pid: number) {
  try { return parseProcess(pid, await readFile(`/proc/${pid}/stat`, "utf8")); }
  catch (error) { if (missingProcess(error)) return undefined; throw error; }
}
const processKey = (proc: Pick<ProcessIdentity, "pid" | "startTime">) => `${proc.pid}:${proc.startTime}`;
async function observeOwned(owned: Map<string, ProcessIdentity>, deadline: number) {
  const table = await before(readdir("/proc").then(names => Promise.all(names.filter(name => /^\d+$/.test(name))
    .map(name => processIdentity(Number(name))))), deadline, "Owned process census");
  const live = table.filter(proc => proc !== undefined).filter(proc => proc.state !== "Z" && proc.state !== "X");
  const anchors = live.filter(proc => owned.has(processKey(proc)));
  for (const proc of anchors) assert.equal(proc.group, owned.get(processKey(proc))?.group, "Owned process changed its group");
  const related = new Set(anchors.map(proc => proc.pid));
  const groups = new Set(anchors.map(proc => proc.group));
  for (let size = -1; size !== related.size;) {
    size = related.size;
    for (const proc of live) if (related.has(proc.parent) || groups.has(proc.group)) {
      related.add(proc.pid);
      if (proc.group === proc.pid) groups.add(proc.group);
    }
  }
  for (const proc of live) if (related.has(proc.pid)) {
    assert.ok(groups.has(proc.group), "Descendant joined a process group without an owned leader");
    owned.set(processKey(proc), proc);
  }
  return live;
}
async function stopOwned(owned: Map<string, ProcessIdentity>, deadline: number) {
  const live = await observeOwned(owned, deadline);
  const groups = new Set([...owned.values()].map(proc => proc.group));
  const results = await Promise.allSettled([...groups].map(async group => {
    const members = live.filter(proc => proc.group === group);
    if (members.length) {
      const anchor = members.find(proc => owned.has(processKey(proc)));
      assert.ok(anchor, `Process group ${group} has no surviving owned identity; absence unknown`);
      const current = await before(processIdentity(anchor.pid), deadline, "Verify process identity before signaling");
      if (current && current.state !== "Z" && current.state !== "X") {
        assert.equal(processKey(current), processKey(anchor), "Process identity changed before signaling");
        assert.equal(current.group, group, "Process group changed before signaling");
        try { process.kill(-group, "SIGKILL"); } catch (error) { if (!missingProcess(error)) throw error; }
      }
    }
    await before(until(async () => await liveGroup(group) ? undefined : true, `Owned group ${group} absence`,
      Math.max(1, deadline - now())), deadline, `Owned group ${group} absence`);
  }));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "Owned process recovery failed");
}
async function node(args: string[], env = process.env, timeout = 20_000) {
  const bodyDeadline = now() + timeout;
  let cleanupDeadline = bodyDeadline + 16_000;
  const owned = new Map<string, ProcessIdentity>(), cleanupFailures: string[] = [];
  const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let output = "", timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { if (output.length < 64 * 1024) output += chunk.toString(); });
  let sampling = Promise.resolve(), samplingActive = false;
  const sample = () => {
    if (samplingActive) return;
    samplingActive = true;
    sampling = observeOwned(owned, Math.min(cleanupDeadline, now() + 1_000)).then(() => {})
      .catch(error => { cleanupFailures.push(describe(error)); }).finally(() => { samplingActive = false; });
  };
  let interval: NodeJS.Timeout | undefined, timer: NodeJS.Timeout | undefined;
  let result: Awaited<typeof exited> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    if (child.pid) {
      const identity = parseProcess(child.pid, readFileSync(`/proc/${child.pid}/stat`, "utf8"));
      owned.set(processKey(identity), identity);
    }
    interval = setInterval(sample, 100);
    const timeoutResult = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), Math.max(0, bodyDeadline - now())); });
    const first = await Promise.race([exited, timeoutResult]);
    cleanupDeadline = Math.min(cleanupDeadline, now() + 16_000);
    if (first === "timeout") {
      timedOut = true;
      await observeOwned(owned, cleanupDeadline - 9_000);
      if (child.pid) {
        const identity = await processIdentity(child.pid);
        assert.ok(identity && owned.has(processKey(identity)), "Entry identity unavailable for cancellation");
        child.kill("SIGTERM");
      }
      const grace = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6_000); });
      result = await Promise.race([exited, grace]);
    } else result = first;
  } catch (error) { failure = { error }; }
  finally {
    clearTimeout(timer); clearInterval(interval);
    cleanupDeadline = Math.min(cleanupDeadline, now() + 16_000);
    try { await before(sampling, cleanupDeadline - 8_000, "Final process census"); }
    catch (error) { cleanupFailures.push(describe(error)); }
    try { await stopOwned(owned, Math.min(cleanupDeadline - 8_000, now() + 2_000)); }
    catch (error) { cleanupFailures.push(describe(error)); }
    try { result ??= await before(exited, Math.min(cleanupDeadline - 7_500, now() + 500), "Contract entry reaping"); }
    catch (error) { cleanupFailures.push(describe(error)); }
    try { await before(closed, Math.min(cleanupDeadline - 7_000, now() + 500), "Contract output drain"); }
    catch (error) { cleanupFailures.push(describe(error)); }
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  if (failure) {
    if (!result) throw failure.error;
    cleanupFailures.unshift(describe(failure.error));
  }
  assert.ok(result, "Contract command exit unknown");
  return { ...result, output, timedOut, cleanupFailures, processes: [...owned.values()], cleanupDeadline };
}

test("local raw process parser accepts the retained Colima host kthreadd row", () => {
  const stat = "2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 6 0 0 20 0 1 0 0 0 0 18446744073709551615 0 0 0 0 0 0 0 2147483647 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
  assert.deepEqual(parseProcess(2, stat), { pid: 2, parent: 0, group: 0, startTime: "0", state: "S" });
});

test("local raw process parser rejects malformed observed fields", () => {
  const fields = ["S", "0", "23", ...Array<string>(16).fill("0"), "0"];
  const row = (parts: string[]) => "23 (payload with spaces) " + parts.join(" ");
  assert.deepEqual(parseProcess(23, row(fields)), { pid: 23, parent: 0, group: 23, startTime: "0", state: "S" });
  for (const [index, value] of [[1, "invalid"], [2, "-1"], [2, "1.5"], [19, "missing"]] satisfies [number, string][]) {
    const invalid = fields.with(index, value);
    assert.throws(() => parseProcess(23, row(invalid)));
  }
  assert.throws(() => parseProcess(23, row(fields.slice(0, 19))));
});

test("local capture preserves exit 23 and marker, including a failed destination", async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "command.log");
  const source = "console.error('unique-exit-23-marker'); process.exitCode = 23";
  const result = await node([diagnostics, "--command", log, process.execPath, "-e", source]);
  assert.equal(result.timedOut, false, "Contract command timed out");
  assert.deepEqual(result.cleanupFailures, []);
  assert.equal(result.code, 23, result.output);
  assert.match(await readFile(log, "utf8"), /unique-exit-23-marker/);
  const failed = await node([diagnostics, "--command", join(dir, "missing", "command.log"), process.execPath, "-e", source]);
  assert.equal(failed.timedOut, false, "Contract command timed out");
  assert.deepEqual(failed.cleanupFailures, []);
  assert.equal(failed.code, 23, failed.output);
  assert.match(failed.output, /unique-exit-23-marker/);
  assert.match(failed.output, /ENOENT/);
  const passed = await node([diagnostics, "--command", join(dir, "missing", "passed.log"), process.execPath, "-e", "process.exitCode=0"]);
  assert.equal(passed.timedOut, false, "Contract command timed out");
  assert.deepEqual(passed.cleanupFailures, []);
  assert.equal(passed.code, 1, passed.output);
  const ordinaryDeadlineCode = join(dir, "ordinary-124.log");
  const ordinary = await node([diagnostics, "--command", ordinaryDeadlineCode, process.execPath, "-e", "process.exitCode=124"]);
  assert.equal(ordinary.timedOut, false, "Contract command timed out");
  assert.deepEqual(ordinary.cleanupFailures, []);
  assert.equal(ordinary.code, 124, ordinary.output);
  assert.equal(JSON.parse(await readFile(ordinaryDeadlineCode + ".result.json", "utf8")).deadlineExceeded, false);
});

test("local capture drains oversized output and retains a finite log", async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "command.log");
  const result = await node([diagnostics, "--command", log, process.execPath, "-e", "process.stdout.write(Buffer.alloc(10*1024*1024, 120))"]);
  assert.equal(result.timedOut, false, "Contract command timed out");
  assert.deepEqual(result.cleanupFailures, []);
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
  t.diagnostic(JSON.stringify({ receivedBytes: result.received, retainedUtf8Bytes: Buffer.byteLength(result.diagnostics, "utf8") }));
  assert.equal(result.received, repetitions * 4, "Command output was not fully drained");
  assert.ok(Buffer.byteLength(result.diagnostics, "utf8") <= 128 * 1024, "Retained output exceeds its byte limit");
  assert.match(result.diagnostics, /^(?:\u{1f600})+$/u, "Retained output contains a split UTF-8 character");
  if (pid !== undefined) assert.equal(await liveGroup(pid), false, `Owned output group ${pid} remains`);
});

test("local bounded command decodes a character split across writes only after draining", { timeout: 8_000 }, async () => {
  const source = `const bytes=Buffer.from('😀');process.stdout.write(bytes.subarray(0,1));
    setTimeout(()=>{process.stdout.write(bytes.subarray(1));process.stdout.write('€'.repeat(50000))},50);`;
  const result = await boundedCommand(process.execPath, ["-e", source], now() + 4_000);
  assert.equal(result.received, 4 + 150_000);
  assert.equal(result.retained, 128 * 1024);
  assert.match(result.diagnostics, /^😀€+\uFFFD$/u, "Only the final truncation boundary may contain a replacement character");
  assert.equal(result.diagnostics.indexOf("\uFFFD"), result.diagnostics.length - 1);
  if (result.pid) assert.equal(await liveGroup(result.pid), false);
});

async function boundedNode(t: TestContext, source: string) {
  let pid: number | undefined;
  t.after(async () => {
    if (pid !== undefined) {
      await stopGroup(pid);
      assert.equal(await liveGroup(pid), false, `Owned output group ${pid} remains`);
    }
  });
  try {
    const result = await boundedCommand(process.execPath, ["-e", source], now() + 4_000);
    pid = result.pid;
    if (pid !== undefined) t.diagnostic(`Owned process group ${pid}`);
    return result;
  } catch (error) {
    if (error instanceof Error && "pid" in error && typeof error.pid === "number" && Number.isSafeInteger(error.pid) && error.pid > 0) {
      pid = error.pid;
      t.diagnostic(`Owned process group ${pid}`);
    }
    throw error;
  }
}

test("local bounded command preserves protocol ID stdout alongside a stderr warning", { timeout: 8_000 }, async t => {
  const id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const warning = "channel-warning-before-id\n", stdout = id + "\n";
  const source = `process.stderr.write(${JSON.stringify(warning)},()=>process.stdout.write(${JSON.stringify(stdout)}))`;
  const result = await boundedNode(t, source);
  assert.ok("stdout" in result);
  assert.deepEqual(result.stdout, { kind: "complete", text: stdout, received: 65, retained: 65 });
  const protocol = z.object({ text: z.string() }).parse(result.stdout);
  assert.equal(z.string().regex(/^[a-f0-9]{64}$/).parse(protocol.text.trim()), id);
  assert.ok("diagnostics" in result && typeof result.diagnostics === "string");
  assert.ok(result.diagnostics.includes(warning));
  assert.equal(result.received, Buffer.byteLength(warning) + 65);
  assert.equal(result.retained, result.received);
  if (result.pid !== undefined) assert.equal(await liveGroup(result.pid), false, `Owned output group ${result.pid} remains`);
});

test("local bounded command keeps protocol ID stdout after stderr exceeds the diagnostic cap", { timeout: 8_000 }, async t => {
  const id = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const stderrBytes = 128 * 1024 + 1, stdout = id + "\n";
  const source = `process.stderr.write(Buffer.alloc(${stderrBytes},119),()=>process.stdout.write(${JSON.stringify(stdout)}))`;
  const result = await boundedNode(t, source);
  assert.ok("stdout" in result);
  assert.deepEqual(result.stdout, { kind: "complete", text: stdout, received: 65, retained: 65 });
  const protocol = z.object({ text: z.string() }).parse(result.stdout);
  assert.equal(z.string().regex(/^[a-f0-9]{64}$/).parse(protocol.text.trim()), id);
  assert.ok("diagnostics" in result && typeof result.diagnostics === "string");
  assert.equal(Buffer.byteLength(result.diagnostics), 128 * 1024);
  assert.equal(result.received, stderrBytes + 65, "Both command streams were not fully drained");
  assert.equal(result.retained, 128 * 1024);
  if (result.pid !== undefined) assert.equal(await liveGroup(result.pid), false, `Owned output group ${result.pid} remains`);
});

test("local bounded command preserves protocol JSON row stdout alongside a stderr warning", { timeout: 8_000 }, async t => {
  const stdout = '{"conversation_id":"channel-contract","attempt":2}\n';
  const warning = "channel-warning-before-json-row\n", stdoutBytes = Buffer.byteLength(stdout);
  const source = `process.stderr.write(${JSON.stringify(warning)},()=>process.stdout.write(${JSON.stringify(stdout)}))`;
  const result = await boundedNode(t, source);
  assert.ok("stdout" in result);
  assert.deepEqual(result.stdout, { kind: "complete", text: stdout, received: stdoutBytes, retained: stdoutBytes });
  assert.ok("diagnostics" in result && typeof result.diagnostics === "string");
  assert.ok(result.diagnostics.includes(warning));
  assert.equal(result.received, Buffer.byteLength(warning) + stdoutBytes);
  assert.equal(result.retained, result.received);
  if (result.pid !== undefined) assert.equal(await liveGroup(result.pid), false, `Owned output group ${result.pid} remains`);
});

test("local bounded command reconstructs stdout emoji across an intervening stderr write", { timeout: 8_000 }, async t => {
  const warning = "channel-warning-between-stdout-bytes\n";
  const source = `const bytes=Buffer.from('😀');process.stdout.write(bytes.subarray(0,1),()=>{
    process.stderr.write(${JSON.stringify(warning)},()=>setTimeout(()=>process.stdout.write(bytes.subarray(1)),50))
  })`;
  const result = await boundedNode(t, source);
  assert.ok("stdout" in result);
  assert.deepEqual(result.stdout, { kind: "complete", text: "😀", received: 4, retained: 4 });
  assert.ok("diagnostics" in result && typeof result.diagnostics === "string");
  assert.ok(result.diagnostics.includes(warning));
  assert.equal(result.received, 4 + Buffer.byteLength(warning));
  assert.equal(result.retained, result.received);
  if (result.pid !== undefined) assert.equal(await liveGroup(result.pid), false, `Owned output group ${result.pid} remains`);
});

test("local bounded command marks stdout beyond 131072 bytes as truncated without protocol text", { timeout: 8_000 }, async t => {
  const source = "process.stdout.write(Buffer.alloc(131073,120))";
  const result = await boundedNode(t, source);
  assert.ok("stdout" in result);
  assert.deepEqual(result.stdout, { kind: "truncated", received: 131073, retained: 131072 });
  assert.ok("diagnostics" in result && typeof result.diagnostics === "string");
  assert.equal(result.diagnostics, "x".repeat(131072));
  assert.equal(result.received, 131073, "Oversized stdout was not fully drained");
  assert.equal(result.retained, 131072);
  if (result.pid !== undefined) assert.equal(await liveGroup(result.pid), false, `Owned output group ${result.pid} remains`);
});

for (const code of [23, 124]) {
  test(`local bounded command failure preserves nested ordinary exit ${code} and stderr marker`, { timeout: 8_000 }, async t => {
    let pid: number | undefined;
    t.after(async () => {
      if (pid !== undefined) {
        await stopGroup(pid);
        assert.equal(await liveGroup(pid), false, `Owned output group ${pid} remains`);
      }
    });
    const marker = `bounded-command-stderr-exit-${code}`;
    const source = `process.stderr.write(${JSON.stringify(marker + "\n")},()=>{
      process.stdout.write('ordinary-exit-${code}-stdout\\n',()=>{process.exitCode=${code}})
    })`;
    await assert.rejects(boundedCommand(process.execPath, ["-e", source], now() + 4_000), (error: unknown) => {
      if (error instanceof Error && "pid" in error && typeof error.pid === "number" && Number.isSafeInteger(error.pid) && error.pid > 0) {
        pid = error.pid;
        t.diagnostic(`Owned process group ${pid}`);
      }
      assert.ok(error instanceof AggregateError);
      const [first]: unknown[] = error.errors;
      assert.ok(first instanceof CommandFailure);
      assert.deepEqual(first.result, { kind: "exited", code });
      assert.ok(first.message.includes(marker));
      assert.ok(error.message.includes(marker));
      return true;
    });
    if (pid !== undefined) assert.equal(await liveGroup(pid), false, `Owned output group ${pid} remains`);
  });
}

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
  assert.equal(outcome.result.timedOut, true);
  assert.deepEqual(outcome.result.cleanupFailures, []);
  assert.notEqual(outcome.result.code, 0, outcome.result.output);
  assert.notEqual(outcome.result.signal, "SIGKILL", "Timeout prevented catchable payload cancellation");
  assert.equal(await readFile(receipt, "utf8"), "SIGTERM");
  for (const group of groups) assert.equal(await liveGroup(group), false, `Owned timeout group ${group} remains at helper return`);
});

test("local subprocess timeout escalates after a detached group leader exits", { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-helper-force-"));
  const ready = join(dir, "ready.json"), term = join(dir, "term.txt");
  const owned = new Map<string, ProcessIdentity>();
  let pending: Promise<Awaited<ReturnType<typeof node>>> | undefined;
  t.after(async () => {
    await pending?.catch(() => {});
    try { await stopOwned(owned, now() + 3_000); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  const branch = `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    setTimeout(()=>process.exit(0),450);`;
  const source = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',${JSON.stringify(branch)}],{detached:true,stdio:'ignore'});
    process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(term)},'SIGTERM'));
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({entry:process.pid,descendant:child.pid}));setInterval(()=>{},1000);`;
  const started = Date.now();
  pending = node(["--input-type=module", "-e", source], process.env, 1_000);
  void pending.catch(() => {});
  await until(async () => readFile(ready, "utf8").catch(error => { if (missingProcess(error)) return undefined; throw error; }), "forced payload readiness", 3_000);
  const identities = z.object({ entry: z.number().int().positive(), descendant: z.number().int().positive() })
    .parse(JSON.parse(await readFile(ready, "utf8")));
  for (const pid of Object.values(identities)) {
    const identity = await processIdentity(pid);
    assert.ok(identity, "Forced payload exited before identity capture");
    owned.set(processKey(identity), identity);
  }
  const result = await pending;
  for (const identity of result.processes) owned.set(processKey(identity), identity);
  assert.ok(result.processes.some(proc => proc.group === identities.descendant && proc.pid !== identities.descendant),
    "Detached descendant identity was lost when its leader exited");
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(result.cleanupFailures, []);
  assert.equal(await readFile(term, "utf8"), "SIGTERM");
  assert.ok(Date.now() - started < 12_000, "Forced cleanup exceeded the local parent reserve");
  for (const pid of Object.values(identities)) {
    assert.ok(result.processes.some(proc => proc.pid === pid && /^\d+$/.test(proc.startTime)), "Missing pre-kill identity");
    assert.equal(await liveGroup(pid), false, `Owned forced group ${pid} remains`);
  }
});

test("local supervising assertion failure sees descendants already disposed", { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "crew-helper-assertion-"));
  const ready = join(dir, "ready.json");
  const owned = new Map<string, ProcessIdentity>();
  let pending: Promise<Awaited<ReturnType<typeof node>>> | undefined;
  t.after(async () => {
    await pending?.catch(() => {});
    try { await stopOwned(owned, now() + 3_000); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  const source = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({entry:process.pid,descendant:child.pid}));
    setTimeout(()=>process.exit(23),500);`;
  pending = node(["--input-type=module", "-e", source]);
  void pending.catch(() => {});
  await until(async () => readFile(ready, "utf8").catch(error => { if (missingProcess(error)) return undefined; throw error; }), "assertion payload readiness", 3_000);
  const identities = z.object({ entry: z.number().int().positive(), descendant: z.number().int().positive() })
    .parse(JSON.parse(await readFile(ready, "utf8")));
  for (const pid of Object.values(identities)) {
    const identity = await processIdentity(pid);
    assert.ok(identity, "Assertion payload exited before identity capture");
    owned.set(processKey(identity), identity);
  }
  const result = await pending;
  await assert.rejects(async () => {
    assert.equal(result.code, 0, "supervising-assertion-canary");
  }, /supervising-assertion-canary/);
  assert.equal(result.code, 23);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.cleanupFailures, []);
  for (const pid of Object.values(identities)) assert.equal(await liveGroup(pid), false, `Assertion path left owned group ${pid}`);
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
  assert.equal(result.timedOut, false, "Contract command timed out");
  assert.deepEqual(result.cleanupFailures, []);
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
  const owned = new Map<string, ProcessIdentity>();
  async function identity(pid: number) {
    const found = await processIdentity(pid);
    assert.ok(found, `Workflow process ${pid} identity is missing`);
    owned.set(processKey(found), found);
    return found;
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
    try { await stopOwned(owned, now() + 3_000); }
    catch (error) { failures.push(error); }
    if (entry.pid && !spawnError) {
      try { await until(async () => result ? true : undefined, "workflow entry reaping", 1_000); }
      catch (error) { failures.push(error); }
    }
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Workflow test process cleanup failed");
  });
  if (entry.pid) {
    const initial = parseProcess(entry.pid, readFileSync(`/proc/${entry.pid}/stat`, "utf8"));
    owned.set(processKey(initial), initial);
  }
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
  await observeOwned(owned, now() + 1_000);
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

const ownershipSchema = z.object({
  label: z.literal("contract"), directory: z.string(), container: z.string().regex(/^birb-proof-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  allocation: z.discriminatedUnion("kind", [z.object({ kind: z.literal("not-started") }), z.object({ kind: z.literal("pending") }),
    z.object({ kind: z.literal("settled"), container: z.string().regex(/^[0-9a-f]{64}$/) })]),
  processes: z.array(z.object({ pid: z.number().int().positive(), log: z.string(),
    identity: z.discriminatedUnion("kind", [z.object({ kind: z.literal("pending") }),
      z.object({ kind: z.literal("known"), group: z.number().int().positive(), startTime: z.string().regex(/^\d+$/) })]) })),
});
async function regularFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { assert.ok((await file.stat()).isFile(), "Ownership evidence must be a regular file"); return await file.readFile("utf8"); }
  finally { await file.close(); }
}
async function recoverFixture(directory: string, observed: ProcessIdentity[], deadline: number) {
  const recovery: { failures: string[]; container: "absent" | "unknown"; directory: "absent" | "unknown";
    processes: "absent" | "unknown" } = { failures: [], container: "unknown", directory: "unknown", processes: "unknown" };
  const attempt = async (operation: () => Promise<void>) => {
    try { await before(operation(), deadline - 300, "Fixture recovery"); }
    catch (error) { recovery.failures.push(describe(error)); }
  };
  const evidence = await before((async () => {
    assert.ok((await lstat(directory)).isDirectory(), "Contract root must be a real directory");
    const entries = (await readdir(directory)).filter(name => name !== "recovery.json");
    assert.equal(entries.length, 1, "Expected exactly one fixture ownership entry");
    const entry = entries[0];
    assert.ok(entry && /^contract-[a-zA-Z0-9]+$/.test(entry), "Unexpected fixture artifact entry");
    const artifacts = join(directory, entry);
    assert.ok((await lstat(artifacts)).isDirectory(), "Fixture artifacts must be a real directory");
    assert.equal(dirname(await realpath(artifacts)), await realpath(directory), "Fixture artifacts escaped contract root");
    return ownershipSchema.parse(JSON.parse(await regularFile(join(artifacts, "ownership.json"))));
  })(), deadline - 300, "Fixture ownership evidence").catch(error => { recovery.failures.push(describe(error)); return undefined; });
  const owned = new Map(observed.map(proc => [processKey(proc), proc]));
  if (evidence) for (const proc of evidence.processes) {
    if (proc.identity.kind === "pending") { recovery.failures.push("Recorded process identity is pending; absence unknown"); continue; }
    if (proc.pid !== proc.identity.group) { recovery.failures.push("Recorded fixture process is not a group leader"); continue; }
    const identity = { pid: proc.pid, ...proc.identity, parent: 0, state: "recorded" };
    owned.set(processKey(identity), identity);
  }
  await Promise.all([
    attempt(async () => {
      await stopOwned(owned, deadline - 500);
      if (evidence && evidence.processes.every(proc => proc.identity.kind === "known" && proc.identity.group === proc.pid)) recovery.processes = "absent";
    }),
    ...(evidence ? [attempt(async () => {
      if (evidence.allocation.kind === "not-started") { recovery.container = "absent"; return; }
      const query = () => boundedCommand("docker", ["ps", "-aq", "--filter", "name=^/" + evidence.container + "$"], Math.min(deadline - 500, now() + 1_500));
      const found = await query();
      assert.ok(found.stdout.kind === "complete", "Docker recovery presence query stdout was truncated");
      if (found.stdout.text.trim()) {
        const inspected = await boundedCommand("docker", ["inspect", "--format",
          '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', evidence.container], Math.min(deadline - 500, now() + 1_500));
        assert.ok(inspected.stdout.kind === "complete", "Docker recovery inspection stdout was truncated");
        const [id, name, marker] = inspected.stdout.text.trim().split(/\s+/);
        assert.ok(id && /^[a-f0-9]{64}$/.test(id), "Container identity missing");
        assert.equal(name, "/" + evidence.container, "Container name disagrees with ownership");
        assert.equal(marker, evidence.container, "Container label disagrees with ownership");
        if (evidence.allocation.kind === "settled") assert.equal(id, evidence.allocation.container, "Allocated container identity changed");
        await boundedCommand("docker", ["rm", "-f", id], Math.min(deadline - 500, now() + 2_000));
      }
      const remaining = await query();
      assert.ok(remaining.stdout.kind === "complete", "Docker recovery absence query stdout was truncated");
      assert.equal(remaining.stdout.text.trim(), "", "Exact owned container remains");
      assert.notEqual(evidence.allocation.kind, "pending", "Docker allocation pending; eventual absence unknown");
      recovery.container = "absent";
    }), attempt(async () => {
      const path = evidence.directory, temporary = await realpath(tmpdir());
      assert.ok(isAbsolute(path) && /^birb-members-[a-zA-Z0-9]+$/.test(basename(path)), "Unexpected fixture directory");
      assert.equal(await realpath(dirname(path)), temporary, "Fixture directory is outside the actual temporary root");
      assert.notEqual(resolve(path), resolve(directory), "Fixture directory is the artifact root");
      assert.notEqual(resolve(path), temporary, "Fixture directory is the temporary root");
      let metadata;
      try { metadata = await lstat(path); }
      catch (error) { if (missingProcess(error)) { recovery.directory = "absent"; return; } throw error; }
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), "Fixture directory was replaced by a symlink");
      assert.equal(dirname(await realpath(path)), temporary, "Fixture directory resolved outside temporary root");
      assert.equal(await regularFile(join(path, ".fixture-owner")), evidence.container, "Fixture directory marker disagrees with ownership");
      await boundedCommand("chmod", ["-R", "u+rwX", "--", path], Math.min(deadline - 500, now() + 1_500));
      await boundedCommand("rm", ["-rf", "--", path], Math.min(deadline - 500, now() + 2_000));
      await assert.rejects(lstat(path), { code: "ENOENT" });
      recovery.directory = "absent";
    })] : []),
  ]);
  await attempt(() => writeFile(join(directory, "recovery.json"), JSON.stringify(recovery, null, 2), { mode: 0o600 }));
  return recovery;
}
async function fixtureNode(directory: string, args: string[]) {
  const absoluteDeadline = now() + 116_000;
  let command: Awaited<ReturnType<typeof node>> | undefined;
  let failure: { error: unknown } | undefined;
  let recovery: Awaited<ReturnType<typeof recoverFixture>>;
  try { command = await node(args, { ...process.env, BIRBCREW_PROOF_ARTIFACTS: directory }, 100_000); }
  catch (error) { failure = { error }; }
  finally { recovery = await recoverFixture(directory, command?.processes ?? [],
    Math.min(absoluteDeadline, command?.cleanupDeadline ?? now() + 16_000)); }
  if (failure) {
    console.error("Fixture command recovery", recovery);
    throw failure.error;
  }
  assert.ok(command, "Fixture command result missing");
  return { ...command, recovery };
}
function recovered(result: Awaited<ReturnType<typeof fixtureNode>>) {
  assert.deepEqual(result.cleanupFailures, [], "Contract process cleanup failed");
  assert.deepEqual(result.recovery, { failures: [], container: "absent", directory: "absent", processes: "absent" });
}

test("local fixture recovery rejects missing and malformed ownership without guessed deletion", async t => {
  for (const malformed of [false, true]) {
    const directory = await contractDirectory(t);
    if (malformed) {
      const artifacts = await mkdtemp(join(directory, "contract-"));
      await writeFile(join(artifacts, "ownership.json"), '{"container":"unowned"}');
    }
    const result = await recoverFixture(directory, [], now() + 3_000);
    assert.ok(result.failures.length > 0);
    assert.equal(result.container, "unknown");
    assert.equal(result.directory, "unknown");
    assert.equal(result.processes, "unknown");
  }
});

async function fixtureRun(directory: string, body: string) {
  const source = `import { withServices, until } from './tests/proof/member-services.mts';
    import { mkdir, chmod, writeFile, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { exitStatus } from './tests/proof/member-service-diagnostics.mts';
    await withServices({label:'contract'}, async s => { ${body} }).catch(error=>{console.error(error);process.exitCode=exitStatus(error)});`;
  return fixtureNode(directory, ["--input-type=module", "-e", source]);
}
async function fixtureReceipt(directory: string) {
  const entries = (await readdir(directory)).filter(name => name !== "recovery.json");
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
      const s=await services(undefined, "contract");
      const first=s.close(), second=s.close();
      if(first!==second) throw new Error('raw disposal promise changed');
      await s.child(process.execPath,['-e','process.exit(0)']).then(()=>{throw new Error('allocated after close')},e=>{if(!e.message.includes('Fixture is closing')) throw e});
      await first;
      console.log('raw-before-schema-disposed');
    } catch(error) { console.error(error);process.exitCode=exitStatus(error); }`;
  const result = await fixtureNode(dir, ["--input-type=module", "-e", source]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /raw-before-schema-disposed/);
  recovered(result);
  assert.equal(result.timedOut, false, "Fixture command timed out");
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
  recovered(result);
  assert.equal(result.timedOut, false, "Fixture command timed out");
  const receipt = await fixtureReceipt(dir);
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
  recovered(result);
  assert.equal(result.timedOut, false, "Fixture command timed out");
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
  recovered(result);
  assert.equal(result.timedOut, false, "Fixture command timed out");
  const receipt = await fixtureReceipt(dir);
  assert.equal(receipt.cleanup.outcome.status, 143);
  assert.match(await readFile(join(receipt.artifacts, "first-failure.txt"), "utf8"), /SIGTERM/);
  await assert.rejects(stat(receipt.ownership.directory), { code: "ENOENT" });
});


test("remote observation child retains exit 23 at the entry boundary", { timeout: 120_000 }, async t => {
  const dir = await contractDirectory(t);
  const result = await fixtureRun(dir, `await s.execute(process.execPath,['-e',"console.error('observation-exit-23-marker'); process.exitCode=23"]);`);
  assert.equal(result.code, 23, result.output);
  recovered(result);
  assert.equal(result.timedOut, false, "Fixture command timed out");
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
  recovered(result);
  assert.equal(result.timedOut, false, "Fixture command timed out");
  const receipt = await fixtureReceipt(dir);
  assert.equal(receipt.cleanup.outcome.kind, "passed");
  assert.match(JSON.stringify(receipt.cleanup.failures), /Permission denied/);
  const capture = JSON.parse(await readFile(join(receipt.artifacts, "collector.json"), "utf8"));
  assert.deepEqual(capture.failures, []);
});

for (const mode of ["catchable", "forced"] as const) {
  test(`remote real fixture ${mode} timeout recovers PostgreSQL, Temporal and worker`, { timeout: 120_000 }, async t => {
    const dir = await contractDirectory(t), started = Date.now();
    const result = await fixtureRun(dir, `
      await s.startTemporal(); await s.worker('pi');
      await until(async()=>{try{return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.v1'") === '1' || undefined}catch{return undefined}},'real timeout fixture registration');
      const {writeFileSync,readFileSync}=await import('node:fs');
      const ownership=JSON.parse(readFileSync(join(s.artifacts,'ownership.json'),'utf8'));
      if(ownership.allocation.kind!=='settled'||ownership.processes.length<2||ownership.processes.some(p=>p.identity.kind!=='known')) throw new Error('early ownership publication incomplete');
      writeFileSync(join(s.artifacts,'timeout-ready.json'),JSON.stringify(ownership));
      ${mode === "forced" ? "process.removeAllListeners('SIGTERM');" : ""}
      process.on('SIGTERM',()=>writeFileSync(join(s.artifacts,'term.txt'),'SIGTERM'));
      await new Promise(()=>{});
    `);
    assert.equal(result.timedOut, true, result.output);
    assert.ok(Date.now() - started < 119_000, "Fixture timeout consumed the parent deadline");
    recovered(result);
    const [entry] = (await readdir(dir)).filter(name => /^contract-/.test(name));
    assert.ok(entry);
    const artifacts = join(dir, entry);
    const ownership = ownershipSchema.parse(JSON.parse(await regularFile(join(artifacts, "timeout-ready.json"))));
    assert.equal(await readFile(join(artifacts, "term.txt"), "utf8"), "SIGTERM");
    assert.equal((await run("docker", ["ps", "-aq", "--filter", "name=^/" + ownership.container + "$"],
      { timeout: 2_000, killSignal: "SIGKILL" })).stdout.trim(), "");
    await assert.rejects(lstat(ownership.directory), { code: "ENOENT" });
    for (const proc of ownership.processes) assert.equal(await liveGroup(proc.pid), false, `Owned fixture group ${proc.pid} remains`);
    if (mode === "catchable") {
      assert.equal(result.code, 143, result.output);
      const original = JSON.parse(await readFile(join(artifacts, "cleanup.json"), "utf8"));
      assert.equal(original.outcome.status, 143);
      assert.match(await readFile(join(artifacts, "first-failure.txt"), "utf8"), /SIGTERM/);
    } else {
      assert.equal(result.signal, "SIGKILL");
      await assert.rejects(lstat(join(artifacts, "cleanup.json")), { code: "ENOENT" });
    }
  });
}
