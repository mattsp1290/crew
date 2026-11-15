import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { before, boundedCommand, describe, now } from "./member-service-diagnostics.mts";
import { atomicReceipt, contractRecoveryReportSchema, contractRunSchema, fixtureOwnerSchema, ownershipSchema, regularFile, missingProcess } from "./member-service-recovery.mts";
import { positiveGroupProcessSchema, processKey } from "./member-service-processes.mts";
const root = process.argv[3];
assert.ok(root && isAbsolute(root), "Absolute artifact root required");
const qualification = join(root, "qualification"), deadline = now() + 20_000;
const watchdog = setTimeout(() => { console.error("Qualification observation deadline exceeded"); process.exit(1); }, 21_000);
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const json = async (path: string): Promise<unknown> => JSON.parse(await regularFile(path));
const utc = z.string().datetime(), sha = z.string().regex(/^[a-f0-9]{64}$/);
const requestedSchema = z.object({ directory: z.string(), worker: positiveGroupProcessSchema, readyUTC: utc }).strict();
const pendingSchema = z.object({ directory: z.string(), artifacts: z.string(), container: z.string(), fixtureOwner: positiveGroupProcessSchema,
  worker: positiveGroupProcessSchema, ownershipSHA256: sha, ownerSHA256: sha, readyUTC: utc }).strict();
const readySchema = z.object({ requestedDirectory: z.string(), pendingDirectory: z.string(), workerPID: z.number().int().positive(), readyUTC: utc }).strict();
const commandSchema = z.object({ pid: z.number().int().positive(), diagnostics: z.string(), received: z.number(), retained: z.number(), stdout: z.object({ kind: z.literal("complete"), text: z.string(), received: z.number(), retained: z.number() }) });
const allocationResultSchema = z.object({ settledUTC: utc, kind: z.literal("fulfilled"), result: commandSchema });
const status = z.discriminatedUnion("status", [z.object({ status: z.literal("absent") }), z.object({ status: z.literal("present"), evidence: z.string() }), z.object({ status: z.literal("unknown"), reason: z.string() })]);
const inspectionSchema = z.object({ version: z.literal(1), kind: z.literal("contract-inspection"), conclusion: z.string(), started: utc,
  completed: z.boolean(), failures: z.array(z.string()), observations: z.array(z.object({ observedAt: utc, failures: z.array(z.string()), roots: z.array(z.object({ directory: z.string(), worker: status, owner: status, processes: status, container: status, directoryResource: status, failures: z.array(z.string()) })) })) });
