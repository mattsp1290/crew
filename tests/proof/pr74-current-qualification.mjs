import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const revisions = { baseline: "3a05af6ae85715a8be5d2bfbe70fbee787fb3a39", head: "267309a1ece9bb15ff778c459b528d58ca8b207d" };
const testPath = "tests/service/child-budget.test.ts", testBlob = "4171437c9a0045dc7c4c1ed602b055a0142a533d";
const selected = "a first launch over budget settles once without a generation and cannot restart after a reset";
const source = process.cwd(), controller = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const label = process.env.PR74_LABEL, revision = process.env.PR74_REVISION;
assert.ok(label in revisions);
assert.equal(revision, revisions[label]);
const output = resolve(source, "../artifacts", label);
mkdirSync(output, { recursive: true });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) => writeFileSync(join(output, name + ".json"), JSON.stringify(value, null, 2) + "\n");
function git(args, cwd = source) {
  const result = spawnSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
function manifest() {
  return git(["ls-files", "--stage", "-z"]).toString().split("\0").filter(Boolean).map(entry => {
    const [, mode, blob, path] = entry.match(/^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/);
    const bytes = mode === "120000" ? Buffer.from(readlinkSync(join(source, path))) : readFileSync(join(source, path));
    assert.equal(sha256(bytes), sha256(git(["cat-file", "blob", blob])), "tracked source differs from Git blob: " + path);
    return { path, mode, blob, bytes: bytes.length, sha256: sha256(bytes) };
  });
}
const commands = [];
let captureCommand, CommandFailure;
async function command(name, executable, args, env = {}) {
  const log = join(output, name + ".log"), previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  const metadata = { name, executable, args, startedAt: new Date().toISOString() };
  let failure;
  try {
    Object.assign(process.env, env);
    try { await captureCommand(log, executable, args); }
    catch (error) { if (!(error instanceof CommandFailure)) throw error; failure = error; }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const receipt = JSON.parse(readFileSync(log + ".result.json", "utf8"));
  commands.push({ ...metadata, finishedAt: new Date().toISOString(), receipt: name + ".log.result.json" }); save("commands", commands);
  assert.equal(receipt.failures.length, 0, name + " capture or cleanup failed");
  assert.equal(receipt.deadlineExceeded, false, name + " exceeded the canonical 20-minute deadline");
  assert.equal(receipt.truncated, false, name + " exceeded the canonical 8 MiB combined log bound");
  assert.equal(receipt.interrupted, undefined); assert.equal(receipt.outcome.kind, "exited");
  if (failure) assert.deepEqual(failure.result, receipt.outcome); else assert.equal(receipt.outcome.code, 0);
  return { code: receipt.outcome.code };
}
async function must(name, executable, args, env) {
  const result = await command(name, executable, args, env);
  assert.equal(result.code, 0, name + " failed; inspect raw log and canonical receipt");
  return result;
}
let before, admin;
try {
  assert.equal(process.version, "v24.22.3");
  assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), revision);
  assert.equal(git(["rev-parse", "HEAD"], controller).toString().trim(), process.env.PR74_PROBE_SHA);
  assert.equal(git(["status", "--porcelain", "--untracked-files=all"]).length, 0);
  before = manifest(); save("source-before", before);
  ({ captureCommand, CommandFailure } = await import(pathToFileURL(join(source, "tests/proof/member-service-diagnostics.mts")).href));
  const regression = readFileSync(join(controller, testPath));
  assert.ok(regression.equals(git(["cat-file", "blob", testBlob], controller)), "controller regression must equal approved Git blob");
  if (label === "baseline") assert.ok(!existsSync(join(source, testPath)), "baseline must lack the new regression");
  else assert.ok(readFileSync(join(source, testPath)).equals(regression));
  save("identity", { label, revision, probeSha: process.env.PR74_PROBE_SHA, node: process.version, nodeExecutableSha256: sha256(readFileSync(process.execPath)), regressionBlob: testBlob, regressionSha256: sha256(regression), runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, isolation: "Each matrix job has a fresh GitHub-hosted VM and PostgreSQL 17 service. Owned command groups are bounded. Generic descendant absence is unproven." });
  await must("npm-ci", "npm", ["ci"]);
  await must("build", "npm", ["run", "build"]);
  await must("npm-graph", "npm", ["ls", "--all", "--json"]);
  const artifactPaths = ["package.json", "package-lock.json", "node_modules/.package-lock.json", ".proof/bin/member-launch"];
  function collect(directory) {
    for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path); else artifactPaths.push(path);
    }
  }
  collect("packages/client/dist");
  save("installed-artifacts", artifactPaths.map(path => ({ path, bytes: lstatSync(join(source, path)).size, sha256: sha256(readFileSync(join(source, path))) })));
  if (label === "baseline") writeFileSync(join(source, testPath), regression, { flag: "wx" });
  const { Pool } = createRequire(join(source, "package.json"))("pg");
  admin = new Pool({ connectionString: process.env.PR74_DATABASE_URL });
  const databases = [];
  async function database(suite) {
    const name = `pr74_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT}_${label}_${suite}`;
    assert.match(name, /^[a-z0-9_]{1,63}$/); await admin.query(`CREATE DATABASE "${name}"`);
    databases.push({ suite, name }); save("databases", databases);
    const url = new URL(process.env.PR74_DATABASE_URL); url.pathname = "/" + name;
    return url.toString();
  }
  async function rows(url) {
    const pool = new Pool({ connectionString: url });
    try {
      return (await pool.query(`SELECT c.child_id,c.phase,c.generation,c.workflow_run_id,c.role_profile->>'role' AS role,
        c.outcome->>'kind' AS outcome,c.outcome->>'code' AS code,
        (SELECT count(*)::int FROM birbcrew_ts.native_launches n WHERE n.child_id=c.child_id) AS launches,
        (SELECT count(*)::int FROM birbcrew_ts.audit_events a WHERE a.payload->>'childId'=c.child_id::text AND a.event_type='delegation.started') AS starts,
        (SELECT count(*)::int FROM birbcrew_ts.audit_events a WHERE a.payload->>'childId'=c.child_id::text AND a.event_type='delegation.finished') AS finishes
        FROM birbcrew_ts.pi_children c ORDER BY c.child_id`)).rows;
    } finally { await pool.end(); }
  }
  const controlDb = await database("control");
  const control = await command("selected-control", process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^" + selected + "$", testPath], { BIRBCREW_TEST_DATABASE_URL: controlDb });
  const persisted = await rows(controlDb); save("selected-control-state", persisted);
  assert.equal(persisted.length, 1, "selected case must create exactly one child");
  const child = persisted[0]; assert.equal(child.launches, 0);
  const raw = readFileSync(join(output, "selected-control.log"), "utf8");
  if (label === "baseline") {
    assert.equal(control.code, 1);
    assert.match(raw, /not ok \d+ - a first launch over budget/); assert.match(raw, /code: 'ERR_ASSERTION'/);
    assert.match(raw, /actual: 'start'/); assert.match(raw, /expected: 'settled'/);
    assert.match(raw, /child-budget\.test\.ts:92:10/); assert.match(raw, /# fail 1\b/);
    assert.equal(child.phase, "running"); assert.ok(child.generation); assert.ok(child.workflow_run_id);
    assert.equal(child.outcome, null); assert.equal(child.starts, 0); assert.equal(child.finishes, 0);
  } else {
    assert.equal(control.code, 0);
    assert.match(raw, /ok \d+ - a first launch over budget/); assert.match(raw, /# fail 0\b/);
    assert.deepEqual([child.phase, child.generation, child.workflow_run_id, child.outcome, child.code, child.starts, child.finishes], ["failed", null, null, "failed", "budget_exhausted", 0, 1]);
    await must("store", process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", "tests/service/child-targets.test.ts", testPath], { BIRBCREW_TEST_DATABASE_URL: await database("store") });
    await must("audit", process.execPath, ["--test", "--test-reporter=tap", "tests/service/audit.test.ts"], { BIRBCREW_TEST_DATABASE_URL: await database("audit") });
    assert.ok(process.env.TEMPORAL_CLI);
    await must("temporal-version", process.env.TEMPORAL_CLI, ["--version"]);
    assert.match(readFileSync(join(output, "temporal-version.log"), "utf8"), /1\.10\.0\b/);
    save("temporal-binary", { sha256: sha256(readFileSync(process.env.TEMPORAL_CLI)) });
    const workflowDb = await database("workflow");
    await must("workflow", process.execPath, ["--test", "--test-reporter=tap", "tests/service/child-target-workflow.test.ts"], { BIRBCREW_TEST_DATABASE_URL: workflowDb });
    const workflowRows = await rows(workflowDb); save("workflow-state", workflowRows);
    const exhausted = workflowRows.filter(row => row.code === "budget_exhausted"); assert.equal(exhausted.length, 1);
    assert.deepEqual([exhausted[0].phase, exhausted[0].generation, exhausted[0].launches, exhausted[0].starts, exhausted[0].finishes], ["failed", null, 0, 0, 1]);
    const recorders = workflowRows.filter(row => row.role === "recorder"); assert.equal(recorders.length, 2);
    for (const row of recorders) assert.deepEqual([row.phase, row.outcome, row.launches, row.starts, row.finishes], ["complete", "completed", 2, 1, 1]);
    save("provider-evidence-scope", { source: "tests/service/child-target-workflow.test.ts", evidence: "Successful existing exhausted-child test asserts no matching request in either provider JSONL before existing cleanup removes those temporary logs. Independent SQL proves zero native launches. No provider SQL table exists; this is not independent retained provider-log evidence." });
  }
  save("selected-control-result", { label, revision, selectedControlExit: control.code });
} catch (error) {
  save("failure", { name: error.name, message: error.message, stack: error.stack }); process.exitCode = 1;
} finally {
  await admin?.end();
  if (before) {
    try {
      const after = manifest(); save("source-after", after); assert.deepEqual(after, before);
      assert.equal(sha256(readFileSync(join(source, testPath))), sha256(readFileSync(join(controller, testPath))));
      save("source-status", { porcelain: git(["status", "--porcelain", "--untracked-files=all"]).toString(), trackedUnchanged: true });
    } catch (error) { save("source-integrity-failure", { message: error.message }); process.exitCode = 1; }
  }
  save("result", { status: process.exitCode ? "FAIL" : "PASS", label, revision });
  const files = readdirSync(output).filter(name => name !== "artifact-checksums.json").sort();
  save("artifact-checksums", files.map(path => ({ path, sha256: sha256(readFileSync(join(output, path))) })));
}
