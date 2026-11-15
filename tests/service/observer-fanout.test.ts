import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { Pool } from "pg";
import type { MemberClient } from "../../src/service/client.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { publishObservation, readEvents, readEventsLimit } from "../../src/service/observation.ts";
import { ObserverHubs, observerFanout, ObserverSettingsError, type FanoutBounds } from "../../src/service/observer-hub.ts";
import { MemberStore } from "../../src/service/store.ts";
import "./observer-sockets.test.ts";

// The gateway's observer fan-out against PostgreSQL alone: changes are published straight into the public event
// ledger, as the store does inside its transactions, so no Temporal server or worker is needed. Each comparison
// attaches a polling observer (the fan-out turned off) beside the hub's observers: the bytes must be identical.

type Change = Parameters<typeof publishObservation>[2];
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

async function until<T>(check: () => T | undefined | Promise<T | undefined>, label: string, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for " + label);
}

async function fixture(t: TestContext) {
  const pool = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL, max: 8 });
  let beforeLedgerRead: (() => Promise<never> | undefined) | undefined;
  const instrumented = new WeakSet();
  pool.on("acquire", (client) => {
    if (instrumented.has(client)) return;
    instrumented.add(client);
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<typeof query>) => {
      const config: unknown = args[0];
      const sql = typeof config === "string" ? config :
        typeof config === "object" && config !== null && "text" in config ? config.text : undefined;
      const read = typeof sql === "string" && sql.includes("FROM birbcrew_ts.public_events e JOIN");
      return (read ? beforeLedgerRead?.() : undefined) ?? query(...args);
    }) as typeof client.query;
  });
  // Hooks run in the order they are added, and every gateway stops before any pool ends: a query still queued for a
  // client when its pool ends never settles, so a gateway's background pass waiting on one would hang its stop.
  const gateways: (() => Promise<void>)[] = [];
  t.after(async () => {
    try { for (const stop of gateways) await stop(); }
    finally { await pool.end(); }
  });
  const store = new MemberStore(pool);
  await store.migrate();
  const owner = randomUUID(), stranger = randomUUID(), ownerId = "owner-" + randomUUID(), strangerId = "owner-" + randomUUID();
  const tokens = { [digest(owner)]: ownerId, [digest(stranger)]: strangerId };
  // Observation never reaches Temporal; anything that tries fails the test.
  const members = new Proxy({}, { get: () => () => { throw new Error("Temporal is not part of observation"); } }) as MemberClient;
  // Short names: a Unix socket path has to fit in about 104 bytes.
  const directory = await mkdtemp(join(tmpdir(), "bf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  /**
   * A gateway on its own Unix socket. Linux keeps a fixed buffer per Unix stream socket (the stock wmem_default is
   * 212,992 bytes), so a client that stops reading blocks the server's writes after a few hundred KiB.
   */
  async function gateway(fanout: boolean | Partial<FanoutBounds>, on = store) {
    const server = createGateway(on, members, tokens,
      typeof fanout === "boolean" ? { fanout } : { fanout: true, fanoutBounds: fanout });
    const socketPath = join(directory, randomBytes(4).toString("hex") + ".sock");
    server.listen(socketPath);
    await once(server, "listening");
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      const closed = once(server, "close");
      server.close(); server.closeAllConnections();
      await closed;
      await server.stopped();
    };
    gateways.push(stop);
    return { socketPath, stats: () => server.observerStats(), stop };
  }

  /**
   * A conversation on the four-turn budget whose first three turns are done, so the next reply completes it.
   * `items` 64 KiB native items in the third turn make every later bootstrap that much larger.
   */
  async function conversation(items = 0) {
    const { memberId } = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: "fixture.v1" });
    const conversationId = randomUUID();
    await store.openConversation({ ownerId, memberId, conversationId });
    await pool.query("UPDATE birbcrew_ts.conversations SET turn_limit=4 WHERE conversation_id=$1", [conversationId]);
    for (let turn = 0; turn < 3; turn++) {
      const requestId = randomUUID(), count = turn === 2 ? items : 0;
      await publish(conversationId, { kind: "input", requestId, text: "earlier" },
        ...Array.from({ length: count }, (_, index): Change => ({ kind: "nativeItem", requestId, index, text: "h".repeat(65_536) })),
        count ? { kind: "reply", requestId, itemCount: count } : { kind: "reply", requestId, text: "done" });
    }
    return conversationId;
  }

  /** Commits changes in one transaction, as the store does, with the conversation lock publishObservation takes. */
  async function publish(conversationId: string, ...changes: Change[]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const change of changes) await publishObservation(client, conversationId, change);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async function ledger(conversationId: string) {
    const { rows } = await pool.query<{ cursor: number; event: unknown }>(
      "SELECT cursor, event FROM birbcrew_ts.public_events WHERE conversation_id=$1 ORDER BY cursor", [conversationId]);
    return rows;
  }

  /** Runs `before` ahead of each read of the public event ledger through this pool; a promise it returns replaces the read. */
  function onLedgerRead(before: () => Promise<never> | undefined) {
    beforeLedgerRead = before;
  }
  return { pool, store, owner, stranger, ownerId, strangerId, gateway, conversation, publish, ledger, onLedgerRead };
}

