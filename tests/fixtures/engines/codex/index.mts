import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventType as E, type Event, type RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import { runCodexTurn } from "../../../../src/service/codex.ts";
import { startProvider } from "./provider.mts";

export async function createFixture(onFailure: () => void) {
  const provider = await startProvider(onFailure);
  const root = await mkdtemp(join(tmpdir(), "birb-codex-chat-"));
  const memberId = randomUUID();
  const sessions = new Map<string, unknown>();
  return {
    run({ threadId, runId, messages }: RunAgentInput, signal: AbortSignal) {
      return new Observable<Event>((subscriber) => {
        async function respond() {
          subscriber.next({ type: E.RUN_STARTED, threadId, runId });
          const prompt = messages.at(-1)?.content;
          if (typeof prompt !== "string") throw new Error("Invalid fixture prompt");
          const result = await runCodexTurn({
            threadId, runId, text: prompt, checkpoint: sessions.get(threadId) ?? null, signal,
          }, { ownerId: "fixture-owner", memberId, stateDir: root, model: "gpt-5.4", baseUrl: provider.url });
          sessions.set(threadId, result.checkpoint);
          const messageId = runId + "/reply";
          subscriber.next({ type: E.TEXT_MESSAGE_START, messageId, role: "assistant" });
          subscriber.next({ type: E.TEXT_MESSAGE_CONTENT, messageId, delta: result.text });
          subscriber.next({ type: E.TEXT_MESSAGE_END, messageId });
          subscriber.next({ type: E.RUN_FINISHED, threadId, runId });
        }
        void respond().catch(() => subscriber.next({ type: E.RUN_ERROR, message: signal.aborted ? "Cancelled" : "Native turn failed" }))
          .finally(() => subscriber.complete());
      });
    },
    async close() { await provider.close(); await rm(root, { recursive: true, force: true }); },
  };
}
