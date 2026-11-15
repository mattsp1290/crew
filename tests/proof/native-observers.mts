import assert from "node:assert/strict";
import { describe, exitStatus } from "./member-service-diagnostics.mts";
import { withServices, until, type Services } from "./member-services.mts";
import { verifyObserverProcesses } from "./member-observer-processes.mts";

async function ready(s: Services) {
  await s.startTemporal();
  await s.worker();
  await until(async () => {
    try {
      return await s.sql("SELECT string_agg(DISTINCT engine, ',' ORDER BY engine) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'") === "claude,codex,pi" || undefined;
    } catch { return undefined; }
  }, "all three fixture worker registrations");
}
try {
  assert.equal(process.version, "v24.22.3");
  await withServices({ label: "observer-processes" }, async s => {
    await ready(s);
    await verifyObserverProcesses(s, ["pi", "claude", "codex"]);
  });
  await withServices({ label: "observation-file" }, async s => {
    await ready(s);
    await s.execute(process.execPath, ["--test", "tests/service/observation.test.ts"]);
  });
} catch (error) {
  console.error(describe(error));
  process.exitCode = exitStatus(error);
}
