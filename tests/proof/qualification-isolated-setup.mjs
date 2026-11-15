#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.env.BIRBCREW_PROOF_ARTIFACTS;
assert.ok(root && isAbsolute(root), "Expected an absolute qualification artifact directory");
mkdirSync(root, { recursive: true, mode: 0o700 });
const [command, ...args] = process.argv.slice(2);
if (command === "identity-before" || command === "identity-after") {
  assert.equal(args.length, 0);
  const paths = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1024 * 1024 }).toString().split("\0").filter(Boolean).sort();
  assert.ok(paths.length > 0 && paths.length <= 4096, "Tracked source count exceeded its bound");
  const source = {
    head: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    files: paths.map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })),
  };
  const json = JSON.stringify(source, null, 2);
  assert.ok(Buffer.byteLength(json) <= 1024 * 1024, "Source identity exceeded its bound");
  const phase = command === "identity-before" ? "before" : "after";
  writeFileSync(join(root, `source-${phase}.json`), json, { mode: 0o600, flag: "wx" });
  if (phase === "after") assert.deepEqual(source, JSON.parse(readFileSync(join(root, "source-before.json"), "utf8")), "Tracked source bytes or HEAD changed");
  console.log(`qualification source identity ${phase} recorded`);
} else {
  assert.equal(command, "ci", "Qualification npm stub accepts only ci");
  assert.equal(args.length, 0, "Qualification npm stub accepts no extra arguments");
  assert.equal(existsSync("node_modules/zod"), false, "Setup probe must precede dependency installation");
  const mode = process.env.QUALIFICATION_MODE;
  assert.ok(mode === "early-setup-failure" || mode === "setup-cancel", "Expected a setup qualification mode");
  writeFileSync(join(root, "setup-ready.json"), JSON.stringify({ mode, pid: process.pid, utc: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  console.log(`qualification synthetic setup ready ${mode}`);
  if (mode === "early-setup-failure") process.exit(37);
  await delay(240_000);
  assert.fail("Qualification setup cancellation was not received within four minutes");
}
