import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { createProxyProfile } from "../../src/service/proxy-profiles.ts";
import type { MemberProfile } from "../../src/service/profiles.ts";

const endpoint = z.url().parse(process.env.BIRBCREW_CONTROL_FIXTURE_ENDPOINT);
const loadedBy = basename(process.argv[1] ?? "");
const log = process.env.BIRBCREW_CONTROL_RUNNER_LOG;
if (log) appendFileSync(log, JSON.stringify({ kind: "profile-load", pid: process.pid, loadedBy }) + "\n", { mode: 0o600 });

const configured: Awaited<ReturnType<typeof createProxyProfile>>[] = [];
async function profile(model: string) {
  const entry = await createProxyProfile({
    engine: "pi", protocol: "openai-chat-completions", endpoint, model,
    accountId: "control-loopback-fixture", allowHttpLoopback: true, protectedTool: "record_work_item",
    resolveCredential: async () => ({ headers: { authorization: "Bearer synthetic-control-fixture" }, expiresAt: Date.now() + 60_000 }),
  });
  configured.push(entry);
  return entry.profile;
}

export const profiles = new Map<string, MemberProfile>();
try {
  const parent = { ...await profile("control-parent"), delegateTask: true };
  const analyst = await profile("control-analyst"), recorder = await profile("control-recorder");
  profiles.set("control.legacy.v1", parent);
  profiles.set("control.parent.v1", { ...parent, childTargets: { pi: {
    analyst: { engine: "pi", profile: "control.analyst.v1" },
    recorder: { engine: "pi", profile: "control.recorder.v1" },
  } } });
  profiles.set("control.analyst.v1", analyst);
  profiles.set("control.recorder.v1", recorder);
} catch (error) {
  await Promise.all(configured.map(entry => entry.close()));
  throw error;
}
export const close = () => Promise.all(configured.map(entry => entry.close()));
