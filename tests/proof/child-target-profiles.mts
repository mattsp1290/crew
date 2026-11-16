import { appendFileSync } from "node:fs";
import { contentText } from "@earendil-works/pi-ai";
import { createPiFixtureOptions } from "../fixtures/engines/pi/index.mts";
import { close, profiles as fixtures } from "./fixture-profiles.mts";
import type { MemberProfile } from "../../src/service/profiles.ts";

const crew = fixtures.get("fixture.crew.v1");
if (!crew) throw new Error("fixture.crew.v1 needs the Pi fixture: leave BIRBCREW_PROOF_ENGINE unset or set it to pi");
const pi = await createPiFixtureOptions((context, options) => {
  const log = process.env.BIRBCREW_PROOF_TARGET_REQUESTS;
  const last = context.messages.findLast((message) => message.role === "user");
  if (log && last?.role === "user") appendFileSync(log, JSON.stringify({ prompt: contentText(last.content), model: options?.model, messages: context.messages }) + "\n");
}, { id: "fixture-child-model", baseUrl: "https://child.fixture.invalid:8443" });
export const profiles = new Map<string, MemberProfile>([
  ["fixture.crew.v1", crew],
  ["fixture.named.v1", { ...crew, childTargets: { pi: {
    analyst: { engine: "pi", profile: "fixture.crew-target.v1" }, recorder: { engine: "pi", profile: "fixture.crew-target.v1" },
  } } }],
  ["fixture.crew-target.v1", { accountId: crew.accountId, protectedTool: "record_work_item", pi }],
]);
profiles.set("fixture.ready.v1", { ...profiles.get("fixture.named.v1")! });
export { close };
