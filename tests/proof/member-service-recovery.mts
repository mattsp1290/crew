import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { before, boundedCommand, completedCommandFailure, describe, liveGroup, now } from "./member-service-diagnostics.mts";
import { ownedProcessMapSchema, parseProcess, positiveGroupProcessSchema, processKey, selectOwnedProcesses, type PositiveGroupProcess } from "./member-service-processes.mts";

export function missingProcess(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
export async function processIdentity(pid: number) {
  try { return parseProcess(pid, await readFile(`/proc/${pid}/stat`, "utf8")); }
  catch (error) { if (missingProcess(error)) return undefined; throw error; }
}
export async function observeOwned(owned: Map<string, PositiveGroupProcess>, deadline: number) {
  const authority = ownedProcessMapSchema.parse(owned);
  if (!authority.size) return [];
  const table = await before(readdir("/proc").then(names => Promise.all(names.filter(name => /^\d+$/.test(name))
    .map(name => processIdentity(Number(name))))), deadline, "Owned process census");
  const rows = table.filter(proc => proc !== undefined);
  for (const proc of authority.values()) {
    const current = rows.find(row => row.pid === proc.pid);
    if (current) assert.equal(processKey(current), processKey(proc), "Owned PID was reused; absence unknown");
  }
  const observation = selectOwnedProcesses(authority, rows);
  for (const [key, proc] of observation.owned) owned.set(key, proc);
  return observation.live;
}
export async function stopOwned(owned: Map<string, PositiveGroupProcess>, deadline: number) {
  const live = await observeOwned(owned, deadline);
  const groups = new Set([...owned.values()].map(proc => proc.group));
  if (!groups.size) return;
  const self = await before(processIdentity(process.pid), deadline, "Recovery process group");
  assert.ok(self, "Recovery process identity unavailable");
  assert.ok(!groups.has(self.group), "Refusing to signal recovery process group");
  const results = await Promise.allSettled([...groups].map(async group => {
    const members = live.filter(proc => proc.group === group);
    if (members.length) {
      const anchor = members.find(proc => owned.has(processKey(proc)));
      assert.ok(anchor, `Process group ${group} has no surviving owned identity; absence unknown`);
      const current = await before(processIdentity(anchor.pid), deadline, "Verify process identity before signaling");
      if (current && current.state !== "Z" && current.state !== "X") {
        assert.equal(processKey(current), processKey(anchor), "Process identity changed before signaling");
        assert.equal(current.group, group, "Process group changed before signaling");
        assert.ok(now() < deadline, "Owned group stop deadline exceeded");
        try { process.kill(-group, "SIGKILL"); } catch (error) { if (!missingProcess(error)) throw error; }
      }
    }
    while (await before(liveGroup(group), deadline, `Owned group ${group} absence`)) {
      assert.ok(now() < deadline, `Owned group ${group} remains`);
      await delay(40);
    }
  }));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "Owned process recovery failed");
}

export const ownershipSchema = z.object({
  version: z.literal(1), pendingProcessAcquisitions: z.number().int().nonnegative(),
  label: z.literal("contract"), directory: z.string(), container: z.string().regex(/^birb-proof-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  allocation: z.discriminatedUnion("kind", [z.object({ kind: z.literal("not-started") }), z.object({ kind: z.literal("pending") }),
    z.object({ kind: z.literal("settled"), container: z.string().regex(/^[0-9a-f]{64}$/) })]),
  processes: z.array(z.object({ pid: z.number().int().positive(), log: z.string(),
    identity: z.discriminatedUnion("kind", [z.object({ kind: z.literal("pending") }),
      z.object({ kind: z.literal("known"), group: z.number().int().positive(), startTime: z.string().regex(/^\d+$/) })]) })),
}).strict();
export const contractRunSchema = z.object({ version: z.literal(1), worker: positiveGroupProcessSchema,
  launch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("not-requested") }).strict(),
    z.object({ kind: z.literal("requested") }).strict()]) }).strict();
export const fixtureOwnerSchema = z.object({ version: z.literal(1), fixtureOwner: positiveGroupProcessSchema }).strict();
export const isolatedOwnerSchema = fixtureOwnerSchema.refine(owner => owner.fixtureOwner.pid === owner.fixtureOwner.group,
  "Contract fixture owner must lead its isolated group");
