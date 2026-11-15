import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { now } from "./member-service-diagnostics.mts";
import { positiveGroupProcessSchema } from "./member-service-processes.mts";
import { atomicReceipt, contractRunSchema, fixtureOwnerSchema, isolatedOwnerSchema, ownershipSchema,
  readContractFixture, readContractRoots, recoverFixture } from "./member-service-recovery.mts";

const worker = positiveGroupProcessSchema.parse({ pid: 401, parent: 399, group: 400, startTime: "1001", state: "S" });
const owner = fixtureOwnerSchema.parse({ version: 1,
  fixtureOwner: { pid: 501, parent: worker.pid, group: 501, startTime: "1002", state: "S" } });
const run = contractRunSchema.parse({ version: 1, worker, launch: { kind: "requested" } });
const ownership = {
  version: 1, pendingProcessAcquisitions: 0, label: "contract", directory: "/tmp/birb-members-example",
  container: "birb-proof-11111111-1111-1111-1111-111111111111", allocation: { kind: "not-started" }, processes: [],
};

async function temporaryRoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crew-recovery-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function contract(root: string, name = "crew-contract-example", record: unknown = run) {
  const directory = join(root, name);
  await mkdir(directory);
  atomicReceipt(join(directory, "contract-run.json"), record);
  return directory;
}
async function fixture(directory: string, record: unknown = owner) {
  const artifacts = join(directory, "contract-example");
  await mkdir(artifacts);
  atomicReceipt(join(artifacts, "owner.json"), record, { immutable: true });
  return artifacts;
}

test("local contract launch records accept a nonleader worker and require an explicit launch state", () => {
  for (const kind of ["not-requested", "requested"]) {
    const record = { version: 1, worker, launch: { kind } };
    assert.deepEqual(contractRunSchema.parse(record), record);
  }
  for (const invalid of [
    { worker, launch: { kind: "requested" } },
    { ...run, version: 2 },
    { ...run, launch: undefined },
    { ...run, launch: { kind: "unknown" } },
    { ...run, launch: { kind: "requested", complete: true } },
    { ...run, complete: true },
  ]) assert.equal(contractRunSchema.safeParse(invalid).success, false);
});

test("local fixture owner records distinguish positive identity from isolated contract authority", () => {
  const nonleader = { ...owner, fixtureOwner: { ...owner.fixtureOwner, group: 500 } };
  assert.deepEqual(fixtureOwnerSchema.parse(nonleader), nonleader);
  assert.deepEqual(isolatedOwnerSchema.parse(owner), owner);
  assert.equal(isolatedOwnerSchema.safeParse(nonleader).success, false);
  assert.equal(fixtureOwnerSchema.safeParse({ fixtureOwner: owner.fixtureOwner }).success, false);
  assert.equal(fixtureOwnerSchema.safeParse({ ...owner, version: 2 }).success, false);
  assert.equal(fixtureOwnerSchema.safeParse({ ...owner, complete: true }).success, false);
});

test("local ownership records preserve known empty fixtures and overlapping pending acquisitions", () => {
  assert.deepEqual(ownershipSchema.parse(ownership), ownership);
  const pending = { ...ownership, pendingProcessAcquisitions: 2,
    processes: [{ pid: 601, log: "worker.log", identity: { kind: "pending" } }] };
  assert.deepEqual(ownershipSchema.parse(pending), pending);
  const partial = { ...pending, pendingProcessAcquisitions: 1,
    processes: [...pending.processes, { pid: 602, log: "gateway.log", identity: { kind: "known", group: 602, startTime: "0" } }] };
  assert.deepEqual(ownershipSchema.parse(partial), partial);
});

test("local ownership records reject missing acquisition state and malformed resource authority", () => {
  for (const invalid of [
    { ...ownership, version: undefined }, { ...ownership, version: 2 },
    { ...ownership, pendingProcessAcquisitions: undefined },
    ...[-1, 0.5, NaN, Infinity, "0"].map(pendingProcessAcquisitions => ({ ...ownership, pendingProcessAcquisitions })),
    { ...ownership, complete: true }, { ...ownership, label: "other" },
    { ...ownership, container: "birb-proof-not-a-uuid" },
    { ...ownership, allocation: { kind: "settled", container: "short-id" } },
  ]) assert.equal(ownershipSchema.safeParse(invalid).success, false);
  const settled = { ...ownership, allocation: { kind: "settled", container: "a".repeat(64) } };
  assert.deepEqual(ownershipSchema.parse(settled), settled);
});

