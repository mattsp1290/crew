import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import {
  boundedCommand, captureCommand, collectArtifacts, collectFiles, CommandFailure,
  completedCommandFailure, durableLog, exitStatus, firstFailure, now,
} from "./member-service-diagnostics.mts";
import { disposeContainer } from "./member-service-container.mts";
import { workingState } from "./member-services.mts";

async function ownedDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "birb-isolated-ci-test-"));
  const marker = randomUUID();
  await writeFile(join(directory, ".test-owner"), marker, { mode: 0o600 });
  console.log("Owned temporary directory " + directory);
  t.after(async () => {
    assert.equal(await readFile(join(directory, ".test-owner"), "utf8"), marker);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function ownedProcess(pid: number | undefined) {
  assert.ok(pid !== undefined && Number.isSafeInteger(pid) && pid > 1);
  console.log("Owned process group " + pid);
}

const owner = "birb-proof-12345678-1234-1234-1234-123456789abc";
const id = "a".repeat(64), otherId = "b".repeat(64);
type DockerScenario =
  | { kind: "empty" }
  | { kind: "present"; id: string; inspection: string }
  | { kind: "missing"; id: string; diagnostic: string; disappear: boolean };

async function fakeDocker(t: TestContext, scenario: DockerScenario) {
  const directory = await ownedDirectory(t);
  const marker = await readFile(join(directory, ".test-owner"), "utf8");
  const executable = join(directory, "docker"), calls = join(directory, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const directory = ${JSON.stringify(directory)}, scenario = ${JSON.stringify(scenario)};
assert.equal(readFileSync(directory + "/.test-owner", "utf8"), ${JSON.stringify(marker)});
const args = process.argv.slice(2), gone = directory + "/removed";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ pid: process.pid, args }) + "\\n");
if (args[0] === "ps") {
  if (scenario.kind !== "empty" && !existsSync(gone)) process.stdout.write(scenario.id + "\\n");
} else if (args[0] === "inspect" && scenario.kind === "missing") {
  if (scenario.disappear) writeFileSync(gone, "missing");
  process.stderr.write(scenario.diagnostic + "\\n");
  process.exitCode = 1;
} else if (args[0] === "inspect" && scenario.kind === "present") {
  process.stdout.write(scenario.inspection + "\\n");
} else if (args[0] === "rm") {
  writeFileSync(gone, "removed");
} else {
  process.exitCode = 42;
}
`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = directory + delimiter + (previous ?? "");
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  return async () => {
    let content: string;
    try { content = await readFile(calls, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return content.trim().split("\n").map(line => {
      const call = z.object({ pid: z.number().int().positive(), args: z.array(z.string()) }).parse(JSON.parse(line));
      ownedProcess(call.pid);
      return call.args;
    });
  };
}

test("bounded commands separate protocol stdout from diagnostic stderr", async () => {
  const result = await boundedCommand(process.execPath, ["-e",
    'process.stdout.write("protocol-value\\n"); process.stderr.write("diagnostic-only\\n")'], now() + 5_000);
  ownedProcess(result.pid);
  assert.deepEqual(result.stdout, { kind: "complete", text: "protocol-value\n", received: 15, retained: 15 });
  assert.ok(result.diagnostics.includes("protocol-value\n"));
  assert.ok(result.diagnostics.includes("diagnostic-only\n"));
  assert.equal(result.received, 31);
});

test("bounded protocol output reports truncation without exposing a partial protocol value", async () => {
  const result = await boundedCommand(process.execPath, ["-e",
    'process.stdout.write(Buffer.alloc(128 * 1024 + 17, 120))'], now() + 5_000);
  ownedProcess(result.pid);
  assert.deepEqual(result.stdout, { kind: "truncated", received: 128 * 1024 + 17, retained: 128 * 1024 });
  assert.equal(Buffer.byteLength(result.diagnostics), 128 * 1024);
  await assert.rejects(boundedCommand(process.execPath, ["-e",
    'process.stderr.write(Buffer.alloc(128 * 1024 + 17, 120)); process.exitCode = 27'], now() + 5_000), error => {
    ownedProcess(z.object({ pid: z.number().int().positive() }).parse(error).pid);
    assert.equal(exitStatus(error), 27);
    assert.equal(completedCommandFailure(error), undefined);
    return true;
  });
});

test("command exit remains primary when log capture fails and first failure evidence stays immutable", async t => {
  const directory = await ownedDirectory(t), log = join(directory, "command.log");
  await writeFile(log, "existing-log", { mode: 0o600 });
  await assert.rejects(captureCommand(log, process.execPath, ["-e", "process.exitCode = 23"]), error => {
    assert.ok(error instanceof CommandFailure);
    assert.deepEqual(error.result, { kind: "exited", code: 23 });
    assert.equal(exitStatus(error), 23);
    return true;
  });
  assert.equal(await readFile(log, "utf8"), "existing-log");
  const evidence = await readFile(log + ".first-failure.txt", "utf8");
  assert.match(evidence, /"code":23/);
  firstFailure(log + ".first-failure.txt", new Error("secondary-capture-failure"));
  assert.equal(await readFile(log + ".first-failure.txt", "utf8"), evidence);
  const report = z.object({ pid: z.number().int().positive(), outcome: z.object({ kind: z.literal("exited"), code: z.number() }), failures: z.array(z.string()) })
    .parse(JSON.parse(await readFile(log + ".result.json", "utf8")));
  ownedProcess(report.pid);
  assert.equal(report.outcome.code, 23);
  assert.ok(report.failures.length > 0);
});

test("capture failure fails an otherwise successful command", async t => {
  const directory = await ownedDirectory(t), log = join(directory, "command.log");
  await writeFile(log, "existing-log", { mode: 0o600 });
  await assert.rejects(captureCommand(log, process.execPath, ["-e", "process.exitCode = 0"]), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(exitStatus(error), 1);
    return true;
  });
  const report = z.object({ pid: z.number().int().positive() })
    .parse(JSON.parse(await readFile(log + ".result.json", "utf8")));
  ownedProcess(report.pid);
});

test("durable logs retain a bounded prefix and report all received bytes", async t => {
  const directory = await ownedDirectory(t), path = join(directory, "worker.log");
  const log = durableLog(path, 7);
  log.append(Buffer.from("first"));
  log.append(Buffer.from("second"));
  assert.deepEqual(log.close(), { received: 11, retained: 7, truncated: true });
  assert.equal(await readFile(path, "utf8"), "firstse");
});

test("Docker disposal never contacts Docker when allocation did not start", async t => {
  const calls = await fakeDocker(t, { kind: "empty" });
  await disposeContainer({ container: owner, allocation: { kind: "not-started" } }, now() + 5_000);
  assert.deepEqual(await calls(), []);
});

test("Docker disposal removes only a fully verified identity and reconciles both selectors", async t => {
  const calls = await fakeDocker(t, { kind: "present", id, inspection: `${id} /${owner} ${owner}` });
  await disposeContainer({ container: owner, allocation: { kind: "settled", container: id } }, now() + 5_000);
  const observed = await calls();
  assert.deepEqual(observed.filter(args => args[0] === "rm"), [["rm", "-f", id]]);
  assert.equal(observed.filter(args => args[0] === "inspect").length, 1);
  for (const selector of ["name=^/" + owner + "$", "id=" + id]) {
    assert.equal(observed.filter(args => args[0] === "ps" && args.at(-1) === selector).length, 2);
  }
});

test("empty Docker queries cannot resolve a pending allocation", async t => {
  const calls = await fakeDocker(t, { kind: "empty" });
  await assert.rejects(disposeContainer({ container: owner, allocation: { kind: "pending" } }, now() + 5_000), /pending/);
  assert.ok((await calls()).length > 0);
  assert.deepEqual((await calls()).filter(args => args[0] === "rm"), []);
});

test("Docker identity, name, and owner disagreements never authorize removal", async t => {
  const cases = [
    { name: "settled ID differs from query", scenario: { kind: "present", id: otherId, inspection: `${otherId} /${owner} ${owner}` } },
    { name: "inspection ID differs from query", scenario: { kind: "present", id, inspection: `${otherId} /${owner} ${owner}` } },
    { name: "inspection name differs", scenario: { kind: "present", id, inspection: `${id} /unrelated ${owner}` } },
    { name: "inspection label differs", scenario: { kind: "present", id, inspection: `${id} /${owner} unrelated` } },
  ] satisfies { name: string; scenario: DockerScenario }[];
  for (const example of cases) await t.test(example.name, async child => {
    const calls = await fakeDocker(child, example.scenario);
    await assert.rejects(disposeContainer({ container: owner, allocation: { kind: "settled", container: id } }, now() + 5_000));
    assert.deepEqual((await calls()).filter(args => args[0] === "rm"), []);
  });
});

test("only calibrated missing inspection plus empty exact selectors resolves settled disposal", async t => {
  await t.test("calibrated disappearance", async child => {
    const calls = await fakeDocker(child, { kind: "missing", id, diagnostic: "Error: No such object: " + id, disappear: true });
    await disposeContainer({ container: owner, allocation: { kind: "settled", container: id } }, now() + 5_000);
    const observed = await calls();
    assert.deepEqual(observed.filter(args => args[0] === "rm"), []);
    for (const selector of ["name=^/" + owner + "$", "id=" + id]) {
      assert.ok(observed.filter(args => args[0] === "ps" && args.at(-1) === selector).length >= 2);
    }
  });
  for (const example of [
    { name: "uncalibrated daemon error", diagnostic: "daemon unavailable; Error: No such object: " + id, disappear: true },
    { name: "exact identity still exists", diagnostic: "Error: No such object: " + id, disappear: false },
  ]) await t.test(example.name, async child => {
    const calls = await fakeDocker(child, { kind: "missing", id, diagnostic: example.diagnostic, disappear: example.disappear });
    await assert.rejects(disposeContainer({ container: owner, allocation: { kind: "settled", container: id } }, now() + 5_000));
    assert.deepEqual((await calls()).filter(args => args[0] === "rm"), []);
  });
});

test("hosted working-state retention requires explicit ordinary GitHub VM configuration", () => {
  assert.equal(workingState({}), "local");
  assert.equal(workingState({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }), "local");
  const hosted = { BIRBCREW_PROOF_WORKING_STATE: "github-hosted-vm", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  assert.equal(workingState(hosted), "hosted-vm");
  for (const env of [
    { ...hosted, GITHUB_ACTIONS: undefined },
    { ...hosted, GITHUB_ACTIONS: "false" },
    { ...hosted, RUNNER_ENVIRONMENT: undefined },
    { ...hosted, RUNNER_ENVIRONMENT: "self-hosted" },
    { ...hosted, BIRBCREW_PROOF_WORKING_STATE: "local" },
  ]) assert.throws(() => workingState(env));
});

test("artifact collection copies bounded allowlisted tails and excludes symlinks, directories, and private files", async t => {
  const directory = await ownedDirectory(t), source = join(directory, "private"), destination = join(directory, "snapshot");
  await mkdir(source);
  const secret = "secret-" + randomUUID(), limit = 256 * 1024;
  const log = Buffer.from("discard-prefix\n" + "x".repeat(limit) + "tail-marker\n");
  await writeFile(join(source, "worker.log"), log);
  await writeFile(join(source, "requests.jsonl"), '{"request":"safe"}\n');
  await writeFile(join(source, "config.json"), secret);
  await writeFile(join(source, ".env"), secret);
  await symlink(join(source, "config.json"), join(source, "temporal.log"));
  await mkdir(join(source, "gateway.log"));
  await collectFiles(source, destination);
  assert.deepEqual((await readdir(destination)).sort(), ["files.json", "requests.jsonl", "worker.log"]);
  assert.deepEqual(await readFile(join(destination, "worker.log")), log.subarray(-limit));
  assert.equal(await readFile(join(destination, "requests.jsonl"), "utf8"), '{"request":"safe"}\n');
  const manifest = await readFile(join(destination, "files.json"), "utf8");
  assert.ok(!manifest.includes(secret));
  const report = z.object({ bytes: z.number(), count: z.number(), files: z.array(z.object({ name: z.string(), status: z.string() })) })
    .parse(JSON.parse(manifest));
  assert.equal(report.count, 2);
  assert.ok(report.bytes <= 16 * 1024 * 1024);
  assert.deepEqual(report.files.filter(file => file.status === "omitted: not regular").map(file => file.name).sort(), ["gateway.log", "temporal.log"]);
});

test("artifact collection caps the number of copied files", async t => {
  const directory = await ownedDirectory(t), source = join(directory, "private"), destination = join(directory, "snapshot");
  await mkdir(source);
  await Promise.all(Array.from({ length: 70 }, (_, i) => writeFile(join(source, `recovery-${i}.log`), "x")));
  await collectFiles(source, destination);
  assert.equal((await readdir(destination)).filter(name => name.endsWith(".log")).length, 64);
  const report = z.object({ bytes: z.number(), count: z.number(), files: z.array(z.object({ status: z.string() })) })
    .parse(JSON.parse(await readFile(join(destination, "files.json"), "utf8")));
  assert.equal(report.count, 64);
  assert.equal(report.bytes, 64);
  assert.equal(report.files.filter(file => file.status === "omitted: budget").length, 6);
});

test("required post-step collection fails when working-state metadata cannot be read", async t => {
  const directory = await ownedDirectory(t), root = join(directory, "artifacts");
  await mkdir(join(root, "fixture"), { recursive: true });
  await assert.rejects(collectArtifacts(root), AggregateError);
  const report = z.object({ failures: z.array(z.string()) })
    .parse(JSON.parse(await readFile(join(root, "collector.json"), "utf8")));
  assert.equal(report.failures.length, 1);
});