const contractRootSchema = z.object({ directory: z.string(), run: contractRunSchema }).strict();
export type ContractRoot = z.infer<typeof contractRootSchema>;
const fixtureAuthoritySchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("not-requested") }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("known"), artifacts: z.string(), owner: isolatedOwnerSchema }).strict()]);
const receiptStateSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("missing"), path: z.string() }),
  z.object({ kind: z.literal("unknown"), path: z.string(), reason: z.string() }),
  z.object({ kind: z.literal("available"), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })]);
const absenceSchema = z.enum(["absent", "unknown"]);
const recoverySchema = z.object({ failures: z.array(z.string()), container: absenceSchema, directory: absenceSchema, processes: absenceSchema });
export type Recovery = z.infer<typeof recoverySchema>;
const rootRecoverySchema = contractRootSchema.extend({ fixture: fixtureAuthoritySchema, worker: absenceSchema,
  owner: z.enum(["absent", "unknown", "not-requested"]), observed: z.array(positiveGroupProcessSchema),
  originals: z.object({ before: z.array(receiptStateSchema), after: z.array(receiptStateSchema) }),
  recovery: recoverySchema, failures: z.array(z.string()) }).strict()
  .refine(root => root.run.launch.kind === "requested" || (root.fixture.kind !== "known" && root.observed.length === 0),
    "Non-requested contract has fixture authority or retained descendants");
export const contractRecoveryReportSchema = z.object({ version: z.literal(1), kind: z.literal("contract-recovery"),
  conclusion: z.string(), started: z.string(), completed: z.boolean(), roots: z.array(rootRecoverySchema),
  failures: z.array(z.string()) }).strict();
export type ContractRecoveryReport = z.infer<typeof contractRecoveryReportSchema>;

export function assertContractHistory(current: readonly ContractRoot[], prior: readonly ContractRoot[]): void {
  const directories = new Map<string, ContractRoot>(), groups = new Map<string, number>();
  for (const contract of current) {
    const worker = contract.run.worker, key = processKey(worker), duplicate = directories.get(contract.directory);
    if (duplicate) {
      assert.equal(processKey(duplicate.run.worker), key, contract.directory + ": Conflicting current worker authority");
      assert.equal(duplicate.run.worker.group, worker.group, contract.directory + ": Conflicting current worker group");
      assert.equal(duplicate.run.launch.kind, contract.run.launch.kind, contract.directory + ": Conflicting current launch authority");
    }
    const group = groups.get(key);
    assert.ok(group === undefined || group === worker.group, `Worker ${key}: Conflicting worker group authority`);
    groups.set(key, worker.group);
    directories.set(contract.directory, contract);
  }
  for (const previous of prior) {
    const contract = directories.get(previous.directory);
    assert.ok(contract, previous.directory + ": Previously acknowledged contract root missing");
    assert.equal(processKey(contract.run.worker), processKey(previous.run.worker), previous.directory + ": Prior contract worker authority changed");
    assert.equal(contract.run.worker.group, previous.run.worker.group, previous.directory + ": Prior contract worker group changed");
    assert.ok(previous.run.launch.kind !== "requested" || contract.run.launch.kind === "requested",
      previous.directory + ": Contract launch authority regressed");
  }
}

export function atomicReceipt(path: string, value: unknown, options: { immutable?: boolean } = {}) {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  try {
    if (options.immutable) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (!missingProcess(error)) throw error; }
  }
}

