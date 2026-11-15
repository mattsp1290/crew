import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { before, boundedCommand, describe, now } from "./member-service-diagnostics.mts";
import { positiveGroupProcessSchema, processKey, type PositiveGroupProcess } from "./member-service-processes.mts";
import { atomicReceipt, contractRunSchema, missingProcess, observeOwned, ownershipSchema, processIdentity,
  readContractFixture, readContractRoots, recoverFixture, regularFile, stopOwned } from "./member-service-recovery.mts";
import { until } from "./member-services.mts";

const absent = { failures: [], container: "absent", directory: "absent", processes: "absent" };

async function contractDirectory(root: string, launch: "requested" | "not-requested") {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "crew-contract-"));
  const worker = positiveGroupProcessSchema.parse(await processIdentity(process.pid));
  const run = contractRunSchema.parse({ version: 1, worker, launch: { kind: launch } });
  atomicReceipt(join(directory, "contract-run.json"), run);
  return { directory, run };
}

async function withOwner(t: TestContext, source: string, proof: (owner: {
  directory: string;
  run: Awaited<ReturnType<typeof contractDirectory>>["run"];
  deadline: number;
  output: () => string;
  wait: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ready: () => Promise<void>;
  stop: () => Promise<void>;
}) => Promise<void>) {
  const deadline = now() + 100_000, cleanupDeadline = deadline + 16_000;
  const { directory, run } = await contractDirectory(process.env.BIRBCREW_PROOF_ARTIFACTS ?? tmpdir(), "requested");
  t.diagnostic("Lifecycle evidence " + directory);
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, BIRBCREW_PROOF_ARTIFACTS: directory, BIRBCREW_CONTRACT_ROOT: directory },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let ended = false;
  void exited.then(() => { ended = true; }, () => { ended = true; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let output = "", identity: PositiveGroupProcess | undefined;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
    output += chunk.toString().slice(0, Math.max(0, 64 * 1024 - output.length));
  });
  const owned = new Map<string, PositiveGroupProcess>();
  const samplingFailures: string[] = [];
  let sampling = Promise.resolve(), samplingActive = false;
  const sample = () => {
    if (samplingActive) return;
    samplingActive = true;
    sampling = observeOwned(owned, Math.min(cleanupDeadline - 8_000, now() + 1_000))
      .then(() => {}).catch(error => { samplingFailures.push(describe(error)); })
      .finally(() => { samplingActive = false; });
  };
  let interval: NodeJS.Timeout | undefined;
  async function stop() {
    if (identity) {
      await observeOwned(owned, Math.min(cleanupDeadline - 8_000, now() + 1_000));
      const current = await processIdentity(identity.pid);
      if (current && current.state !== "Z" && current.state !== "X") {
        assert.equal(processKey(current), processKey(identity), "Owner identity changed before exact PID stop");
        assert.equal(current.group, identity.group, "Owner group changed before exact PID stop");
        try { process.kill(identity.pid, "SIGKILL"); }
        catch (error) { if (!missingProcess(error)) throw error; }
      }
    }
    await before(exited, Math.min(cleanupDeadline - 8_000, now() + 2_000), "Owned fixture creator exit");
  }
  let primary: { error: unknown } | undefined;
  try {
    assert.ok(child.pid, "Detached fixture owner has no PID");
    identity = positiveGroupProcessSchema.parse(await processIdentity(child.pid));
    assert.equal(identity.group, child.pid, "Fixture owner must lead its acquired detached group");
    assert.equal(identity.parent, process.pid, "Fixture owner must be a direct child of this worker");
    assert.notEqual(identity.group, run.worker.group, "Fixture owner must not share the test worker group");
    owned.set(processKey(identity), identity);
    interval = setInterval(sample, 100);
    await before(proof({ directory, run, deadline, output: () => output,
      wait: async () => {
        const result = await before(exited, deadline, "Fixture owner body");
        await before(closed, deadline, "Fixture owner output drain");
        return result;
      },
      ready: async () => { await until(async () => {
        if (output.includes("lifecycle-ready\n")) return true;
        assert.equal(ended, false, "Fixture owner exited before readiness\n" + output);
        return undefined;
      },
        "actual fixture owner readiness", Math.max(1, deadline - now())); }, stop }), deadline, "Lifecycle contract body");
  } catch (error) { primary = { error }; }
  finally {
    clearInterval(interval);
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>) => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    await attempt(() => before(sampling, cleanupDeadline - 8_000, "Final acquired descendant census"));
    let creatorStopped = false;
    await attempt(async () => { await stop(); creatorStopped = true; });
    if (creatorStopped) {
      await attempt(() => stopOwned(owned, Math.min(cleanupDeadline - 6_000, now() + 2_000)));
      await attempt(async () => {
        const result = await recoverFixture(directory, [...owned.values()], cleanupDeadline);
        assert.deepEqual(result, absent, "Final acknowledged resource recovery failed");
      });
    }
    await attempt(() => before(closed, cleanupDeadline, "Final owner output drain"));
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    if (samplingFailures.length) failures.push(new Error(samplingFailures.join("\n")));
    if (primary) failures.unshift(primary.error);
    if (failures.length) throw new AggregateError(failures, "Lifecycle failed; retained evidence " + directory);
  }
}

