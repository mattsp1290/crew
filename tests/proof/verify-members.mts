import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { verifyObserverProcesses } from "./member-observer-processes.mts";
import { evidenceOutputs, fixtureReport } from "./member-report.mts";
import { verifyChildren } from "./member-children.mts";
import { verifyDecisions } from "./member-decisions.mts";
import { verifyNotes } from "./member-notes.mts";
import { commands } from "./member-commands.mts";
import { run, services, until, type Engine, type Services } from "./member-services.mts";

const matrix = {
  pi: { native: ["pi/durable", "pi/protected", "pi/delegation", "pi/confinement"], service: ["child-launch"], archive: "^(?:@ag-ui/pi |Pi's )",
    observers: "^pi |^two HttpAgents .*child|^two HttpAgents .*subagents|^terminated Pi child" },
  claude: { native: ["claude/durable", "claude/protected"], service: [], archive: "^@ag-ui/claude", observers: "^claude " },
  codex: { native: ["codex/qualification", "codex/native"], service: ["codex-subscription", "codex-mcp", "codex-registration", "codex-chat", "codex-calls", "codex-live", "codex-live-crashes"],
    archive: "^the locked official Codex", observers: "^codex " },
} as const;

async function execute(program: string, args: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn(program, args, { env, stdio: "inherit", detached: true });
  const kill = () => { if (proc.pid && proc.exitCode === null && !proc.signalCode) process.kill(-proc.pid, "SIGKILL"); };
  process.prependOnceListener("SIGINT", kill); process.prependOnceListener("SIGTERM", kill);
  let code;
  try { [code] = await once(proc, "exit"); }
  finally { process.off("SIGINT", kill); process.off("SIGTERM", kill); }
  if (code !== 0) throw new Error("Verification command failed: " + [program, ...args].join(" "));
}
async function test(paths: string[], env: NodeJS.ProcessEnv, pattern?: string) {
  if (paths.length) await execute(process.execPath, ["--test", ...(pattern ? ["--test-name-pattern=" + pattern] : []), ...paths], env);
}