async function realDirectory(path: string) {
  assert.ok(isAbsolute(path), "Artifact directory must be absolute");
  const metadata = await lstat(path);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), "Artifact directory must be a real directory");
  return realpath(path);
}
export async function readContractRoots(root: string, deadline: number): Promise<{ roots: ContractRoot[]; failures: string[] }> {
  const roots: ContractRoot[] = [], failures: string[] = [];
  await before((async () => {
    const actual = await realDirectory(root);
    const names = await readdir(root);
    assert.ok(names.length <= 1024, "Artifact root entry bound exceeded");
    const contracts = names.filter(name => name.startsWith("crew-contract-"));
    assert.ok(contracts.length > 0 && contracts.length <= 128, "Contract root count is unknown or exceeds its bound");
    for (const name of contracts) {
      try {
        assert.match(name, /^crew-contract-[a-zA-Z0-9]+$/, "Unexpected contract root name");
        const directory = join(root, name);
        assert.equal(dirname(await realDirectory(directory)), actual, "Contract root escaped artifact root");
        const run = contractRunSchema.parse(JSON.parse(await regularFile(join(directory, "contract-run.json"))));
        roots.push({ directory, run });
      } catch (error) { failures.push(name + ": " + describe(error)); }
    }
  })(), deadline, "Contract root discovery");
  return { roots, failures };
}
async function fixtureArtifacts(directory: string) {
  const actual = await realDirectory(directory);
  const entries = (await readdir(directory)).filter(name => name !== "recovery.json" && name !== "contract-run.json");
  assert.equal(entries.length, 1, "Expected exactly one fixture ownership entry");
  const entry = entries[0];
  assert.ok(entry && /^contract-[a-zA-Z0-9]+$/.test(entry), "Unexpected fixture artifact entry");
  const artifacts = join(directory, entry);
  assert.equal(dirname(await realDirectory(artifacts)), actual, "Fixture artifacts escaped contract root");
  return artifacts;
}
export async function readContractFixture(directory: string, worker: PositiveGroupProcess, deadline: number) {
  return before((async () => {
    const artifacts = await fixtureArtifacts(directory);
    const owner = isolatedOwnerSchema.parse(JSON.parse(await regularFile(join(artifacts, "owner.json"))));
    assert.equal(owner.fixtureOwner.parent, worker.pid, "Fixture owner parent disagrees with contract worker");
    assert.notEqual(owner.fixtureOwner.group, worker.group, "Fixture owner shares the worker group");
    return { artifacts, owner };
  })(), deadline, "Contract fixture authority");
}
export function regularFileSync(path: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(file);
    assert.ok(metadata.isFile() && metadata.size <= 1024 * 1024, "Ownership evidence must be a bounded regular file");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const count = readSync(file, bytes, 0, bytes.length, 0);
    assert.ok(count <= 1024 * 1024, "Ownership evidence exceeded its byte bound");
    return bytes.subarray(0, count).toString("utf8");
  } finally { closeSync(file); }
}
export async function regularFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    assert.ok(metadata.isFile() && metadata.size <= 1024 * 1024, "Ownership evidence must be a bounded regular file");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    assert.ok(bytesRead <= 1024 * 1024, "Ownership evidence exceeded its byte bound");
    return bytes.subarray(0, bytesRead).toString("utf8");
  }
  finally { await file.close(); }
}
export function isMissingDockerInspection(failure: ReturnType<typeof completedCommandFailure>, fullId: string) {
  return failure?.code === 1 && failure.diagnostics.trim() === "Error: No such object: " + fullId;
}
export async function recoverFixture(directory: string, observed: readonly PositiveGroupProcess[], deadline: number) {
  const observedProcesses = z.array(positiveGroupProcessSchema).parse(observed);
  const recovery: Recovery = { failures: [], container: "unknown", directory: "unknown", processes: "unknown" };
  const attempt = async (operation: () => Promise<void>) => {
    try { await before(operation(), deadline - 300, "Fixture recovery"); }
    catch (error) { recovery.failures.push(describe(error)); }
  };
  const evidence = await before((async () => {
    const artifacts = await fixtureArtifacts(directory);
    return ownershipSchema.parse(JSON.parse(await regularFile(join(artifacts, "ownership.json"))));
  })(), deadline - 300, "Fixture ownership evidence").catch(error => { recovery.failures.push(describe(error)); return undefined; });
  if (evidence?.pendingProcessAcquisitions) recovery.failures.push("Process acquisition pending; absence unknown");
  const owned = new Map(observedProcesses.map(proc => [processKey(proc), proc]));
  if (evidence) for (const proc of evidence.processes) {
    if (proc.identity.kind === "pending") { recovery.failures.push("Recorded process identity is pending; absence unknown"); continue; }
    if (proc.pid !== proc.identity.group) { recovery.failures.push("Recorded fixture process is not a group leader"); continue; }
    const identity = positiveGroupProcessSchema.parse({ pid: proc.pid, ...proc.identity, parent: 0, state: "recorded" });
    owned.set(processKey(identity), identity);
  }
  await Promise.all([
    attempt(async () => {
      await stopOwned(owned, deadline - 500);
      if (evidence && evidence.pendingProcessAcquisitions === 0 && evidence.processes.every(proc => proc.identity.kind === "known" && proc.identity.group === proc.pid)) recovery.processes = "absent";
    }),
    ...(evidence ? [attempt(async () => {
      if (evidence.allocation.kind === "not-started") { recovery.container = "absent"; return; }
      const selectors = ["name=^/" + evidence.container + "$", ...(evidence.allocation.kind === "settled" ? ["id=" + evidence.allocation.container] : [])];
      const query = async () => {
        const results = await Promise.all(selectors.map(selector => boundedCommand("docker", ["ps", "--no-trunc", "-aq", "--filter", selector],
          Math.min(deadline - 500, now() + 1_500))));
        return results.flatMap(result => {
          assert.ok(result.stdout.kind === "complete", "Docker recovery query stdout was truncated");
          const ids = result.stdout.text.trim() ? result.stdout.text.trim().split(/\s+/) : [];
          for (const id of ids) assert.match(id, /^[a-f0-9]{64}$/, "Docker query returned an invalid identity");
          return ids;
        });
      };
      const found = new Set(await query());
      if (evidence.allocation.kind === "settled") for (const foundId of found)
        assert.equal(foundId, evidence.allocation.container, "Allocated container identity changed");
      for (const foundId of found) {
        let inspected: Awaited<ReturnType<typeof boundedCommand>>;
        try {
          inspected = await boundedCommand("docker", ["inspect", "--format",
            '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', foundId], Math.min(deadline - 500, now() + 1_500));
        } catch (error) {
          if (evidence.allocation.kind !== "settled" || !isMissingDockerInspection(completedCommandFailure(error), foundId)) throw error;
          try { assert.deepEqual(await query(), [], "Exact owned container remains after missing inspection"); }
          catch (observationError) { throw new AggregateError([error, observationError],
            "Docker absence unproven after missing inspection\n" + [error, observationError].map(describe).join("\n")); }
          console.error(`Docker inspection target ${foundId} disappeared; exact-name and settled-ID queries are empty`);
          continue;
        }
        assert.ok(inspected.stdout.kind === "complete", "Docker recovery inspection stdout was truncated");
        const [id, name, marker] = inspected.stdout.text.trim().split(/\s+/);
        assert.ok(id && /^[a-f0-9]{64}$/.test(id), "Container identity missing");
        assert.equal(id, foundId, "Inspected container identity changed");
        assert.equal(name, "/" + evidence.container, "Container name disagrees with ownership");
        assert.equal(marker, evidence.container, "Container label disagrees with ownership");
        if (evidence.allocation.kind === "settled") assert.equal(id, evidence.allocation.container, "Allocated container identity changed");
        await boundedCommand("docker", ["rm", "-f", id], Math.min(deadline - 500, now() + 2_000));
      }
      const remaining = await query();
      assert.deepEqual(remaining, [], "Exact owned container remains");
      assert.notEqual(evidence.allocation.kind, "pending", "Docker allocation pending; eventual absence unknown");
      recovery.container = "absent";
    })] : []),
  ]);
  if (evidence) await attempt(async () => {
      assert.equal(recovery.processes, "absent", "Private directory removal requires process absence and settled acquisition");
      assert.notEqual(evidence.allocation.kind, "pending", "Private directory removal requires settled Docker acquisition");
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
    });
  return recovery;
}