test("local contract readers discover a later root on a second census", { timeout: 8_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "crew-recovery-rescan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await contractDirectory(root, "not-requested");
  const initial = await readContractRoots(root, now() + 2_000);
  assert.deepEqual(initial, { roots: [first], failures: [] });
  const later = await contractDirectory(root, "not-requested");
  const rescanned = await readContractRoots(root, now() + 2_000);
  assert.deepEqual(rescanned.failures, []);
  assert.deepEqual(rescanned.roots.toSorted((a, b) => a.directory.localeCompare(b.directory)),
    [first, later].toSorted((a, b) => a.directory.localeCompare(b.directory)));
  await rm(root, { recursive: true });
  t.diagnostic("Reader census only; production creator barriers require the separate hosted CLI trials");
});

test("remote real overlapping service starts publish two pending acquisitions and two known children", { timeout: 120_000 }, async t => {
  const source = `import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {services} from './tests/proof/member-services.mts';
    import {ownershipSchema} from './tests/proof/member-service-recovery.mts';
    const s=await services(undefined,'contract');
    try {
      const read=()=>ownershipSchema.parse(JSON.parse(readFileSync(join(s.artifacts,'ownership.json'),'utf8')));
      const first=s.child(process.execPath,['-e','setInterval(()=>{},1000)'],s.env,'overlap-first.log');
      const second=s.child(process.execPath,['-e','setInterval(()=>{},1000)'],s.env,'overlap-second.log');
      assert.equal(read().pendingProcessAcquisitions,2,'both acquisitions must be published before either await');
      await Promise.all([first,second]);
      const settled=read();
      assert.equal(settled.pendingProcessAcquisitions,0);
      assert.equal(settled.processes.length,2);
      assert.equal(new Set(settled.processes.map(p=>p.pid)).size,2);
      for(const p of settled.processes) {
        assert.equal(p.identity.kind,'known');
        assert.equal(p.identity.group,p.pid);
      }
      console.log('overlapping-acquisitions-observed');
    } finally { await s.close(); }
    console.log('raw-close-complete');`;
  await withOwner(t, source, async owner => {
    assert.deepEqual(await owner.wait(), { code: 0, signal: null }, owner.output());
    assert.match(owner.output(), /overlapping-acquisitions-observed\n/);
    assert.match(owner.output(), /raw-close-complete\n/);
    const fixture = await readContractFixture(owner.directory, owner.run.worker, owner.deadline);
    const evidence = ownershipSchema.parse(JSON.parse(await regularFile(join(fixture.artifacts, "ownership.json"))));
    assert.equal(evidence.pendingProcessAcquisitions, 0);
    assert.equal(evidence.processes.length, 2);
    await assert.rejects(lstat(evidence.directory), { code: "ENOENT" });
    await assert.rejects(readFile(join(fixture.artifacts, "first-failure.txt")), { code: "ENOENT" });
  });
});

