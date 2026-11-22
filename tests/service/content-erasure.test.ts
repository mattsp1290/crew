import { responseValidator } from "./gateway-fixtures.ts";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createGateway } from "../../src/service/gateway.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { CustomEventSchema } from "@ag-ui/core/schemas";
import {
  conversationContentTombstoneSchema,
  serverRequestReceiptSchema,
  requestReceiptResponseSchema,
} from "@birbcrew/client/contract";
import { MemberStore } from "../../src/service/store.ts";
import { ownerInitiator } from "../../src/service/domain.ts";
import {
  beginContentErasure,
  contentErasureState,
  contentTombstone,
  finishContentErasure,
  preflightContentErasure,
  reserveTextWorkflowStart,
  sealTextClosure,
  settleTextWorkflowStart,
} from "../../src/service/content-erasure-store.ts";
import { readSnapshot } from "../../src/service/observation.ts";
import { IntegrationApi } from "../../src/service/integration-api.ts";
import { ConversationContentOutput } from "../../src/service/content-output.ts";
import {
  eraseConversationContent,
  type TextErasureLifecycle,
} from "../../src/service/content-erasure.ts";
import { MemberClient } from "../../src/service/client.ts";
import { Client } from "@temporalio/client";

const database = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!database)
  throw new Error(
    "Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database",
  );
const pool = new Pool({ connectionString: database }),
  store = new MemberStore(pool);
before(() => store.migrate());
after(() => pool.end());
const offline: TextErasureLifecycle = {
  async describeClosure() {
    throw Error("Temporal offline");
  },
  async ensureCleanupWorkflow() {
    throw Error("Temporal offline");
  },
  async closeTextConversation() {
    throw Error("Temporal offline");
  },
};
const members = {
  ...offline,
  async accept() {
    throw Error("unused");
  },
  async cancelPending() {
    throw Error("unused");
  },
  async requestStatus() {
    throw Error("must not call Temporal");
  },
};
async function fixture(
  engine: "cursor" | "opencode" = "cursor",
  reason: "predecessor_failed" | "predecessor_cancelled" = "predecessor_failed",
) {
  const ownerId = randomUUID(),
    member = await store.spawn({
      ownerId,
      engine,
      profile: "erasure.v1",
      requestId: randomUUID(),
    });
  const key = { ownerId, conversationId: randomUUID() };
  await store.openConversation({ ...key, memberId: member.memberId });
  const request = {
    ...key,
    requestId: randomUUID(),
    text: "private-marker-" + randomUUID(),
  };
  await store.recordAcceptance(request, ownerInitiator);
  await store.rejectAccepted(request, reason);
  return { key, member, request };
}
async function seal(key: { ownerId: string; conversationId: string }) {
  const row = await contentErasureState(pool, key);
  return sealTextClosure(store, key, {
    workflowId: `birbcrew-ts/member/${row.memberId}/conversation/${key.conversationId}`,
    runId: randomUUID(),
    status: "COMPLETED",
    namespace: "default",
    generation: row.text_start_generation,
  });
}
for (const engine of ["cursor", "opencode"] as const)
  for (const reason of [
    "predecessor_failed",
    "predecessor_cancelled",
  ] as const) {
    test(`${engine}: ${reason} retains identity and terminal receipt, repeats offline without result`, async () => {
      const { key, request, member } = await fixture(engine, reason);
      await seal(key);
      const id = await beginContentErasure(store, key);
      const tombstone = await finishContentErasure(store, key);
      assert.ok(tombstone);
      conversationContentTombstoneSchema.parse(tombstone);
      assert.equal(tombstone.erasureId, id);
      assert.equal(tombstone.memberId, member.memberId);
      assert.deepEqual(
        await eraseConversationContent({ store, lifecycle: offline, key }),
        tombstone,
      );
      const receipt = await new IntegrationApi(store, members).status({
        ...key,
        requestId: request.requestId,
      });
      assert.equal(
        receipt.status,
        reason === "predecessor_cancelled" ? "cancelled" : "failed",
      );
      assert.equal(receipt.erased, true);
      assert.equal("result" in receipt, false);
      assert.equal(
        serverRequestReceiptSchema.safeParse({
          ...receipt,
          result: { text: "leak" },
        }).success,
        false,
      );
      assert.equal(
        requestReceiptResponseSchema.safeParse({
          ...receipt,
          result: { text: "leak" },
        }).success,
        false,
      );
      assert.equal(
        (await readSnapshot(pool, key.ownerId, key.conversationId)).state
          .erased,
        true,
      );
      assert.equal(
        (await readSnapshot(pool, key.ownerId, key.conversationId)).state.phase,
        receipt.status === "cancelled" ? "cancelled" : "failed",
      );
      for (const text of [request.text, "changed"]) {
        await assert.rejects(store.committedReply({ ...request, text }), {
          code: "conversation_erased",
        });
      }
      const audit = await pool.query(
        "SELECT payload FROM birbcrew_ts.audit_events WHERE conversation_id=$1 AND event_type='conversation.content_erased'",
        [key.conversationId],
      );
      assert.deepEqual(audit.rows, [{ payload: { erasureId: id } }]);
      const retained = await pool.query(
        "SELECT phase,prompt_digest FROM birbcrew_ts.request_admissions WHERE conversation_id=$1",
        [key.conversationId],
      );
      assert.equal(retained.rows[0].phase, "rejected");
      assert.equal(retained.rows[0].prompt_digest.length, 32);
    });
  }
