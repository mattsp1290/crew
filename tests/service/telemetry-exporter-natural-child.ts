import { flushTelemetry, traced, turnFlushBudgetMs } from "../../src/service/telemetry.ts";

const [conversationId, requestId, workflowRunId, secret] = process.argv.slice(2);
const scope = { engine: "claude", conversationId, requestId, workflowRunId, prompt: secret, apiKey: secret } satisfies
  Parameters<typeof traced>[1] & { prompt: string; apiKey: string };
const result = await traced("workflow.segment", scope, () => traced("model.invoke", scope, async () => "reply " + secret));
const started = performance.now();
await flushTelemetry(turnFlushBudgetMs);
console.log(JSON.stringify({ value: result === "reply " + secret, flushed: performance.now() - started }));
