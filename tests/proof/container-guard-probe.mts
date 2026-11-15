import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { before, boundedCommand, describe, now } from "./member-service-diagnostics.mts";
import { atomicReceipt, missingProcess, ownershipSchema, recoverFixture, regularFile, type Recovery } from "./member-service-recovery.mts";

const fullId = z.string().regex(/^[a-f0-9]{64}$/);
const containerName = z.string().regex(/^birb-proof-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const inspectedSchema = z.object({
  id: fullId, name: z.string(), label: z.string(), status: z.string(),
  mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Source: z.string().optional(), Destination: z.string() })).nullable(),
  tmpfs: z.record(z.string(), z.string()).nullable(),
});
type Inspected = z.infer<typeof inspectedSchema>;
type Ownership = z.infer<typeof ownershipSchema>;
type Acquisition = {
  name: string;
  label: string;
  allocation: { kind: "requested" } | { kind: "returned"; id: string };
  inspection: Inspected | undefined;
  cleanup: { kind: "unknown" } | { kind: "absent"; queries: { byName: string[]; byId: string[] }; volumes: string[] };
};
type PrivateDirectory = { path: string; marker: string; absence: "unknown" | "absent" };
type Scenario = {
  name: "mismatched-label" | "mismatched-allocation";
  sourceReceipts: string[];
  faultReceipt: string;
  recovery: Recovery | undefined;
  preserved: Inspected[];
  passed: boolean;
};
type Report = {
  version: 1;
  kind: "container-guard-qualification";
  started: string;
  completed: boolean;
  acquisitions: Acquisition[];
  privateDirectories: PrivateDirectory[];
  scenarios: Scenario[];
  commands: { args: string[]; stdout: string; elapsedMs: number }[];
  failures: string[];
};

const deadline = now() + 30_000, workDeadline = deadline - 10_000;
const report: Report = { version: 1, kind: "container-guard-qualification", started: new Date().toISOString(),
  completed: false, acquisitions: [], privateDirectories: [], scenarios: [], commands: [], failures: [] };
let persist = () => {};
let artifacts: string | undefined;
const failure = (error: unknown) => describe(error).slice(0, 2_048);
const watchdog = setTimeout(() => {
  report.failures.push("Qualification watchdog expired; completion and remaining cleanup are unknown");
  persist();
  process.exit(1);
}, 35_000);

async function docker(args: string[], until: number, maximum = 1_500) {
  assert.ok(report.commands.length < 96, "Docker command count exceeded its bound");
  const started = now();
  const result = await boundedCommand("docker", args, Math.min(until, now() + maximum));
  assert.equal(result.stdout.kind, "complete", "Docker stdout was truncated");
  assert.ok(result.stdout.kind === "complete");
  assert.ok(result.stdout.received <= 8_192, "Docker stdout exceeded probe report bound");
  report.commands.push({ args, stdout: result.stdout.text, elapsedMs: now() - started });
  persist();
  return result.stdout.text.trim();
}

async function inspect(id: string, until: number) {
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"label":{{json (index .Config.Labels "birb-proof-owner")}},"status":{{json .State.Status}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}';
  return inspectedSchema.parse(JSON.parse(await docker(["inspect", "--format", format, fullId.parse(id)], until)));
}

async function queries(acquisition: Acquisition, until: number) {
  const selectors = ["name=^/" + acquisition.name + "$",
    ...(acquisition.allocation.kind === "returned" ? ["id=" + acquisition.allocation.id] : [])];
  const rows = await Promise.all(selectors.map(async selector => {
    const output = await docker(["ps", "--no-trunc", "-aq", "--filter", selector], until);
    return output ? z.array(fullId).parse(output.split(/\s+/)) : [];
  }));
  const [byName, byId = []] = rows;
  assert.ok(byName);
  return { byName, byId };
}

function assertIdentity(acquisition: Acquisition, current: Inspected, id: string) {
  assert.equal(current.id, id, "Actual container ID changed");
  assert.equal(current.name, "/" + acquisition.name, "Actual container name changed");
  assert.equal(current.label, acquisition.label, "Actual creation label changed");
  assert.equal(current.status, "created", "Probe container must remain stopped");
}

