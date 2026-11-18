import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { addressAllowed, parseTarget, postToTarget, resolveTarget, TargetRefusedError, TargetUnreachableError,
  type ResolvedAddress, type TargetPolicy } from "../../src/service/webhook-target.ts";

const secure: TargetPolicy = { allowInsecure: false };
const insecure: TargetPolicy = { allowInsecure: true };
const loopback: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];

async function serve(t: TestContext, server: Server | ReturnType<typeof createTcpServer>) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.close(); await once(server, "close"); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("only public unicast addresses are allowed; the insecure setting adds loopback and private ones, never special ones", () => {
  for (const address of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"]) {
    assert.equal(addressAllowed(address, secure), true, address);
  }
  for (const address of ["127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
    "::1", "fd12:3456::1", "fc00::1"]) {
    assert.equal(addressAllowed(address, secure), false, address);
    assert.equal(addressAllowed(address, insecure), true, address);
  }
  // Link-local and cloud metadata, unspecified, multicast, broadcast, reserved, documentation and
  // benchmark ranges, and IPv6 forms that embed an IPv4 address.
  for (const address of ["0.0.0.0", "169.254.169.254", "169.254.170.2", "100.100.100.200", "168.63.129.16", "192.0.0.192", "192.0.2.1",
    "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "fe80::1", "fec0::1", "ff02::1", "fd00:ec2::254", "fd20:ce::254", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:8.8.8.8",
    "64:ff9b::a00:1", "2002:a00:1::1", "2001::1", "2001:db8::1", "3fff::1", "100::1", "::127.0.0.1"]) {
    assert.equal(addressAllowed(address, secure), false, address);
    assert.equal(addressAllowed(address, insecure), false, address);
  }
  for (const value of ["example.com", "", "1.2.3", "300.1.1.1"]) assert.equal(addressAllowed(value, insecure), false, value);
});

test("a target URL is HTTPS without credentials or fragment, and an IP literal must be allowed", () => {
  const refused = (input: string, policy: TargetPolicy, reason: string) =>
    assert.throws(() => parseTarget(input, policy), (error: unknown) => error instanceof TargetRefusedError && error.reason === reason, input);
  assert.equal(parseTarget("https://Hooks.Example.com/in?x=1", secure).href, "https://hooks.example.com/in?x=1");
  assert.equal(parseTarget("https://hooks.example.com:8443/", secure).host, "hooks.example.com:8443");
  assert.equal(parseTarget("http://receiver.test/in", insecure).href, "http://receiver.test/in");
  for (const input of ["http://hooks.example.com/", "ftp://hooks.example.com/", "javascript:alert(1)", "file:///etc/passwd", "not a url",
    "https://user:pass@hooks.example.com/", "https://user@hooks.example.com/", "https://:pass@hooks.example.com/",
    "https://hooks.example.com/#fragment", "https://hooks.example.com/#", "https://a$b.example.com/", "https://hooks.example.com/" + "a".repeat(2048)]) {
    refused(input, secure, "url");
  }
  refused("https://user:pass@127.0.0.1/", insecure, "url");
  // Every spelling the URL parser normalizes to loopback is still loopback.
  for (const input of ["https://127.0.0.1/", "https://0x7f000001/", "https://2130706433/", "https://127.1/", "https://[::1]/",
    "https://10.0.0.8/", "https://[fd00::8]/"]) {
    refused(input, secure, "address");
    assert.doesNotThrow(() => parseTarget(input, insecure), input);
  }
  for (const input of ["https://169.254.169.254/latest/meta-data/", "http://169.254.169.254/", "https://[fd00:ec2::254]/", "https://0.0.0.0/",
    "https://[::ffff:127.0.0.1]/", "https://[::ffff:169.254.169.254]/"]) {
    assert.throws(() => parseTarget(input, insecure), TargetRefusedError, input);
  }
});

