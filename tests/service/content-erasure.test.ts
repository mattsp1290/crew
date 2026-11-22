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
import { appendAudit } from "../../src/service/audit.ts";
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
  await assert.rejects(seal(key), { code: "content_requests_unresolved" });
  assert.equal(
    (await contentErasureState(pool, key)).text_lifecycle,
    "startable",
  );
});
test("closure generation invalidates an older terminal describe, and ambiguous sends never expire into closure", async () => {
  const { key } = await fixture(),
    workflowId = "test/" + key.conversationId;
  const row = await contentErasureState(pool, key);
  const attempt = await reserveTextWorkflowStart(
    store,
    key,
    workflowId,
    "default",
  );
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
  const next = await reserveTextWorkflowStart(
    store,
    key,
    workflowId,
    "default",
  );
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
    "INSERT INTO birbcrew_ts.public_publications(conversation_id,logical_key,payload_digest) VALUES($1,'input/original',decode(repeat('ab',32),'hex'))",
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
  assert.deepEqual(
    (
      await pool.query(
        "SELECT logical_key,payload_digest FROM birbcrew_ts.public_publications WHERE conversation_id=$1",
        [key.conversationId],
      )
    ).rows,
    [{ logical_key: "input/original", payload_digest: null }],
  );
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
  await assert.rejects(
    pool.query(
      "UPDATE birbcrew_ts.turns SET erased=true,reply=NULL,checkpoint=NULL WHERE conversation_id=$1",
      [key.conversationId],
    ),
    { code: "23514" },
  );
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
  const cancelApi = new IntegrationApi(
    store,
    new MemberClient(store, new Client()),
  );
  const cancellation = await cancelApi.cancel({ ...key, requestId });
  assert.equal(cancellation.status, "completed");
  assert.deepEqual(await cancelApi.cancel({ ...key, requestId }), cancellation);
  let releaseReplay!: () => void, reachedReplay!: () => void;
  const pausedReplay = new Promise<void>((r) => {
      releaseReplay = r;
    }),
    preparedReplay = new Promise<void>((r) => {
      reachedReplay = r;
    });
  const replayStore = new MemberStore(pool);
  replayStore.requestAdmission = async (input) => {
    const value = await store.requestAdmission(input);
    reachedReplay();
    await pausedReplay;
    return value;
  };
  const replay = assert.rejects(replayStore.committedReply(request), {
    code: "conversation_erased",
  });
  await preparedReplay;
  const erasureId = await beginContentErasure(store, key);
  releaseReplay();
  await replay;
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
  await upgraded.query(
    "ALTER TABLE birbcrew_ts.turns ADD CONSTRAINT retained_fixture_rule CHECK(phase<>'committed' OR reply IS NOT NULL OR checkpoint IS NOT NULL OR attempt>0)",
  );
  const constraints =
    "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='birbcrew_ts.turns'::regclass AND contype='c' AND conname NOT IN ('turns_check1','turns_content_shape') ORDER BY conname";
  const constraintsBefore = (await upgraded.query(constraints)).rows;
  const query =
    "SELECT conversation_id,request_id,prompt_digest,reply,checkpoint,phase,token FROM birbcrew_ts.turns ORDER BY conversation_id";
  const before = (await upgraded.query(query)).rows;
  const service = new MemberStore(upgraded);
  const blocker = await upgraded.connect();
  try {
    await blocker.query(
      "BEGIN; LOCK TABLE birbcrew_ts.public_snapshots IN ROW EXCLUSIVE MODE",
    );
    await assert.rejects(service.migrate(), { code: "55P03" });
    assert.equal(
      (
        await upgraded.query(
          "SELECT 1 FROM birbcrew_ts.schema_versions WHERE version=43",
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await upgraded.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='birbcrew_ts' AND table_name='conversations' AND column_name='content_erasure_id'",
        )
      ).rowCount,
      0,
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  await service.migrate();
  await service.migrate();
  assert.deepEqual((await upgraded.query(query)).rows, before);
  const constraintsAfter = (await upgraded.query(constraints)).rows.filter(
    (row) => constraintsBefore.some((old) => old.conname === row.conname),
  );
  assert.deepEqual(constraintsAfter, constraintsBefore);
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

test("SQL refuses incomplete cleanup inventories, pre-finalized erasures and pre-acknowledged locations", async () => {
  const { key, member } = await fixture();
  const locationId = randomUUID(),
    erasureId = randomUUID();
  await pool.query(
    "INSERT INTO birbcrew_ts.text_state_locations(location_id,engine) VALUES($1,'cursor')",
    [locationId],
  );
  await pool.query(
    "INSERT INTO birbcrew_ts.text_conversation_locations(conversation_id,location_id,profile) VALUES($1,$2,$3)",
    [key.conversationId, locationId, member.profile],
  );
  await seal(key);
  await assert.rejects(
    pool.query(
      "INSERT INTO birbcrew_ts.conversation_content_erasures(conversation_id,erasure_id,terminal_phase,erased_at) VALUES($1,$2,'failed',clock_timestamp())",
      [key.conversationId, erasureId],
    ),
    { code: "23514" },
  );
  await pool.query(
    "INSERT INTO birbcrew_ts.conversation_content_erasures(conversation_id,erasure_id,terminal_phase) VALUES($1,$2,'failed')",
    [key.conversationId, erasureId],
  );
  await assert.rejects(
    pool.query(
      "UPDATE birbcrew_ts.conversations SET content_erasure_id=$2 WHERE conversation_id=$1",
      [key.conversationId, erasureId],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO birbcrew_ts.conversation_content_cleanup(conversation_id,erasure_id,location_id,cleaned_at) VALUES($1,$2,$3,clock_timestamp())",
      [key.conversationId, erasureId, locationId],
    ),
    { code: "23514" },
  );
  await pool.query(
    "INSERT INTO birbcrew_ts.conversation_content_cleanup(conversation_id,erasure_id,location_id) VALUES($1,$2,$3)",
    [key.conversationId, erasureId, locationId],
  );
  await pool.query(
    "UPDATE birbcrew_ts.conversations SET content_erasure_id=$2 WHERE conversation_id=$1",
    [key.conversationId, erasureId],
  );
  await assert.rejects(
    pool.query(
      "UPDATE birbcrew_ts.conversation_content_erasures SET erased_at=clock_timestamp() WHERE conversation_id=$1",
      [key.conversationId],
    ),
    { code: "23514" },
  );
});

test("fenced content cannot be moved to a retained conversation", async () => {
  const source = await fixture(),
    destination = await fixture();
  for (const key of [source.key, destination.key])
    await pool.query(
      "INSERT INTO birbcrew_ts.public_snapshots(conversation_id,state) VALUES($1,'{}')",
      [key.conversationId],
    );
  await pool.query(
    "INSERT INTO birbcrew_ts.public_events(conversation_id,cursor,event) VALUES($1,1,$2)",
    [
      source.key.conversationId,
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "x",
        delta: source.request.text,
      },
    ],
  );
  await seal(source.key);
  await beginContentErasure(store, source.key);
  await assert.rejects(
    pool.query(
      "UPDATE birbcrew_ts.public_events SET conversation_id=$2 WHERE conversation_id=$1",
      [source.key.conversationId, destination.key.conversationId],
    ),
    { code: "23514" },
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM birbcrew_ts.public_events WHERE conversation_id=$1",
        [destination.key.conversationId],
      )
    ).rowCount,
    0,
  );
  await finishContentErasure(store, source.key);
});

test("only the completed persisted erasure can append its single owner audit fact", async () => {
  const { key, member } = await fixture();
  const fact = {
    type: "conversation.content_erased" as const,
    ...key,
    memberId: member.memberId,
    payload: { erasureId: randomUUID() },
  };
  await assert.rejects(
    store.transaction((db) => appendAudit(db, fact)),
    { code: "23514" },
  );
  await seal(key);
  const erasureId = await beginContentErasure(store, key);
  await assert.rejects(
    store.transaction((db) =>
      appendAudit(db, { ...fact, payload: { erasureId } }),
    ),
    { code: "23514" },
  );
  await finishContentErasure(store, key);
  for (const payload of [
    { erasureId: "arbitrary text" },
    { erasureId, secret: "raw SQL marker" },
    { erasureId: null },
    [],
  ]) {
    await assert.rejects(
      pool.query(
        "INSERT INTO birbcrew_ts.audit_events(event_type,owner_id,member_id,conversation_id,actor_kind,actor_id,payload) VALUES('conversation.content_erased',$1,$2,$3,'owner',$1,$4)",
        [
          key.ownerId,
          member.memberId,
          key.conversationId,
          JSON.stringify(payload),
        ],
      ),
      { code: "23514" },
    );
  }
  await assert.rejects(
    store.transaction((db) => appendAudit(db, fact)),
    { code: "23514" },
  );
  await store.transaction(async (db) => {
    await appendAudit(db, { ...fact, payload: { erasureId } });
    await appendAudit(db, { ...fact, payload: { erasureId } });
  });
  assert.deepEqual(
    (
      await pool.query(
        "SELECT payload FROM birbcrew_ts.audit_events WHERE conversation_id=$1 AND event_type='conversation.content_erased'",
        [key.conversationId],
      )
    ).rows,
    [{ payload: { erasureId } }],
  );
});

test("concurrent finalizers both return the same completed tombstone", async () => {
  const { key } = await fixture();
  await pool.query(
    "INSERT INTO birbcrew_ts.public_snapshots(conversation_id,state) VALUES($1,'{}')",
    [key.conversationId],
  );
  await seal(key);
  await beginContentErasure(store, key);
  let reached!: () => void, release!: () => void;
  const beforeCommit = new Promise<void>((r) => {
      reached = r;
    }),
    commit = new Promise<void>((r) => {
      release = r;
    });
  const paused = new MemberStore(pool),
    original = paused.transaction.bind(paused);
  paused.transaction = (action) =>
    original(async (db) => {
      const value = await action(db);
      reached();
      await commit;
      return value;
    });
  const first = finishContentErasure(paused, key);
  await beforeCommit;
  const second = finishContentErasure(store, key);
  // Observe a real database lock wait before allowing the first finalizer to commit.
  try {
    const deadline = Date.now() + 1500;
    while (
      !(
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%conversations%' AND pid<>pg_backend_pid()",
        )
      ).rowCount
    ) {
      assert.ok(
        Date.now() < deadline,
        "second finalizer did not wait on the held conversation",
      );
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    release();
  }
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM birbcrew_ts.audit_events WHERE conversation_id=$1 AND event_type='conversation.content_erased'",
        [key.conversationId],
      )
    ).rowCount,
    1,
  );
});

