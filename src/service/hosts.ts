import { z } from "zod";

/** Host names as the capability ceiling and the `host` selector compare them
 * (docs/member-capabilities.md). Everything here is lexical: nothing resolves a name. A value
 * that cannot be put in canonical form is refused, never guessed at. */

declare const hostBrand: unique symbol;
/** A lowercase ASCII DNS name without its trailing dot, a dotted-decimal IPv4 address, or a
 * bracketed IPv6 address, as the WHATWG URL parser writes them. Only canonicalHost makes one. */
export type Host = string & { readonly [hostBrand]: true };
declare const patternBrand: unique symbol;
/** A Host, or `*.` and a DNS name of at least two labels. Only hostPattern makes one. */
export type HostPattern = string & { readonly [patternBrand]: true };

const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const dnsName = new RegExp(`^${label}(?:\\.${label})*$`);
const octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const ipv4 = new RegExp(`^${octet}(?:\\.${octet}){3}$`);
const isAddress = (host: string) => host.startsWith("[") || ipv4.test(host);

/** The canonical form of a bare host, or null. The WHATWG parser does the folding (case, IDNA
 * to punycode, numeric IPv4 forms, IPv6 compression); the input may hold nothing the parser
 * could read as a port, userinfo, a path or an escape, and the result must be a strict DNS
 * name (letters, digits and inner hyphens, labels of 1 to 63, at most 253 in all) or an address.
 * One trailing dot is dropped: `example.com.` names the same host. */
export function canonicalHost(input: string): Host | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) return null;
  const bracketed = /^\[[0-9A-Fa-f:.]+\]$/.test(input);
  if (!bracketed && /[\u0000- \u007f- :\/\\?#@\[\]%]/.test(input)) return null;
  let url: URL;
  try { url = new URL("https://" + input + "/"); } catch { return null; }
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null;
  let host = url.hostname;
  if (host.startsWith("[")) return bracketed ? host as Host : null;
  if (bracketed) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (ipv4.test(host)) return host as Host;
  return host.length <= 253 && dnsName.test(host) ? host as Host : null;
}

/** `example.com` matches that host only. `*.example.com` matches every DNS name below
 * example.com at any depth and never example.com itself or an address. The wildcard needs a
 * base of at least two labels; no public-suffix list is consulted, so `*.co.uk` is accepted. */
export function hostPattern(input: string): HostPattern | null {
  if (typeof input !== "string") return null;
  if (!input.startsWith("*.")) return canonicalHost(input) as HostPattern | null;
  const base = canonicalHost(input.slice(2));
  return base && !isAddress(base) && base.includes(".") ? "*." + base as HostPattern : null;
}

export function hostMatches(pattern: HostPattern, host: Host): boolean {
  if (!pattern.startsWith("*.")) return pattern as string === host;
  const suffix = pattern.slice(1);
  return !isAddress(host) && host.length > suffix.length && host.endsWith(suffix);
}

/** Whether every host `inner` matches is also matched by `outer`. */
export function patternCovers(outer: HostPattern, inner: HostPattern): boolean {
  if (!outer.startsWith("*.")) return outer === inner;
  if (!inner.startsWith("*.")) return hostMatches(outer, inner as string as Host);
  return inner === outer || inner.endsWith(outer.slice(1));
}

export const hostPatternSchema = z.string().max(260)
  .refine(value => hostPattern(value) !== null, { message: "Expected a host name, an IP address, or *. and a domain of at least two labels" })
  .transform(value => hostPattern(value)!);

export interface FetchTarget {
  /** The URL as it will be requested: canonical host, no fragment. */
  href: string;
  scheme: "https" | "http";
  host: Host;
  /** The explicit port, or the scheme's default. */
  port: number;
}

export const fetchUrlBytes = 4096;

/** Reads an absolute http or https URL the way the request will be made, or null. Refused:
 * userinfo (`https://example.com@evil.test/` would otherwise read as example.com), a missing
 * or empty `//` authority (the parser would skip extra slashes and find a host further on),
 * an escape in the authority, whitespace, control characters and backslashes (the parser
 * strips or rewrites them), port 0, and any host canonicalHost refuses. */
export function fetchTarget(input: string): FetchTarget | null {
  if (typeof input !== "string" || Buffer.byteLength(input) > fetchUrlBytes) return null;
  if (/[\u0000- \u007f- \\]/.test(input)) return null;
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\/?#]*)/.exec(input);
  if (!authority || authority[1] === "" || /[@%]/.test(authority[1])) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = canonicalHost(url.hostname);
  if (!host) return null;
  const scheme = url.protocol === "https:" ? "https" : "http";
  url.hostname = host;
  url.hash = "";
  const port = url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
  if (canonicalHost(url.hostname) !== host || port === 0 || Buffer.byteLength(url.href) > fetchUrlBytes) return null;
  return { href: url.href, scheme, host, port };
}
