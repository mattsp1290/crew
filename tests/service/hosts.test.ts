import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHost, fetchTarget, fetchUrlBytes, hostMatches, hostPattern, hostPatternSchema, patternCovers } from "../../src/service/hosts.ts";

const host = (text: string) => { const value = canonicalHost(text); assert.ok(value, text); return value; };
const pattern = (text: string) => { const value = hostPattern(text); assert.ok(value, text); return value; };

test("a host folds to one canonical form: case, trailing dot, IDNA and numeric IPv4 spellings", () => {
  for (const [input, expected] of [
    ["Example.COM", "example.com"], ["example.com.", "example.com"], ["localhost", "localhost"],
    ["bücher.example", "xn--bcher-kva.example"], ["BÜCHER.example", "xn--bcher-kva.example"], ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    // IDNA maps these to ASCII before any request is made, so they name example.com.
    ["ｅｘａｍｐｌｅ.com", "example.com"], ["example。com", "example.com"], ["exa​mple.com", "example.com"], ["exa­mple.com", "example.com"],
    ["127.0.0.1", "127.0.0.1"], ["127.1", "127.0.0.1"], ["0x7f.0.0.1", "127.0.0.1"], ["2130706433", "127.0.0.1"], ["0177.0.0.1", "127.0.0.1"],
    ["1.2.3.4.", "1.2.3.4"],
    ["[::1]", "[::1]"], ["[0:0:0:0:0:0:0:1]", "[::1]"], ["[::FFFF:127.0.0.1]", "[::ffff:7f00:1]"],
    ["a".repeat(63) + ".com", "a".repeat(63) + ".com"],
  ]) assert.equal(canonicalHost(input), expected, input);
});

test("a host that carries anything but a host is refused, never trimmed to one", () => {
  for (const input of [
    "", ".", "example.com..", "a..b", "*", "*.example.com",
    // A port, userinfo, a path, a query, a fragment, an escape.
    "example.com:443", "example.com:", "user@example.com", "user:pass@example.com", "@example.com", "example.com/x", "example.com/",
    "example.com?x", "example.com#x", "ex%61mple.com", "example.com\\x", "\\\\example.com",
    // Whitespace and control characters, which the URL parser would strip.
    " example.com", "example.com ", "exa mple.com", "example.com\n", "exa\tmple.com", "example.com\0", "example.com\u007f", "example .com",
    // Not a strict DNS name.
    "a_b.example.com", "-a.example.com", "a-.example.com", "a".repeat(64) + ".com", "xn--a.example",
    [...Array(64)].map(() => "abc").join(".") + ".example", // 263 characters, over the 253 a name may have
    // Not an address the parser accepts, or an address outside brackets.
    "1.2.3.4.5", "256.1.1.1", "foo.123", "::1", "[::1", "::1]", "[::1]:443", "[::1].", "[fe80::1%25eth0]", "[fe80::1%eth0]", "[example.com]",
  ]) assert.equal(canonicalHost(input), null, JSON.stringify(input));
  for (const input of [null, undefined, 1, {}, ["example.com"]]) assert.equal(canonicalHost(input as never), null);
});

test("a pattern is an exact host or a wildcard over a domain of at least two labels", () => {
  for (const [input, expected] of [["example.com", "example.com"], ["Example.COM.", "example.com"], ["127.1", "127.0.0.1"], ["[::1]", "[::1]"],
    ["*.example.com", "*.example.com"], ["*.Example.COM.", "*.example.com"], ["*.bücher.example", "*.xn--bcher-kva.example"],
    // No public-suffix list is consulted.
    ["*.co.uk", "*.co.uk"]]) {
    assert.equal(hostPattern(input), expected, input);
  }
  for (const input of ["*", "*.", "*..", "*.com", "*.localhost", "**.example.com", "*.*.example.com", "a.*.example.com", "*example.com",
    "example.*", "*.1.2.3.4", "*.127.1", "*.[::1]", "*.example.com:443", "*.example.com/", "*. example.com", ".example.com", "*.-a.example.com"]) {
    assert.equal(hostPattern(input), null, input);
  }
  assert.equal(hostPatternSchema.parse("*.Example.COM"), "*.example.com");
  assert.equal(hostPatternSchema.safeParse("example.com:443").success, false);
  assert.equal(hostPatternSchema.safeParse(7).success, false);
});