test("closure repeat returns the persisted evidence and native missing replay stays absent", async () => {
  const { key } = await fixture();
  const first = await seal(key);
  assert.deepEqual(await sealTextClosure(store, key, first), first);
  assert.equal(
    await store.committedReply({
      ownerId: randomUUID(),
      conversationId: randomUUID(),
      requestId: randomUUID(),
      text: "absent",
    }),
    undefined,
  );
});

test("one blocked conversation does not block another conversation's output", async () => {
  const blocked = await fixture(),
    other = await fixture(),
    db = await pool.connect();
  const output = new ConversationContentOutput(pool);
  let pending: Promise<unknown> | undefined;
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE",
      [blocked.key.conversationId],
    );
    pending = output
      .enqueue(blocked.key, () => ({ backpressure: false }))
      .catch((error) => error);
    assert.deepEqual(
      await output.enqueue(other.key, () => ({ backpressure: false })),
      { kind: "retained", backpressure: false },
    );
    await db.query("COMMIT");
    assert.deepEqual(await pending, { kind: "retained", backpressure: false });
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pending;
    await output.stop();
  }
});

test("a live gateway retries its own failed output acknowledgement without failing the delivered frame", async () => {
  const { key } = await fixture(),
    transient = new Pool({ connectionString: database });
  let fail = true;
  transient.on("connect", (db) => {
    const original = db.query.bind(db);
    db.query = ((...args: unknown[]) => {
      const statement = args[0];
      const text =
        typeof statement === "string"
          ? statement
          : statement && typeof statement === "object" && "text" in statement
            ? statement.text
            : undefined;
      if (
        fail &&
        typeof text === "string" &&
        text.startsWith("DELETE FROM birbcrew_ts.content_output_reservations")
      ) {
        fail = false;
        return Promise.reject(Error("injected acknowledgement failure"));
      }
      return Reflect.apply(original, db, args);
    }) as typeof db.query;
  });
  const output = new ConversationContentOutput(transient);
  try {
    assert.deepEqual(
      await output.enqueue(key, () => ({ backpressure: false })),
      { kind: "retained", backpressure: false },
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
    const deadline = Date.now() + 5000;
    while (
      (
        await pool.query(
          "SELECT 1 FROM birbcrew_ts.content_output_reservations WHERE conversation_id=$1",
          [key.conversationId],
        )
      ).rowCount
    ) {
      assert.ok(
        Date.now() < deadline,
        "live owner did not release its delivered ticket",
      );
      await new Promise((r) => setTimeout(r, 20));
    }
    await seal(key);
    await beginContentErasure(store, key);
    assert.ok(await finishContentErasure(store, key));
  } finally {
    await output.stop();
    await transient.end();
  }
});

test("an open chunked DELETE body receives 400 without destroying the response", async (t) => {
  const { request: httpRequest } = await import("node:http");
  const { key } = await fixture(),
    token = randomUUID();
  const server = createGateway(store, new MemberClient(store, new Client()), {
    [createHash("sha256").update(token).digest("hex")]: key.ownerId,
  });
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await server.stopped();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: addr.port,
        path: `/v1/conversations/${key.conversationId}/content`,
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + token,
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        resolve(res.statusCode);
        res.resume();
        req.end();
      },
    );
    req.on("error", reject);
    req.write("nonempty");
    req.setTimeout(2000, () =>
      req.destroy(Error("missing invalid-input response")),
    );
  });
  assert.equal(status, 400);
  assert.equal((await contentErasureState(pool, key)).content_erasure_id, null);
});

