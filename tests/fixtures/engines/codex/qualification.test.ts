import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { z } from "zod";
import { startProvider } from "./provider.mts";

const callMessage = z.object({
  kind: z.literal("call"),
  threadId: z.uuid(),
  arguments: z.strictObject({ operation_id: z.uuid(), note: z.literal("private fixture note") }),
  resume: z.object({ version: z.literal(2), engine: z.literal("codex") }).passthrough(),
});

for (const decision of ["approve", "deny", "interrupt"] as const) {
  test("native Codex host tool " + decision, { timeout: 45_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "birb-codex-tool-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = new DatabaseSync(join(root, "operations.sqlite"));
    t.after(() => db.close());
    db.exec("CREATE TABLE effects (operation_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)");
    const effects = () => db.prepare("SELECT receipt FROM effects").all().map((row) => row.receipt);
    const provider = await startProvider();
    t.after(provider.close);
    const operation = randomUUID(), receipt = randomUUID();
    const ownerId = "fixture-owner", memberId = randomUUID(), threadId = randomUUID();
    let proposals = 0;
    function worker(prompt: string, checkpoint?: unknown) {
      const child = fork(new URL("./qualification-worker.mts", import.meta.url), [
        root, provider.url, ownerId, memberId, threadId, randomUUID(), prompt, ...(checkpoint ? [JSON.stringify(checkpoint)] : []),
      ], { env: { PATH: process.env.PATH }, detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
      const exit = once(child, "exit");
      const messages: unknown[] = [];
      child.on("message", (value) => messages.push(value));
      async function take(kind: string) {
        for (;;) {
          const found = messages.find((value) => value && typeof value === "object" && "kind" in value && value.kind === kind);
          if (found) return found;
          await once(child, "message");
        }
      }
      async function stop() {
        try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await exit;
      }
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) await stop(); });
      return { child, exit, take, stop, pid: child.pid! };
    }
    const first = worker("record " + operation);
    const call = callMessage.parse(await first.take("call"));
    assert.equal(call.arguments.operation_id, operation);
    proposals++;
    assert.deepEqual(effects(), []);
    if (decision === "interrupt") {
      await first.stop();
      const second = worker("continue", call.resume);
      assert.equal(z.object({ kind: z.literal("thread"), threadId: z.uuid() }).parse(await second.take("thread")).threadId, call.threadId);
      assert.equal((await second.exit)[0], 0);
    } else {
      if (decision === "approve") db.prepare("INSERT INTO effects VALUES (?,?)").run(operation, receipt);
      const text = decision === "approve" ? String(effects()[0]) : "request denied";
      first.child.send({ text, isError: decision !== "approve" });
      assert.equal((await first.exit)[0], 0);
    }
    assert.equal(proposals, 1);
    assert.deepEqual(effects(), decision === "approve" ? [receipt] : []);
    const outputs = provider.requests.flatMap((req) => req.filter((item) => item.type === "function_call_output" && item.call_id === "call_" + operation));
    assert.equal(outputs.length, 1);
    assert.ok(JSON.stringify(outputs[0].output).includes(decision === "approve" ? receipt : decision === "deny" ? "request denied" : "aborted"));
    for (let i = 0; i < 50; i++) {
      try { process.kill(-first.pid, 0); } catch { return; }
      await delay(20);
    }
    assert.fail("Codex process group is still present");
  });
}