export async function readRecoveryReports(root: string, deadline: number) {
  return before((async () => {
    await realDirectory(root);
    const names = (await readdir(root)).filter(name => /^ci-recovery-\d{4}\.json$/.test(name)).sort();
    assert.ok(names.length <= 32, "Recovery attempt bound exceeded");
    const reports: ContractRecoveryReport[] = [];
    for (const name of names) reports.push(contractRecoveryReportSchema.parse(JSON.parse(await regularFile(join(root, name)))));
    return reports;
  })(), deadline, "Prior recovery evidence");
}
export function retainedProcesses(reports: readonly ContractRecoveryReport[], contract: ContractRoot,
  fixture: Awaited<ReturnType<typeof readContractFixture>>, services: z.infer<typeof ownershipSchema>["processes"]) {
  const owner = fixture.owner.fixtureOwner;
  const anchors = new Map<string, PositiveGroupProcess>([[processKey(owner), owner]]);
  for (const proc of services) if (proc.identity.kind === "known" && proc.pid === proc.identity.group) {
    const identity = positiveGroupProcessSchema.parse({ pid: proc.pid, parent: owner.pid, state: "recorded", ...proc.identity });
    anchors.set(processKey(identity), identity);
  }
  for (const report of reports) for (const previous of report.roots) {
    if (previous.directory !== contract.directory) continue;
    if (previous.fixture.kind !== "known") {
      assert.equal(previous.observed.length, 0, "Prior descendants have no fixture authority");
      continue;
    }
    assert.deepEqual(previous.fixture.owner, fixture.owner, "Prior fixture owner changed");
    assert.equal(previous.fixture.artifacts, fixture.artifacts, "Prior artifact location changed");
    const selected = selectOwnedProcesses(anchors, previous.observed);
    for (const proc of previous.observed) {
      assert.ok(selected.owned.has(processKey(proc)), "Retained descendant lacks causal fixture authority");
      assert.notEqual(proc.group, contract.run.worker.group, "Retained descendant adopted shared worker group");
      anchors.set(processKey(proc), proc);
    }
  }
  return anchors;
}
export async function reportPath(root: string, prefix: "ci-recovery" | "ci-inspection", initial: unknown) {
  await realDirectory(root);
  for (let attempt = 1; attempt <= 32; attempt++) {
    const path = join(root, `${prefix}-${String(attempt).padStart(4, "0")}.json`);
    try { atomicReceipt(path, initial, { immutable: true }); return path; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  throw new Error("CI evidence attempt bound exceeded");
}
async function originals(contract: ContractRoot, fixture: z.infer<typeof fixtureAuthoritySchema>) {
  const paths = [join(contract.directory, "contract-run.json"), join(contract.directory, "recovery.json"),
    ...(fixture.kind === "known" ? ["owner.json", "ownership.json", "cleanup.json", "first-failure.txt"].map(name => join(fixture.artifacts, name)) : [])];
  return Promise.all(paths.map(async path => {
    try { return receiptStateSchema.parse({ kind: "available", path, sha256: createHash("sha256").update(await regularFile(path)).digest("hex") }); }
    catch (error) { return receiptStateSchema.parse(missingProcess(error) ? { kind: "missing", path } : { kind: "unknown", path, reason: describe(error) }); }
  }));
}
async function protectedProcesses(deadline: number) {
  const protectedPids = new Set<number>([1]);
  for (let pid = process.pid; pid > 1;) {
    assert.ok(!protectedPids.has(pid), "Recovery ancestry contains a cycle");
    protectedPids.add(pid);
    const identity = await before(processIdentity(pid), deadline, "Recovery ancestry");
    assert.ok(identity, "Recovery ancestry is unavailable");
    pid = identity.parent;
  }
  return protectedPids;
}
async function stopExact(identity: PositiveGroupProcess, protectedPids: ReadonlySet<number>, deadline: number,
  sample: () => Promise<void> = async () => {}) {
  assert.ok(!protectedPids.has(identity.pid), "Refusing to stop recovery or runner ancestry");
  async function current() {
    const found = await before(processIdentity(identity.pid), deadline, "Exact creator identity");
    if (!found) return undefined;
    assert.equal(processKey(found), processKey(identity), "Creator PID was reused; absence unknown");
    assert.equal(found.group, identity.group, "Creator group changed; absence unknown");
    return found.state === "Z" || found.state === "X" ? undefined : found;
  }
  if (!await current()) return;
  await sample();
  if (await current()) {
    assert.ok(now() < deadline, "Creator stop deadline exceeded");
    try { process.kill(identity.pid, "SIGTERM"); } catch (error) { if (!missingProcess(error)) throw error; }
  }
  const grace = Math.min(deadline - 700, now() + 6_000);
  while (now() < grace && await current()) { await sample(); await delay(100); }
  if (await current()) {
    await sample();
    if (await current()) {
      assert.ok(now() < deadline, "Creator force-stop deadline exceeded");
      try { process.kill(identity.pid, "SIGKILL"); } catch (error) { if (!missingProcess(error)) throw error; }
    }
  }
  while (await current()) {
    assert.ok(now() < deadline, "Creator remains after bounded stop");
    await delay(40);
  }
}
export async function recoverContracts(root: string, conclusion: string, deadline: number): Promise<ContractRecoveryReport> {
  const report: ContractRecoveryReport = { version: 1, kind: "contract-recovery", conclusion, started: new Date().toISOString(),
    completed: false, roots: [], failures: [] };
  const path = await reportPath(root, "ci-recovery", report);
  const persist = () => atomicReceipt(path, report);
  try {
    const previous = await readRecoveryReports(root, deadline);
    const first = await readContractRoots(root, deadline - 500);
    report.failures.push(...first.failures);
    const priorRoots = previous.flatMap(report => report.roots);
    assertContractHistory(first.roots, priorRoots);
    async function record(contract: ContractRoot): Promise<z.infer<typeof rootRecoverySchema>> {
      let fixture: z.infer<typeof fixtureAuthoritySchema>;
      if (contract.run.launch.kind === "not-requested") fixture = { kind: "not-requested" };
      else {
        try { fixture = { kind: "known", ...await readContractFixture(contract.directory, contract.run.worker, deadline - 500) }; }
        catch (error) { fixture = { kind: "unknown", reason: describe(error) }; }
      }
      return { ...contract, fixture, worker: "unknown", owner: fixture.kind === "not-requested" ? "not-requested" : "unknown", observed: [],
        originals: { before: await originals(contract, fixture), after: [] },
        recovery: { failures: [], container: "unknown", directory: "unknown", processes: "unknown" }, failures: [] };
    }
    for (const contract of first.roots) report.roots.push(await record(contract));
    persist();
    const protectedPids = await protectedProcesses(deadline - 500);
    const workers = new Map(first.roots.map(({ run: { worker } }) => [processKey(worker), worker]));
    const stopped = new Set<string>();
    await Promise.all([...workers].map(async ([key, worker]) => {
      try {
        await stopExact(worker, protectedPids, Math.min(deadline - 10_000, now() + 7_000));
        stopped.add(key);
      }
      catch (error) { report.failures.push(`Worker ${key}: ${describe(error)}`); }
    }));
    const second = await readContractRoots(root, deadline - 500);
    report.failures.push(...second.failures);
    assertContractHistory(second.roots, [...first.roots, ...priorRoots]);
    const roots = new Map(first.roots.map(contract => [contract.directory, contract]));
    for (const contract of second.roots) roots.set(contract.directory, contract);
    const originalRecords = new Map(report.roots.map(result => [result.directory, result]));
    report.roots = [];
    for (const contract of roots.values()) {
      const result = await record(contract), initial = originalRecords.get(contract.directory);
      if (initial) result.originals.before = initial.originals.before;
      result.worker = stopped.has(processKey(contract.run.worker)) ? "absent" : "unknown";
      report.roots.push(result);
    }
    persist();
    await Promise.all(report.roots.map(async result => {
      try {
        assert.equal(result.worker, "absent", "Worker quiescence unproven after root rescan");
        if (result.fixture.kind === "not-requested") {
          result.recovery = { failures: [], container: "absent", directory: "absent", processes: "absent" };
          return;
        }
        assert.ok(result.fixture.kind === "known", result.fixture.kind === "unknown" ? result.fixture.reason : "Missing fixture authority");
        const fixture = result.fixture;
        let services: z.infer<typeof ownershipSchema>["processes"] = [];
        try { services = ownershipSchema.parse(JSON.parse(await regularFile(join(fixture.artifacts, "ownership.json")))).processes; }
        catch (error) { result.failures.push("Pre-stop resource snapshot: " + describe(error)); }
        const owned = retainedProcesses(previous, result, fixture, services);
        const sample = async () => {
          await observeOwned(owned, Math.min(deadline - 4_000, now() + 1_000));
          result.observed = [...owned.values()];
          persist();
        };
        await sample();
        await stopExact(fixture.owner.fixtureOwner, protectedPids, Math.min(deadline - 4_000, now() + 7_000), sample);
        result.owner = "absent";
        await sample();
        result.recovery = await recoverFixture(result.directory, result.observed, deadline - 500);
      } catch (error) { result.failures.push(describe(error)); }
      finally {
        result.originals.after = await originals(result, result.fixture);
        persist();
      }
    }));
    report.completed = true;
  } catch (error) { report.failures.push(describe(error)); }
  finally { persist(); }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deadline = now() + 28_000;
  let finished = false;
  const watchdog = setTimeout(() => { console.error("Contract recovery watchdog expired; completion unknown"); process.exit(1); }, 29_000);
  try {
    assert.equal(process.argv[2], "--contracts", "Expected --contracts <absolute artifact root>");
    const root = process.argv[3];
    assert.ok(root && isAbsolute(root), "Absolute artifact root required");
    const report = await before(recoverContracts(root, process.env.CONTRACTS_CONCLUSION ?? "unknown", deadline), deadline, "Contract recovery");
    finished = report.completed;
    process.exitCode = !report.completed || report.failures.length || report.roots.some(result => result.failures.length || result.worker !== "absent" ||
      result.owner === "unknown" || result.recovery.failures.length || [result.recovery.container, result.recovery.directory, result.recovery.processes].some(status => status !== "absent")) ? 1 : 0;
  } catch (error) { console.error(describe(error)); process.exitCode = 1; }
  finally { if (finished) clearTimeout(watchdog); }
}
