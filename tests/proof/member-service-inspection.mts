import assert from "node:assert/strict";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { before, boundedCommand, describe, now } from "./member-service-diagnostics.mts";
import { parseProcess, processKey, type PositiveGroupProcess, type RawProcess } from "./member-service-processes.mts";
import { atomicReceipt, missingProcess, ownershipSchema, readContractFixture, readContractRoots, readRecoveryReports,
  regularFile, reportPath, retainedProcesses } from "./member-service-recovery.mts";

type Observation = { status: "absent" } | { status: "present"; evidence: string } | { status: "unknown"; reason: string };
type ContractObservation = { directory: string; worker: Observation; owner: Observation;
  processes: Observation; container: Observation; directoryResource: Observation; failures: string[] };
type InspectionSample = { observedAt: string; roots: ContractObservation[]; failures: string[] };
export type ContractInspectionReport = { version: 1; kind: "contract-inspection"; conclusion: string; started: string;
  completed: boolean; observations: InspectionSample[]; failures: string[] };
const absent: Observation = { status: "absent" };
const unknown = (error: unknown): Observation => ({ status: "unknown", reason: describe(error) });
async function observation(operation: () => Promise<Observation>): Promise<Observation> {
  try { return await operation(); } catch (error) { return unknown(error); }
}
async function processTable(deadline: number) {
  return before((async () => {
    const names = (await readdir("/proc")).filter(name => /^\d+$/.test(name));
    const rows = await Promise.all(names.map(async name => {
      try { return parseProcess(Number(name), await readFile(`/proc/${name}/stat`, "utf8")); }
      catch (error) { if (missingProcess(error)) return undefined; throw error; }
    }));
    return rows.filter(row => row !== undefined);
  })(), deadline, "Independent process census");
}
function exactProcess(identity: PositiveGroupProcess, table: readonly RawProcess[]): Observation {
  const current = table.find(proc => proc.pid === identity.pid);
  if (!current) return absent;
  if (processKey(current) !== processKey(identity) || current.group !== identity.group) return unknown("Exact process identity or group changed");
  return current.state === "Z" || current.state === "X" ? absent : { status: "present", evidence: JSON.stringify(current) };
}
async function inspectContainer(evidence: z.infer<typeof ownershipSchema>, deadline: number): Promise<Observation> {
  if (evidence.allocation.kind === "not-started") return absent;
  const selectors = ["name=^/" + evidence.container + "$", ...(evidence.allocation.kind === "settled" ? ["id=" + evidence.allocation.container] : [])];
  const found = new Set<string>();
  for (const selector of selectors) {
    const result = await boundedCommand("docker", ["ps", "--no-trunc", "-aq", "--filter", selector], Math.min(deadline, now() + 1_500));
    assert.ok(result.stdout.kind === "complete", "Independent Docker query stdout truncated");
    for (const id of result.stdout.text.trim().split(/\s+/).filter(Boolean)) {
      assert.match(id, /^[a-f0-9]{64}$/, "Independent Docker query identity malformed");
      found.add(id);
    }
  }
  for (const id of found) {
    const result = await boundedCommand("docker", ["inspect", "--format", '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', id],
      Math.min(deadline, now() + 1_500));
    assert.ok(result.stdout.kind === "complete", "Independent Docker inspection stdout truncated");
    const [actual, name, marker] = result.stdout.text.trim().split(/\s+/);
    assert.equal(actual, id, "Independent Docker identity changed");
    assert.equal(name, "/" + evidence.container, "Independent Docker name changed");
    assert.equal(marker, evidence.container, "Independent Docker owner label changed");
    if (evidence.allocation.kind === "settled") assert.equal(id, evidence.allocation.container, "Independent allocated Docker identity changed");
  }
  assert.notEqual(evidence.allocation.kind, "pending", "Docker allocation pending; eventual absence unknown");
  return found.size ? { status: "present", evidence: JSON.stringify([...found]) } : absent;
}
async function inspectDirectory(evidence: z.infer<typeof ownershipSchema>): Promise<Observation> {
  assert.equal(evidence.pendingProcessAcquisitions, 0, "Process acquisition pending; directory lifetime unknown");
  assert.notEqual(evidence.allocation.kind, "pending", "Docker allocation pending; directory lifetime unknown");
  const path = evidence.directory, temporary = await realpath(tmpdir());
  assert.ok(isAbsolute(path) && /^birb-members-[a-zA-Z0-9]+$/.test(basename(path)), "Unexpected private directory path");
  assert.equal(await realpath(dirname(path)), temporary, "Private directory outside actual temporary root");
  let metadata;
  try { metadata = await lstat(path); } catch (error) { if (missingProcess(error)) return absent; throw error; }
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), "Private directory replaced with non-directory or symlink");
  assert.equal(dirname(await realpath(path)), temporary, "Private directory escaped temporary root");
  assert.equal(await regularFile(join(path, ".fixture-owner")), evidence.container, "Private directory owner marker changed");
  return { status: "present", evidence: path };
}
export async function inspectContracts(root: string, conclusion: string, deadline: number): Promise<ContractInspectionReport> {
  const report: ContractInspectionReport = { version: 1, kind: "contract-inspection", conclusion, started: new Date().toISOString(),
    completed: false, observations: [], failures: [] };
  const path = await reportPath(root, "ci-inspection", report);
  try {
    for (let round = 0; round < 2; round++) {
      if (round) await before(delay(500), deadline - 500, "Independent observation spacing");
      const sample: InspectionSample = { observedAt: new Date().toISOString(), roots: [], failures: [] };
      report.observations.push(sample);
      atomicReceipt(path, report);
      const discovered = await readContractRoots(root, deadline - 500);
      sample.failures.push(...discovered.failures);
      const previous = await readRecoveryReports(root, deadline - 500);
      let table: RawProcess[] | undefined;
      try { table = await processTable(deadline - 500); }
      catch (error) { sample.failures.push(describe(error)); }
      for (const contract of discovered.roots) {
        const result: ContractObservation = { directory: contract.directory,
          worker: table ? exactProcess(contract.run.worker, table) : unknown("Independent process census unavailable"),
          owner: unknown("Fixture owner unobserved"), processes: unknown("Resources unobserved"),
          container: unknown("Resources unobserved"), directoryResource: unknown("Resources unobserved"), failures: [] };
        sample.roots.push(result);
        try {
          if (contract.run.launch.kind === "not-requested") {
            result.owner = result.processes = result.container = result.directoryResource = absent;
            continue;
          }
          const fixture = await readContractFixture(contract.directory, contract.run.worker, deadline - 500);
          result.owner = table ? exactProcess(fixture.owner.fixtureOwner, table) : unknown("Independent process census unavailable");
          const evidence = ownershipSchema.parse(JSON.parse(await regularFile(join(fixture.artifacts, "ownership.json"))));
          const owned = retainedProcesses(previous, contract, fixture, evidence.processes);
          result.processes = await observation(async () => {
            assert.ok(table, "Independent process census unavailable");
            assert.ok(previous.some(report => report.roots.some(prior => prior.directory === contract.directory &&
              prior.observed.some(proc => processKey(proc) === processKey(fixture.owner.fixtureOwner)))), "Retained owner census unavailable");
            assert.equal(evidence.pendingProcessAcquisitions, 0, "Process acquisition pending; absence unknown");
            assert.ok(evidence.processes.every(proc => proc.identity.kind === "known" && proc.pid === proc.identity.group), "Service process identity pending or nonisolated");
            const rows = table;
            const statuses = [...owned.values()].map(proc => exactProcess(proc, rows));
            const uncertain = statuses.find(status => status.status === "unknown");
            if (uncertain) return uncertain;
            const live = table.filter(proc => proc.state !== "Z" && proc.state !== "X");
            for (const group of new Set([...owned.values()].map(proc => proc.group))) {
              const members = live.filter(proc => proc.group === group);
              if (members.length) {
                if (!members.some(proc => owned.has(processKey(proc)))) return unknown("Group remains without a surviving owned identity");
                return { status: "present", evidence: JSON.stringify(members) };
              }
            }
            return absent;
          });
          [result.container, result.directoryResource] = await Promise.all([
            observation(() => inspectContainer(evidence, deadline - 500)), observation(() => inspectDirectory(evidence)),
          ]);
        } catch (error) { result.failures.push(describe(error)); }
        finally { atomicReceipt(path, report); }
      }
      atomicReceipt(path, report);
    }
    report.completed = true;
  } catch (error) { report.failures.push(describe(error)); }
  finally { atomicReceipt(path, report); }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deadline = now() + 28_000;
  let finished = false;
  const watchdog = setTimeout(() => { console.error("Contract inspection watchdog expired; completion unknown"); process.exit(1); }, 29_000);
  try {
    assert.equal(process.argv[2], "--contracts", "Expected --contracts <absolute artifact root>");
    const root = process.argv[3];
    assert.ok(root && isAbsolute(root), "Absolute artifact root required");
    const report = await before(inspectContracts(root, process.env.CONTRACTS_CONCLUSION ?? "unknown", deadline), deadline, "Contract inspection");
    finished = report.completed;
    process.exitCode = !report.completed || report.failures.length || report.observations.length !== 2 || report.observations.some(sample =>
      sample.failures.length || sample.roots.some(result => result.failures.length ||
        [result.worker, result.owner, result.processes, result.container, result.directoryResource].some(status => status.status !== "absent"))) ? 1 : 0;
  } catch (error) { console.error(describe(error)); process.exitCode = 1; }
  finally { if (finished) clearTimeout(watchdog); }
}
