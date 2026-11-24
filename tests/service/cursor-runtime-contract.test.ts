import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertCursorPolicySupport } from "../../src/service/cursor-policy-support.ts";

const run = promisify(execFile);
test("the installed candidate passes the real credential-free export probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crew-cursor-real-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assertCursorPolicySupport(root);
  assert.deepEqual(await readdir(root), []);
});
for (const mode of ["valid", "missing"]) {
  test(`production Cursor SDK boundary (${mode}) runs in an isolated child`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "crew-cursor-contract-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await run(process.execPath, [fileURLToPath(new URL("./cursor-runtime-contract-child.ts", import.meta.url)), mode, root], {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC", HOME: root, TMPDIR: root,
        CURSOR_API_KEY: "parent-credential", DATABASE_URL: "parent-database-credential",
        CURSOR_BACKEND_URL: "https://parent-endpoint.invalid", CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: "parent-catalog",
        CURSOR_RIPGREP_PATH: "/parent/helper",
      }, timeout: 20_000,
    });
    assert.equal(result.stdout, "production-cursor-boundary-verified\n");
    if (mode === "missing") assert.match(result.stderr, /cursor_policy_unsupported/);
    for (const sentinel of ["parent-credential", "parent-database-credential", "parent-endpoint", "parent-catalog", "synthetic-sdk-key", "synthetic input"]) {
      assert.equal(result.stderr.includes(sentinel), false);
    }
  });
}
