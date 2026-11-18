import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { startClaudeFixtureProvider } from "../fixtures/engines/claude/index.mts";
import { startProvider } from "../fixtures/engines/codex/provider.mts";

type Engine = "claude" | "codex" | "pi";
type Evidence = Record<Engine, { requests: number; credentialDigests: string[] }>;
const routes: Record<Engine, string> = { claude: "/v1/messages", codex: "/responses", pi: "/chat/completions" };
const models: Record<Engine, string> = { claude: "claude-sonnet-4-6", codex: "gpt-5.4", pi: "fixture-chat" };
const bodySchema = z.looseObject({ model: z.string(), messages: z.unknown().optional() });
const piMessages = z.array(z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))]).nullish(),
}));

async function readBody(request: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 16 * 1024 * 1024) throw new Error("Fixture request limit");
    parts.push(part);
  }
  return bodySchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
}

function piReply(body: z.infer<typeof bodySchema>, response: ServerResponse) {
  const messages = piMessages.parse(body.messages).map(message => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : message.content?.map(part => part.text ?? "").join("") ?? "",
  }));
  const prompt = messages.findLast(message => message.role === "user")?.content;
  const remembered = messages.findLast(message => message.role === "user" && message.content.startsWith("remember "))?.content.slice(9);
  if (!remembered || !(prompt === "recall" || prompt?.startsWith("remember "))) throw new Error("Unsupported restart fixture prompt");
  const text = (prompt === "recall" ? "recalled " : "stored ") + remembered;
  const id = "chatcmpl_" + randomUUID();
  const frame = (delta: object, finish_reason: string | null = null) => "data: " + JSON.stringify({
    id, object: "chat.completion.chunk", created: 1, model: models.pi,
    choices: [{ index: 0, delta, finish_reason }],
  }) + "\n\n";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(frame({ role: "assistant" }));
  response.write(frame({ content: text }));
  response.write(frame({}, "stop"));
  response.end("data: [DONE]\n\n");
}

/** Local scripted protocols retained across worker/service restarts. No live model traffic. Claude's
 * reports 10 input and 10 output tokens per call; Codex's reports `codexUsage`, or zeros. */
export async function startRestartFixtures(options: { codexUsage?: (request: number) => Record<string, unknown> } = {}) {
  const claude = await startClaudeFixtureProvider();
  let codex: Awaited<ReturnType<typeof startProvider>>;
  try { codex = await startProvider(undefined, undefined, undefined, options.codexUsage); }
  catch { await claude.close(); throw new Error("Restart fixture initialization failed"); }
  const evidence: Evidence = {
    claude: { requests: 0, credentialDigests: [] },
    codex: { requests: 0, credentialDigests: [] },
    pi: { requests: 0, credentialDigests: [] },
  };
  const seen = new Set<string>();
  const active = new Set<AbortController>();
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      // Never expose request headers, credentials, body-validation errors or native diagnostics.
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end('{"error":{"message":"Restart fixture request failed"}}');
      } else response.destroy();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const engine = (Object.keys(routes) as Engine[]).find(candidate => routes[candidate] === request.url);
    if (!engine || request.method !== "POST" || request.headers["x-fixture-engine"] !== engine) throw new Error("Invalid fixture route");
    const match = /^Bearer (synthetic-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(\d+))$/.exec(request.headers.authorization ?? "");
    if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= Date.now()) throw new Error("Invalid fixture credential");
    const digest = createHash("sha256").update(match[1]).digest("hex");
    const body = await readBody(request);
    if (body.model !== models[engine]) throw new Error("Invalid fixture model");
    if (seen.has(digest) || Number(match[2]) <= Date.now()) throw new Error("Invalid or reused fixture credential");
    // Count authenticated protocol calls; evidence contains only credential digests.
    seen.add(digest);
    evidence[engine].requests++;
    evidence[engine].credentialDigests.push(digest);
    if (engine === "pi") { piReply(body, response); return; }
    const stop = new AbortController();
    active.add(stop);
    const abort = () => stop.abort();
    response.once("close", abort);
    try {
      const native = engine === "claude" ? claude : codex;
      const upstream = await fetch(native.url + routes[engine], {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: stop.signal, redirect: "error",
      });
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); throw new Error("Native fixture failed"); }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (!response.write(next.value)) await once(response, "drain", { signal: stop.signal });
        }
        response.end();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } finally {
      response.off("close", abort);
      active.delete(stop);
    }
  }
  let completion: Promise<void> | undefined;
  const close = () => completion ??= (async () => {
    for (const stop of active) stop.abort();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await Promise.all([claude.close(), codex.close()]);
  })();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Restart fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      endpoints: Object.fromEntries((Object.keys(routes) as Engine[]).map(engine => [engine, origin + routes[engine]])) as Record<Engine, string>,
      evidence: (): Evidence => structuredClone(evidence),
      close,
    };
  } catch {
    await close();
    throw new Error("Restart fixture initialization failed");
  }
}