async function createContainer(root: string, labelMatches: boolean) {
  const name = containerName.parse("birb-proof-" + randomUUID());
  const label = labelMatches ? name : containerName.parse("birb-proof-" + randomUUID());
  const acquisition: Acquisition = { name, label, allocation: { kind: "requested" }, inspection: undefined, cleanup: { kind: "unknown" } };
  report.acquisitions.push(acquisition);
  persist();
  const output = await docker(["create", "--pull", "never", "--name", name, "--label", "birb-proof-owner=" + label,
    "--tmpfs", "/var/lib/postgresql/data", "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"], workDeadline, 3_000);
  acquisition.allocation = { kind: "returned", id: fullId.parse(output) };
  atomicReceipt(join(root, `acquisition-${report.acquisitions.length}.json`), acquisition, { immutable: true });
  persist();
  const current = await inspect(acquisition.allocation.id, workDeadline);
  acquisition.inspection = current;
  persist();
  assertIdentity(acquisition, current, acquisition.allocation.id);
  assert.ok(current.tmpfs && Object.hasOwn(current.tmpfs, "/var/lib/postgresql/data"), "Postgres data tmpfs was not recorded");
  return acquisition;
}

async function privateDirectory(marker: string) {
  const temporary = await before(realpath(tmpdir()), workDeadline, "Temporary root");
  const path = await before(mkdtemp(join(temporary, "birb-members-")), workDeadline, "Private directory creation");
  const record: PrivateDirectory = { path, marker, absence: "unknown" };
  report.privateDirectories.push(record);
  persist();
  await before(writeFile(join(path, ".fixture-owner"), marker, { flag: "wx", mode: 0o600 }), workDeadline, "Private directory marker");
  return path;
}

async function sourceOwnership(root: string, acquisition: Acquisition) {
  assert.equal(acquisition.allocation.kind, "returned", "Container creation must return an exact ID");
  assert.ok(acquisition.allocation.kind === "returned");
  const evidence = ownershipSchema.parse({ version: 1, pendingProcessAcquisitions: 0, label: "contract",
    directory: await privateDirectory(acquisition.name), container: acquisition.name,
    allocation: { kind: "settled", container: acquisition.allocation.id }, processes: [] });
  const path = join(root, `original-ownership-${acquisition.name}.json`);
  atomicReceipt(path, evidence, { immutable: true });
  return { evidence, path };
}

async function provePresent(acquisition: Acquisition) {
  assert.ok(acquisition.allocation.kind === "returned");
  const found = await queries(acquisition, workDeadline);
  assert.deepEqual(found.byName, [acquisition.allocation.id], "Exact container name did not retain its original ID");
  assert.deepEqual(found.byId, [acquisition.allocation.id], "Exact original container ID is missing");
  const current = await inspect(acquisition.allocation.id, workDeadline);
  assertIdentity(acquisition, current, acquisition.allocation.id);
  return current;
}

async function scenario(root: string, name: Scenario["name"], sources: { evidence: Ownership; path: string }[],
  fault: Ownership, containers: Acquisition[]) {
  const directory = await before(mkdtemp(join(root, "crew-contract-")), workDeadline, "Contract artifact root");
  const fixture = await before(mkdtemp(join(directory, "contract-")), workDeadline, "Fixture artifacts");
  const path = join(fixture, "ownership.json");
  const record: Scenario = { name, sourceReceipts: sources.map(source => source.path), faultReceipt: path,
    recovery: undefined, preserved: [], passed: false };
  report.scenarios.push(record);
  atomicReceipt(path, fault, { immutable: true });
  persist();
  record.recovery = await before(recoverFixture(directory, [], Math.min(workDeadline, now() + 4_500)), workDeadline, name);
  persist();
  const presence = await Promise.allSettled(containers.map(async acquisition => {
    record.preserved.push(await provePresent(acquisition));
    persist();
  }));
  const missing = presence.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (missing.length) throw new AggregateError(missing, "Exact probe container preservation was not proven\n" + missing.map(failure).join("\n"));
  assert.equal(record.recovery.container, "unknown", "Recovery must refuse container deletion");
  assert.ok(record.recovery.failures.length > 0, "Recovery refusal must carry a failure");
  assert.equal(record.recovery.processes, "absent", "Empty process authority must remain settled");
  assert.equal(record.recovery.directory, "absent", "A valid independently owned directory may be removed after container refusal");
  assert.match(record.recovery.failures.join("\n"), name === "mismatched-label"
    ? /Container label disagrees with ownership/
    : /Allocated container identity changed|Container name disagrees with ownership/);
  for (const source of sources) {
    const original = ownershipSchema.parse(JSON.parse(await before(regularFile(source.path), workDeadline, "Original ownership receipt")));
    assert.deepEqual(original, source.evidence, "Original acquisition ownership receipt changed");
  }
  record.passed = true;
  persist();
}

