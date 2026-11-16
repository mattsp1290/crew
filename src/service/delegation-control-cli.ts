import { json } from "node:stream/consumers";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { DelegationControl, type ChildWorkflowControl } from "./delegation-control.ts";
import { TemporalDelegationWorkflows } from "./delegation-control-workflows.ts";
import { temporalConnectionOptions, temporalSettings } from "./temporal-config.ts";

const [operation, ...args] = process.argv.slice(2);
let pool: Pool | undefined;
let connection: Connection | undefined;
try {
  if (!process.env.BIRBCREW_DATABASE_URL || !["change", "status", "drain"].includes(operation)
    || args.length !== (operation === "drain" ? 1 : 0)) throw new Error("usage");
  pool = new Pool({ connectionString: process.env.BIRBCREW_DATABASE_URL, connectionTimeoutMillis: 5000,
    statement_timeout: 10000, query_timeout: 12000 });
  let adapter: Promise<TemporalDelegationWorkflows> | undefined;
  const workflows = () => adapter ??= (async () => {
    const temporal = temporalSettings(process.env);
    connection = await Connection.connect({ ...await temporalConnectionOptions(temporal), connectTimeout: 3000 });
    return new TemporalDelegationWorkflows(new Client({ connection, namespace: temporal.namespace }));
  })();
  const lazy: ChildWorkflowControl = {
    signalDecision: async key => (await workflows()).signalDecision(key),
    observe: async key => (await workflows()).observe(key),
    observeParentResult: async key => (await workflows()).observeParentResult(key),
  };
  const control = new DelegationControl({ pool, workflows: lazy });
  const result = operation === "change" ? await control.change(await json(process.stdin))
    : operation === "status" ? await control.status() : await control.drain(args[0]);
  console.log(JSON.stringify(result));
} catch {
  console.error(JSON.stringify({ status: "failed", message: "Delegation control operation refused or unavailable. Inspect private operator diagnostics." }));
  process.exitCode = 1;
} finally {
  try {
    try { await connection?.close(); } finally { await pool?.end(); }
  } catch {
    console.error(JSON.stringify({ status: "failed", message: "Delegation control cleanup failed. Inspect private operator diagnostics." }));
    process.exitCode = 1;
  }
}
