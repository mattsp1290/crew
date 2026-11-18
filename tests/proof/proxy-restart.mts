import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commands } from "./member-commands.mts";
import { services, until, type Engine } from "./member-services.mts";
import { startRestartFixtures } from "./proxy-restart-fixtures.mts";

assert.equal(process.version, "v24.22.3", "Activate pinned Node 24.22.3");
const engines: Engine[] = ["claude", "codex", "pi"];
const s = await services();
try {
  const fixtures = await startRestartFixtures();
  try {
    s.env.BIRBCREW_PROXY_FIXTURE_ENDPOINTS = JSON.stringify(fixtures.endpoints);
    const worker = () => s.child(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/proxy-restart-profiles.mts"]);
    const { command, create } = commands(s);
    let temporal = await s.startTemporal();
    let stop = await worker();
    await until(async () => {
      try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='proxy.fixture.v1'") === "3" || undefined; }
      catch { return undefined; }
    }, "proxy worker registration");
    const cases = [];
    for (const engine of engines) {
      const member = await create(engine, "proxy.fixture.v1");
      const key = await member.open();
      const nonce = randomUUID();
      const request = { ...key, requestId: randomUUID(), text: "remember " + nonce };
      assert.deepEqual(await command("turn", request), { text: "stored " + nonce });
      cases.push({ engine, key, nonce, request });
      assert.equal(fixtures.evidence()[engine].requests, 1);
    }
    // Actual process group termination, not merely closing/recreating a profile.
    await stop();
    await temporal();
    await s.restartDatabase(); // rediscovers an automatically reassigned DB port
    temporal = await s.startTemporal(); // same SQLite persistence file
    stop = await worker(); // same private native state; new processes and relay tokens
    for (const { engine, key, nonce, request } of cases) {
      assert.deepEqual(await command("turn", request), { text: "stored " + nonce });
      assert.equal(fixtures.evidence()[engine].requests, 1, "duplicate replay did not infer again");
      assert.deepEqual(await command("turn", { ...key, requestId: randomUUID(), text: "recall" }), { text: "recalled " + nonce });
      const evidence = fixtures.evidence()[engine];
      assert.equal(evidence.requests, 2);
      assert.equal(new Set(evidence.credentialDigests).size, 2, "recall resolved fresh credentials after restart");
      console.log(`${engine}: process/Postgres/Temporal restart, duplicate replay=0 new requests, recall=1 fresh request`);
    }
    await stop();
    await temporal();
  } finally { await fixtures.close(); }
} finally { await s.close(); }
console.log("Proxy restart fixture passed; all owned services and private state cleaned up. No live inference.");
