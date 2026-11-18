import { testDatabaseName } from "./database-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { registerProfiles } from "../../src/service/deployment.ts";
import { MemberStore } from "../../src/service/store.ts";

test("migration 011 preserves existing members, admits native Codex volumes, and keeps Pi delegation exclusive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "birb-codex-volume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = new URL(process.env.BIRBCREW_TEST_DATABASE_URL!);
  const admin = new Pool({ connectionString: source.href });
  const database = testDatabaseName("upgrade_");
  await admin.query("CREATE DATABASE " + database);
  source.pathname = "/" + database;
  const pool = new Pool({ connectionString: source.href });
  try {
    const sql = new URL("../../src/service/sql/", import.meta.url);
    await pool.query("CREATE SCHEMA birbcrew_ts");
    await pool.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
    for (const file of (await readdir(sql)).sort()) {
      const version = Number(file.split("-")[0]);
      if (version > 10) continue;
      await pool.query(await readFile(new URL(file, sql), "utf8"));
      await pool.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [version]);
    }
    const store = new MemberStore(pool);
    const ownerId = randomUUID(), requestId = randomUUID();
    const old = { ownerId, requestId, engine: "claude" as const, profile: "legacy" };
    // Seed as the v10 service wrote it; current spawn also appends an audit row this schema lacks.
    const { rows: [member] } = await pool.query(`INSERT INTO birbcrew_ts.members (owner_id,spawn_request_id,engine,profile)
      VALUES ($1,$2,$3,$4) RETURNING owner_id AS "ownerId",member_id AS "memberId",engine,profile`,
      [ownerId, requestId, old.engine, old.profile]);
    const insert = (engine: string, volume: string | null, delegate = false) =>
      pool.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,volume,delegate_task) VALUES ('legacy',$1,'fixture',$2,$3)",
        [engine, volume, delegate]);
    const volume = randomUUID();
    await insert("claude", volume);
    await insert("pi", null, true);
    await assert.rejects(insert("codex", randomUUID()), { code: "23514" });

    await Promise.all([store.migrate(), store.migrate()]);
    assert.deepEqual(await store.spawn(old), { ...member, subagents: { mode: "legacy", targets: [] } });
    assert.equal((await pool.query("SELECT volume FROM birbcrew_ts.profiles WHERE engine='claude'")).rows[0].volume, volume);
    await assert.rejects(store.spawn({ ...old, engine: "codex" }), { code: "conflict" });
    await assert.rejects(insert("codex", null), { code: "23514" });
    await assert.rejects(insert("codex", randomUUID(), true), { code: "23514" });
    await assert.rejects(insert("unknown", null), { code: "23514" });
    await insert("codex", randomUUID());
    const config = { accountId: "fixture", claude: { apiKey: "fixture", model: "fixture" },
      codex: { model: "fixture", baseUrl: "http://127.0.0.1" } };
    const profiles = new Map([["registered", config]]);
    await registerProfiles(pool, profiles, directory);
    const bindings = await pool.query("SELECT engine,volume FROM birbcrew_ts.profiles WHERE name='registered' ORDER BY engine");
    assert.deepEqual(bindings.rows, [
      { engine: "claude", volume: await readFile(join(directory, ".birbcrew-volume"), "utf8") },
      { engine: "codex", volume: await readFile(join(directory, "codex", ".birbcrew-volume"), "utf8") },
    ]);
    assert.notEqual(bindings.rows[0].volume, bindings.rows[1].volume);
    await assert.rejects(registerProfiles(pool, profiles, join(directory, "other")), /another account or native state volume/);
    const codex = await store.spawn({ ...old, requestId: randomUUID(), engine: "codex" });
    assert.equal(codex.engine, "codex");
    await assert.rejects(pool.query("UPDATE birbcrew_ts.members SET engine='pi' WHERE member_id=$1", [codex.memberId]), { code: "23514" });
  } finally {
    await pool.end();
    await admin.query("DROP DATABASE " + database);
    await admin.end();
  }
});