test("local contract root discovery preserves not-requested and requested roots without inventing owners", async t => {
  const root = await temporaryRoot(t);
  const notRequested = contractRunSchema.parse({ ...run, launch: { kind: "not-requested" } });
  const idle = await contract(root, "crew-contract-idle", notRequested);
  const requested = await contract(root, "crew-contract-requested");
  await writeFile(join(root, "unrelated.json"), "{}");
  const result = await readContractRoots(root, now() + 2_000);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.roots.toSorted((a, b) => a.directory.localeCompare(b.directory)),
    [{ directory: idle, run: notRequested }, { directory: requested, run }]);
  await assert.rejects(readContractFixture(requested, worker, now() + 2_000));
});

test("local contract root discovery retains valid roots and reports missing or corrupt records", async t => {
  const root = await temporaryRoot(t);
  const valid = await contract(root, "crew-contract-valid");
  await mkdir(join(root, "crew-contract-missing"));
  const corrupt = await contract(root, "crew-contract-corrupt");
  await writeFile(join(corrupt, "contract-run.json"), "{broken");
  await contract(root, "crew-contract-incomplete", { version: 1, worker });
  const result = await readContractRoots(root, now() + 2_000);
  assert.deepEqual(result.roots, [{ directory: valid, run }]);
  assert.equal(result.failures.length, 3);
  for (const name of ["crew-contract-missing", "crew-contract-corrupt", "crew-contract-incomplete"])
    assert.ok(result.failures.some(failure => failure.startsWith(name + ":")));
});

test("local contract root discovery rejects absent empty relative and symlink artifact roots", async t => {
  const root = await temporaryRoot(t);
  await assert.rejects(readContractRoots(join(root, "missing"), now() + 2_000));
  await assert.rejects(readContractRoots(root, now() + 2_000));
  await assert.rejects(readContractRoots("relative-artifacts", now() + 2_000));
  const actual = join(root, "actual");
  await mkdir(actual);
  await contract(actual);
  const alias = join(root, "alias");
  await symlink(actual, alias, "dir");
  await assert.rejects(readContractRoots(alias, now() + 2_000));
});

test("local contract root discovery rejects symlink escapes and symlink worker records", async t => {
  const root = await temporaryRoot(t);
  const outside = join(root, "outside");
  const scanned = join(root, "scanned");
  await mkdir(outside);
  await mkdir(scanned);
  const escaped = await contract(outside);
  await symlink(escaped, join(scanned, "crew-contract-escape"), "dir");
  const linked = join(scanned, "crew-contract-linked");
  await mkdir(linked);
  await symlink(join(escaped, "contract-run.json"), join(linked, "contract-run.json"));
  await writeFile(join(scanned, "crew-contract-file"), "{}");
  const result = await readContractRoots(scanned, now() + 2_000);
  assert.deepEqual(result.roots, []);
  assert.equal(result.failures.length, 3);
});

test("local contract root discovery rejects excessive contract counts", async t => {
  const root = await temporaryRoot(t);
  await Promise.all(Array.from({ length: 129 }, (_, index) => mkdir(join(root, "crew-contract-" + index))));
  await assert.rejects(readContractRoots(root, now() + 2_000));
});

