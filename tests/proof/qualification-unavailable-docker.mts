import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { before, boundedCommand, describe, now } from "./member-service-diagnostics.mts";
import { atomicReceipt, missingProcess, ownershipSchema, readContractFixture, readContractRoots, regularFile } from "./member-service-recovery.mts";

const stage = z.enum(["pre", "after-invalid", "final"]).parse(process.argv[2]);
const root = process.argv[3];
assert.ok(root && isAbsolute(root), "Absolute artifact root required");
const output = join(root, "qualification-unavailable-docker"), deadline = now() + 20_000;
const watchdog = setTimeout(() => { console.error("Docker qualification observer exceeded 21 seconds"); process.exit(1); }, 21_000);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.object({ directory: z.string(), artifacts: z.string(), worker: z.unknown(), owner: z.unknown(),
  ownerSHA256: sha, ownershipSHA256: sha, readySHA256: sha, container: z.string(), allocatedID: sha });
async function work() {
  await mkdir(output, { recursive: true });
  const manifestText = await regularFile("tests/proof/qualification-unavailable-docker-inputs.json");
  const manifest = z.object({ preparedSHA256: z.record(z.string(), sha), protectedSHA256: z.record(z.string(), sha), patchSHA256: sha }).parse(JSON.parse(manifestText));
  for (const [path, expected] of Object.entries({ ...manifest.protectedSHA256, ...manifest.preparedSHA256 })) {
    assert.ok(!isAbsolute(path) && !path.split("/").includes(".."));
    const metadata = await lstat(resolve(path));
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1_048_576);
    assert.equal(hash(await readFile(resolve(path))), expected, path + " changed from prepared source");
  }
  const patch = await regularFile("tests/proof/qualification-unavailable-docker.patch");
  assert.equal(hash(patch), manifest.patchSHA256);
  if (stage === "pre") {
    atomicReceipt(join(output, "source-inputs.json"), JSON.parse(manifestText));
    atomicReceipt(join(output, "source-verification.json"), { passed: true, manifestSHA256: hash(manifestText) });
  }
  const discovered = await readContractRoots(root, deadline - 1_000);
  assert.deepEqual(discovered.failures, []);
  assert.equal(discovered.roots.length, 1, "Expected the existing forced timeout contract only");
  const contract = discovered.roots[0];
  assert.ok(contract && contract.run.launch.kind === "requested");
  const fixture = await readContractFixture(contract.directory, contract.run.worker, deadline - 1_000);
  const ownerText = await regularFile(join(fixture.artifacts, "owner.json"));
  const ownershipText = await regularFile(join(fixture.artifacts, "ownership.json"));
  const evidence = ownershipSchema.parse(JSON.parse(ownershipText));
  const readyText = await regularFile(join(fixture.artifacts, "timeout-ready.json"));
  assert.deepEqual(ownershipSchema.parse(JSON.parse(readyText)), evidence, "Settled ownership changed after readiness");
  const ready = z.object({ readyUTC: z.string().datetime(), mode: z.literal("forced") }).strict()
    .parse(JSON.parse(await regularFile(join(fixture.artifacts, "qualification-ready.json"))));
  assert.equal(evidence.pendingProcessAcquisitions, 0);
  assert.ok(evidence.allocation.kind === "settled", "Acknowledged Docker allocation required");
  assert.ok(evidence.processes.every(proc => proc.identity.kind === "known"));
  const allocatedID = evidence.allocation.container;
  const reference = { directory: contract.directory, artifacts: fixture.artifacts, worker: contract.run.worker, owner: fixture.owner,
    ownerSHA256: hash(ownerText), ownershipSHA256: hash(ownershipText), readySHA256: hash(readyText), container: evidence.container, allocatedID };
  if (stage !== "pre") {
    const previous = referenceSchema.parse(JSON.parse(await regularFile(join(output, "pre.json"))));
    assert.deepEqual(reference, previous, "Original fixture authority changed");
  }
  const query = async (args: string[]) => {
    const result = await boundedCommand("docker", args, Math.min(deadline - 500, now() + 2_000));
    assert.ok(result.stdout.kind === "complete", "Docker query output must be complete");
    return { result, text: result.stdout.text.trim() };
  };
  const byID = await query(["ps", "--no-trunc", "-aq", "--filter", "id=" + allocatedID]);
  const byName = await query(["ps", "--no-trunc", "-aq", "--filter", "name=^/" + evidence.container + "$"]);
  const expected = stage === "final" ? "" : allocatedID;
  assert.equal(byID.text, expected, "Exact allocated Docker ID observation mismatch");
  assert.equal(byName.text, expected, "Exact Docker name observation mismatch");
  let inspection: Awaited<ReturnType<typeof query>> | undefined;
  if (stage !== "final") {
    inspection = await query(["inspect", "--format", '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', allocatedID]);
    assert.equal(inspection.text, allocatedID + " /" + evidence.container + " " + evidence.container);
  }
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
  try { metadata = await lstat(evidence.directory); }
  catch (error) { if (!missingProcess(error)) throw error; }
  const directory = metadata ? "present" : "absent";
  if (metadata) {
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
    assert.equal(await regularFile(join(evidence.directory, ".fixture-owner")), evidence.container);
  }
  if (stage === "pre") assert.equal(directory, "present");
  if (stage === "final") assert.equal(directory, "absent");
  atomicReceipt(join(output, stage + ".json"), { ...reference, passed: true, stage, observedUTC: new Date().toISOString(), ready,
    sourceManifestSHA256: hash(manifestText), byID, byName, inspection, directoryResource: directory });
  if (stage === "final") atomicReceipt(join(output, "step-conclusions.json"), {
    workflowSHA: process.env.GITHUB_SHA, contracts: process.env.QUALIFICATION_CONTRACTS,
    pre: process.env.QUALIFICATION_PRE, invalidRecovery: process.env.QUALIFICATION_INVALID_RECOVERY,
    invalidInspection: process.env.QUALIFICATION_INVALID_INSPECTION, afterInvalid: process.env.QUALIFICATION_AFTER_INVALID,
    normalRecovery: process.env.QUALIFICATION_NORMAL_RECOVERY, normalInspection: process.env.QUALIFICATION_NORMAL_INSPECTION });
}
try { await before(work(), deadline, "Unavailable Docker observations"); }
catch (error) {
  await mkdir(output, { recursive: true });
  atomicReceipt(join(output, stage + "-error.json"), { passed: false, stage, error: describe(error) });
  throw error;
} finally { clearTimeout(watchdog); }
