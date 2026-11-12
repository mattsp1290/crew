import { childOpener } from "./child-observation.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { EventType as E, type Event } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import { Client, Connection, WorkflowUpdateFailedError } from "@temporalio/client";
import { Client as PgClient, Pool, type PoolOptions } from "pg";
import { z } from "zod";
import { decisionSchema } from "./approvals.ts";
import { AuditUnsettledError, auditCsv, auditParameterNames, auditQuerySchema, readAudit } from "./audit.ts";
import { CapabilityCeilingError, spawnRequestSchema } from "./capabilities.ts";
import { MemberClient } from "./client.ts";
import { listGrants, revokeGrant } from "./grants.ts";
import { MemoryApi, memoryListParameterNames } from "./memories.ts";
import { MemberStoreError, openSchema, submitSchema, turnKey } from "./domain.ts";
import { readEvents, readSnapshot, toolBootstrap, type PublicSnapshot } from "./observation.ts";
import { MemberStore } from "./store.ts";
import { IntegrationApi, integrationCapabilities } from "./integration-api.ts";
import { firingParameterNames, RoutineApi, RoutineDispatcher, routineListParameterNames, type Clock } from "./routines.ts";
import { TemporalSettingsError, temporalConnectionOptions, temporalSettings } from "./temporal-config.ts";

const credentials = z.record(z.string().regex(/^[0-9a-f]{64}$/), z.string().min(1));
const encoder = new EventEncoder();
const requestLimit = 128 * 1024;
const human = decisionSchema.omit({ ownerId: true, conversationId: true, argumentDigest: true, nativeCallId: true });

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) { super(reason); this.status = status; }
}

// Refuses malformed UTF-8 instead of replacing it with U+FFFD, and keeps a BOM for JSON.parse to refuse.
const exactUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `exact` refuses a body that is not well-formed UTF-8; otherwise malformed bytes become U+FFFD. */
async function body(request: IncomingMessage, exact = false): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > requestLimit) {
      request.resume();
      throw new HttpError(413, "request_too_large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  try { return JSON.parse(exact ? exactUtf8.decode(raw) : raw.toString("utf8")); }
  catch { throw new HttpError(400, "invalid_json"); }
}

function json(response: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(data));
}

function isEmpty(value: unknown) {
  return value == null || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);
}

// Strict schemas see every parameter; a repeated one is ambiguous, not last-wins.
function searchParams(url: URL): Record<string, string> {
  const entries = [...url.searchParams];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new HttpError(400, "invalid_input");
  return Object.fromEntries(entries);
}

export const probeTimeout = 2_000;
// A slow or failing dependency becomes undefined, so no driver text or address is reported.
async function probe<T>(check: () => Promise<T>): Promise<T | undefined> {
  const timer = new AbortController();
  try { return await Promise.race([check(), delay(probeTimeout, undefined, { signal: timer.signal })]); }
  catch { return undefined; }
  finally { timer.abort(); }
}

// probe() only ends the HTTP wait. The read itself uses its own connection, never the pool: pool.connect() has
// no bound (real routes keep an unbounded wait), so a connect stalled on a silent or unreachable host would pin
// the shared probe and a pool slot until the OS gave up, or forever. Settings are the ones pg-pool hands its own
// clients, plus password, which pg-pool makes non-enumerable so a spread drops it. connectionTimeoutMillis covers
// TCP, TLS and authentication; statement_timeout makes the server cancel a lock-blocked read; query_timeout
// covers a silent socket; end() gets the same bound before the socket is destroyed. So this settles within
// 3 * probeTimeout whatever the server does.
async function readSchemaVersion(options: PoolOptions): Promise<number | null> {
  const client = new PgClient({ ...options, password: options.password,
    connectionTimeoutMillis: probeTimeout, statement_timeout: probeTimeout, query_timeout: probeTimeout });
  client.on("error", () => {}); // a socket error after the probe gave up must not crash the gateway
  try {
    await client.connect();
    const { rows: [row] } = await client.query<{ version: number | null }>("SELECT max(version) AS version FROM birbcrew_ts.schema_versions");
    return row.version;
  } finally {
    const ended = await Promise.race([client.end().then(() => true), delay(probeTimeout, false, { ref: false })]);
    if (!ended) client.connection.stream.destroy();
  }
}