test("local fixture authority remains valid before a resource ownership snapshot exists", async t => {
  const root = await temporaryRoot(t);
  const directory = await contract(root);
  const artifacts = await fixture(directory);
  atomicReceipt(join(directory, "recovery.json"), { failures: ["original local recovery"] });
  assert.deepEqual(await readContractFixture(directory, worker, now() + 2_000), { artifacts, owner });
  await assert.rejects(readFile(join(artifacts, "ownership.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "recovery.json"), "utf8")), { failures: ["original local recovery"] });
});

test("local requested fixture authority rejects missing corrupt and incomplete owner records", async t => {
  const root = await temporaryRoot(t);
  const directory = await contract(root);
  const artifacts = join(directory, "contract-example");
  await mkdir(artifacts);
  await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
  for (const text of ["{broken", "{}", JSON.stringify({ fixtureOwner: owner.fixtureOwner })]) {
    await writeFile(join(artifacts, "owner.json"), text);
    await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
  }
});

test("local fixture authority rejects a wrong parent nonleader owner and shared worker group", async t => {
  const root = await temporaryRoot(t);
  const directory = await contract(root);
  const artifacts = await fixture(directory);
  const invalidOwners = [
    { ...owner, fixtureOwner: { ...owner.fixtureOwner, parent: worker.pid + 1 } },
    { ...owner, fixtureOwner: { ...owner.fixtureOwner, group: 500 } },
    { ...owner, fixtureOwner: { ...owner.fixtureOwner, pid: worker.group, group: worker.group } },
  ];
  for (const invalid of invalidOwners) {
    await writeFile(join(artifacts, "owner.json"), JSON.stringify(invalid));
    await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
  }
});

test("local fixture authority rejects extra siblings and unrecognized artifact names", async t => {
  const root = await temporaryRoot(t);
  for (const name of ["unrelated.json", "contract-second", "other-directory"]) {
    const directory = await contract(root, "crew-contract-" + name.replace(/[^a-zA-Z0-9]/g, ""));
    await fixture(directory);
    await writeFile(join(directory, name), "{}");
    await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
  }
  const directory = await contract(root, "crew-contract-unrecognized");
  const artifacts = join(directory, "unrecognized");
  await mkdir(artifacts);
  atomicReceipt(join(artifacts, "owner.json"), owner);
  await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
});

test("local fixture authority rejects symlink roots and artifact directories outside their root", async t => {
  const root = await temporaryRoot(t);
  const outside = await contract(root, "crew-contract-outside");
  const artifacts = await fixture(outside);
  const directory = await contract(root, "crew-contract-linked");
  await symlink(artifacts, join(directory, "contract-escape"), "dir");
  await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
  const alias = join(root, "alias");
  await symlink(outside, alias, "dir");
  await assert.rejects(readContractFixture(alias, worker, now() + 2_000));
});

test("local fixture authority rejects symlink directory and oversized owner records", async t => {
  const root = await temporaryRoot(t);
  const directory = await contract(root);
  const artifacts = join(directory, "contract-example");
  await mkdir(artifacts);
  const original = join(root, "original.json"), receipt = join(artifacts, "owner.json");
  atomicReceipt(original, owner);
  await symlink(original, receipt);
  await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
  await rm(receipt);
  await mkdir(receipt);
  await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
  await rm(receipt, { recursive: true });
  await writeFile(receipt, JSON.stringify({ ...owner, padding: "x".repeat(1024 * 1024) }));
  await assert.rejects(readContractFixture(directory, worker, now() + 2_000));
});

test("local immutable owner publication preserves its first complete private receipt", async t => {
  const root = await temporaryRoot(t), path = join(root, "owner.json");
  atomicReceipt(path, owner, { immutable: true });
  const original = await readFile(path, "utf8");
  assert.deepEqual(fixtureOwnerSchema.parse(JSON.parse(original)), owner);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.throws(() => atomicReceipt(path, { ...owner, version: 2 }, { immutable: true }), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(root), ["owner.json"]);
});

test("local immutable owner publication refuses a symlink without replacing its target", async t => {
  const root = await temporaryRoot(t), original = join(root, "original.json"), path = join(root, "owner.json");
  await writeFile(original, "original evidence");
  await symlink(original, path);
  assert.throws(() => atomicReceipt(path, owner, { immutable: true }), { code: "EEXIST" });
  assert.equal(await readFile(original, "utf8"), "original evidence");
  assert.deepEqual((await readdir(root)).toSorted(), ["original.json", "owner.json"]);
});

test("local atomic launch publication replaces the complete record and leaves no temporary receipts", async t => {
  const root = await temporaryRoot(t), path = join(root, "contract-run.json");
  const initial = contractRunSchema.parse({ ...run, launch: { kind: "not-requested" } });
  atomicReceipt(path, initial);
  assert.deepEqual(contractRunSchema.parse(JSON.parse(await readFile(path, "utf8"))), initial);
  atomicReceipt(path, run);
  assert.deepEqual(contractRunSchema.parse(JSON.parse(await readFile(path, "utf8"))), run);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ["contract-run.json"]);
});


test("local fixture fallback refuses a private directory with a changed owner marker", async t => {
  const root = await temporaryRoot(t), directory = join(root, "crew-contract-marker"), artifacts = join(directory, "contract-marker");
  await mkdir(artifacts, { recursive: true });
  const privateDirectory = await mkdtemp(join(tmpdir(), "birb-members-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const wrongMarker = "changed-owner-marker", canary = "preserve-private-data";
  await writeFile(join(privateDirectory, ".fixture-owner"), wrongMarker);
  await writeFile(join(privateDirectory, "canary.txt"), canary);
  atomicReceipt(join(artifacts, "ownership.json"), { ...ownership, directory: privateDirectory });
  const result = await recoverFixture(directory, [], now() + 2_000);
  assert.equal(result.processes, "absent");
  assert.equal(result.container, "absent");
  assert.equal(result.directory, "unknown");
  assert.match(result.failures.join("\n"), /marker disagrees with ownership/);
  assert.ok((await lstat(privateDirectory)).isDirectory());
  assert.equal(await readFile(join(privateDirectory, ".fixture-owner"), "utf8"), wrongMarker);
  assert.equal(await readFile(join(privateDirectory, "canary.txt"), "utf8"), canary);
});
