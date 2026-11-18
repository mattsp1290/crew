import { Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** Where a webhook may be sent, and how it is sent. The only module that opens outbound
 * connections for webhooks: every target is checked here at registration and again before
 * every delivery, and a delivery connects only to the addresses that check accepted. */
export const targetLimits = {
  urlBytes: 2048, // webhook_endpoints.url CHECK in 032-webhooks.sql repeats it
  resolveTimeoutMs: 5_000,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 10_000,
  responseBytes: 4_096,
} as const;

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type TargetPolicy = {
  /** BIRBCREW_WEBHOOK_ALLOW_INSECURE_TARGETS=1 permits plain http and loopback or private
   * addresses in any deployment. Link-local, metadata and other special addresses stay refused. */
  allowInsecure: boolean;
  /** Tests replace DNS; production asks the configured DNS servers. `signal` aborts at the timeout. */
  lookup?: (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;
};
export const defaultTargetPolicy: TargetPolicy = Object.freeze({ allowInsecure: false });

/** `url`: refused before any lookup. `address`: resolves to an address Crew never calls.
 * `resolution`: the name did not resolve in time; at delivery this is a network failure. */
export class TargetRefusedError extends Error {
  readonly reason: "url" | "address" | "resolution";
  constructor(reason: TargetRefusedError["reason"]) { super(`Webhook target refused: ${reason}`); this.name = "TargetRefusedError"; this.reason = reason; }
}
/** No HTTP response arrived. Carries no address or driver text. */
export class TargetUnreachableError extends Error {
  readonly reason: "timeout" | "network" | "aborted";
  constructor(reason: TargetUnreachableError["reason"]) { super(`Webhook target unreachable: ${reason}`); this.name = "TargetUnreachableError"; this.reason = reason; }
}

function blocks(ranges: readonly (readonly [string, number])[], type: "ipv4" | "ipv6") {
  const list = new BlockList();
  for (const [network, prefix] of ranges) list.addSubnet(network, prefix, type);
  return list;
}
// Never called, whatever the policy: unspecified, link-local (cloud metadata at 169.254.169.254 and
// 169.254.170.2), multicast, reserved, documentation and benchmark ranges, protocol assignments and
// the metadata addresses that sit outside link-local.
const never4 = blocks([["0.0.0.0", 8], ["169.254.0.0", 16], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["100.100.100.200", 32], ["168.63.129.16", 32]], "ipv4");
// Loopback, RFC 1918 and shared address space: refused unless the operator allows insecure targets.
const private4 = blocks([["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]], "ipv4");
// IPv4-mapped, NAT64, 6to4 and Teredo addresses embed an IPv4 address this check would not see.
const never6 = blocks([["::", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["3fff::", 20], ["2002::", 16], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ["fd00:ec2::254", 128], ["fd20:ce::254", 128]], "ipv6");
const private6 = blocks([["::1", 128], ["fc00::", 7]], "ipv6");
const global6 = blocks([["2000::", 3]], "ipv6");

/** Whether Crew may connect to this IP address under the policy. Anything not an IP is refused. */
export function addressAllowed(address: string, policy: TargetPolicy): boolean {
  switch (isIP(address)) {
    case 4:
      if (never4.check(address, "ipv4")) return false;
      return private4.check(address, "ipv4") ? policy.allowInsecure : true;
    case 6:
      if (never6.check(address, "ipv6")) return false;
      if (private6.check(address, "ipv6")) return policy.allowInsecure;
      return global6.check(address, "ipv6");
    default: return false;
  }
}

const bare = (hostname: string) => hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

/** The normalized target, or TargetRefusedError("url"/"address"). An IP literal is checked here;
 * a name is checked when it resolves. */
export function parseTarget(input: string, policy: TargetPolicy): URL {
  if (Buffer.byteLength(input) > targetLimits.urlBytes || input.includes("#")) throw new TargetRefusedError("url");
  let target: URL;
  try { target = new URL(input); } catch { throw new TargetRefusedError("url"); }
  if (!(target.protocol === "https:" || (policy.allowInsecure && target.protocol === "http:"))) throw new TargetRefusedError("url");
  if (target.username || target.password || Buffer.byteLength(target.href) > targetLimits.urlBytes) throw new TargetRefusedError("url");
  const host = bare(target.hostname);
  if (isIP(host)) {
    if (!addressAllowed(host, policy)) throw new TargetRefusedError("address");
  } else if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/.test(host) || host.length > 253) throw new TargetRefusedError("url");
  return target;
}

// DNS queries through c-ares, not getaddrinfo: getaddrinfo blocks one of libuv's four pool threads
// until the resolver gives up, so names whose servers never answer could starve the gateway's file,
// crypto and database-connect work. The hosts file is not read.
async function systemLookup(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  signal.addEventListener("abort", () => resolver.cancel(), { once: true });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  if (v4.status === "rejected" && v6.status === "rejected") throw v4.reason;
  return [...(v4.status === "fulfilled" ? v4.value.map(address => ({ address, family: 4 as const })) : []),
    ...(v6.status === "fulfilled" ? v6.value.map(address => ({ address, family: 6 as const })) : [])];
}

/** Every address the name resolves to, each allowed. One refused address refuses them all, so a
 * name cannot mix a public answer with a private one. */
export async function resolveTarget(target: URL, policy: TargetPolicy): Promise<ResolvedAddress[]> {
  const host = bare(target.hostname);
  const family = isIP(host);
  if (family) {
    if (!addressAllowed(host, policy)) throw new TargetRefusedError("address");
    return [{ address: host, family: family === 6 ? 6 : 4 }];
  }
  const timer = new AbortController();
  let addresses: ResolvedAddress[];
  try {
    addresses = await Promise.race([(policy.lookup ?? systemLookup)(host, timer.signal),
      delay(targetLimits.resolveTimeoutMs, undefined, { signal: timer.signal }).then(() => { throw new TargetRefusedError("resolution"); })]);
  } catch (error) {
    if (error instanceof TargetRefusedError) throw error;
    throw new TargetRefusedError("resolution");
  } finally { timer.abort(); }
  if (!addresses.length) throw new TargetRefusedError("resolution");
  if (!addresses.every(({ address }) => addressAllowed(address, policy))) throw new TargetRefusedError("address");
  return addresses;
}

export type Timeouts = { connectMs: number; totalMs: number };

/** POSTs the body to the target, connecting only to `addresses` (resolved and checked by the
 * caller), and resolves with the response status. No redirect is followed, no cookie or Crew
 * credential is sent, and at most a few KiB of the response are read before the socket closes. */
export function postToTarget(target: URL, addresses: readonly ResolvedAddress[], body: string, headers: Record<string, string>,
  stop: AbortSignal, timeouts: Timeouts = { connectMs: targetLimits.connectTimeoutMs, totalMs: targetLimits.totalTimeoutMs }): Promise<number> {
  if (!addresses.length) return Promise.reject(new TargetRefusedError("resolution"));
  // net.connect asks for every address when it races families, and for one otherwise.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses.map(({ address, family }) => ({ address, family })));
    else callback(null, addresses[0].address, addresses[0].family);
  };
  const deadline = AbortSignal.timeout(timeouts.totalMs);
  const signal = AbortSignal.any([stop, deadline]);
  const secure = target.protocol === "https:";
  const host = bare(target.hostname);
  return new Promise((settle, fail) => {
    const sent = (secure ? httpsRequest : httpRequest)({
      hostname: host, port: target.port || undefined, path: target.pathname + target.search, method: "POST",
      headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      // rejectUnauthorized given explicitly, so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn verification off here.
      agent: false, lookup: pinned, signal, ...(secure ? { rejectUnauthorized: true, ...(!isIP(host) && { servername: host }) } : {}),
    });
    const connectTimer = setTimeout(() => sent.destroy(new TargetUnreachableError("timeout")), timeouts.connectMs);
    sent.once("socket", socket => socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(connectTimer)));
    sent.once("response", (response: IncomingMessage) => {
      clearTimeout(connectTimer);
      settle(response.statusCode ?? 0);
      let read = 0;
      response.on("error", () => {});
      response.on("data", (chunk: Buffer) => { read += chunk.length; if (read >= targetLimits.responseBytes) response.destroy(); });
    });
    // `on`, not `once`: a second error after the first must never be an uncaught exception.
    sent.on("error", error => {
      clearTimeout(connectTimer);
      if (error instanceof TargetUnreachableError) return fail(error);
      if (stop.aborted) return fail(new TargetUnreachableError("aborted"));
      fail(new TargetUnreachableError(deadline.aborted ? "timeout" : "network"));
    });
    sent.end(body);
  });
}