async function health(schemaVersion: () => Promise<number | null>, members: MemberClient) {
  const [version, temporal] = await Promise.all([
    probe(schemaVersion),
    probe(async () => { await members.temporalReachable(Date.now() + probeTimeout); return true; }),
  ]);
  const database = typeof version === "number" ? "ready" : "unavailable";
  return {
    apiVersion: "1", status: database === "ready" && temporal ? "ready" : "not_ready",
    dependencies: { database: { status: database, schemaVersion: version ?? null }, temporal: { status: temporal ? "ready" : "unavailable" } },
  } as const;
}

async function observe(
  pool: Pool, owner: string, snapshot: PublicSnapshot, runId: string, response: ServerResponse,
) {
  if (response.destroyed) return;
  const { conversationId: threadId } = snapshot.state;
  let cursor = snapshot.cursor;
  const stop = new AbortController();
  response.once("close", () => stop.abort());
  response.writeHead(200, { "Content-Type": encoder.getContentType(), "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  async function send(event: Event, id?: number) {
    stop.signal.throwIfAborted();
    const data = (id === undefined ? "" : `id: ${id}\n`) + encoder.encode(event);
    if (!response.write(data)) await once(response, "drain", { signal: stop.signal });
  }
  async function finish(phase: unknown) {
    if (phase === "failed") await send({ type: E.RUN_ERROR, code: "MEMBER_FAILED", message: "Member conversation failed" });
    else if (phase === "complete" || phase === "cancelled") await send({ type: E.RUN_FINISHED, threadId, runId });
    else return false;
    return true;
  }
  try {
    await send({ type: E.RUN_STARTED, threadId, runId });
    await send({ type: E.MESSAGES_SNAPSHOT, messages: snapshot.messages });
    await send({ type: E.STATE_SNAPSHOT, snapshot: snapshot.state }, cursor);
    if (snapshot.state.openStep) await send({ type: E.STEP_STARTED, stepName: snapshot.state.openStep });
    for (const child of snapshot.state.children ?? []) {
      if (child.phase !== "running") continue;
      await send(childOpener(child));
      if (child.openStep) await send({ type: E.STEP_STARTED, stepName: child.openStep, subagentRunId: child.childId });
      const text = snapshot.childText[child.childId];
      if (text) {
        await send({ type: E.TEXT_MESSAGE_START, messageId: text.id, role: "assistant", subagentRunId: child.childId });
        await send({ type: E.TEXT_MESSAGE_CONTENT, messageId: text.id, delta: text.prefix, subagentRunId: child.childId });
      }
    }
    if (snapshot.openText) {
      const { id, prefix } = snapshot.openText;
      await send({ type: E.TEXT_MESSAGE_START, role: "assistant", messageId: id });
      await send({ type: E.TEXT_MESSAGE_CONTENT, messageId: id, delta: prefix });
    }
    for (const tool of Object.values(snapshot.openTools)) {
      for (const event of toolBootstrap(tool)) await send(event);
    }
    if (await finish(snapshot.state.phase)) return;
    while (!stop.signal.aborted) {
      const rows = await readEvents(pool, owner, threadId, cursor);
      for (const row of rows) {
        if (row.cursor !== cursor + 1) {
          await send({ type: E.RUN_ERROR, code: "CURSOR_EXPIRED", message: "Reconnect for the current conversation snapshot" });
          return;
        }
        await send(row.event, row.cursor);
        cursor = row.cursor;
        if (row.event.type === E.STATE_SNAPSHOT && await finish(row.event.snapshot.phase)) return;
      }
      if (!rows.length) await delay(75, undefined, { signal: stop.signal });
    }
  } catch {
    if (!stop.signal.aborted && !response.destroyed) {
      await send({ type: E.RUN_ERROR, code: "OBSERVATION_FAILED", message: "Reconnect for the current conversation snapshot" });
    }
  } finally {
    response.end();
  }
}

function queryOf(url: URL, names: readonly string[]) {
  const given = [...url.searchParams.keys()];
  if (new Set(given).size !== given.length || !given.every(name => names.includes(name))) throw new HttpError(400, "invalid_input");
  return Object.fromEntries(url.searchParams);
}

/** `clock` drives routine schedules; tests inject one. */
export function createGateway(store: MemberStore, members: MemberClient, owners: Record<string, string>,
  { clock = () => new Date() }: { clock?: Clock } = {}) {
  const integration = new IntegrationApi(store, members);
  const accounts = Object.entries(credentials.parse(owners)).map(([hash, actor]) => ({ digest: Buffer.from(hash, "hex"), actor }));
  // One database probe at a time, shared by concurrent health calls, so polling holds at most one probe connection.
  // A stalled probe pins this slot only until readSchemaVersion's own bounds end it.
  let databaseProbe: Promise<number | null> | undefined;
  const schemaVersion = () => databaseProbe ??= readSchemaVersion(store.pool.options).finally(() => { databaseProbe = undefined; });
  const routines = new RoutineApi(store, clock);
  const memories = new MemoryApi(store);
  const dispatcher = new RoutineDispatcher({ store, members, integration, owners: accounts.map(({ actor }) => actor), clock });
  async function route(request: IncomingMessage, response: ServerResponse) {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ") || auth.length === 7) throw new HttpError(401, "authentication_required");
    const hash = createHash("sha256").update(auth.slice(7)).digest();
    const ownerId = accounts.find(({ digest }) => timingSafeEqual(digest, hash))?.actor;
    if (!ownerId) throw new HttpError(401, "authentication_required");
    const url = new URL(request.url ?? "/", "http://localhost");
    const versioned = url.pathname.startsWith("/v1/");
    const path = versioned ? url.pathname.slice(3) : url.pathname;
    if (versioned && path === "/capabilities" && request.method === "GET") return json(response, 200, integrationCapabilities);
    if (versioned && path === "/health" && request.method === "GET") {
      z.strictObject({}).parse(searchParams(url));
      const report = await health(schemaVersion, members);
      return json(response, report.status === "ready" ? 200 : 503, report);
    }
    if (versioned && path === "/members" && request.method === "GET") return json(response, 200, await integration.listMembers(ownerId, searchParams(url)));
    if (versioned && path === "/conversations" && request.method === "GET") {
      return json(response, 200, await integration.listConversations(ownerId, searchParams(url)));
    }
    if (versioned && path === "/audit") {
      if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
      const query = auditQuerySchema.parse(queryOf(url, auditParameterNames));
      const page = await readAudit(store.pool, ownerId, query);
      if (query.format === "json") return json(response, 200, { apiVersion: "1", ...page });
      response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="audit.csv"', "Audit-Next-After": page.nextAfter, "Audit-Has-More": String(page.hasMore) });
      return response.end(auditCsv(page.events));
    }
    const routineRoute = versioned && /^\/routines(?:\/([^/]+)(?:\/(enable|disable|firings))?)?$/.exec(path);
    if (routineRoute) {
      const [, id, action] = routineRoute;
      if (id === undefined) {
        if (request.method === "POST") return json(response, 201, await routines.create(ownerId, await body(request)));
        if (request.method === "GET") return json(response, 200, await routines.list(ownerId, queryOf(url, routineListParameterNames)));
        throw new HttpError(405, "method_not_allowed");
      }
      const routineId = z.uuid().parse(id);
      if (action === "firings" && request.method === "GET") {
        return json(response, 200, await routines.firings(ownerId, routineId, queryOf(url, firingParameterNames)));
      }
      if ((action === "enable" || action === "disable") && request.method === "POST") {
        z.strictObject({}).parse(await body(request));
        return json(response, 200, await routines.change(ownerId, routineId, action));
      }
      if (action === undefined && request.method === "GET") return json(response, 200, await routines.get(ownerId, routineId));
      if (action === undefined && request.method === "DELETE") return json(response, 200, await routines.change(ownerId, routineId, "delete"));
      throw new HttpError(405, "method_not_allowed");
    }
    const memoryRoute = versioned && /^\/memories(?:\/([^/]+))?$/.exec(path);
    if (memoryRoute) {
      const [, id] = memoryRoute;
      if (id === undefined) {
        if (request.method === "POST") {
          if (url.search) throw new HttpError(400, "invalid_input");
          return json(response, 201, await memories.create(ownerId, await body(request, true)));
        }
        if (request.method === "GET") return json(response, 200, await memories.list(ownerId, queryOf(url, memoryListParameterNames)));
        throw new HttpError(405, "method_not_allowed");
      }
      const memoryId = z.uuid().parse(id);
      if (url.search) throw new HttpError(400, "invalid_input");
      if (request.method === "GET") return json(response, 200, await memories.get(ownerId, memoryId));
      if (request.method === "DELETE") return json(response, 200, await memories.delete(ownerId, memoryId));
      throw new HttpError(405, "method_not_allowed");
    }
    const grantRoute = versioned && /^\/members\/([^/]+)\/grants(?:\/([^/]+)\/(revoke))?$/.exec(path);
    if (grantRoute) {
      if (url.search) throw new HttpError(400, "invalid_input");
      const memberId = z.uuid().parse(grantRoute[1]);
      if (!grantRoute[2] && request.method === "GET") return json(response, 200, await listGrants(store.pool, { ownerId, memberId }));
      if (grantRoute[2] && request.method === "POST") {
        z.strictObject({}).parse(await body(request));
        return json(response, 200, await revokeGrant(store.pool, { ownerId, memberId, grantId: z.uuid().parse(grantRoute[2]) }));
      }
      throw new HttpError(405, "method_not_allowed");
    }
    const requestRoute = versioned && /^\/conversations\/([^/]+)\/requests(?:\/([^/]+)(\/cancel)?)?$/.exec(path);
    if (requestRoute) {
      const conversationId = z.uuid().parse(requestRoute[1]);
      if (!requestRoute[2] && request.method === "POST") {
        const prompt = submitSchema.omit({ ownerId: true, conversationId: true }).parse(await body(request));
        return json(response, 202, await integration.submit({ ownerId, conversationId, ...prompt }));
      }
      if (requestRoute[2]) {
        const requestId = z.uuid().parse(requestRoute[2]);
        if (!requestRoute[3] && request.method === "GET") return json(response, 200, await integration.status({ ownerId, conversationId, requestId }));
        if (requestRoute[3] && request.method === "POST") {
          z.strictObject({}).parse(await body(request));
          return json(response, 202, await integration.cancel({ ownerId, conversationId, requestId }));
        }
      }
      throw new HttpError(405, "method_not_allowed");
    }
    if (path === "/members" && request.method === "POST") {
      const input = spawnRequestSchema.omit({ ownerId: true }).parse(await body(request));
      const published = await store.pool.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine=$1 AND name=$2", [input.engine, input.profile]);
      if (!published.rowCount) throw new HttpError(409, "unknown_profile");
      return json(response, 201, await store.spawn({ ownerId, ...input }));
    }
    if (path === "/conversations" && request.method === "POST") {
      const input = openSchema.omit({ ownerId: true }).parse(await body(request));
      await members.open({ ownerId, ...input });
      return json(response, 201, await readSnapshot(store.pool, ownerId, input.conversationId));
    }
    const statusPath = /^\/conversations\/([^/]+)\/requests\/([^/]+)$/.exec(path);
    if (statusPath && request.method === "GET") return json(response,200,await members.requestStatus({
      ownerId,conversationId:z.uuid().parse(statusPath[1]),requestId:z.uuid().parse(statusPath[2]),
    }));
    const parts = /^\/conversations\/([^/]+)(?:\/(events|inputs|human|cancel))?$/.exec(path);
    if (!parts) throw new HttpError(404, "not_found");
    const conversationId = z.uuid().parse(parts[1]);
    if (!parts[2] && request.method === "GET") return json(response, 200, await readSnapshot(store.pool, ownerId, conversationId));
    await store.getConversation({ ownerId, conversationId });
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const input = await body(request);
    switch (parts[2]) {
      case "inputs": {
        const prompt = submitSchema.omit({ ownerId: true, conversationId: true }).parse(input);
        return json(response, 202, await members.accept({ ownerId, conversationId, ...prompt }));
      }
      case "cancel": {
        const key = turnKey.omit({ ownerId: true, conversationId: true }).parse(input);
        await members.cancelPending({ ownerId, conversationId, ...key });
        return json(response, 202, { requestId: key.requestId });
      }
      case "human": {
        const key = human.parse(input);
        const { rows: [call] } = await store.pool.query<{ argument_digest: string; native_call_id: string }>(
          `SELECT argument_digest,native_call_id FROM birbcrew_ts.deferred_calls JOIN birbcrew_ts.conversations USING (conversation_id)
           WHERE conversation_id=$1 AND approval_id=$2 AND owner_id=$3`,
          [conversationId, key.approvalId, ownerId]);
        if (!call) throw new HttpError(409, "unknown_approval");
        const decision = await members.decide({ ownerId, conversationId, ...key, nativeCallId: call.native_call_id, argumentDigest: call.argument_digest });
        return json(response, 200, { approvalId: key.approvalId, decision });
      }
      case "events": {
        const run = RunAgentInputSchema.parse(input);
        if (run.threadId !== conversationId || run.tools.length || run.messages.length || run.context.length ||
            run.resume?.length || !isEmpty(run.state) || !isEmpty(run.forwardedProps)) throw new HttpError(400, "observation_only");
        const snapshot = await readSnapshot(store.pool, ownerId, conversationId);
        const after = url.searchParams.get("after");
        if (after !== null && after !== String(snapshot.cursor)) throw new HttpError(410, "CURSOR_EXPIRED");
        return observe(store.pool, ownerId, snapshot, run.runId, response);
      }
      default: throw new HttpError(404, "not_found");
    }
  }
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.destroyed || response.headersSent) return response.end();
      if (error instanceof HttpError) return json(response, error.status, { error: error.message });
      if (error instanceof z.ZodError) return json(response, 400, { error: "invalid_input" });
      if (error instanceof CapabilityCeilingError) return json(response, 400, { error: error.message });
      if (error instanceof MemberStoreError) return json(response, error.code === "not_found" ? 404 : 409, { error: error.code });
      if (error instanceof WorkflowUpdateFailedError) return json(response, 409, { error: "update_rejected" });
      if (error instanceof AuditUnsettledError) return json(response, 503, { error: "audit_unsettled" }, { "Retry-After": "1" });
      return json(response, 503, { error: "retry_same_request" });
    });
  });
  // Background loops: the cancellation outbox and the routine dispatcher. Neither keeps the
  // process alive; each skips a beat while its previous pass still runs.
  const timers: ReturnType<typeof setInterval>[] = [];
  server.once("listening", () => {
    const flush = () => { void integration.flushCancellations().catch(() => {}); };
    const dispatch = () => { void dispatcher.tick().catch(() => {}); };
    for (const loop of [flush, dispatch]) {
      const timer = setInterval(loop, 1000);
      timer.unref();
      timers.push(timer);
      loop();
    }
  });
  let stopping = Promise.resolve();
  server.once("close", () => {
    for (const timer of timers) clearInterval(timer);
    stopping = dispatcher.stop();
  });
  // Settles once the close has ended the dispatcher's pass; await it before closing the pool.
  return Object.assign(server, { stopped: () => stopping });
}

const configSchema = z.strictObject({ tokenHashes: credentials, port: z.number().int().min(0).max(65535) });
async function main() {
  const file = process.argv[2], database = process.env.BIRBCREW_DATABASE_URL;
  if (!file || !database) throw new Error("Set BIRBCREW_DATABASE_URL and supply the gateway configuration file");
  const config = configSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const temporal = temporalSettings(process.env);
  const pool = new Pool({ connectionString: database });
  const connection = await Connection.connect(await temporalConnectionOptions(temporal));
  try {
    const store = new MemberStore(pool);
    await store.migrate();
    const server = createGateway(store, new MemberClient(store, new Client({ connection, namespace: temporal.namespace })), config.tokenHashes);
    server.listen(config.port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address && typeof address !== "string") console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}` }));
    const stop = () => { server.close(); server.closeAllConnections(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try { await once(server, "close"); await server.stopped(); }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } finally {
    await connection.close();
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof TemporalSettingsError ? error.message : "Gateway could not start");
    process.exitCode = 1;
  });
}