/** A raw SSE observer: the exact bytes the gateway wrote, in order. `paused` reads nothing past the headers. */
function observe(socketPath: string, token: string, conversationId: string, runId = randomUUID(), paused = false) {
  const body = JSON.stringify({ threadId: conversationId, runId, messages: [], tools: [], context: [], state: {}, forwardedProps: {} });
  let raw = "", response: IncomingMessage | undefined;
  const call = request({ socketPath, path: `/v1/conversations/${conversationId}/events`, method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
  const done = new Promise<number | undefined>((resolve, reject) => {
    call.on("response", (incoming) => {
      response = incoming;
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => { raw += chunk; });
      if (paused) incoming.pause();
      incoming.on("end", () => resolve(incoming.statusCode));
      incoming.on("error", reject);
    });
    call.on("error", reject);
  });
  void done.catch(() => {});
  call.end(body);
  // Only complete frames: a chunk can end inside one.
  const frames = () => raw.slice(0, raw.lastIndexOf("\n\n") + 1).split("\n\n").filter((block) => block.trim()).map((block) => {
    const id = /^id: (\d+)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return { id: id === undefined ? undefined : Number(id), event: JSON.parse(data!) as { type: string; [key: string]: unknown } };
  });
  return {
    runId, done, frames,
    get raw() { return raw; },
    get status() { return response?.statusCode; },
    has: (type: string) => frames().some((frame) => frame.event.type === type),
    pause: () => response!.pause(),
    resume: () => response!.resume(),
    close: () => call.destroy(),
  };
}
type Observer = ReturnType<typeof observe>;

test("a lock-blocked ledger read releases its hub and observers resume at the same cursor", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const hub = await f.gateway(true);
  const cid = await f.conversation(), requestId = randomUUID(), runId = randomUUID();
  await f.publish(cid, input(requestId));
  const observers = [observe(hub.socketPath, f.owner, cid, runId), observe(hub.socketPath, f.owner, cid, runId)];
  for (const observer of observers) t.after(() => observer.close());
  await until(() => observers.every((observer) => observer.has("STATE_SNAPSHOT")), "bootstrap");
  const lock = await f.pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE birbcrew_ts.public_events IN ACCESS EXCLUSIVE MODE");
    const blockedPid = await until(async () => {
      const { rows } = await f.pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND query LIKE 'SELECT e.cursor,e.event FROM birbcrew_ts.public_events%'`);
      return rows.length === 1 ? rows[0].pid : undefined;
    }, "one PostgreSQL hub read blocked on the ledger lock");
    const reconnect = observe(hub.socketPath, f.owner, cid, runId);
    observers.push(reconnect);
    t.after(() => reconnect.close());
    await until(() => reconnect.has("STATE_SNAPSHOT") && hub.stats()?.observers === 3 || undefined, "reconnect joins blocked hub");
    await until(() => hub.stats()?.fallbacks === 3 || undefined, "blocked read times out and frees every observer", 6_000);
    assert.equal(hub.stats()?.hubs, 0);
    await until(async () => {
      const { rows } = await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [blockedPid]);
      return rows.length === 0 || undefined;
    }, "PostgreSQL cancels the original read while the lock is still held");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  await f.publish(cid, text(requestId, 0, "after lock"), { kind: "reply", requestId, text: "after lock" });
  assert.deepEqual(await Promise.all(observers.map((observer) => observer.done)), [200, 200, 200]);
  for (const observer of observers) {
    assert.ok(!observer.has("RUN_ERROR"));
    assertLedger(observer, await f.ledger(cid));
  }
  assert.equal(observers[0].raw, observers[1].raw);
  assert.equal(observers[0].raw, observers[2].raw);
});

test("ledger deadlines leave the shared connection's session policy unchanged", async (t) => {
  const f = await fixture(t), cid = await f.conversation();
  const uri = new URL(process.env.BIRBCREW_TEST_DATABASE_URL!);
  uri.searchParams.set("statement_timeout", "0");
  const single = new Pool({ connectionString: uri.href, max: 1 });
  t.after(() => single.end());
  await single.query("SET statement_timeout = '12345ms'");
  const { rows: [before] } = await single.query("SHOW statement_timeout");
  assert.deepEqual(await readEvents(single, f.ownerId, cid, 0), await f.ledger(cid));
  const { rows: [after] } = await single.query("SHOW statement_timeout");
  assert.deepEqual(after, before);
});

test("a ledger timeout does not cancel a store write waiting on the same relation", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), cid = await f.conversation();
  const lock = await f.pool.connect();
  await lock.query("BEGIN");
  await lock.query("LOCK TABLE birbcrew_ts.public_events IN ACCESS EXCLUSIVE MODE");
  let written = false;
  const publication = f.publish(cid, input(randomUUID())).then(() => { written = true; });
  try {
    await assert.rejects(readEvents(f.pool, f.ownerId, cid, 0), { code: "57014" });
    assert.equal(written, false, "the write is still pending after the read's server deadline");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  await publication;
  assert.equal(written, true);
});

/** The bootstrap's state snapshot carries the snapshot cursor as its SSE id; every later id'd frame must be exactly
 * the ledger's rows after it, in cursor order. */
function assertLedger(observer: Observer, rows: { cursor: number; event: unknown }[]) {
  const from = observer.frames().find((frame) => frame.id !== undefined)!.id!;
  const tail = observer.frames().filter((frame) => frame.id !== undefined && frame.id > from);
  assert.ok(tail.length > 0);
  assert.deepEqual(tail.map((frame) => frame.id), rows.filter((row) => row.cursor > from).map((row) => row.cursor));
  assert.deepEqual(tail.map((frame) => frame.event), rows.filter((row) => row.cursor > from).map((row) => row.event));
}

const input = (requestId: string, text = "go"): Change => ({ kind: "input", requestId, text });
const text = (requestId: string, index: number, delta: string): Change => ({ kind: "text", messageId: requestId + "/assistant", index, delta });

for (const ending of ["complete", "failed", "stopped"] as const) {
  test(`hub observers and a polling observer receive identical bytes through ${ending}`, { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    const hub = await f.gateway(true), polling = await f.gateway(false);
    const cid = await f.conversation();
    const runId = randomUUID();
    const first = [observe(hub.socketPath, f.owner, cid, runId), observe(hub.socketPath, f.owner, cid, runId),
      observe(polling.socketPath, f.owner, cid, runId)];
    await until(() => first.every((o) => o.has("STATE_SNAPSHOT")), "bootstrap");
    assert.deepEqual(hub.stats(), { hubs: 1, observers: 2, fallbacks: 0 });
    assert.equal(polling.stats(), undefined);
    const requestId = randomUUID(), words = ["one", " two", " three", " four"];
    await f.publish(cid, input(requestId));
    await f.publish(cid, text(requestId, 0, words[0]), text(requestId, 1, words[1]));
    await until(() => first.every((o) => o.raw.includes(words[1])), "first deltas");
    // A late observer of each kind joins an open text message; the hub's joins behind its reader or level with it.
    const late = [observe(hub.socketPath, f.owner, cid, runId), observe(polling.socketPath, f.owner, cid, runId)];
    await until(() => late.every((o) => o.has("STATE_SNAPSHOT")), "late bootstrap");
    for (const [index, delta] of words.slice(2).entries()) await f.publish(cid, text(requestId, index + 2, delta));
    await until(() => [...first, ...late].every((o) => o.raw.includes(words[3])), "last delta");
    // Still on the hub: the byte comparison is not between polling observers.
    assert.deepEqual(hub.stats(), { hubs: 1, observers: 3, fallbacks: 0 });
    await f.publish(cid, ending === "complete" ? { kind: "reply", requestId, text: words.join("") } : { kind: ending, requestId });
    const statuses = await Promise.all([...first, ...late].map((o) => o.done));
    assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
    const last = first[0].frames().at(-1)!.event;
    if (ending === "failed") assert.deepEqual([last.type, last.code], ["RUN_ERROR", "MEMBER_FAILED"]);
    else assert.equal(last.type, "RUN_FINISHED");
    assert.equal(first[0].raw, first[1].raw);
    assert.equal(first[0].raw, first[2].raw);
    assert.equal(late[0].raw, late[1].raw);
    assertLedger(first[0], await f.ledger(cid));
    await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
    assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 0 });
  });
}

test("a slow observer overflows, reads the database itself and still receives every event in order", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  // Above one read's 32 rows, so the observer that keeps up never overflows.
  const hub = await f.gateway({ capacity: 40 });
  const cid = await f.conversation();
  const runId = randomUUID();
  const fast = observe(hub.socketPath, f.owner, cid, runId), slow = observe(hub.socketPath, f.owner, cid, runId);
  await until(() => fast.has("STATE_SNAPSHOT") && slow.has("STATE_SNAPSHOT"), "bootstrap");
  slow.pause();
  const requestId = randomUUID();
  await f.publish(cid, input(requestId));
  // Each item is five rows, among them a snapshot of every message so far, so the paused client's socket fills
  // within a few items and its rows then queue in the hub until they pass the capacity.
  let items = 0, extra = 0;
  while (extra < 2) {
    assert.ok(items < 60, "the paused observer never overflowed");
    await f.publish(cid, { kind: "nativeItem", requestId, index: items, text: String(items).padEnd(8192, ".") });
    items++;
    const head = (await f.ledger(cid)).at(-1)!.cursor;
    await until(() => fast.frames().at(-1)?.id === head || undefined, "the fast observer to keep up");
    if (hub.stats()!.fallbacks) extra++;
  }
  assert.deepEqual(hub.stats(), { hubs: 1, observers: 1, fallbacks: 1 });
  await f.publish(cid, { kind: "reply", requestId, itemCount: items });
  // The fast observer finishes while the slow one is still paused: nobody waited for it.
  assert.equal(await fast.done, 200);
  assert.equal(fast.frames().at(-1)!.event.type, "RUN_FINISHED");
  assert.ok(!slow.has("RUN_FINISHED"));
  slow.resume();
  assert.equal(await slow.done, 200);
  assert.equal(slow.raw, fast.raw);
  assertLedger(slow, await f.ledger(cid));
  await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
});

test("an observer that attaches behind its hub reads the gap from the database, then follows the hub", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const hub = await f.gateway(true), polling = await f.gateway(false);
  // A 1 MiB message history, several times a socket's buffer: a client that has read nothing holds its observer
  // inside the bootstrap, after the snapshot was read and before the observer attaches.
  const cid = await f.conversation(16);
  const leader = observe(hub.socketPath, f.owner, cid);
  await until(() => leader.has("STATE_SNAPSHOT"), "leader bootstrap");
  const runId = randomUUID();
  const behind = observe(hub.socketPath, f.owner, cid, runId, true), reference = observe(polling.socketPath, f.owner, cid, runId, true);
  await until(() => behind.status && reference.status, "snapshots read");
  const requestId = randomUUID();
  await f.publish(cid, input(requestId), text(requestId, 0, "while"));
  await f.publish(cid, text(requestId, 1, " held"));
  await until(() => leader.raw.includes(" held"), "the hub to move past the held snapshot");
  assert.deepEqual(hub.stats(), { hubs: 1, observers: 1, fallbacks: 0 }, "the held observer has not attached yet");
  behind.resume(); reference.resume();
  await until(() => hub.stats()?.observers === 2 || undefined, "the held observer to attach");
  // Nothing new is published, so only the observer's own database read can deliver what it missed.
  await until(() => behind.raw.includes(" held") || undefined, "the missed rows from the database", 5_000);
  await f.publish(cid, text(requestId, 2, " then"));
  await until(() => behind.raw.includes(" then") || undefined, "the next row from the hub");
  assert.deepEqual(hub.stats(), { hubs: 1, observers: 2, fallbacks: 0 }, "the caught-up observer follows the hub");
  await f.publish(cid, { kind: "reply", requestId, text: "while held then" });
  assert.deepEqual(await Promise.all([leader.done, behind.done, reference.done]), [200, 200, 200]);
  assert.equal(behind.raw, reference.raw);
  assertLedger(behind, await f.ledger(cid));
  await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 0 });
});

test("an observer ahead of its hub skips the rows its snapshot holds and stays on the hub", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const cid = await f.conversation();
  const head = (await f.ledger(cid)).at(-1)!.cursor;
  const hubs = new ObserverHubs(f.pool);
  t.after(() => hubs.close());
  const stop = new AbortController();
  t.after(() => stop.abort());
  // The leader opens the hub at the start of the ledger. The other observer, whose snapshot is at the head, attaches
  // before the hub's first read returns, so the hub then publishes every row that observer already has.
  const leader = hubs.attach(f.ownerId, cid, 0, stop.signal)!;
  const ahead = hubs.rows(f.ownerId, cid, head, stop.signal);
  const first = ahead.next();
  assert.deepEqual(hubs.stats(), { hubs: 1, observers: 2, fallbacks: 0 });
  for (let cursor = 1; cursor <= head; cursor++) assert.equal((await leader.next())?.cursor, cursor);
  await f.publish(cid, input(randomUUID()));
  assert.equal((await first).value?.cursor, head + 1);
  assert.deepEqual(hubs.stats(), { hubs: 1, observers: 2, fallbacks: 0 }, "the skipped rows did not send it to the database");
  await ahead.return();
  leader.dispose();
  await until(() => hubs.stats().hubs === 0 || undefined, "hub release");
  assert.deepEqual(hubs.stats(), { hubs: 0, observers: 0, fallbacks: 0 });
});

test("an observer overtaken while its hub could not read gets CURSOR_EXPIRED, as a polling one does", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  // The gateways share one connection, so holding it stops every read they make while the ledger moves on.
  const single = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL, max: 1 });
  t.after(() => single.end());
  const held = new MemberStore(single);
  // Once the connection is free the hub's first two reads (64 rows) reach the observer before its own read
  // returns, so the capacity leaves room above them: this test is about the gap, not an overflow.
  const hub = await f.gateway({ capacity: 128 }, held), polling = await f.gateway(false, held);
  const cid = await f.conversation();
  const runId = randomUUID();
  const observers = [observe(hub.socketPath, f.owner, cid, runId), observe(polling.socketPath, f.owner, cid, runId)];
  await until(() => observers.every((o) => o.has("STATE_SNAPSHOT")), "bootstrap");
  const slot = await single.connect();
  try {
    // Two commits: without the held connection the readers would take the first before the second prunes it.
    const requestId = randomUUID(), deltas = Array.from({ length: 300 }, () => "x");
    await f.publish(cid, input(requestId), ...deltas.map((delta, index) => text(requestId, index, delta)));
    await f.publish(cid, { kind: "reply", requestId, text: deltas.join("") });
  } finally { slot.release(); }
  assert.deepEqual(await Promise.all(observers.map((o) => o.done)), [200, 200]);
  const last = observers[0].frames().at(-1)!.event;
  assert.deepEqual([last.type, last.code], ["RUN_ERROR", "CURSOR_EXPIRED"]);
  assert.equal(observers[0].raw, observers[1].raw);
  await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 0 });
});

test("an observer refused by a full hub reads the database itself and receives the same bytes", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const hub = await f.gateway({ maxObservers: 1 }), polling = await f.gateway(false);
  const cid = await f.conversation();
  const runId = randomUUID();
  const observers = [observe(hub.socketPath, f.owner, cid, runId), observe(hub.socketPath, f.owner, cid, runId),
    observe(polling.socketPath, f.owner, cid, runId)];
  await until(() => observers.every((o) => o.has("STATE_SNAPSHOT")), "bootstrap");
  assert.deepEqual(hub.stats(), { hubs: 1, observers: 1, fallbacks: 1 });
  const requestId = randomUUID();
  await f.publish(cid, input(requestId), text(requestId, 0, "full"));
  await f.publish(cid, { kind: "reply", requestId, text: "full" });
  assert.deepEqual(await Promise.all(observers.map((o) => o.done)), [200, 200, 200]);
  assert.equal(observers[0].raw, observers[2].raw);
  assert.equal(observers[1].raw, observers[2].raw);
  await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
  // The admitted observer stayed on the hub through the terminal frame.
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 1 });
});

test("a failed hub read releases the hub, and its observers finish from the database without loss", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  let failNext = false;
  f.onLedgerRead(() => {
    if (!failNext) return undefined;
    failNext = false;
    return Promise.reject(new Error("injected hub read failure"));
  });
  // The polling reference reads through its own pool, so the injected failure can only reach the hub.
  const other = new Pool({ connectionString: process.env.BIRBCREW_TEST_DATABASE_URL, max: 4 });
  t.after(() => other.end());
  const hub = await f.gateway(true), polling = await f.gateway(false, new MemberStore(other));
  const cid = await f.conversation();
  const runId = randomUUID();
  const observers = [observe(hub.socketPath, f.owner, cid, runId), observe(hub.socketPath, f.owner, cid, runId),
    observe(polling.socketPath, f.owner, cid, runId)];
  await until(() => observers.every((o) => o.has("STATE_SNAPSHOT")), "bootstrap");
  assert.deepEqual(hub.stats(), { hubs: 1, observers: 2, fallbacks: 0 });
  // Attached observers that are level with their hub make no reads of their own, so the next one is the hub's.
  failNext = true;
  await until(() => hub.stats()?.hubs === 0 || undefined, "the failed hub to be released");
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 2 });
  const requestId = randomUUID();
  await f.publish(cid, input(requestId), text(requestId, 0, "after"));
  await f.publish(cid, { kind: "reply", requestId, text: "after" });
  assert.deepEqual(await Promise.all(observers.map((o) => o.done)), [200, 200, 200]);
  assert.equal(observers[0].raw, observers[2].raw);
  assert.equal(observers[1].raw, observers[2].raw);
  assertLedger(observers[0], await f.ledger(cid));
  // The observers that fell back opened no new hub.
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 2 });
});

test("an observer that leaves while the hub holds its row gives its place back", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const cid = await f.conversation();
  const head = (await f.ledger(cid)).at(-1)!.cursor;
  // Two places, and the smallest capacity: the stream keeps a place until its pending call for a row settles.
  const hubs = new ObserverHubs(f.pool, { maxObservers: 2, capacity: readEventsLimit });
  t.after(() => hubs.close());
  const stop = new AbortController();
  t.after(() => stop.abort());
  const leader = hubs.attach(f.ownerId, cid, head, stop.signal)!;
  const following = (async () => { for (let row = await leader.next(); row; row = await leader.next()); })();
  // Never asks for a row, so its first row stays offered until it overflows.
  hubs.attach(f.ownerId, cid, head, stop.signal);
  const requestId = randomUUID();
  await f.publish(cid, input(requestId), ...Array.from({ length: readEventsLimit + 8 }, (_, index) => text(requestId, index, "x")));
  await until(() => hubs.stats().fallbacks === 1 || undefined, "the stalled observer to overflow");
  const newcomer = hubs.attach(f.ownerId, cid, head, stop.signal);
  assert.ok(newcomer, "the observer that overflowed with a row offered still held its place");
  // Leaves while sending a row: that row's call settles too.
  await f.publish(cid, text(requestId, readEventsLimit + 8, "y"));
  assert.ok(await newcomer.next());
  newcomer.dispose();
  await until(() => hubs.stats().observers === 1 || undefined, "the newcomer to leave");
  const last = hubs.attach(f.ownerId, cid, head, stop.signal);
  assert.ok(last, "the observer that left while sending still held its place");
  last.dispose();
  leader.dispose();
  await following;
  await until(() => hubs.stats().hubs === 0 || undefined, "hub release");
  assert.deepEqual(hubs.stats(), { hubs: 0, observers: 0, fallbacks: 1 });
});

test("another owner's observer is refused before subscribing, and a hub only reads its owner's rows", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const hub = await f.gateway(true);
  const cid = await f.conversation();
  const refused = observe(hub.socketPath, f.stranger, cid);
  assert.equal(await refused.done, 404);
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 0 });
  assert.ok(!refused.raw.includes("STATE_SNAPSHOT"));

  // Below the route's check: a hub keyed by the other owner never receives this owner's rows.
  const hubs = new ObserverHubs(f.pool);
  t.after(() => hubs.close());
  const stop = new AbortController();
  t.after(() => stop.abort());
  const own = hubs.attach(f.ownerId, cid, 0, stop.signal)!, other = hubs.attach(f.strangerId, cid, 0, stop.signal)!;
  assert.deepEqual(hubs.stats(), { hubs: 2, observers: 2, fallbacks: 0 });
  const requestId = randomUUID();
  await f.publish(cid, input(requestId), text(requestId, 0, "private"));
  const rows = await f.ledger(cid);
  const received = [];
  while (received.length < rows.length) received.push(await own.next());
  assert.deepEqual(received, rows);
  const nothing = await Promise.race([other.next(), delay(500, "nothing")]);
  assert.equal(nothing, "nothing");
  // Leaving because the database disagreed with the hub counts as a fallback; disposing does not.
  own.abandon(); other.dispose();
  await until(() => hubs.stats().hubs === 0 || undefined, "both hubs released");
  assert.deepEqual(hubs.stats(), { hubs: 0, observers: 0, fallbacks: 1 });
});

test("the last observer to leave stops the hub's reader and releases it", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.onLedgerRead(() => {
    reads++;
    return undefined;
  });
  const hub = await f.gateway(true);
  const cid = await f.conversation();
  const observers = [observe(hub.socketPath, f.owner, cid), observe(hub.socketPath, f.owner, cid)];
  await until(() => observers.every((o) => o.has("STATE_SNAPSHOT")), "bootstrap");
  assert.deepEqual(hub.stats(), { hubs: 1, observers: 2, fallbacks: 0 });
  observers[0].close();
  await until(() => hub.stats()?.observers === 1 || undefined, "one observer left");
  assert.equal(hub.stats()!.hubs, 1);
  const before = reads;
  await delay(300);
  assert.ok(reads > before, "the remaining observer's hub keeps reading");
  observers[1].close();
  await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 0 });
  const after = reads;
  await delay(300);
  assert.equal(reads, after, "no reader runs for a conversation nobody observes");
  // A new observer opens a new hub at its own snapshot.
  const again = observe(hub.socketPath, f.owner, cid);
  await until(() => again.has("STATE_SNAPSHOT") && hub.stats()?.hubs === 1 || undefined, "a new hub");
  again.close();
  await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
});

test("a gateway restart mid-stream ends its hub, and observers of the new gateway match polling ones", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const polling = await f.gateway(false);
  let hub = await f.gateway(true);
  const cid = await f.conversation();
  const runId = randomUUID();
  const before = observe(hub.socketPath, f.owner, cid, runId), steady = observe(polling.socketPath, f.owner, cid, runId);
  await until(() => before.has("STATE_SNAPSHOT") && steady.has("STATE_SNAPSHOT"), "bootstrap");
  const requestId = randomUUID();
  await f.publish(cid, input(requestId), text(requestId, 0, "before"));
  await until(() => before.raw.includes("before") && steady.raw.includes("before"), "first delta");
  await hub.stop();
  await before.done.catch(() => {});
  assert.deepEqual(hub.stats(), { hubs: 0, observers: 0, fallbacks: 0 });
  assert.ok(steady.raw.startsWith(before.raw), "up to the restart both paths sent the same bytes");
  assert.ok(!before.has("RUN_ERROR") && !before.has("RUN_FINISHED"));
  await f.publish(cid, text(requestId, 1, " during"));
  hub = await f.gateway(true);
  const after = observe(hub.socketPath, f.owner, cid, runId), fresh = observe(polling.socketPath, f.owner, cid, runId);
  await until(() => after.has("STATE_SNAPSHOT") && fresh.has("STATE_SNAPSHOT"), "reattached bootstrap");
  await f.publish(cid, text(requestId, 2, " after"));
  await f.publish(cid, { kind: "reply", requestId, text: "before during after" });
  assert.deepEqual(await Promise.all([after.done, fresh.done, steady.done]), [200, 200, 200]);
  assert.equal(after.raw, fresh.raw);
  const resumed = after.frames().find((frame) => frame.event.type === "TEXT_MESSAGE_CONTENT")!.event;
  assert.equal(resumed.delta, "before during", "the new gateway replays the open text prefix once");
  assertLedger(steady, await f.ledger(cid));
  await until(() => hub.stats()?.hubs === 0 || undefined, "hub release");
});

test("BIRBCREW_OBSERVER_FANOUT selects the path and refuses anything but true or false; bounds are checked", () => {
  // On by default, as docs/persistent-deployment.md says.
  assert.equal(observerFanout({}), true);
  assert.equal(observerFanout({ BIRBCREW_OBSERVER_FANOUT: "" }), true);
  assert.equal(observerFanout({ BIRBCREW_OBSERVER_FANOUT: "false" }), false);
  assert.equal(observerFanout({ BIRBCREW_OBSERVER_FANOUT: " TRUE " }), true);
  for (const value of ["0", "1", "off", "yes"]) {
    assert.throws(() => observerFanout({ BIRBCREW_OBSERVER_FANOUT: value }), ObserverSettingsError, value);
  }
  // Below one read's 32 rows even an observer that keeps up would overflow.
  assert.throws(() => new ObserverHubs({} as Pool, { capacity: 31 }), RangeError);
  assert.throws(() => new ObserverHubs({} as Pool, { maxObservers: 0 }), RangeError);
});

test("the Temporal workflow bundle contains no Switchboard code", { timeout: 120_000 }, async () => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url)),
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} },
  });
  assert.ok(code.length > 0);
  assert.ok(!code.includes("switchboard") && !code.includes("createEventStream") && !code.includes("observer-hub"));
});