test("an exact pattern matches its own host and nothing else", () => {
  const exact = pattern("example.com");
  assert.equal(hostMatches(exact, host("EXAMPLE.com.")), true);
  for (const other of ["www.example.com", "example.com.evil.test", "evilexample.com", "example.co", "example.comm",
    "com", "127.0.0.1", "[::1]"]) assert.equal(hostMatches(exact, host(other)), false, other);
  // A Cyrillic lookalike is another name, whether or not the parser accepts it.
  const lookalike = canonicalHost("exаmple.com");
  assert.notEqual(lookalike, "example.com");
  if (lookalike) assert.equal(hostMatches(exact, lookalike), false);
  // Every spelling of one IPv4 address is one host; an IPv4-mapped IPv6 address is another.
  assert.equal(hostMatches(pattern("127.0.0.1"), host("0x7f.1")), true);
  assert.equal(hostMatches(pattern("127.0.0.1"), host("[::ffff:127.0.0.1]")), false);
  assert.equal(hostMatches(pattern("127.0.0.1"), host("127.0.0.2")), false);
});

test("a wildcard matches names below its base at any depth, never the base, a lookalike or an address", () => {
  const wildcard = pattern("*.example.com");
  for (const below of ["a.example.com", "A.B.Example.Com.", "xn--bcher-kva.example.com", "1.example.com"]) {
    assert.equal(hostMatches(wildcard, host(below)), true, below);
  }
  for (const other of ["example.com", "badexample.com", "a.badexample.com", "example.com.evil.test", "a.example.com.evil.test", "a.example.co",
    "a.example.comm", "com", "1.2.3.4", "[::1]"]) assert.equal(hostMatches(wildcard, host(other)), false, other);
});

test("one pattern covers another only when it matches every host the other does", () => {
  const covers = (outer: string, inner: string) => patternCovers(pattern(outer), pattern(inner));
  for (const [outer, inner] of [["example.com", "example.com"], ["*.example.com", "a.example.com"], ["*.example.com", "a.b.example.com"],
    ["*.example.com", "*.example.com"], ["*.example.com", "*.a.example.com"], ["127.0.0.1", "127.1"]]) {
    assert.equal(covers(outer, inner), true, `${outer} covers ${inner}`);
  }
  for (const [outer, inner] of [["example.com", "a.example.com"], ["a.example.com", "example.com"], ["example.com", "*.example.com"],
    ["*.example.com", "example.com"], ["*.a.example.com", "*.example.com"], ["*.example.com", "*.badexample.com"],
    ["*.example.com", "a.badexample.com"], ["*.example.com", "*.example.org"], ["*.example.com", "127.0.0.1"], ["127.0.0.1", "127.0.0.2"]]) {
    assert.equal(covers(outer, inner), false, `${outer} does not cover ${inner}`);
  }
  // Covering agrees with matching on every pair of these names.
  const names = ["example.com", "a.example.com", "a.b.example.com", "badexample.com", "example.org", "com.example", "127.0.0.1", "[::1]"];
  const patterns = [...names, "*.example.com", "*.a.example.com", "*.b.example.com", "*.example.org"].map(pattern);
  for (const outer of patterns) for (const inner of patterns) {
    if (!patternCovers(outer, inner)) continue;
    for (const name of names.map(host)) {
      if (hostMatches(inner, name)) assert.equal(hostMatches(outer, name), true, `${outer} covers ${inner} but misses ${name}`);
    }
  }
});