for (const fanout of [true, false])
  for (const stage of ["bootstrap", "tail"] as const) {
    test(`${fanout ? "hub" : "polling"} SSE discards a paused ${stage} frame after another gateway fences`, async (t) => {
      const { key, member, request } = await fixture();
      await pool.query(
        "INSERT INTO birbcrew_ts.public_snapshots(conversation_id,state,messages) VALUES($1,$2,$3)",
        [
          key.conversationId,
          {
            conversationId: key.conversationId,
            memberId: member.memberId,
            engine: member.engine,
            profile: member.profile,
            phase: "running",
            openStep: null,
            pendingApprovals: [],
          },
          JSON.stringify(
            stage === "bootstrap"
              ? [{ id: "prompt", role: "user", content: request.text }]
              : [],
          ),
        ],
      );
      let release!: () => void, reached!: () => void, bootstrapped!: () => void;
      const pause = new Promise<void>((r) => {
          release = r;
        }),
        prepared = new Promise<void>((r) => {
          reached = r;
        }),
        bootstrap = new Promise<void>((r) => {
          bootstrapped = r;
        });
      class PausedOutput extends ConversationContentOutput {
        calls = 0;
        override async enqueue(
          ...args: Parameters<ConversationContentOutput["enqueue"]>
        ) {
          const call = ++this.calls;
          if (call === (stage === "bootstrap" ? 1 : 5)) {
            reached();
            await pause;
          }
          const result = await super.enqueue(...args);
          if (call === 3) bootstrapped();
          return result;
        }
      }
      const token = randomUUID(),
        owners = {
          [createHash("sha256").update(token).digest("hex")]: key.ownerId,
        };
      const client = new MemberClient(store, new Client()),
        first = createGateway(store, client, owners, {
          fanout,
          contentOutput: new PausedOutput(pool),
        }),
        second = createGateway(store, client, owners);
      t.after(async () => {
        release();
        for (const server of [first, second]) {
          server.closeAllConnections();
          server.close();
          await server.stopped();
        }
      });
      for (const server of [first, second]) {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
      }
      const url = (server: typeof first) => {
        const addr = server.address();
        assert.ok(addr && typeof addr !== "string");
        return `http://127.0.0.1:${addr.port}`;
      };
      const headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
      const old = fetch(
        url(first) + `/v1/conversations/${key.conversationId}/events`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            threadId: key.conversationId,
            runId: randomUUID(),
            messages: [],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          }),
        },
      );
      if (stage === "tail") {
        await bootstrap;
        await store.transaction(async (db) => {
          await db.query(
            "SELECT 1 FROM birbcrew_ts.conversations WHERE conversation_id=$1 FOR UPDATE",
            [key.conversationId],
          );
          await db.query(
            "INSERT INTO birbcrew_ts.public_events(conversation_id,cursor,event) VALUES($1,1,$2),($1,2,$3)",
            [
              key.conversationId,
              { type: "TEXT_MESSAGE_START", messageId: "x", role: "assistant" },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: "x",
                delta: request.text,
              },
            ],
          );
          await db.query(
            "UPDATE birbcrew_ts.public_snapshots SET cursor=2 WHERE conversation_id=$1",
            [key.conversationId],
          );
        });
      }
      await prepared;
      await seal(key);
      const erased = await fetch(
        url(second) + `/v1/conversations/${key.conversationId}/content`,
        { method: "DELETE", headers },
      );
      assert.equal(erased.status, 200);
      release();
      const response = await old,
        raw = await response.text();
      assert.equal(response.status, 200);
      assert.equal(raw.includes(request.text), false);
      assert.ok(raw.includes("CONVERSATION_ERASED"));
      if (fanout) assert.equal(first.observerStats()?.hubs, 0);
    });
  }

