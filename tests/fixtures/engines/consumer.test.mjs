import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { json } from "node:stream/consumers";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import { EventEncoder } from "@ag-ui/encoder";

async function serve(fixture, t) {
  const encoder = new EventEncoder();
  const runs = new Map();
  const server = createServer(async (request, response) => {
    try {
      const input = await json(request);
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      response.writeHead(200, { "Content-Type": encoder.getContentType() });
      const events = [];
      const done = Promise.withResolvers();
      runs.set(input.runId, { events, done: done.promise, signal: controller.signal });
      fixture.run(input, controller.signal).subscribe({
        next(event) {
          events.push(event);
          if (!response.destroyed) response.write(encoder.encode(event));
        },
        error(error) {
          done.resolve(error);
          response.destroy();
        },
        complete() {
          done.resolve();
          response.end();
        },
      });
    } catch (error) {
      response.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    await fixture.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, runs };
}

function terminalTypes(events) {
  return events
    .map(({ type }) => type)
    .filter((type) => type === "RUN_FINISHED" || type === "RUN_ERROR");
}

async function turn(host, threadId, prompt, t, cancel = false) {
  const runId = randomUUID();
  const agent = new HttpAgent({
    url: host.url,
    threadId,
    initialMessages: [{ id: randomUUID(), role: "user", content: prompt }],
  });
  const received = [];
  let text = "";
  const abort = () => agent.abortRun();
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    await agent.runAgent({ runId }, {
      onEvent({ event }) {
        received.push(event);
        if (event.type === "TEXT_MESSAGE_CONTENT") text += event.delta;
        if (cancel && event.type === "TEXT_MESSAGE_CONTENT" && text === "waiting") abort();
      },
    });
    const run = host.runs.get(runId);
    assert.ok(run, "HTTP request reached the SDK fixture");
    assert.ifError(await run.done);
    const started = run.events.filter(({ type }) => type === "RUN_STARTED");
    assert.deepEqual(started.map((event) => [event.threadId, event.runId]), [[threadId, runId]]);
    const terminals = terminalTypes(run.events);
    assert.equal(terminals.length, 1, "SDK emitted exactly one terminal event");
    assert.equal(run.events.at(-1).type, terminals[0], "terminal event was last");
    if (cancel) {
      assert.equal(text, "waiting");
      assert.ok(run.signal.aborted, "client disconnected before the SDK finished");
      assert.equal(terminals[0], "RUN_ERROR");
      assert.match(run.events.at(-1).message, /abort|cancel|interrupt/i);
    } else {
      assert.deepEqual(terminalTypes(received), terminals, "terminal event reached HttpAgent");
      assert.equal(terminals[0], prompt === "fail" ? "RUN_ERROR" : "RUN_FINISHED");
    }
    return text;
  } finally {
    t.signal.removeEventListener("abort", abort);
  }
}

for (const engine of ["claude", "pi", "codex"]) {
  // The Codex member ships only a Linux arm64/x64 binary (src/service/codex-executable.ts).
  test(`${engine} clean consumer`, { skip: engine === "codex" && process.platform !== "linux", timeout: 120_000 }, async (t) => {
    const { createFixture } = await import(`./${engine}/index.mts`);
    const providerFailure = t.mock.fn();
    const host = await serve(await createFixture(providerFailure), t);
    const thread = randomUUID();
    const other = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    assert.equal(await turn(host, thread, `remember ${first}`, t), `stored ${first}`);
    assert.equal(await turn(host, other, "recall", t), "recalled none");
    assert.equal(await turn(host, other, `remember ${second}`, t), `stored ${second}`);
    assert.equal(await turn(host, thread, "recall", t), `recalled ${first}`);
    assert.equal(await turn(host, other, "recall", t), `recalled ${second}`);
    await turn(host, randomUUID(), "fail", t);
    assert.ok(providerFailure.mock.callCount() > 0, "scripted provider handled the failure prompt");
    await turn(host, randomUUID(), "wait", t, true);
  });
}
