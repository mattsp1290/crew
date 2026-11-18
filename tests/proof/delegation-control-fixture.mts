import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as portProbe } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { before, boundedCommand, durableLog, now, signalOwnedChild } from "./member-service-diagnostics.mts";

export type LogCapture = ReturnType<ReturnType<typeof durableLog>["close"]>;
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Polls every 100 ms. The `until` in member-services.mts polls every 200 ms, so it is not a drop-in replacement here. */
export async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 60_000): Promise<T> {
  const deadline = now() + timeout;
  while (now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error("Timed out waiting for " + label);
}

export function absent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; }
}

const loadSchema = z.strictObject({ kind: z.literal("profile-load"), pid: z.number().int().positive(), loadedBy: z.string() });
/** Reads the profile loads that delegation-control-profiles.mts appends to `path`. */
export async function runnerLoads(path: string, limit = 512 * 1024) {
  let bytes: string;
  try { bytes = await readFile(path, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  assert.ok(Buffer.byteLength(bytes) < limit);
  return bytes.trim().split("\n").filter(Boolean).map(line => loadSchema.parse(JSON.parse(line)));
}

export function redact(text: string, database: string) {
  const password = new URL(database).password;
  let safe = text.replaceAll(database, "[fixture-database-url]");
  if (password) safe = safe.replaceAll(password, "[fixture-database-password]");
  return safe.replace(/Bearer\s+[^\s"']+/g, "Bearer [fixture-credential]");
}

/**
 * Spawns a detached child whose output goes to a durable log. `stop` signals it, kills its group if it has not closed
 * after 20 s, always closes the log and runs `afterStop`, then throws the sole failure or all of them together.
 */
export function ownedProcess(options: { scope: string; program: string; args: string[]; env: NodeJS.ProcessEnv; logPath: string;
  shutdown: "group" | "process"; afterStop(child: ChildProcess, capture: LogCapture): Promise<void> }) {
  const log = durableLog(options.logPath);
  const child = spawn(options.program, options.args, { env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const failures: unknown[] = [];
  child.on("error", error => failures.push(error));
  child.stdout.on("error", error => failures.push(error));
  child.stderr.on("error", error => failures.push(error));
  child.stdout.on("data", (bytes: Buffer) => log.append(bytes));
  child.stderr.on("data", (bytes: Buffer) => log.append(bytes));
  const closed = new Promise<void>(done => child.once("close", () => done()));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (options.shutdown === "process") child.kill("SIGTERM");
    else signalOwnedChild(child, "SIGTERM");
    try { await before(closed, now() + 20_000, options.scope + " owned process close"); }
    catch (error) {
      failures.push(error);
      signalOwnedChild(child, "SIGKILL");
      try { await before(closed, now() + 3_000, options.scope + " forced close"); } catch (forced) { failures.push(forced); }
    }
    try { await options.afterStop(child, log.close()); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, options.scope + " process ownership failed");
  })();
  return { child, stop, logPath: options.logPath };
}

/** Starts the official Temporal CLI 1.10.0 development server on a free loopback port and waits for cluster health. */
export async function temporalDevServer(cli: string, directory: string, start: (args: string[]) => { child: ChildProcess },
  timeout = 60_000) {
  const version = await boundedCommand(cli, ["--version"], now() + 5_000);
  assert.equal(version.stdout.kind, "complete");
  if (version.stdout.kind !== "complete") throw new Error("Truncated Temporal version");
  assert.match(version.stdout.text, /^temporal version 1\.10\.0\b/);
  const probe = portProbe().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const bound = probe.address();
  assert.ok(bound && typeof bound === "object");
  const address = "127.0.0.1:" + bound.port;
  await new Promise<void>(done => probe.close(() => done()));
  const server = start(["server", "start-dev", "--headless", "--port", String(bound.port), "--db-filename", join(directory, "temporal.db")]);
  await until(async () => {
    assert.equal(server.child.exitCode, null, "Owned Temporal server exited during startup");
    try { await boundedCommand(cli, ["operator", "cluster", "health", "--address", address, "--command-timeout", "1s"], now() + 2_000); return true; }
    catch { return undefined; }
  }, "Temporal health", timeout);
  return { address, version: version.stdout.text.trim() };
}

const messageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))]).nullish() });
const requestSchema = z.looseObject({ model: z.enum(["control-parent", "control-analyst", "control-recorder"]),
  messages: z.array(messageSchema), tools: z.array(z.looseObject({ function: z.looseObject({ name: z.string(), parameters: z.unknown() }) })).optional() });
const taskSchema = z.strictObject({ role: z.enum(["analyst", "recorder"]), task: z.string() });
export type Task = z.infer<typeof taskSchema>;
export type WireObservation = { sequence: number; model: z.infer<typeof requestSchema>["model"]; promptDigest: string; continuation: boolean; responseClosed: boolean; responseFinished: boolean };
const text = (message: z.infer<typeof messageSchema>) => typeof message.content === "string" ? message.content : message.content?.map(part => part.text ?? "").join("") ?? "";