test("opening legacy text identities cannot replace expired closure history with a fresh run", async () => {
  for (const hasTurn of [false, true]) {
    const ownerId = randomUUID(),
      member = await store.spawn({
        ownerId,
        engine: "cursor",
        profile: "legacy-expired",
        requestId: randomUUID(),
      }),
      key = { ownerId, conversationId: randomUUID() };
    await pool.query(
      "INSERT INTO birbcrew_ts.conversations(owner_id,member_id,conversation_id,turn_limit,text_location_inventory_complete) VALUES($1,$2,$3,1,$4)",
      [ownerId, member.memberId, key.conversationId, hasTurn],
    );
    if (hasTurn)
      await pool.query(
        "INSERT INTO birbcrew_ts.turns(conversation_id,request_id,position,prompt_digest,attempt,phase,reply,checkpoint,workflow_run_id,activity_id) VALUES($1,$2,1,$3,1,'committed','retained',$4,$5,'old')",
        [
          key.conversationId,
          randomUUID(),
          Buffer.alloc(32),
          { version: 1, engine: "cursor", state: {} },
          randomUUID(),
        ],
      );
    let starts = 0;
    const temporal = {
      workflow: {
        start: async () => {
          starts++;
          throw Error("must not replace legacy execution");
        },
        getHandle: () => ({
          describe: async () => {
            throw Error("expired history");
          },
        }),
      },
      connection: {
        withDeadline: async (
          _deadline: number,
          action: () => Promise<unknown>,
        ) => action(),
      },
      options: { namespace: "default" },
    } as unknown as Client;
    const client = new MemberClient(store, temporal);
    await client.open({ ...key, memberId: member.memberId });
    assert.equal(starts, 0);
    await assert.rejects(client.describeClosure(key), /expired history/);
    assert.equal(
      (await contentErasureState(pool, key)).text_lifecycle,
      "startable",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM birbcrew_ts.conversation_workflow_starts WHERE conversation_id=$1",
          [key.conversationId],
        )
      ).rowCount,
      0,
    );
  }
});