test("completed erased receipt requires explicit erasure, forbids result, and preserves live completed validation", () => {
  const base = {
    apiVersion: "1",
    conversationId: randomUUID(),
    requestId: randomUUID(),
    acceptance: { boundary: "sql_admission_and_temporal_queue" },
    status: "completed",
  };
  for (const schema of [
    serverRequestReceiptSchema,
    requestReceiptResponseSchema,
  ]) {
    assert.equal(schema.safeParse(base).success, false);
    assert.equal(
      schema.safeParse({ ...base, result: { text: "reply" } }).success,
      true,
    );
    assert.equal(schema.safeParse({ ...base, erased: true }).success, true);
    assert.equal(
      schema.safeParse({ ...base, erased: true, result: { text: "reply" } })
        .success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...base, status: "uncertain", erased: true }).success,
      false,
    );
  }
  CustomEventSchema.parse({
    type: "CUSTOM",
    name: "crew.content_erased",
    value: null,
  });
});
test("open workflow, active requests and raw uncertainty cannot create a fence or change content", async () => {
  const { key, request } = await fixture();
  await assert.rejects(beginContentErasure(store, key), {
    code: "conversation_open",
  });
  assert.equal((await contentErasureState(pool, key)).content_erasure_id, null);
  // A rejected admission must not mask an independently uncertain raw turn.
  await pool.query(
    "INSERT INTO birbcrew_ts.turns(conversation_id,request_id,position,prompt_digest,attempt,phase) SELECT conversation_id,request_id,1,prompt_digest,1,'uncertain' FROM birbcrew_ts.request_admissions WHERE conversation_id=$1",
    [key.conversationId],
  );
  await assert.rejects(preflightContentErasure(store, key), {
    code: "content_requests_unresolved",
  });
  assert.equal(
    (await store.requestStatus({ ...key, requestId: request.requestId })).phase,
    "rejected",
  );
  assert.equal((await contentErasureState(pool, key)).content_erasure_id, null);
});
test("closure generation invalidates an older terminal describe, and ambiguous sends never expire into closure", async () => {
  const { key } = await fixture(),
    workflowId = "test/" + key.conversationId;
  const row = await contentErasureState(pool, key);
  const attempt = await reserveTextWorkflowStart(store, key, workflowId);
  assert.ok(attempt);
  await settleTextWorkflowStart(store, key, attempt, randomUUID());
  await assert.rejects(
    sealTextClosure(store, key, {
      workflowId,
      runId: randomUUID(),
      status: "COMPLETED",
      namespace: "default",
      generation: row.text_start_generation,
    }),
    { code: "content_start_unresolved" },
  );
  const next = await reserveTextWorkflowStart(store, key, workflowId);
  assert.ok(next);
  await settleTextWorkflowStart(store, key, next);
  await assert.rejects(preflightContentErasure(store, key), {
    code: "content_start_unresolved",
  });
  assert.equal(
    (await contentErasureState(pool, key)).text_lifecycle,
    "startable",
  );
});
test("stale REPEATABLE READ insertion aborts after the authoritative tuple changes", async () => {
  const { key } = await fixture();
  const stale = await pool.connect();
  try {
    await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await stale.query(
      "SELECT * FROM birbcrew_ts.conversations WHERE conversation_id=$1",
      [key.conversationId],
    );
    await seal(key);
    await beginContentErasure(store, key);
    await assert.rejects(
      stale.query(
        "INSERT INTO birbcrew_ts.public_snapshots(conversation_id,state) VALUES($1,'{}')",
        [key.conversationId],
      ),
      { code: "40001" },
    );
  } finally {
    await stale.query("ROLLBACK");
    stale.release();
  }
});
test("pending fence, finalization rollback, immutable tombstone and SQL resurrection refusal", async () => {
  const { key, request } = await fixture();
  await pool.query(
    "INSERT INTO birbcrew_ts.public_snapshots(conversation_id,state,messages,open_text,open_tools,child_open_text) VALUES($1,$2,$3,$4,$5,$6)",
    [
      key.conversationId,
      JSON.stringify({ secret: request.text }),
      JSON.stringify([{ role: "user", content: request.text }]),
      JSON.stringify({ prefix: request.text }),
      JSON.stringify({ a: { prefix: request.text } }),
      JSON.stringify({ a: { prefix: request.text } }),
    ],
  );
  await pool.query(
    "INSERT INTO birbcrew_ts.public_events(conversation_id,cursor,event) VALUES($1,1,$2)",
    [
      key.conversationId,
      { type: "TEXT_MESSAGE_CONTENT", messageId: "x", delta: request.text },
    ],
  );
  await pool.query(
    "INSERT INTO birbcrew_ts.public_publications(conversation_id,logical_key) VALUES($1,'input/original')",
    [key.conversationId],
  );
  await seal(key);
  await beginContentErasure(store, key);
  await assert.rejects(
    new IntegrationApi(store, members).status({
      ...key,
      requestId: request.requestId,
    }),
    { code: "content_erasure_pending" },
  );
  await assert.rejects(readSnapshot(pool, key.ownerId, key.conversationId), {
    code: "content_erasure_pending",
  });
  for (const sql of [
    "UPDATE birbcrew_ts.public_events SET event='{}' WHERE conversation_id=$1",
    "DELETE FROM birbcrew_ts.public_events WHERE conversation_id=$1",
    "UPDATE birbcrew_ts.conversations SET content_erasure_id=NULL WHERE conversation_id=$1",
    "DELETE FROM birbcrew_ts.request_admissions WHERE conversation_id=$1",
  ]) {
    await assert.rejects(pool.query(sql, [key.conversationId]), {
      code: "23514",
    });
  }
  // Inject a transaction-local failing audit append, proving all scrub writes roll back with it.
  const broken = new MemberStore(pool);
  const original = broken.transaction.bind(broken);
  broken.transaction = (action) =>
    original(async (db) => {
      await db.query("SET LOCAL statement_timeout='2000ms'");
      await action(db);
      throw Error("audit/finalization rollback");
    });
  await assert.rejects(finishContentErasure(broken, key), /rollback/);
  assert.equal(
    (
      await pool.query(
        "SELECT event->>'delta' AS text FROM birbcrew_ts.public_events WHERE conversation_id=$1",
        [key.conversationId],
      )
    ).rows[0].text,
    request.text,
  );
  assert.equal(await contentTombstone(pool, key), null);
  await finishContentErasure(store, key);
  const snapshot = await readSnapshot(pool, key.ownerId, key.conversationId);
  assert.deepEqual(snapshot.messages, []);
  assert.equal(snapshot.openText, null);
  assert.deepEqual(snapshot.openTools, {});
  assert.deepEqual(snapshot.childText, {});
  assert.equal(JSON.stringify(snapshot).includes(request.text), false);
  for (const table of [
    "conversation_content_erasures",
    "conversations",
    "request_admissions",
    "public_publications",
  ]) {
    await assert.rejects(
      pool.query(`DELETE FROM birbcrew_ts.${table} WHERE conversation_id=$1`, [
        key.conversationId,
      ]),
      { code: "23514" },
    );
  }
  await assert.rejects(
    pool.query(
      "UPDATE birbcrew_ts.conversation_content_erasures SET erased_at=clock_timestamp() WHERE conversation_id=$1",
      [key.conversationId],
    ),
    { code: "23514" },
  );
});
test("output prepared before a fence is discarded; backpressure returns without holding the SQL lock", async () => {
  const { key } = await fixture();
  await seal(key);
  const first = new ConversationContentOutput(pool),
    second = new ConversationContentOutput(pool);
  let emitted = 0;
  assert.deepEqual(
    await first.enqueue(key, () => {
      emitted++;
      return { backpressure: true };
    }),
    { kind: "retained", backpressure: true },
  );
  await beginContentErasure(store, key); // Would block if write(false) kept the row locked.
  assert.deepEqual(
    await second.enqueue(key, () => {
      emitted++;
      return { backpressure: false };
    }),
    { kind: "erasing" },
  );
  assert.equal(emitted, 1);
  await finishContentErasure(store, key);
  assert.deepEqual(
    await first.enqueue(key, () => {
      throw Error("stale frame");
    }),
    { kind: "erased" },
  );
});
test("completed turns erase atomically only after independent stop proofs, retaining all digests and event identities", async () => {
  const ownerId = randomUUID(),
    member = await store.spawn({
      ownerId,
      requestId: randomUUID(),
      engine: "cursor",
      profile: "complete.v1",
    });
  const key = { ownerId, conversationId: randomUUID() },
    requestId = randomUUID();
  await store.openConversation({ ...key, memberId: member.memberId });
  const marker = "executed-marker-" + randomUUID(),
    request = { ...key, requestId, text: marker };
  await store.recordAcceptance(request, ownerInitiator);
  const execution = {
    workflowRunId: randomUUID(),
    activityId: "fixture",
    attempt: 1,
  };
  const turn = await store.beginTurn(request, execution);
  assert.equal(turn.kind, "start");
  await pool.query(
    "INSERT INTO birbcrew_ts.native_launches(conversation_id,request_id,token,workflow_run_id,activity_id,attempt,stopped) VALUES($1,$2,$3,$4,$5,1,true)",
    [
      key.conversationId,
      requestId,
      turn.token,
      execution.workflowRunId,
      execution.activityId,
    ],
  );
  await store.commitTurn({
    ...key,
    requestId,
    token: turn.token,
    reply: marker,
    checkpoint: { version: 1, engine: "cursor", state: { secret: marker } },
  });
  const before = await pool.query(
    "SELECT request_id,phase,token,prompt_digest FROM birbcrew_ts.turns WHERE conversation_id=$1",
    [key.conversationId],
  );
  await assert.rejects(preflightContentErasure(store, key), {
    code: "content_runtime_unconfirmed",
  });
  const locationId = randomUUID();
  await pool.query(
    "INSERT INTO birbcrew_ts.text_state_locations(location_id,engine) VALUES($1,'cursor')",
    [locationId],
  );
  await pool.query(
    "INSERT INTO birbcrew_ts.text_conversation_locations(conversation_id,location_id,profile) VALUES($1,$2,$3)",
    [key.conversationId, locationId, member.profile],
  );
  await pool.query(
    "INSERT INTO birbcrew_ts.text_runtime_cleanup_proofs(conversation_id,request_id,token,location_id,confirmed_at) VALUES($1,$2,$3,$4,clock_timestamp())",
    [key.conversationId, requestId, turn.token, locationId],
  );
  await seal(key);
  const erasureId = await beginContentErasure(store, key);
  assert.equal(await finishContentErasure(store, key), null);
  assert.equal(
    (
      await pool.query(
        "SELECT reply FROM birbcrew_ts.turns WHERE conversation_id=$1",
        [key.conversationId],
      )
    ).rows[0].reply,
    marker,
  );
  await pool.query(
    "UPDATE birbcrew_ts.conversation_content_cleanup SET cleaned_at=clock_timestamp() WHERE conversation_id=$1 AND erasure_id=$2",
    [key.conversationId, erasureId],
  );
  // Even with Temporal offline an already-acknowledged pending operation finalizes from SQL.
  await eraseConversationContent({ store, lifecycle: offline, key });
  assert.deepEqual(
    (
      await pool.query(
        "SELECT request_id,phase,token,prompt_digest FROM birbcrew_ts.turns WHERE conversation_id=$1",
        [key.conversationId],
      )
    ).rows,
    before.rows,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT erased,reply,checkpoint FROM birbcrew_ts.turns WHERE conversation_id=$1",
        [key.conversationId],
      )
    ).rows,
    [{ erased: true, reply: null, checkpoint: null }],
  );
  const receipt = await new IntegrationApi(store, members).status({
    ...key,
    requestId,
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.erased, true);
  assert.equal("result" in receipt, false);
  await assert.rejects(
    store.commitTurn({
      ...key,
      requestId,
      token: turn.token,
      reply: marker,
      checkpoint: { version: 1, engine: "cursor", state: {} },
    }),
    { code: "conversation_erased" },
  );
  await assert.rejects(
    store.appendText(
      { ...key, requestId, token: turn.token },
      "late",
      0,
      marker,
    ),
    { code: "conversation_erased" },
  );
});