async function verify(s: Services, engines: Engine[], pass: (name: string) => void, selected?: Engine, replayEvidence?: string) {
  const { env } = s, { command, create } = commands(s);
  const node = process.execPath;
  await execute(node, ["node_modules/typescript/bin/tsc", "--noEmit"], env);
  await test(["tests/proof/member-evidence.test.mts"], env);
  await test(["tests/fixtures/engines/artifacts.test.ts"], env, selected && matrix[selected].archive);
  await test(["tests/fixtures/engines/consumer.test.mjs"], env, selected && "^" + selected + " ");
  await test(engines.flatMap((e) => matrix[e].native.map((n) => "tests/fixtures/engines/" + n + ".test.ts")), env);
  if (!selected) await test(["store", "providers", "approvals"].map((n) => "tests/service/" + n + ".test.ts"), env);

  let temporal = await s.startTemporal();
  const workers = await Promise.all(engines.map((e) => s.worker(e)));
  await until(async () => {
    try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.v1'") === String(engines.length) || undefined; }
    catch { return undefined; }
  }, "selected member profiles");
  pass("Locked packages, consumer clients, native SDK contracts and worker registration");
  const serviceFiles = engines.flatMap((e) => matrix[e].service.map((n) => "tests/service/" + n + ".test.ts"));
  await test(serviceFiles, env);
  if (!selected) await test(["tests/service/closure.test.ts", "tests/service/supervisor.test.ts", "tests/service/member-cancel.test.ts"], env);
  else if (selected !== "codex") await test(["tests/service/supervisor.test.ts"], env, "^" + selected + " ");
  pass("Selected service routes, native admission and recovery");
  const cases = [];
  for (const engine of engines) {
    const member = await create(engine);
    for (let i = 0; i < 2; i++) {
      const key = await member.open();
      const nonce = randomUUID();
      const request = { ...key, requestId: randomUUID(), text: "remember " + nonce };
      cases.push({ engine, key, request, nonce });
    }
  }
  await Promise.all(cases.map(async ({ request, nonce }) => assert.deepEqual(await command("turn", request), { text: "stored " + nonce })));
  await Promise.all(workers.map((stop) => stop()));
  await temporal();
  await s.restartDatabase();
  temporal = await s.startTemporal();
  let stop = await s.worker();
  await Promise.all(cases.map(async ({ key, nonce, request, engine }) => {
    assert.deepEqual(await command("turn", request), { text: "stored " + nonce });
    await command("turn", { ...request, text: "changed" }, true);
    const recall = { ...key, requestId: randomUUID(), text: "recall" };
    await command("turn", { ...recall, ownerId: "another-owner" }, true);
    await command("turn", { ...recall, engine }, true);
    assert.deepEqual(await command("turn", recall), { text: "recalled " + nonce });
  }));
  console.log("Verified two native conversations per member after PostgreSQL, Temporal and worker replacement.");
  pass("Two independent conversations per member across cold PostgreSQL, Temporal and worker restart");
  stop = await verifyDecisions(s, engines, stop);
  if (engines.some((e) => e !== "codex")) pass("Claude/Pi selected native protected decisions and ordinary next steps after worker replacement");
  stop = await verifyNotes(s, engines, stop);
  pass("Project-scoped notes on native requests before and after worker replacement");
  if (engines.includes("pi")) { stop = await verifyChildren(s, stop); pass("Pi child intent recovery, cancellation and effect budget"); }
  const requests = async () => (await readFile(env.BIRBCREW_PROOF_REQUESTS!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const { engine, request } of cases) {
    assert.equal((await requests()).filter((r) => r.engine === engine && r.prompt === request.text).length, 1);
  }
  const requestOffset = (await requests()).length;
  const observedHangs = async () => (await requests()).slice(requestOffset)
    .filter((r) => r.prompt === "wait").map((r) => r.engine as string);
  const interrupted = cases.filter((_, i) => i % 2 === 0);
  const hanging = interrupted.map(({ key }) => command("turn", { ...key, requestId: randomUUID(), text: "wait" }, true));
  const all = Promise.all(hanging);
  void all.catch(() => {});
  await until(async () => {
    const started = await observedHangs();
    return engines.every(engine => started.includes(engine)) || undefined;
  }, "all native providers in flight");
  await stop();
  stop = await s.worker();
  await all;
  for (const { key } of interrupted) assert.equal(await s.sql("SELECT phase FROM birbcrew_ts.turns WHERE conversation_id='" + key.conversationId +
    "' ORDER BY position DESC LIMIT 1"), "uncertain");
  assert.deepEqual((await observedHangs()).sort(), [...engines].sort());

  pass("Interrupted SDK invocations reconcile without automatic resubmission");
  await verifyObserverProcesses(s, engines);
  pass("Two independent clients/observe.mjs processes persisted the canonical SQL and gateway messages");
  if (selected !== "codex") await test(["tests/service/observation.test.ts"], env, selected && matrix[selected].observers);
  if (!selected) await execute(node, ["tests/proof/replay-traces.mts"], {
    ...env,
    BIRBCREW_REPLAY_EVIDENCE: replayEvidence,
    BIRBCREW_SOURCE_REVISION: process.env.BIRBCREW_SOURCE_REVISION,
    BIRBCREW_SOURCE_SHA256: process.env.BIRBCREW_SOURCE_SHA256,
  });
  pass("Official observers and selected gateway cases");
  if (!selected) pass("Cross-engine offline replay and allowlisted traces");
  await stop();
  await temporal();
}
const { values } = parseArgs({ options: { engine: { type: "string" }, mode: { type: "string", default: "fixture" },
  approval: { type: "string" }, help: { type: "boolean" } }, strict: true });
if (values.help) {
  console.log("scripts/verify-members [--mode fixture] [--engine pi|claude|codex]\nscripts/verify-members --mode live --engine ENGINE --approval FILE");
} else {
  assert.equal(process.version, "v24.22.3", "Activate pinned Node 24.22.3");
  const engine = z.enum(["pi", "claude", "codex"]).optional().parse(values.engine);
  if (values.mode === "live") {
    if (!engine || !values.approval) throw new Error("Supply an engine and an explicit proof approval");
    await execute(process.execPath, ["tests/proof/live-members.ts", "--engine", engine, "--approval", values.approval], process.env);
  } else {
    if (values.mode !== "fixture" || values.approval) throw new Error("Expected fixture mode with no proof approval");
    const outputs = await evidenceOutputs();
    await run("scripts/build-native", []);
    const engines: Engine[] = engine ? [engine] : ["pi", "claude", "codex"];
    const report = await fixtureReport(engines, outputs.fixture);
    let passed = false;
    try {
      const s = await services(engine);
      try { await verify(s, engines, report.pass, engine, outputs.replay); }
      finally { await s.close(); }
      report.pass("Fixture processes, PostgreSQL container and private state removed");
      passed = true;
    } finally {
      await report.finish(passed);
    }
  }
}
