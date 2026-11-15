import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { until, withServices } from "./member-services.mts";

assert.equal(process.version, "v24.22.3");
const mode = z.enum(["native-failure", "native-diagnostics-failure", "native-catchable", "native-stopped"]).parse(process.argv[2]);
const root = process.env.BIRBCREW_PROOF_ARTIFACTS;
assert.ok(root && isAbsolute(root), "Expected an absolute qualification artifact directory");
await withServices({ label: "qualification-isolated", engine: "pi" }, async s => {
  await s.startTemporal();
  await s.worker();
  await until(async () => {
    try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.v1' AND engine='pi'") === "1" || undefined; }
    catch { return undefined; }
  }, "qualification Pi worker registration");
  const token = randomUUID(), config = join(s.directory, "gateway.json");
  await writeFile(config, JSON.stringify({ port: 0, tokenHashes: {
    [createHash("sha256").update(token).digest("hex")]: randomUUID(),
  } }), { mode: 0o600 });
  const gateway = await s.gateway(config);
  const response = await fetch(gateway.url + "/v1/health", { headers: { Authorization: "Bearer " + token } });
  assert.equal(response.status, 200);
  z.object({ status: z.literal("ready"), dependencies: z.object({ temporal: z.object({ status: z.literal("ready") }) }) }).parse(await response.json());
  writeFileSync(join(root, "probe-ready.json"), JSON.stringify({ mode, pid: process.pid, utc: new Date().toISOString(), fixtureArtifacts: s.artifacts }), { mode: 0o600, flag: "wx" });
  console.log(`qualification synthetic native fixture ready ${mode}`);
  if (mode === "native-diagnostics-failure") {
    writeFileSync(join(s.artifacts, "snapshot"), "qualification intentionally obstructs the required snapshot", { mode: 0o600, flag: "wx" });
    return;
  }
  if (mode === "native-failure") assert.fail("Qualification synthetic native assertion failure");
  if (mode === "native-stopped") process.kill(process.pid, "SIGSTOP");
  await delay(19 * 60_000);
  assert.fail("Qualification native cancellation was not received within nineteen minutes");
});
