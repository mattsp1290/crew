import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { readEvents } from "../../src/service/observation.ts";

for (const mode of ["setup-silence", "select-silence", "commit-silence", "select-disconnect"]) {
  test(`ledger read discards its client and recovers after ${mode}`, { timeout: 15_000 }, async (t) => {
    const target = new URL(process.env.BIRBCREW_TEST_DATABASE_URL!);
    let drop = false, triggered = false;
    const sockets = new Set<Socket>();
    const marker = Buffer.from(mode === "setup-silence" ? "BEGIN READ ONLY" : mode === "commit-silence" ? "COMMIT" : "SELECT e.cursor,e.event");
    const relay = createServer((downstream) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      for (const [socket, peer] of [[upstream, downstream], [downstream, upstream]]) {
        sockets.add(socket);
        socket.on("error", () => peer.destroy());
        socket.on("close", () => { sockets.delete(socket); peer.destroy(); });
      }
      let tail = Buffer.alloc(0);
      downstream.on("data", (chunk) => {
        const command = Buffer.concat([tail, chunk]);
        tail = command.subarray(-marker.length);
        if (!triggered && command.includes(marker)) {
          triggered = true;
          drop = true;
          if (mode === "select-disconnect") { downstream.destroy(); upstream.destroy(); return; }
        }
        upstream.write(chunk);
      });
      upstream.on("data", (chunk) => { if (!drop) downstream.write(chunk); });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    const relayed = new URL(target);
    relayed.hostname = "127.0.0.1";
    relayed.port = String(address.port);
    relayed.searchParams.set("statement_timeout", "0");
    relayed.searchParams.set("query_timeout", "0");
    const pool = new Pool({ connectionString: relayed.href, max: 1 });
    pool.on("error", () => {});
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await pool.end();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    });
    const connected = await pool.connect();
    connected.release();
    await assert.rejects(readEvents(pool, "missing-owner", randomUUID(), 0), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, mode === "select-disconnect" ? "Connection terminated unexpectedly" : "Query read timeout");
      return true;
    });
    assert.ok(triggered, "the relay intercepted the production transaction stage");
    assert.equal(pool.totalCount, 0, "the failed read destroyed its checked-out client");
    drop = false;
    assert.deepEqual(await readEvents(pool, "missing-owner", randomUUID(), 0), []);
  });
}