test("a fetch URL is read as the request will be made: canonical host, effective port, no fragment", () => {
  const read = (url: string) => fetchTarget(url);
  assert.deepEqual(read("https://example.com/a?b#c"), { href: "https://example.com/a?b", scheme: "https", host: "example.com", port: 443 });
  assert.deepEqual(read("HTTPS://EXAMPLE.com:443/"), { href: "https://example.com/", scheme: "https", host: "example.com", port: 443 });
  assert.deepEqual(read("https://example.com:8443/"), { href: "https://example.com:8443/", scheme: "https", host: "example.com", port: 8443 });
  assert.deepEqual(read("http://example.com/"), { href: "http://example.com/", scheme: "http", host: "example.com", port: 80 });
  assert.deepEqual(read("http://example.com:443/"), { href: "http://example.com:443/", scheme: "http", host: "example.com", port: 443 });
  assert.deepEqual(read("https://example.com./x"), { href: "https://example.com/x", scheme: "https", host: "example.com", port: 443 });
  assert.deepEqual(read("https://bücher.example/"), { href: "https://xn--bcher-kva.example/", scheme: "https", host: "xn--bcher-kva.example", port: 443 });
  assert.deepEqual(read("https://0x7f.1/"), { href: "https://127.0.0.1/", scheme: "https", host: "127.0.0.1", port: 443 });
  assert.deepEqual(read("https://[::FFFF:127.0.0.1]:8080/x"), { href: "https://[::ffff:7f00:1]:8080/x", scheme: "https", host: "[::ffff:7f00:1]", port: 8080 });
  // An @ after the authority is path, query or fragment text, not userinfo.
  assert.equal(read("https://evil.test#@example.com/")?.host, "evil.test");
  assert.equal(read("https://evil.test/@example.com")?.host, "evil.test");
  assert.equal(read("https://example.com?@evil.test")?.host, "example.com");
});

test("a fetch URL with userinfo, a rewritten authority, another scheme or parser-stripped characters is refused", () => {
  for (const url of [
    // Userinfo makes the text before @ look like the host.
    "https://example.com@evil.test/", "https://example.com:443@evil.test/", "https://user:pass@example.com/", "https://@example.com/",
    "https://:@example.com/", "https://example.com%40evil.test/", "https://example.com%2F@evil.test/", "https://example.com\\@evil.test/",
    "https://evil.test\\.example.com/",
    // The parser would find a host these do not show where an authority belongs.
    "https:example.com", "https:/example.com", "https:///example.com", "https:////example.com", "//example.com/", "example.com", "/example.com",
    "https://", "https:///", "https://?x", "https://#x",
    // The parser would strip or rewrite these.
    " https://example.com/", "https://example.com/ ", "https://exa\tmple.com/", "https://example.com/a\nb", "https://example.com/a b",
    "https://example.com/\0", "ht\ttps://example.com/", "https://example.com/\u007f", "https://example.com/\u0085",
    // Text that is not well formed would be rewritten to U+FFFD.
    "https://example.com/\ud800", "https://example.com/?q=\udc00",
    "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "ws://example.com/", "blob:https://example.com/x",
    "view-source:https://example.com/", "about:blank",
    "https://example.com:0/", "https://example.com:65536/", "https://example.com:port/", "https://a_b.example.com/", "https://exa%6dple.com/",
    "https://[fe80::1%25eth0]/", "https://1.2.3.4.5/",
    "https://example.com/" + "a".repeat(fetchUrlBytes),
  ]) assert.equal(fetchTarget(url), null, JSON.stringify(url));
  for (const url of [null, undefined, 7, new URL("https://example.com/")]) assert.equal(fetchTarget(url as never), null);
});

// Compile-time only: a plain string is not a host or a pattern until it has been through the parser.
function typeChecks() {
  // @ts-expect-error a plain string is not a HostPattern
  hostMatches("example.com", "example.com");
  // @ts-expect-error a plain string is not a HostPattern
  patternCovers("*.example.com", "a.example.com");
}
void typeChecks;