test("start reservations and closure observations bind one namespace before sending RPCs", async () => {
  const { key } = await fixture();
  const workflowId = `birbcrew-ts/member/${(await contentErasureState(pool, key)).memberId}/conversation/${key.conversationId}`;
  const attempt = await reserveTextWorkflowStart(
    store,
    key,
    workflowId,
    "namespace-a",
  );
  assert.ok(attempt);
  await assert.rejects(
    reserveTextWorkflowStart(store, key, workflowId, "namespace-b"),
    { code: "content_namespace_mismatch" },
  );
  await settleTextWorkflowStart(store, key, attempt, randomUUID());
  const row = await contentErasureState(pool, key);
  await assert.rejects(
    sealTextClosure(store, key, {
      workflowId,
      runId: randomUUID(),
      status: "COMPLETED",
      namespace: "namespace-b",
      generation: row.text_start_generation,
    }),
    { code: "content_namespace_mismatch" },
  );
  const evidence = await sealTextClosure(store, key, {
    workflowId,
    runId: randomUUID(),
    status: "COMPLETED",
    namespace: "namespace-a",
    generation: row.text_start_generation,
  });
  assert.equal(evidence.namespace, "namespace-a");
  assert.equal(
    (await contentErasureState(pool, key)).text_workflow_namespace,
    "namespace-a",
  );
});

