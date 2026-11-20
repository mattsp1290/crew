import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { codexProcessChannel } from "../../src/service/codex.ts";
import { exitGraceMs } from "../../src/service/codex-subscription.ts";

test("a descendant that keeps the app-server pipes open does not hold the channel or drop a late frame", async () => {
  const child = spawn("sh", ["-c", "(sleep 0.2; printf frame-after-exit; sleep 20) >&1 0<&- &\nexit 0"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const channel = codexProcessChannel(child);
  const received: Buffer[] = [];
  let ended = 0;
  channel.listen({
    data: (bytes) => received.push(Buffer.from(bytes)),
    diagnostic: () => {},
    ended: () => { ended += 1; },
  });
  const started = Date.now();
  await new Promise((resolve) => child.once("exit", resolve));
  const write = channel.write(Buffer.from("late"), AbortSignal.timeout(exitGraceMs + 2_000));
  await assert.rejects(write);
  assert.equal(ended, 1);
  assert.ok(Buffer.concat(received).includes(Buffer.from("frame-after-exit")));
  assert.equal(child.stdout?.destroyed, true);
  assert.equal(child.stderr?.destroyed, true);
  assert.ok(Date.now() - started < 10_000);
  child.kill("SIGKILL");
});

test("disposing the listener during the exit grace still delivers the late frame", async () => {
  const child = spawn("sh", ["-c", "(sleep 0.2; printf frame-after-exit; sleep 20) >&1 0<&- &\nexit 0"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const channel = codexProcessChannel(child);
  const received: Buffer[] = [];
  let ended = 0;
  const detach = channel.listen({
    data: (bytes) => received.push(Buffer.from(bytes)),
    diagnostic: () => {},
    ended: () => { ended += 1; },
  });
  await new Promise((resolve) => child.once("exit", resolve));
  const write = channel.write(Buffer.from("late"), AbortSignal.timeout(exitGraceMs + 2_000));
  detach();
  await assert.rejects(write);
  assert.equal(ended, 1);
  assert.ok(Buffer.concat(received).includes(Buffer.from("frame-after-exit")));
  assert.equal(child.stdout?.destroyed, true);
  assert.equal(child.stderr?.destroyed, true);
  child.kill("SIGKILL");
});