async function cleanupContainer(acquisition: Acquisition) {
  const found = await queries(acquisition, deadline);
  const ids = [...new Set([...found.byName, ...found.byId])];
  if (acquisition.allocation.kind === "returned") {
    for (const id of ids) assert.equal(id, acquisition.allocation.id, "Cleanup found a replacement container");
  }
  assert.ok(ids.length <= 1, "Cleanup found conflicting exact container identities");
  const volumes = new Set<string>();
  for (const mount of acquisition.inspection?.mounts ?? []) if (mount.Type === "volume") {
    assert.ok(mount.Name && /^[a-f0-9]{64}$/.test(mount.Name), "Unexpected recorded image-created volume identity");
    volumes.add(mount.Name);
  }
  for (const id of ids) {
    const current = await inspect(id, deadline);
    assertIdentity(acquisition, current, id);
    for (const mount of current.mounts ?? []) if (mount.Type === "volume") {
      assert.ok(mount.Name && /^[a-f0-9]{64}$/.test(mount.Name), "Unexpected image-created volume identity");
      volumes.add(mount.Name);
    }
    acquisition.inspection ??= current;
    persist();
    await docker(["rm", "--volumes", id], deadline, 2_000);
  }
  const remaining = await queries(acquisition, deadline);
  assert.deepEqual(remaining, { byName: [], byId: [] }, "Probe container remains after exact cleanup");
  for (const volume of volumes) {
    assert.equal(await docker(["volume", "ls", "-q", "--filter", "name=^" + volume + "$"], deadline), "", "Image-created anonymous volume remains");
  }
  assert.equal(acquisition.allocation.kind, "returned", "Container allocation acknowledgement pending; eventual absence unknown");
  acquisition.cleanup = { kind: "absent", queries: remaining, volumes: [...volumes] };
  persist();
}

async function cleanupDirectory(record: PrivateDirectory) {
  try {
    const metadata = await before(lstat(record.path), deadline, "Private directory metadata");
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), "Private cleanup refuses a replaced directory");
    const temporary = await before(realpath(tmpdir()), deadline, "Cleanup temporary root");
    assert.equal(dirname(await before(realpath(record.path), deadline, "Private directory identity")), temporary);
    assert.match(basename(record.path), /^birb-members-[a-zA-Z0-9]+$/);
    assert.equal(await before(regularFile(join(record.path, ".fixture-owner")), deadline, "Private directory cleanup marker"), record.marker);
    await before(rm(record.path, { recursive: true }), deadline, "Exact private directory cleanup");
  } catch (error) { if (!missingProcess(error)) throw error; }
  await assert.rejects(before(lstat(record.path), deadline, "Private directory absence"), { code: "ENOENT" });
  record.absence = "absent";
  persist();
}

try {
  const configured = process.env.BIRBCREW_PROOF_ARTIFACTS;
  assert.ok(configured && isAbsolute(configured), "BIRBCREW_PROOF_ARTIFACTS must be an existing absolute directory");
  const metadata = await before(lstat(configured), workDeadline, "Artifact root metadata");
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), "Artifact root must be a real directory");
  const root = await before(realpath(configured), workDeadline, "Artifact root identity");
  artifacts = await before(mkdtemp(join(root, "container-guard-")), workDeadline, "Qualification artifact creation");
  const reportPath = join(artifacts, "report.json");
  persist = () => atomicReceipt(reportPath, report);
  persist();
  const wrongLabel = await createContainer(artifacts, false);
  const wrongLabelSource = await sourceOwnership(artifacts, wrongLabel);
  await scenario(artifacts, "mismatched-label", [wrongLabelSource], wrongLabelSource.evidence, [wrongLabel]);
  const containerA = await createContainer(artifacts, true), containerB = await createContainer(artifacts, true);
  const sourceA = await sourceOwnership(artifacts, containerA), sourceB = await sourceOwnership(artifacts, containerB);
  const fault = ownershipSchema.parse({ ...sourceB.evidence, allocation: sourceA.evidence.allocation });
  await scenario(artifacts, "mismatched-allocation", [sourceA, sourceB], fault, [containerA, containerB]);
} catch (error) {
  report.failures.push(failure(error));
  persist();
} finally {
  for (const acquisition of report.acquisitions) {
    try { await cleanupContainer(acquisition); }
    catch (error) { report.failures.push("Container cleanup: " + failure(error)); persist(); }
  }
  for (const record of report.privateDirectories) {
    try { await cleanupDirectory(record); }
    catch (error) { report.failures.push("Directory cleanup: " + failure(error)); persist(); }
  }
  report.completed = report.failures.length === 0 && report.scenarios.length === 2 && report.scenarios.every(record => record.passed)
    && report.acquisitions.length === 3 && report.acquisitions.every(record => record.cleanup.kind === "absent")
    && report.privateDirectories.every(record => record.absence === "absent");
  persist();
  clearTimeout(watchdog);
  process.exitCode = report.completed ? 0 : 1;
  process.stdout.write(JSON.stringify({ completed: report.completed, artifacts, failures: report.failures }) + "\n");
}