test("ineligible closure evidence warns without failing worker liveness", async () => {
  const { startContentErasureReconciliation } = await import(
    "../../src/service/content-erasure-reconciliation.ts"
  );
  const { key } = await fixture();
  await reserveTextWorkflowStart(store, key, "test/ambiguous", "default");
  await pool.query(
    "UPDATE birbcrew_ts.conversations SET text_closing_at=clock_timestamp()-interval '6 minutes' WHERE conversation_id=$1",
    [key.conversationId],
  );
  const temporal = {
    connection: {
      withDeadline: async (_deadline: number, action: () => Promise<unknown>) =>
        action(),
    },
    workflow: {
      getHandle: () => ({
        describe: async () => {
          throw Error("missing history");
        },
      }),
      start: async () => {
        throw Error("offline cleanup");
      },
    },
    options: { namespace: "default" },
  } as unknown as Client;
  const loop = startContentErasureReconciliation(pool, temporal);
  await loop.stop();
  assert.equal(loop.healthy(), true);
  assert.equal(
    (await contentErasureState(pool, key)).text_lifecycle,
    "startable",
  );
});

test(
  "a text SSE bootstrap progresses after a large frame has already drained",
  { timeout: 10000 },
  async (t) => {
    const { key, member, request } = await fixture(),
      content = request.text + "x".repeat(200000);
    await pool.query(
      "INSERT INTO birbcrew_ts.public_snapshots(conversation_id,state,messages) VALUES($1,$2,$3)",
      [
        key.conversationId,
        {
          conversationId: key.conversationId,
          memberId: member.memberId,
          engine: member.engine,
          profile: member.profile,
          phase: "failed",
          openStep: null,
          pendingApprovals: [],
        },
        JSON.stringify([{ id: "large", role: "user", content }]),
      ],
    );
    const token = randomUUID(),
      server = createGateway(store, new MemberClient(store, new Client()), {
        [createHash("sha256").update(token).digest("hex")]: key.ownerId,
      });
    t.after(async () => {
      server.closeAllConnections();
      server.close();
      await server.stopped();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/v1/conversations/${key.conversationId}/events`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          threadId: key.conversationId,
          runId: randomUUID(),
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.ok(raw.includes(content));
    assert.ok(raw.includes("MEMBER_FAILED"));
  },
);