test("remote real acknowledged children recover after creator exit and preserve original receipts on repeat", { timeout: 120_000 }, async t => {
  const source = `import {services} from './tests/proof/member-services.mts';
    const s=await services(undefined,'contract');
    await Promise.all([
      s.child(process.execPath,['-e','setInterval(()=>{},1000)'],s.env,'fallback-first.log'),
      s.child(process.execPath,['-e','setInterval(()=>{},1000)'],s.env,'fallback-second.log')
    ]);
    console.log('lifecycle-ready');
    setInterval(()=>{},1000);`;
  await withOwner(t, source, async owner => {
    await owner.ready();
    const fixture = await readContractFixture(owner.directory, owner.run.worker, owner.deadline);
    const paths = [join(owner.directory, "contract-run.json"), join(fixture.artifacts, "owner.json"), join(fixture.artifacts, "ownership.json")];
    const originalBytes = await Promise.all(paths.map(path => regularFile(path)));
    const evidence = ownershipSchema.parse(JSON.parse(originalBytes[2] ?? ""));
    assert.equal(evidence.pendingProcessAcquisitions, 0);
    assert.equal(evidence.allocation.kind, "settled");
    assert.equal(evidence.processes.length, 2);
    const children: PositiveGroupProcess[] = [];
    for (const proc of evidence.processes) {
      assert.equal(proc.identity.kind, "known");
      const current = positiveGroupProcessSchema.parse(await processIdentity(proc.pid));
      assert.equal(current.group, proc.pid);
      assert.ok(proc.identity.kind === "known");
      assert.equal(current.startTime, proc.identity.startTime);
      assert.ok(current.state !== "Z" && current.state !== "X", "Acknowledged child must actually be live");
      children.push(current);
    }
    await lstat(evidence.directory);
    await owner.stop();
    assert.deepEqual(await owner.wait(), { code: null, signal: "SIGKILL" });
    const creator = await processIdentity(fixture.owner.fixtureOwner.pid);
    assert.ok(!creator || creator.state === "Z" || creator.state === "X", "Creator must exit before fallback");
    for (const child of children) {
      const current = positiveGroupProcessSchema.parse(await processIdentity(child.pid));
      assert.equal(processKey(current), processKey(child));
      assert.equal(current.group, child.group);
      assert.ok(current.state !== "Z" && current.state !== "X", "Fallback must begin with a live acknowledged child after creator exit");
    }
    let sampling = true, samples = 0;
    const ordering = (async () => {
      while (sampling) {
        let missing = false;
        try { await lstat(evidence.directory); }
        catch (error) { if (!missingProcess(error)) throw error; missing = true; }
        if (missing) for (const child of children) {
          const current = await processIdentity(child.pid);
          if (current) {
            assert.equal(processKey(current), processKey(child), "Sampled child PID identity changed");
            assert.equal(current.group, child.group, "Sampled child process group changed");
            assert.ok(current.state === "Z" || current.state === "X", "Private directory vanished while an owned child remained live");
          }
        }
        samples++;
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
    })();
    void ordering.catch(() => {});
    let first: Awaited<ReturnType<typeof recoverFixture>>;
    try { first = await recoverFixture(owner.directory, children, Math.min(owner.deadline, now() + 12_000)); }
    finally { sampling = false; await before(ordering, owner.deadline, "Process and directory ordering sampler"); }
    assert.deepEqual(first, absent);
    const recoveryPath = join(owner.directory, "recovery.json");
    atomicReceipt(recoveryPath, first, { immutable: true });
    const originalRecovery = await regularFile(recoveryPath);
    assert.deepEqual(await recoverFixture(owner.directory, children, Math.min(owner.deadline, now() + 12_000)), absent);
    assert.equal(await regularFile(recoveryPath), originalRecovery, "Repeat recovery overwrote original local recovery evidence");
    assert.deepEqual(await Promise.all(paths.map(path => regularFile(path))), originalBytes, "Recovery rewrote original authority receipts");
    for (const child of children) {
      const current = await processIdentity(child.pid);
      if (current) {
        assert.equal(processKey(current), processKey(child), "Final child PID identity changed");
        assert.equal(current.group, child.group, "Final child process group changed");
      }
      assert.ok(!current || current.state === "Z" || current.state === "X", "Owned child remains after fallback");
    }
    await assert.rejects(lstat(evidence.directory), { code: "ENOENT" });
    assert.ok(evidence.allocation.kind === "settled");
    for (const selector of ["name=^/" + evidence.container + "$", "id=" + evidence.allocation.container]) {
      const query = await boundedCommand("docker", ["ps", "--no-trunc", "-aq", "--filter", selector], Math.min(owner.deadline, now() + 1_500));
      assert.ok(query.stdout.kind === "complete");
      assert.equal(query.stdout.text.trim(), "", "Exact acknowledged container remains");
    }
    t.diagnostic(`Directory-first ordering samples ${samples}; unsampled windows require source review and hosted creator-barrier qualification`);
  });
});