/**
 * The loopback chat-completions endpoint behind delegation-control-profiles.mts; the user prompt's first word picks the
 * reply. `hold` is offered every reply that can be held, keyed `child/`, `parent/` or `resume/` plus the prompt digest,
 * and returns whether it took it. A `hold` prompt that nobody takes is never answered.
 */
export function controlProvider(options: { note: string; limit: number; outcome?(value: unknown): unknown;
  hold?(key: string, release: () => void, closed: Promise<void>): boolean; failed?(error: unknown): void }) {
  const wire: WireObservation[] = [];
  const recalls = new Set<WireObservation>();
  const server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      options.failed?.(error);
      if (!response.headersSent) { response.writeHead(502); response.end('{"error":{"message":"Control fixture request refused"}}'); }
      else response.destroy();
    });
  });
  async function respond(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.method, "POST"); assert.equal(request.url, "/chat/completions");
    assert.equal(request.headers.authorization, "Bearer synthetic-control-fixture");
    const parts: Buffer[] = []; let bytes = 0;
    for await (const part of request) { bytes += part.length; assert.ok(bytes <= 1024 * 1024); parts.push(part); }
    const body = requestSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    const prompt = text(body.messages.findLast(message => message.role === "user") ?? { role: "user", content: "" });
    const continuation = body.messages.at(-1)?.role === "tool";
    assert.ok(wire.length < options.limit, "Control fixture request bound");
    const observation: WireObservation = { sequence: wire.length + 1, model: body.model, promptDigest: digest(prompt), continuation, responseClosed: false, responseFinished: false };
    wire.push(observation);
    const closed = new Promise<void>(done => response.once("close", () => { observation.responseClosed = true; done(); }));
    const id = "chatcmpl_" + randomUUID();
    const frame = (delta: object, finish_reason: string | null = null) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
    response.writeHead(200, { "content-type": "text/event-stream" }); response.write(frame({ role: "assistant" }));
    function finish(content: string) {
      if (response.destroyed) return;
      response.write(frame({ content })); response.write(frame({}, "stop"));
      observation.responseFinished = true; response.end("data: [DONE]\n\n");
    }
    function calls(name: string, values: unknown[]) {
      values.forEach((value, index) => response.write(frame({ tool_calls: [{ index, id: "call_" + randomUUID(), type: "function",
        function: { name, arguments: JSON.stringify(value) } }] })));
      response.write(frame({}, "tool_calls")); response.end("data: [DONE]\n\n"); observation.responseFinished = true;
    }
    function reply(key: string, content: string) {
      if (!options.hold?.(key, () => finish(content), closed)) finish(content);
    }
    if (prompt.startsWith("delegate ")) {
      if (!continuation) {
        const tasks: unknown = JSON.parse(prompt.slice(9));
        calls("delegate_task", Array.isArray(tasks) ? z.array(taskSchema).min(1).max(2).parse(tasks) : [taskSchema.parse(tasks)]);
      } else {
        const results = body.messages.filter(message => message.role === "tool").map(message => {
          const result: unknown = JSON.parse(text(message));
          return options.outcome ? options.outcome(result) : result;
        });
        reply("parent/" + digest(prompt), "delegated " + JSON.stringify(results));
      }
    } else if (prompt.startsWith("record ")) {
      if (continuation) reply("resume/" + digest(prompt), "settled " + text(body.messages.at(-1) ?? { role: "tool", content: "" }));
      else {
        const tool = body.tools?.find(tool => tool.function.name === "record_work_item");
        const schema = z.looseObject({ properties: z.looseObject({ operation_id: z.looseObject({ const: z.uuid() }) }) }).parse(tool?.function.parameters);
        calls("record_work_item", [{ operation_id: schema.properties.operation_id.const, note: options.note }]);
      }
    } else if (prompt.startsWith("hold ")) options.hold?.("child/" + digest(prompt), () => finish("held complete"), closed);
    else if (prompt.startsWith("remember ")) finish("stored " + prompt.slice(9));
    else if (prompt.startsWith("recall ")) {
      assert.ok(body.messages.some(message => message.role === "assistant" && text(message) === "stored " + prompt.slice(7)),
        "Real native checkpoint retains earlier assistant content");
      recalls.add(observation); finish("recalled " + prompt.slice(7));
    } else throw new Error("Unsupported control fixture prompt");
  }
  return {
    server, wire, recalls,
    /** Listens on a free loopback port and returns the chat-completions URL. */
    async listen() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}/chat/completions`;
    },
    close() {
      const closed = new Promise<void>(done => server.close(() => done()));
      server.closeAllConnections();
      return closed;
    },
  };
}
