import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { json } from "node:stream/consumers";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { MemberClient } from "./client.ts";
import { MemberStore } from "./store.ts";
import { spawnRequestSchema } from "./capabilities.ts";
import { flushTelemetry } from "./telemetry.ts";
import { temporalConnectionOptions, temporalSettings } from "./temporal-config.ts";

async function main() {
  const [operation, configPath] = process.argv.slice(2);
  if (!["spawn", "open", "turn", "pending", "decide", "cancel-pending", "worker", "erasure-inventory"].includes(operation)) {
    throw new Error("Use spawn, open, turn, pending, decide, cancel-pending, or worker <trusted-profile-module>");
  }
  const url = process.env.BIRBCREW_DATABASE_URL;
  if (!url) throw new Error("Set BIRBCREW_DATABASE_URL to the private TypeScript application database");
  const temporal = temporalSettings(process.env);
  const pool = new Pool({ connectionString: url });
  const store = new MemberStore(pool);
  try {
    await store.migrate();
    if (operation === "worker") {
      const stateDir = process.env.BIRBCREW_STATE_DIR, heartbeat = process.env.BIRBCREW_WORKER_HEARTBEAT_FILE;
      if (!stateDir || !configPath) throw new Error("Supply BIRBCREW_STATE_DIR and the trusted provider module path");
      if (heartbeat !== undefined) {
        if (!isAbsolute(heartbeat)) throw new Error("BIRBCREW_WORKER_HEARTBEAT_FILE must be an absolute path");
        await access(dirname(heartbeat), constants.W_OK).catch(() => {
          throw new Error("BIRBCREW_WORKER_HEARTBEAT_FILE must be in an existing writable directory");
        });
      }
      // A malformed price table stops the worker here, naming the setting, before its supervisor reads it.
      (await import("./usage-prices.ts")).operatorPrices();
      const { runMemberWorker } = await import("./worker.ts");
      const { registerProfiles } = await import("./deployment.ts");
      const { controlPoolBounds } = await import("./delegation-control.ts");
      const { profiles, close } = await import(pathToFileURL(resolve(configPath)).href);
      const controlPool = new Pool({ connectionString: url, max: 2, ...controlPoolBounds });
      try {
        await registerProfiles(pool, profiles, stateDir);
        await runMemberWorker({ store, temporal, profiles, configPath: resolve(configPath), stateDir, heartbeat, controlPool });
      } finally {
        try { await controlPool.end(); }
        finally {
          try { await close?.(); } finally { await flushTelemetry(); }
        }
      }
      return;
    }
    const input: unknown = operation==="erasure-inventory" ? undefined : await json(process.stdin);
    if (operation === "spawn") {
      const spawn = spawnRequestSchema.parse(input);
      const registered = await pool.query("SELECT 1 FROM birbcrew_ts.profiles WHERE engine=$1 AND name=$2",
        [spawn.engine, spawn.profile]);
      if (!registered.rowCount) throw new Error("Start a worker with this engine and profile before spawning a member");
      console.log(JSON.stringify(await store.spawn(spawn)));
      return;
    }
    const connection = await Connection.connect(await temporalConnectionOptions(temporal));
    try {
      const members = new MemberClient(store, new Client({ connection, namespace: temporal.namespace }));
      if(operation==="erasure-inventory"){
        const {runErasureInventoryCommand}=await import("./erasure-inventory.ts");
        console.log(JSON.stringify(await runErasureInventoryCommand(store,new Client({connection,namespace:temporal.namespace}),process.argv.slice(3))));
        return;
      }
      let result;
      switch (operation) {
        case "open": result = await members.open(input); break;
        case "pending": result = await members.pending(input); break;
        case "decide": result = { decision: await members.decide(input) }; break;
        case "cancel-pending":
          await members.cancelPending(input);
          result = { cancelled: true };
          break;
        default: result = { text: await members.submit(input) };
      }
      console.log(JSON.stringify(result));
    } finally {
      await connection.close();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Member command failed");
  // A failed Worker.create (for example a missing namespace) leaves Temporal native handles that keep Node alive.
  process.exit(1);
});