test("two real gateways discard a prepared JSON snapshot after DELETE commits on the other replica", async (t) => {
  const { key, member, request } = await fixture();
  await pool.query(
    "INSERT INTO birbcrew_ts.public_snapshots(conversation_id,state,messages) VALUES($1,$2,$3)",
    [
      key.conversationId,
      JSON.stringify({
        conversationId: key.conversationId,
        memberId: member.memberId,
        engine: "cursor",
        profile: member.profile,
        phase: "failed",
        openStep: null,
        pendingApprovals: [],
        private: request.text,
      }),
      JSON.stringify([{ id: "prompt", role: "user", content: request.text }]),
    ],
  );
  await seal(key);
  let release!: () => void, reached!: () => void;
  const paused = new Promise<void>((r) => {
      release = r;
    }),
    prepared = new Promise<void>((r) => {
      reached = r;
    });
  class PausedOutput extends ConversationContentOutput {
    override async enqueue(
      ...args: Parameters<ConversationContentOutput["enqueue"]>
    ) {
      reached();
      await paused;
      return super.enqueue(...args);
    }
  }
  const token = randomUUID(),
    owners = {
      [createHash("sha256").update(token).digest("hex")]: key.ownerId,
    };
  const client = new MemberClient(store, new Client());
  const first = createGateway(store, client, owners, {
      contentOutput: new PausedOutput(pool),
    }),
    second = createGateway(store, client, owners);
  t.after(async () => {
    release();
    first.close();
    second.close();
    await Promise.all([first.stopped(), second.stopped()]);
  });
  first.listen(0, "127.0.0.1");
  second.listen(0, "127.0.0.1");
  await Promise.all([once(first, "listening"), once(second, "listening")]);
  function url(server: typeof first) {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    return `http://127.0.0.1:${addr.port}`;
  }
  const headers = { Authorization: "Bearer " + token };
  const old = fetch(url(first) + `/v1/conversations/${key.conversationId}`, {
    headers,
  });
  await prepared;
  const erased = await fetch(
    url(second) + `/v1/conversations/${key.conversationId}/content`,
    { method: "DELETE", headers },
  );
  assert.equal(erased.status, 200);
  release();
  const response = await old;
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes(request.text), false);
  assert.equal(JSON.parse(raw).erased, true);
});
test("043 upgrades retained native/text data from 042, is idempotent, and protects every new recovery table", async (t) => {
  const { testDatabaseName } = await import("./database-fixtures.ts");
  const { readFile, readdir } = await import("node:fs/promises");
  const name = testDatabaseName("erasure_upgrade_");
  await pool.query("CREATE DATABASE " + name);
  const target = new URL(database!);
  target.pathname = "/" + name;
  const upgraded = new Pool({ connectionString: target.href });
  t.after(async () => {
    await upgraded.end();
    await pool.query("DROP DATABASE " + name);
  });
  await upgraded.query(
    "CREATE SCHEMA birbcrew_ts;CREATE TABLE birbcrew_ts.schema_versions(version integer PRIMARY KEY)",
  );
  const sql = new URL("../../src/service/sql/", import.meta.url);
  for (const file of (await readdir(sql)).sort()) {
    const version = Number(file.slice(0, 3));
    if (version > 42) continue;
    await upgraded.query(await readFile(new URL(file, sql), "utf8"));
    await upgraded.query("INSERT INTO birbcrew_ts.schema_versions VALUES($1)", [
      version,
    ]);
  }
  for (const engine of ["pi", "cursor"]) {
    const ownerId = randomUUID(),
      memberId = randomUUID(),
      conversationId = randomUUID();
    await upgraded.query(
      "INSERT INTO birbcrew_ts.members(member_id,owner_id,spawn_request_id,engine,profile) VALUES($1,$2,$3,$4,'upgrade')",
      [memberId, ownerId, randomUUID(), engine],
    );
    await upgraded.query(
      "INSERT INTO birbcrew_ts.conversations(conversation_id,owner_id,member_id,turn_limit) VALUES($1,$2,$3,$4)",
      [conversationId, ownerId, memberId, engine === "pi" ? 128 : 1],
    );
    await upgraded.query(
      "INSERT INTO birbcrew_ts.turns(conversation_id,request_id,position,prompt_digest,attempt,phase,reply,checkpoint) VALUES($1,$2,1,$3,1,'committed','retained reply',$4)",
      [
        conversationId,
        randomUUID(),
        Buffer.alloc(32, 1),
        { version: 1, engine, state: { private: "retained checkpoint" } },
      ],
    );
  }
  const query =
    "SELECT conversation_id,request_id,prompt_digest,reply,checkpoint,phase,token FROM birbcrew_ts.turns ORDER BY conversation_id";
  const before = (await upgraded.query(query)).rows;
  const service = new MemberStore(upgraded);
  await service.migrate();
  await service.migrate();
  assert.deepEqual((await upgraded.query(query)).rows, before);
  assert.equal(
    (
      await upgraded.query(
        "SELECT 1 FROM birbcrew_ts.conversations WHERE text_location_inventory_complete",
      )
    ).rowCount,
    0,
  );
  const missing =
    await upgraded.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='birbcrew_ts' AND c.relkind='r' AND c.relname NOT IN ('schema_versions','recovery_control','recovery_runs')
      AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='recovery_write_barrier')`);
  assert.deepEqual(missing.rows, []);
  const client = await upgraded.connect();
  try {
    await client.query(
      "CREATE TEMP TABLE turn_shapes (LIKE birbcrew_ts.turns INCLUDING CONSTRAINTS INCLUDING DEFAULTS)",
    );
    for (const phase of ["committed", "started", "uncertain"])
      for (const erased of [false, true])
        for (const content of [false, true]) {
          const values = [
            randomUUID(),
            randomUUID(),
            Buffer.alloc(32),
            phase,
            erased,
            content ? "reply" : null,
            content ? { version: 1, engine: "pi", state: {} } : null,
          ];
          const valid =
            phase === "committed"
              ? erased
                ? !content
                : content
              : !erased && !content;
          const action = () =>
            client.query(
              "INSERT INTO turn_shapes(conversation_id,request_id,position,prompt_digest,attempt,phase,erased,reply,checkpoint) VALUES($1,$2,1,$3,1,$4,$5,$6,$7)",
              values,
            );
          if (valid) await action();
          else await assert.rejects(action(), { code: "23514" });
        }
  } finally {
    client.release();
  }
});

test("published raw OpenAPI rejects result presence on erased receipts", () => {
  const validate = responseValidator("requestStatus", 200);
  const receipt = {
    apiVersion: "1",
    conversationId: randomUUID(),
    requestId: randomUUID(),
    status: "completed",
    erased: true,
    acceptance: { boundary: "sql_admission_and_temporal_queue" },
  };
  assert.equal(validate(receipt), true);
  assert.equal(validate({ ...receipt, result: { text: "leak" } }), false);
  assert.equal(validate({ ...receipt, result: null }), false);
});
for (const mode of ["before_commit", "after_commit"] as const) {
  test(
    `backend loss cannot bypass output fencing while the gateway is paused ${mode}`,
    { timeout: 20000 },
    async () => {
      const { spawn } = await import("node:child_process");
      const { clearQuiescedContentOutputs } = await import(
        "../../src/service/erasure-inventory.ts"
      );
      const { key } = await fixture();
      await seal(key);
      const name = "output-race-" + randomUUID();
      const child = spawn(
        process.execPath,
        [
          "tests/service/output-reservation-child.mjs",
          mode,
          JSON.stringify(key),
          name,
        ],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (errors += chunk));
      const ended = once(child, "close");
      try {
        const deadline = Date.now() + 10000;
        while (!output.includes("FROZEN ")) {
          if (Date.now() > deadline)
            throw Error("Gateway did not pause: " + errors);
          await new Promise((r) => setTimeout(r, 20));
        }
        const pid = Number(/FROZEN (\d+)/.exec(output)?.[1]);
        const terminated = await pool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND application_name=$2",
          [pid, name],
        );
        assert.equal(terminated.rowCount, 1);
        if (mode === "before_commit") {
          await beginContentErasure(store, key);
          await finishContentErasure(store, key);
        } else {
          await assert.rejects(beginContentErasure(store, key), {
            code: "content_output_busy",
          });
          assert.equal(
            (await contentErasureState(pool, key)).content_erasure_id,
            null,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM birbcrew_ts.content_output_reservations WHERE conversation_id=$1",
                [key.conversationId],
              )
            ).rowCount,
            1,
          );
        }
        child.kill("SIGCONT");
        await ended;
        assert.equal(
          output.includes("ENQUEUED"),
          mode === "after_commit",
          output,
        );
        if (mode === "after_commit") {
          // Positive process reaping proves this test gateway cannot emit again. No age-based cleanup.
          const drainId = randomUUID();
          await store.transaction((db) =>
            clearQuiescedContentOutputs(db, key, drainId),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM birbcrew_ts.content_output_drains WHERE drain_id=$1",
                [drainId],
              )
            ).rowCount,
            1,
          );
          await beginContentErasure(store, key);
          await finishContentErasure(store, key);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await ended;
        }
      }
    },
  );
}
