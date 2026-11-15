import { createHash } from "node:crypto";
import { z } from "zod";
import { codexSubscriptionEndpoint } from "./accounts.ts";
import type { MemberProfile } from "./profiles.ts";
import { destinationSchema, type ChildTarget } from "./child-target.ts";

export const upstreamIdentitySchema = z.strictObject({ model: z.string().min(1).max(256), providerHost: z.string().min(1).max(512), relayHost: z.string().min(1).max(512).nullable() });
export type ProviderIdentity = Readonly<z.infer<typeof upstreamIdentitySchema>>;

export function providerHost(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Provider identity requires a non-secret HTTP endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider identity requires a non-secret HTTP endpoint");
  }
  if (!url.hostname.startsWith("[")) url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return url.host;
}

export function configuredDestination(config: ReadonlyMap<string, MemberProfile>, route: ChildTarget) {
  const profile = config.get(route.profile);
  if (!profile || !profile[route.engine] || !profile.accountId?.trim()) throw new Error("Unknown child destination");
  const upstream = profile.upstreamIdentity?.[route.engine];
  let identity: { model: string; providerHost: string };
  if (upstream) {
    const parsed = upstreamIdentitySchema.parse(upstream);
    const endpoint = route.engine === "pi" ? profile.pi!.model.baseUrl : profile[route.engine]!.baseUrl;
    const proxy = route.engine === "pi" ? profile.pi!.model.provider === "birbcrew-proxy"
      : route.engine === "codex" ? !!profile.codex!.proxyTransport : parsed.relayHost !== null;
    if (!proxy || (parsed.relayHost !== null && (!endpoint || providerHost(endpoint) !== parsed.relayHost))
      || (parsed.relayHost === null && (route.engine !== "codex" || endpoint !== undefined))) {
      throw new Error("Upstream identity differs from proxy routing");
    }
    identity = { model: parsed.model, providerHost: parsed.providerHost };
    if (providerHost(`https://${identity.providerHost}`) !== identity.providerHost && providerHost(`http://${identity.providerHost}`) !== identity.providerHost) throw new Error("Noncanonical provider host");
  } else {
    switch (route.engine) {
      case "pi": {
        const pi = profile.pi!;
        if (pi.model.provider === "birbcrew-proxy") throw new Error("Proxy upstream identity unavailable");
        identity = { model: pi.model.id, providerHost: providerHost(pi.model.baseUrl) };
        break;
      }
      case "claude": {
        const claude = profile.claude!;
        identity = { model: claude.model, providerHost: providerHost(claude.baseUrl ?? "https://api.anthropic.com") };
        break;
      }
      case "codex": {
        const codex = profile.codex!;
        if (codex.proxyTransport || (!codex.baseUrl && !codex.subscription && !codex.apiKey)) throw new Error("Codex upstream identity unavailable");
        identity = { model: codex.model, providerHost: providerHost(codex.baseUrl ?? (codex.subscription ? codexSubscriptionEndpoint : "https://api.openai.com")) };
        break;
      }
    }
  }
  const model = route.engine === "pi" ? profile.pi!.model.id : profile[route.engine]!.model;
  if (identity.model !== model) throw new Error("Upstream model differs from configured model");
  return destinationSchema.parse({ ...route, ...identity, accountDigest: createHash("sha256").update(profile.accountId).digest("hex") });
}
