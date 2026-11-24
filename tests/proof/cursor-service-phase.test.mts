import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./cursor-restricted-text.mts", import.meta.url));
for (const phase of ["complete", "native-admitted", "uncertain", "erased"]) {
  for (const requests of [undefined, []]) {
    test(`${phase} cannot pass without an actual request identity (${requests === undefined ? "missing" : "empty"})`, async () => {
      const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
        const child = execFile(process.execPath, [script], { timeout: 5_000, env: { PATH: process.env.PATH } },
          (error, stdout, stderr) => resolve({ error, stdout, stderr }));
        assert.ok(child.stdin);
        child.stdin.end(JSON.stringify({ phase, token: "synthetic", otherToken: "other", seed: "a".repeat(32),
          memberId: randomUUID(), negativeUrl: "https://canary.invalid/negative", ...(requests === undefined ? {} : { requests }) }));
      });
      assert.ok(result.error);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).code, "cursor_service_qualification_failed");
    });
  }
}