test("a name resolves only to allowed addresses: one refused answer refuses them all", async () => {
  const answers: Record<string, ResolvedAddress[]> = {
    "public.test": [{ address: "93.184.215.14", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }],
    "mixed.test": [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.1", family: 4 }],
    "rebind.test": [{ address: "127.0.0.1", family: 4 }, { address: "169.254.169.254", family: 4 }],
    "metadata.test": [{ address: "169.254.169.254", family: 4 }],
    "local.test": loopback, "empty.test": [],
  };
  let lookups = 0;
  const lookup = async (host: string) => {
    lookups++;
    if (host === "broken.test") throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    return answers[host] ?? [];
  };
  const reason = (error: unknown) => error instanceof TargetRefusedError ? error.reason : String(error);
  const resolve = (url: string, allowInsecure = false) => resolveTarget(new URL(url), { allowInsecure, lookup }).catch(reason);
  assert.deepEqual(await resolve("https://public.test/"), answers["public.test"]);
  assert.equal(await resolve("https://mixed.test/"), "address");
  assert.deepEqual(await resolve("https://mixed.test/", true), answers["mixed.test"]);
  assert.equal(await resolve("https://rebind.test/", true), "address");
  assert.equal(await resolve("https://metadata.test/", true), "address");
  assert.equal(await resolve("https://local.test/"), "address");
  assert.deepEqual(await resolve("https://local.test/", true), loopback);
  assert.equal(await resolve("https://empty.test/"), "resolution");
  assert.equal(await resolve("https://broken.test/"), "resolution");
  // An IP literal is checked without a lookup.
  const before = lookups;
  assert.deepEqual(await resolve("https://[2606:4700:4700::1111]/"), [{ address: "2606:4700:4700::1111", family: 6 }]);
  assert.equal(await resolve("https://169.254.169.254/", true), "address");
  assert.equal(lookups, before);
  // A resolver that never answers is refused after the resolution timeout.
  const started = Date.now();
  assert.equal(await resolveTarget(new URL("https://slow.test/"), { allowInsecure: false, lookup: () => new Promise(() => {}) }).catch(reason),
    "resolution");
  assert.ok(Date.now() - started < 7_000);
});

test("a delivery connects only to the checked address, follows no redirect and sends no credential or cookie", async (t) => {
  const seen: { url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  let elsewhere = 0;
  const other = await serve(t, createServer((_request, response) => { elsewhere++; response.end(); }));
  const port = await serve(t, createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    seen.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
    if (request.url === "/redirect") response.writeHead(307, { Location: `http://127.0.0.1:${other}/`, "Set-Cookie": "session=1" }).end();
    else response.writeHead(204).end();
  }));
  // receiver.test exists only in this pinned answer: any second lookup would fail to resolve.
  const target = parseTarget(`http://receiver.test:${port}/in?x=1`, insecure);
  const addresses = await resolveTarget(target, { allowInsecure: true, lookup: async () => loopback });
  assert.equal(await postToTarget(target, addresses, '{"a":1}', { "Content-Type": "application/json" }, new AbortController().signal), 204);
  assert.deepEqual(seen[0].url, "/in?x=1");
  assert.equal(seen[0].headers.host, `receiver.test:${port}`);
  assert.equal(seen[0].body, '{"a":1}');
  assert.equal(seen[0].headers["content-length"], "7");
  for (const header of ["cookie", "authorization", "proxy-authorization"]) assert.equal(seen[0].headers[header], undefined, header);

  const redirect = parseTarget(`http://receiver.test:${port}/redirect`, insecure);
  assert.equal(await postToTarget(redirect, addresses, "{}", {}, new AbortController().signal), 307);
  // The cookie it set is never sent back, and the redirect target is never contacted.
  assert.equal(await postToTarget(target, addresses, "{}", {}, new AbortController().signal), 204);
  assert.equal(seen.at(-1)!.headers.cookie, undefined);
  assert.equal(elsewhere, 0);
});

test("a delivery gives up at its connect and total timeouts and reads only a few KiB of the response", async (t) => {
  const reason = (error: unknown) => error instanceof TargetUnreachableError ? error.reason : String(error);
  const signal = new AbortController().signal;
  // Accepts the request and never answers.
  const silent = await serve(t, createServer(() => {}));
  let started = Date.now();
  assert.equal(await postToTarget(new URL(`http://127.0.0.1:${silent}/`), loopback, "{}", {}, signal, { connectMs: 1_000, totalMs: 300 }).catch(reason), "timeout");
  assert.ok(Date.now() - started < 2_000);
  // Accepts TCP and never completes a TLS handshake: the connect timeout ends it.
  const mute = await serve(t, createTcpServer(() => {}));
  started = Date.now();
  assert.equal(await postToTarget(new URL(`https://receiver.test:${mute}/`), loopback, "{}", {}, signal, { connectMs: 200, totalMs: 5_000 }).catch(reason), "timeout");
  assert.ok(Date.now() - started < 2_000);
  // Nothing listens.
  const vacant = createTcpServer();
  vacant.listen(0, "127.0.0.1"); await once(vacant, "listening");
  const vacantPort = (vacant.address() as { port: number }).port;
  vacant.close(); await once(vacant, "close");
  assert.equal(await postToTarget(new URL(`http://127.0.0.1:${vacantPort}/`), loopback, "{}", {}, signal).catch(reason), "network");
  // Stopping the dispatcher aborts an attempt without classifying it.
  const stop = new AbortController();
  const attempt = postToTarget(new URL(`http://127.0.0.1:${silent}/`), loopback, "{}", {}, stop.signal).catch(reason);
  setTimeout(() => stop.abort(), 50);
  assert.equal(await attempt, "aborted");
  // A large response: the status settles at once and the socket closes after a few KiB.
  let streamed = 0, ended: () => void = () => {};
  const finished = new Promise<void>(resolve => { ended = resolve; });
  const flood = await serve(t, createServer((_request, response) => {
    response.writeHead(200);
    const chunk = Buffer.alloc(1024, 0x61);
    const timer = setInterval(() => { streamed += chunk.length; response.write(chunk); }, 5);
    response.once("close", () => { clearInterval(timer); ended(); });
  }));
  started = Date.now();
  assert.equal(await postToTarget(new URL(`http://127.0.0.1:${flood}/`), loopback, "{}", {}, signal), 200);
  await finished;
  assert.ok(Date.now() - started < 2_000 && streamed < 64 * 1024, `streamed ${streamed} bytes`);
});
