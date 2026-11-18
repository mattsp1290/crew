import { goEndpoint } from "../../src/service/accounts.ts";
import { loadLiveProfiles } from "../../src/service/live-profiles.ts";
import { engineSchema } from "../../src/service/domain.ts";
import { accountKey } from "./live-account.ts";

const engine = engineSchema.parse(process.env.BIRBCREW_LIVE_ENGINE);
const relay = new URL(process.env.BIRBCREW_LIVE_RELAY!);
if (relay.protocol !== "http:" || relay.hostname !== "127.0.0.1" || !relay.port || !/^\/[a-f0-9]{64}$/.test(relay.pathname)) {
  throw new Error("Invalid proof relay");
}
const workerKey = process.env.BIRBCREW_LIVE_TOKEN;
if (!workerKey || !/^[a-f0-9]{64}$/.test(workerKey)) throw new Error("Missing private proof relay credential");
const selected = { BIRBCREW_LIVE_PROFILES: process.env.BIRBCREW_LIVE_PROFILES,
  ...(process.env.BIRBCREW_LIVE_AUTH !== "chatgpt-subscription" && { [accountKey[engine]]: workerKey }) };
export const profiles = await loadLiveProfiles(selected, async (input, init) => {
  const url = input.toString();
  if (![goEndpoint + "/models", goEndpoint + "/chat/completions"].includes(url)) throw new Error("Unexpected Go route");
  return fetch(relay.href + url.slice(goEndpoint.length), init);
}, async (_home, accountId) => {
  if (!accountId) throw new Error("Subscription proof requires an approved account");
  return { accessToken: workerKey, accountId };
});
for (const profile of profiles.values()) {
  if (profile.claude) profile.claude = { ...profile.claude, baseUrl: relay.href };
  if (profile.codex) profile.codex = { ...profile.codex, baseUrl: relay.href };
}
