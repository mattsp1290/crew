import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { before, now } from "./member-service-diagnostics.mts";
import { inspectContracts, type ContractInspectionReport } from "./member-service-inspection.mts";
import { positiveGroupProcessSchema } from "./member-service-processes.mts";
import { atomicReceipt, contractRecoveryReportSchema, contractRunSchema, ownershipSchema, processIdentity,
  readContractFixture } from "./member-service-recovery.mts";

const exitedFixtureSchema = z.object({
  worker: positiveGroupProcessSchema,
  fixtureOwner: positiveGroupProcessSchema,
  directory: ownershipSchema.shape.directory,
  container: ownershipSchema.shape.container,
}).strict();

async function historyFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crew-recovery-history-"));
  const directory = join(root, "crew-contract-proof"), artifacts = join(directory, "contract-proof");
  let privateDirectory: string | undefined;
  t.after(async () => {
    try {
      if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(artifacts, { recursive: true });
  const ownerCode = `import {mkdtemp,writeFile,rm} from 'node:fs/promises';
    import {join} from 'node:path'; import {tmpdir} from 'node:os'; import {randomUUID} from 'node:crypto';
    import {processIdentity,atomicReceipt} from './tests/proof/member-service-recovery.mts';
    const watchdog=setTimeout(()=>process.exit(1),3500);
    let directory, published=false;
    try {
      const fixtureOwner=await processIdentity(process.pid), container='birb-proof-'+randomUUID();
      directory=await mkdtemp(join(tmpdir(),'birb-members-'));
      await writeFile(join(directory,'.fixture-owner'),container);
      atomicReceipt(${JSON.stringify(join(artifacts, "owner.json"))},{version:1,fixtureOwner},{immutable:true});
      atomicReceipt(${JSON.stringify(join(artifacts, "ownership.json"))},{version:1,pendingProcessAcquisitions:0,
        label:'contract',directory,container,allocation:{kind:'not-started'},processes:[]});
      console.log(JSON.stringify({fixtureOwner,directory,container}));
      published=true;
    } finally {
      if(!published && directory) await rm(directory,{recursive:true,force:true});
      clearTimeout(watchdog);
    }`;
  const workerCode = `import assert from 'node:assert/strict'; import {spawn} from 'node:child_process';
    import {processIdentity} from './tests/proof/member-service-recovery.mts';
    const watchdog=setTimeout(()=>process.exit(1),4500);
    try {
      const worker=await processIdentity(process.pid);
      const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(ownerCode)}],
        {detached:true,stdio:['ignore','pipe','pipe']});
      let output='', errors='';
      child.stdout.on('data',chunk=>output+=chunk.toString().slice(0,Math.max(0,16384-output.length)));
      child.stderr.on('data',chunk=>errors+=chunk.toString().slice(0,Math.max(0,16384-errors.length)));
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
      assert.equal(code,0,errors);
      console.log(JSON.stringify({worker,...JSON.parse(output)}));
    } finally {clearTimeout(watchdog);}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", workerCode], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString().slice(0, Math.max(0, 16_384 - output.length)); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString().slice(0, Math.max(0, 16_384 - errors.length)); });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(await before(closed, now() + 5_000, "Naturally exiting history fixture"), 0, errors);
  const actual = exitedFixtureSchema.parse(JSON.parse(output));
  privateDirectory = actual.directory;
  assert.equal(actual.worker.pid, child.pid);
  assert.equal(actual.worker.group, actual.worker.pid);
  assert.equal(actual.worker.parent, process.pid);
  assert.equal(actual.fixtureOwner.parent, actual.worker.pid);
  assert.equal(actual.fixtureOwner.group, actual.fixtureOwner.pid);
  assert.notEqual(actual.fixtureOwner.group, actual.worker.group);
  assert.equal(await processIdentity(actual.worker.pid), undefined);
  assert.equal(await processIdentity(actual.fixtureOwner.pid), undefined);
  const run = contractRunSchema.parse({ version: 1, worker: actual.worker, launch: { kind: "requested" } });
  const owner = { version: 1, fixtureOwner: actual.fixtureOwner };
  atomicReceipt(join(directory, "contract-run.json"), run);
  assert.deepEqual(await readContractFixture(directory, actual.worker, now() + 1_000), { artifacts, owner });
  const priorPath = join(root, "ci-recovery-0001.json");
  const previous = contractRecoveryReportSchema.parse({
    version: 1, kind: "contract-recovery", conclusion: "cancelled", started: new Date().toISOString(), completed: false,
    roots: [{ directory, run, fixture: { kind: "known", artifacts, owner }, worker: "absent", owner: "absent",
      observed: [actual.fixtureOwner], originals: { before: [], after: [] },
      recovery: { failures: [], container: "absent", directory: "unknown", processes: "absent" }, failures: [] }],
    failures: [],
  });
  atomicReceipt(priorPath, previous, { immutable: true });
  return { root, directory, artifacts, run, priorPath, privateDirectory, container: actual.container };
}

async function preserve(paths: string[]) {
  return Promise.all(paths.map(async path => ({ path, bytes: await readFile(path) })));
}

async function assertPreserved(receipts: Awaited<ReturnType<typeof preserve>>, directory: string, container: string) {
  assert.ok((await lstat(directory)).isDirectory(), "Independent inspection must leave the marked private directory present");
  assert.equal(await readFile(join(directory, ".fixture-owner"), "utf8"), container);
  for (const receipt of receipts) assert.deepEqual(await readFile(receipt.path), receipt.bytes,
    "Independent inspection changed original authority evidence " + receipt.path);
}

function assertHistoryNotAbsent(report: ContractInspectionReport, directory: string) {
  if (!report.completed || report.failures.length) return;
  assert.ok(report.observations.length > 0, "Inspection must observe acknowledged history or fail closed");
  for (const sample of report.observations) {
    const prior = sample.roots.find(root => root.directory === directory);
    assert.ok(sample.failures.length || (prior && (prior.failures.length ||
      [prior.owner, prior.processes, prior.container, prior.directoryResource].some(resource => resource.status !== "absent"))),
    "Inspection certified absence after discarding a previously acknowledged fixture scope");
  }
}

test("local inspection rejects a launch regression after a prior recovery acknowledged the fixture", { timeout: 12_000 }, async t => {
  const fixture = await historyFixture(t);
  atomicReceipt(join(fixture.directory, "contract-run.json"), { ...fixture.run, launch: { kind: "not-requested" } });
  const receipts = await preserve([fixture.priorPath, join(fixture.directory, "contract-run.json"),
    join(fixture.artifacts, "owner.json"), join(fixture.artifacts, "ownership.json")]);
  const report = await inspectContracts(fixture.root, "cancelled", now() + 4_000);
  await assertPreserved(receipts, fixture.privateDirectory, fixture.container);
  assertHistoryNotAbsent(report, fixture.directory);
});

test("local inspection retains a prior acknowledged root when another nonlaunch root remains", { timeout: 12_000 }, async t => {
  const fixture = await historyFixture(t);
  const retained = join(fixture.root, "retained-proof");
  await rename(fixture.directory, retained);
  await assert.rejects(lstat(fixture.directory), { code: "ENOENT" });
  const current = join(fixture.root, "crew-contract-current");
  await mkdir(current);
  atomicReceipt(join(current, "contract-run.json"), { ...fixture.run, launch: { kind: "not-requested" } });
  const receipts = await preserve([fixture.priorPath, join(current, "contract-run.json"),
    join(retained, "contract-run.json"), join(retained, "contract-proof", "owner.json"),
    join(retained, "contract-proof", "ownership.json")]);
  const report = await inspectContracts(fixture.root, "cancelled", now() + 4_000);
  await assertPreserved(receipts, fixture.privateDirectory, fixture.container);
  assertHistoryNotAbsent(report, fixture.directory);
});
