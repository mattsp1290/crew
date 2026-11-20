import { createHash } from "node:crypto";
import { codexToolContinuation, runCodexTurn } from "../../../../src/service/codex.ts";

const [stateDir, provider, ownerId, memberId, threadId, runId, prompt, checkpointJson] = process.argv.slice(2);
if (!stateDir || !provider || !ownerId || !memberId || !threadId || !runId || !prompt) throw new Error("Incomplete qualification worker");
const checkpoint = checkpointJson ? JSON.parse(checkpointJson) : null;
const ownerDigest = createHash("sha256").update(ownerId).digest("hex");
await runCodexTurn({
  threadId, runId, text: prompt, checkpoint, signal: AbortSignal.timeout(40_000),
  onThreadStarted(id) { process.send?.({ kind: "thread", threadId: id }); },
  hold: {
    tool: "record_work_item",
    answer(call) {
      const answered = Promise.withResolvers<{ text: string; isError: boolean }>();
      process.send?.({
        kind: "call", threadId: call.pending.target.session.opaque, arguments: call.arguments,
        resume: { version: 2, engine: "codex", state: {
          threadId, nativeId: call.pending.target.session.opaque, memberId, ownerDigest, model: "gpt-5.4", requestId: runId,
          session: call.pending.target.session, fingerprint: null, priorTotal: null,
        } },
      });
      const onMessage = (message: unknown) => {
        if (!message || typeof message !== "object" || !("text" in message) || !("isError" in message)) return;
        if (typeof message.text !== "string" || typeof message.isError !== "boolean") return;
        process.off("message", onMessage);
        answered.resolve({ text: message.text, isError: message.isError });
      };
      process.on("message", onMessage);
      return answered.promise.then(({ text, isError }) => codexToolContinuation(call.pending.target, text, isError));
    },
  },
}, { ownerId, memberId, stateDir, model: "gpt-5.4", baseUrl: provider });
process.send?.({ kind: "done" });