async function work() {
  if (process.argv[2] === "--observe") {
    atomicReceipt(join(qualification, "step-conclusions.json"), { workflowSHA: process.env.GITHUB_SHA,
      contracts: process.env.QUALIFICATION_CONTRACTS, recovery: process.env.QUALIFICATION_RECOVERY, inspection: process.env.QUALIFICATION_INSPECTION });
    const manifest = z.object({ preparedSHA256: z.record(z.string(), sha) }).parse(await json(join(qualification, "qualification-inputs.json")));
    for (const [path, expected] of Object.entries(manifest.preparedSHA256)) {
      assert.ok(!isAbsolute(path) && !path.split("/").includes(".."));
      const metadata = await lstat(resolve(path));
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1_048_576, "Source input must be a bounded regular file");
      assert.equal(hash(await readFile(resolve(path))), expected, path + " changed from prepared source");
    }
    atomicReceipt(join(qualification, "source-verification.json"), { passed: true, inputsSHA256: hash(await regularFile(join(qualification, "qualification-inputs.json"))) });
    const marker = pendingSchema.parse(await json(join(qualification, "pending-docker-started.json")));
    const captured = allocationResultSchema.parse(await json(join(qualification, "docker-allocation-result.json")));
    const allocatedID = captured.result.stdout.text.trim();
    assert.match(allocatedID, /^[a-f0-9]{64}$/);
    const byID = await boundedCommand("docker", ["ps", "--no-trunc", "-aq", "--filter", "id=" + allocatedID], Math.min(deadline, now() + 2_000));
    assert.ok(byID.stdout.kind === "complete");
    assert.ok(byID.stdout.text.trim() === "" || byID.stdout.text.trim() === allocatedID);
    const result = await boundedCommand("docker", ["ps", "--no-trunc", "-aq", "--filter", "name=^/" + marker.container + "$"], Math.min(deadline, now() + 2_000));
    assert.ok(result.stdout.kind === "complete");
    const ids = result.stdout.text.trim().split(/\s+/).filter(Boolean);
    assert.ok(ids.length <= 1, "Exact Docker name has multiple matches");
    assert.deepEqual(ids, byID.stdout.text.trim() ? [allocatedID] : []);
    const inspections = [];
    for (const id of ids) {
      assert.match(id, /^[a-f0-9]{64}$/);
      const observed = await boundedCommand("docker", ["inspect", "--format", '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', id], Math.min(deadline, now() + 2_000));
      assert.ok(observed.stdout.kind === "complete");
      assert.equal(observed.stdout.text.trim(), id + " /" + marker.container + " " + marker.container);
      inspections.push({ id, result: observed });
    }
    const ownership = ownershipSchema.parse(await json(join(marker.artifacts, "ownership.json")));
    let directory: { observed: "present" | "absent"; path: string };
    try {
      const metadata = await lstat(ownership.directory);
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
      assert.equal(await regularFile(join(ownership.directory, ".fixture-owner")), marker.container);
      directory = { observed: "present", path: ownership.directory };
    } catch (error) { if (!missingProcess(error)) throw error; directory = { observed: "absent", path: ownership.directory }; }
    atomicReceipt(join(qualification, "docker-after-production.json"), { observedUTC: new Date().toISOString(), container: marker.container, allocatedID, byID, result, inspections, directory });
    return;
  }
  assert.equal(process.argv[2], "--assert");
  const cancelPath = process.argv[4];
  assert.ok(cancelPath, "Actual cancellation request evidence required");
  const cancel = z.object({ requestUTC: utc, workflowSHA: z.string().regex(/^[a-f0-9]{40}$/), inputsSHA256: sha }).strict().parse(await json(resolve(cancelPath)));
  const manifestText = await regularFile(join(qualification, "qualification-inputs.json"));
  assert.equal(hash(manifestText), cancel.inputsSHA256);
  const manifest = z.object({ candidate: z.literal("8f8700846937c501c8ef48ed3d7a7d307e43ab9b"), patchSHA256: sha }).parse(JSON.parse(manifestText));
  assert.equal(hash(await regularFile(join(qualification, "qualification-instrumentation.patch"))), manifest.patchSHA256);
  assert.deepEqual(await json(join(qualification, "source-verification.json")), { passed: true, inputsSHA256: cancel.inputsSHA256 });
  const steps = z.object({ workflowSHA: z.string(), contracts: z.literal("cancelled"), recovery: z.literal("failure"), inspection: z.literal("failure") }).strict().parse(await json(join(qualification, "step-conclusions.json")));
  assert.equal(steps.workflowSHA, cancel.workflowSHA);
  for (const name of ["recovery", "inspection"]) assert.equal((await regularFile(join(qualification, name + "-exit.txt"))).trim(), "1");
  const requested = requestedSchema.parse(await json(join(qualification, "requested-before-spawn.json")));
  const pending = pendingSchema.parse(await json(join(qualification, "pending-docker-started.json")));
  const ready = readySchema.parse(await json(join(qualification, "unknown-acquisition-ready.json")));
  for (const marker of [requested, pending, ready]) {
    assert.ok(Date.parse(marker.readyUTC) < Date.parse(cancel.requestUTC), "Cancellation preceded readiness");
    assert.ok(Date.parse(cancel.requestUTC) - Date.parse(marker.readyUTC) < 60_000, "Cancellation missed qualification hold");
  }
  assert.equal(ready.requestedDirectory, requested.directory);
  assert.equal(ready.pendingDirectory, pending.directory);
  assert.equal(dirname(pending.directory), dirname(requested.directory));
  assert.notEqual(pending.directory, requested.directory);
  assert.equal(processKey(pending.worker), processKey(requested.worker));
  assert.equal(ready.workerPID, requested.worker.pid);
  assert.equal(pending.fixtureOwner.parent, requested.worker.pid);
  assert.equal(pending.fixtureOwner.pid, pending.fixtureOwner.group);
  const local = (directory: string) => { assert.match(basename(directory), /^crew-contract-[a-zA-Z0-9]+$/); return join(root, basename(directory)); };
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith("crew-contract-")).sort(), [basename(requested.directory), basename(pending.directory)].sort());
  for (const marker of [requested, pending]) {
    const run = contractRunSchema.parse(await json(join(local(marker.directory), "contract-run.json")));
    assert.equal(run.launch.kind, "requested");
    assert.deepEqual(run.worker, marker.worker);
  }
  assert.deepEqual((await readdir(local(requested.directory))).filter(name => name !== "recovery.json"), ["contract-run.json"]);
  assert.equal(dirname(pending.artifacts), pending.directory);
  assert.match(basename(pending.artifacts), /^contract-[a-zA-Z0-9]+$/);
  const artifacts = join(local(pending.directory), basename(pending.artifacts));
  const ownerText = await regularFile(join(artifacts, "owner.json")), ownershipText = await regularFile(join(artifacts, "ownership.json"));
  assert.equal(hash(ownerText), pending.ownerSHA256);
  assert.equal(hash(ownershipText), pending.ownershipSHA256);
  assert.deepEqual(fixtureOwnerSchema.parse(JSON.parse(ownerText)).fixtureOwner, pending.fixtureOwner);
  const ownership = ownershipSchema.parse(JSON.parse(ownershipText));
  assert.equal(ownership.allocation.kind, "pending");
  assert.equal(ownership.container, pending.container);
  assert.equal(ownership.pendingProcessAcquisitions, 0);
  assert.deepEqual(ownership.processes, []);
  const captured = allocationResultSchema.parse(await json(join(qualification, "docker-allocation-result.json")));
  assert.match(captured.result.stdout.text.trim(), /^[a-f0-9]{64}$/);
  const report = contractRecoveryReportSchema.parse(await json(join(root, "ci-recovery-0001.json")));
  assert.equal(report.completed, true);
  assert.equal(report.conclusion, steps.contracts);
  assert.deepEqual(report.failures, []);
  assert.equal(report.roots.length, 2);
  for (const marker of [requested, pending]) {
    const found = report.roots.find(item => item.directory === marker.directory);
    assert.ok(found);
    assert.equal(found.worker, "absent");
    assert.deepEqual(found.run.worker, marker.worker);
    assert.equal(found.run.launch.kind, "requested");
    assert.equal(found.recovery.container, "unknown");
    assert.equal(found.recovery.directory, "unknown");
    for (const original of found.originals.before) if (original.kind === "available") assert.ok(found.originals.after.some(after => after.kind === "available" && after.path === original.path && after.sha256 === original.sha256), "Original receipt changed during recovery");
    if (marker === requested) {
      assert.equal(found.fixture.kind, "unknown");
      assert.equal(found.owner, "unknown");
      assert.equal(found.recovery.processes, "unknown");
      assert.match(JSON.stringify(found.failures), /Expected exactly one fixture ownership entry/);
    } else {
      assert.ok(found.fixture.kind === "known");
      assert.equal(found.fixture.artifacts, pending.artifacts);
      assert.deepEqual(found.fixture.owner.fixtureOwner, pending.fixtureOwner);
      assert.equal(found.owner, "absent");
      assert.equal(found.recovery.processes, "absent");
      assert.ok(found.observed.some(proc => processKey(proc) === processKey(pending.fixtureOwner)));
      assert.match(JSON.stringify(found.recovery.failures), /Docker allocation pending; eventual absence unknown/);
      assert.match(JSON.stringify(found.recovery.failures), /Private directory removal requires settled Docker acquisition/);
    }
  }
  const inspection = inspectionSchema.parse(await json(join(root, "ci-inspection-0001.json")));
  assert.equal(inspection.completed, true);
  assert.equal(inspection.conclusion, steps.contracts);
  assert.deepEqual(inspection.failures, []);
  assert.equal(inspection.observations.length, 2);
  for (const sample of inspection.observations) {
    assert.deepEqual(sample.failures, []);
    assert.equal(sample.roots.length, 2);
    for (const marker of [requested, pending]) {
      const found = sample.roots.find(item => item.directory === marker.directory);
      assert.ok(found);
      assert.equal(found.container.status, "unknown");
      assert.equal(found.directoryResource.status, "unknown");
      if (marker === requested) {
        assert.equal(found.owner.status, "unknown");
        assert.equal(found.processes.status, "unknown");
        assert.match(JSON.stringify(found.failures), /Expected exactly one fixture ownership entry/);
      } else {
        assert.equal(found.owner.status, "absent");
        assert.equal(found.processes.status, "absent");
        assert.deepEqual(found.failures, []);
        assert.ok(found.container.status === "unknown" && found.directoryResource.status === "unknown");
        assert.match(found.container.reason, /Docker allocation pending; eventual absence unknown/);
        assert.match(found.directoryResource.reason, /Docker allocation pending; directory lifetime unknown/);
      }
    }
  }
  const observation = z.object({ observedUTC: utc, container: z.string(), allocatedID: z.string(), byID: commandSchema, result: commandSchema,
    inspections: z.array(z.object({ id: z.string(), result: commandSchema })), directory: z.object({ observed: z.enum(["present", "absent"]), path: z.string() }) }).parse(await json(join(qualification, "docker-after-production.json")));
  assert.equal(observation.container, pending.container);
  assert.equal(observation.allocatedID, captured.result.stdout.text.trim());
  assert.equal(observation.directory.path, ownership.directory);
  assert.equal(observation.directory.observed, "present", "Pending acquisition private directory must survive production cleanup");
  const ids = observation.result.stdout.text.trim().split(/\s+/).filter(Boolean);
  assert.deepEqual(ids, observation.byID.stdout.text.trim() ? [observation.allocatedID] : []);
  assert.deepEqual(observation.inspections.map(item => item.id), ids);
  for (const item of observation.inspections) assert.equal(item.result.stdout.text.trim(), item.id + " /" + pending.container + " " + pending.container);
  atomicReceipt(join(qualification, "assertions.json"), { passed: true, completedUTC: new Date().toISOString(), cancel, steps, ownershipSHA256: hash(ownershipText), scope: "unknown-acquisition supplemental assertions; pending acquisition remains historically unknown" });
}
try { await before(work(), deadline, "Qualification observations"); }
catch (error) { atomicReceipt(join(qualification, process.argv[2] === "--observe" ? "observation-error.json" : "assertions.json"), { passed: false, error: describe(error) }); throw error; }
finally { clearTimeout(watchdog); }
