import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { z } from "zod";

const project = fileURLToPath(new URL("../../", import.meta.url));

async function fixture(t: TestContext, mode: "valid" | "missing" | "version" | "hang" | "network" | "early-exit" | "held-pipe" | "group-helper") {
  const root = await mkdtemp(join(tmpdir(), "cursor-policy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(project, "src"), join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await mkdir(join(root, "node_modules/@cursor"), { recursive: true });
  await mkdir(join(root, "node_modules/@operatorworks"), { recursive: true });
  for (const entry of await readdir(join(project, "node_modules"))) {
    if (entry === "@cursor" || entry === "@operatorworks") continue;
    await symlink(join(project, "node_modules", entry), join(root, "node_modules", entry), "dir");
  }
  const sdk = join(root, "node_modules/@cursor/sdk");
  const adapter = join(root, "node_modules/@operatorworks/switchboard");
  await mkdir(sdk);
  await cp(join(project, "node_modules/@operatorworks/switchboard"), adapter, { recursive: true });
  await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: mode === "version" ? "1.4.3" : "1.4.2", type: "module", exports: "./index.js" }));
  const observed = join(root, "observed.json");
  const invoked = join(root, "agent-invoked");
  await writeFile(join(sdk, "index.js"), `
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(observed)},JSON.stringify({env:process.env,cwd:process.cwd()}));
${mode === "hang" ? "await new Promise(()=>{setInterval(()=>{},1000)});" : ""}
${mode === "network" ? "await fetch('https://127.0.0.1:1/forbidden');" : ""}
${mode === "early-exit" ? "process.exit(0);" : ""}
${mode === "held-pipe" ? "const {spawn}=await import('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),7000)'],{detached:true,stdio:['ignore','inherit','ignore']}).unref();process.exit(0);" : ""}
${mode === "group-helper" ? `const {spawn}=await import('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(observed + ".late")},'survived')},500)`)}],{stdio:'ignore'}).unref();` : ""}
const forbidden=()=>{writeFileSync(${JSON.stringify(invoked)},'unexpected');throw new Error('inference forbidden')};
export class Agent {static create=forbidden;static resume=forbidden;}
export const Cursor={models:{list:forbidden}};
export class JsonlLocalAgentStore {constructor(){forbidden();}}
export const emptyFs=${mode === "missing" ? "undefined" : "()=>({read(){},list(){},write(){},delete(){}})"};
`);
  await writeFile(join(adapter, "dist/cursor/index.js"), "export function createCursorTextRuntime(){throw new Error('agent construction forbidden')}\n");
  const module: typeof import("../../src/service/cursor-policy-support.ts") = await import(pathToFileURL(join(root, "src/service/cursor-policy-support.ts")).href);
  return { root, state: join(root, "state"), observed, invoked, support: module.assertCursorPolicySupport };
}

test("the probe is credential-free, export-only and cleaned after success", async (t) => {
  const f = await fixture(t, "valid");
  const inherited = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: "/usr/bin:/bin", HOME: "/synthetic-parent-home",
    CURSOR_API_KEY: "parent-key-secret", NODE_OPTIONS: "--require /secret/preload.js",
    HTTP_PROXY: "http://user:proxy-secret@127.0.0.1:9", HTTPS_PROXY: "http://user:proxy-secret@127.0.0.1:9",
    http_proxy: "http://user:proxy-secret@127.0.0.1:9", https_proxy: "http://user:proxy-secret@127.0.0.1:9",
    DATABASE_URL: "parent-database-secret", SSL_CERT_FILE: "/parent/secret-ca", PROFILE_MODULE: "/parent/profiles.ts",
  });
  try { await f.support(f.state); }
  finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(inherited, key)) delete process.env[key];
    Object.assign(process.env, inherited);
  }
  const observation = z.object({ cwd: z.string(), env: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(f.observed, "utf8")));
  const privateRoot = observation.cwd;
  assert.ok(privateRoot.startsWith(await realpath(f.state) + "/.cursor-policy-"));
  // CoreFoundation adds its own encoding scalar on Darwin; Linux has only the literal environment.
  if (process.platform === "darwin" && observation.env.__CF_USER_TEXT_ENCODING !== undefined) {
    assert.match(observation.env.__CF_USER_TEXT_ENCODING, /^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/);
    delete observation.env.__CF_USER_TEXT_ENCODING;
  }
  assert.deepEqual(observation.env, {
    HOME: privateRoot, TMPDIR: privateRoot, CURSOR_DATA_DIR: privateRoot,
    PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC",
  });
  await assert.rejects(access(f.invoked));
  assert.deepEqual(await readdir(f.state), []);
});

for (const mode of ["missing", "network", "early-exit"] as const) {
  test(`an unsupported ${mode} probe fails with a fixed diagnostic and cleans up`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(f.support(f.state), { code: "cursor_policy_unsupported", message: "Cursor text policy is unsupported" });
    await assert.rejects(access(f.invoked));
    assert.deepEqual(await readdir(f.state), []);
  });
}

test("a hanging SDK import is bounded, awaited and removed", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "hang");
  const started = Date.now();
  await assert.rejects(f.support(f.state), { code: "cursor_policy_unsupported" });
  assert.ok(Date.now() - started < 12_000);
  assert.deepEqual(await readdir(f.state), []);
});

test("a detached fixture holding stdout cannot extend the probe deadline", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "held-pipe");
  const started = Date.now();
  try {
    await assert.rejects(f.support(f.state), { code: "cursor_policy_unsupported" });
    assert.ok(Date.now() - started < 6_500);
    assert.deepEqual(await readdir(f.state), []);
  } finally {
    // This credential-free fixture exits itself after seven seconds; do not leave it behind.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 7_500 - (Date.now() - started))));
  }
});

test("a successful probe terminates its remaining helper group", async (t) => {
  const f = await fixture(t, "group-helper");
  await f.support(f.state);
  await new Promise(resolve => setTimeout(resolve, 800));
  await assert.rejects(access(f.observed + ".late"));
  assert.deepEqual(await readdir(f.state), []);
});

test("the adapter cannot resolve a different nested SDK", async (t) => {
  const f = await fixture(t, "valid");
  const nested = join(f.root, "node_modules/@operatorworks/switchboard/node_modules/@cursor/sdk");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.4.3", main: "index.js" }));
  await writeFile(join(nested, "index.js"), "throw new Error('nested SDK must not load');\n");
  await assert.rejects(f.support(f.state), { code: "cursor_policy_unsupported" });
  await assert.rejects(access(f.state));
  await assert.rejects(access(f.observed));
});

test("unsupported installed tuples prevent registration before SQL or volume markers", async (t) => {
  const f = await fixture(t, "version");
  const { registerProfiles } = await import(pathToFileURL(join(f.root, "src/service/deployment.ts")).href);
  const pool = new Pool({ connectionString: "postgresql://fixture:fixture@127.0.0.1:1/fixture" });
  t.after(() => pool.end());
  let queries = 0;
  pool.query = () => { queries += 1; throw new Error("SQL must not be reached"); };
  pool.connect = () => { queries += 1; throw new Error("SQL must not be reached"); };
  const config = new Map([["cursor.v1", { accountId: "synthetic", cursor: { model: "grok-4.7", apiKey: "synthetic-key", cwd: "/metadata/legacy" } }]]);
  await assert.rejects(registerProfiles(pool, config, f.state), { code: "cursor_policy_unsupported" });
  assert.equal(queries, 0);
  await assert.rejects(access(f.state));
  await assert.rejects(access(f.observed));
});

test("runner re-registration does not repeat the startup Cursor import probe", async (t) => {
  const f = await fixture(t, "version");
  const { registerProfiles } = await import(pathToFileURL(join(f.root, "src/service/deployment.ts")).href);
  const pool = new Pool({ connectionString: "postgresql://fixture:fixture@127.0.0.1:1/fixture" });
  t.after(() => pool.end());
  let queries = 0;
  pool.query = () => { queries += 1; throw new Error("fixture database reached"); };
  pool.connect = () => { queries += 1; throw new Error("fixture database reached"); };
  const config = new Map([["cursor.v1", { accountId: "synthetic", cursor: { model: "grok-4.7", apiKey: "synthetic-key", cwd: "/metadata/legacy" } }]]);
  await assert.rejects(registerProfiles(pool, config, f.state, undefined, { probeCursorPolicy: false }), { message: "fixture database reached" });
  assert.ok(queries > 0);
  await assert.rejects(access(f.observed));
});
