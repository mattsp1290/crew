import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { engineSchema } from "../../src/service/domain.ts";
import { usageAttributes, type SegmentUsage } from "../../src/service/usage-capture.ts";

const [mode, engineValue, provider, conversationId, requestId, workflowRunId, secret] = process.argv.slice(2);
const engine = engineSchema.parse(engineValue);
if (mode === "start-failure" || mode === "finish-failure") {
  const original = BasicTracerProvider.prototype.getTracer;
  BasicTracerProvider.prototype.getTracer = function (...args) {
    const tracer = original.apply(this, args);
    if (args[0] === "@mattsp1290/switchboard") {
      const start = tracer.startSpan.bind(tracer);
      tracer.startSpan = (...spanArgs) => {
        if (mode === "start-failure") throw new Error(secret);
        const span = start(...spanArgs);
        span.end = () => { throw new Error(secret); };
        return span;
      };
    }
    return tracer;
  };
}
const { flushTelemetry, observedAgent, traced } = await import("../../src/service/telemetry.ts");
const scope = { engine, provider, conversationId, requestId, workflowRunId, prompt: secret, apiKey: secret };
const usage: SegmentUsage = { state: "reported", model: secret, inputTokens: 31, outputTokens: 7,
  cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null };
let calls = 0;
async function native(kind = "complete") {
  const reply = { kind, text: secret, checkpoint: { nativeId: secret }, usage };
  const result = await observedAgent(scope, async () => { calls++; return reply; });
  assert.strictEqual(result, reply);
  return result;
}
async function fails() {
  const error = { message: secret, nativeId: secret };
  await assert.rejects(observedAgent(scope, async () => { calls++; throw error; }), value => value === error);
}
if (mode === "success" || mode === "start-failure" || mode === "finish-failure") {
  for (const kind of ["complete", "pending", "delegated"]) {
    await traced("workflow.segment", scope, () => traced("native.restore", scope, () =>
      traced("model.invoke", scope, () => native(kind), result => usageAttributes(result.usage))));
  }
  await fails();
  assert.equal(calls, 4);
} else if (mode === "error") {
  await traced("workflow.segment", scope, async () => { await fails(); });
  assert.equal(calls, 1);
} else if (mode === "nested") {
  await traced("workflow.segment", scope, () => observedAgent(scope, async () => {
    calls++;
    await traced("tool.settle", scope, async () => undefined);
    await observedAgent(scope, async () => { calls++; });
    const other = { ...scope, requestId: randomUUID(), workflowRunId: randomUUID() };
    await observedAgent(other, () => traced("tool.settle", other, async () => undefined));
  }));
  await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const parallel = { ...scope, requestId: randomUUID(), workflowRunId: randomUUID() };
    return traced("workflow.segment", parallel, () => observedAgent(parallel, async () => {
      calls++;
      await delay(index % 3);
      await traced("tool.settle", parallel, async () => undefined);
    }));
  }));
  assert.equal(calls, 14);
} else if (mode === "capacity") {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tasks = Array.from({ length: 129 }, () => observedAgent(scope, async () => { calls++; await gate; }));
  assert.equal(calls, 129);
  release();
  await Promise.all(tasks);
} else if (mode === "invalid") {
  for (const invalid of [{ ...scope, conversationId: secret }, { ...scope, requestId: secret },
    { ...scope, workflowRunId: secret }, { ...scope, childId: secret },
    ...["", "pi/secret", "https://private.invalid", "private@example.org", "UPPER", "a".repeat(65), "x\n"].map(provider => ({ ...scope, provider }))]) {
    const result = {};
    assert.strictEqual(await observedAgent(invalid, async () => { calls++; return result; }), result);
  }
  assert.equal(calls, 11);
} else {
  await native();
  await fails();
  assert.equal(calls, 2);
}
await flushTelemetry();
console.log(JSON.stringify({ calls, preserved: true }));
process.exit(0);
