import { json } from "node:stream/consumers";
import { Client, Connection } from "@temporalio/client";
import { Pool } from "pg";
import { changeControl, controlPoolBounds, controlState, drainDelegation, type ChildWorkflowControl } from "./delegation-control.ts";
import { TemporalDelegationWorkflows } from "./delegation-control-workflows.ts";
import { temporalConnectionOptions, temporalSettings } from "./temporal-config.ts";

const [operation, ...args] = process.argv.slice(2);
let pool: Pool | undefined;
let connection: Connection | undefined;
// Connects on the first observation only, so an empty cohort needs no Temporal, and a failed connection
// is kept: every observation reports unavailable and drain still prints its report and exits 0.
function lazyWorkflows(): ChildWorkflowControl {
  let adapter: Promise<TemporalDelegationWorkflows> | undefined;
  const workflows = () => adapter ??= (async () => {
    const temporal = temporalSettings(process.env);
    connection = await Connection.connect({ ...await temporalConnectionOptions(temporal), connectTimeout: 3000 });
    return new TemporalDelegationWorkflows(new Client({ connection, namespace: temporal.namespace }));
  })();
  return {
    signalDecision: async key => (await workflows()).signalDecision(key),
    observe: async key => (await workflows()).observe(key),
    observeParentResult: async key => (await workflows()).observeParentResult(key),
  };
}
try {
  if (!process.env.BIRBCREW_DATABASE_URL || !["change", "status", "drain"].includes(operation)
    || args.length !== (operation === "drain" ? 1 : 0)) throw new Error("usage");
  pool = new Pool({ connectionString: process.env.BIRBCREW_DATABASE_URL, ...controlPoolBounds });
  const result = operation === "change" ? await changeControl(pool, await json(process.stdin))
    : operation === "status" ? await controlState(pool) : await drainDelegation({ pool, workflows: lazyWorkflows() }, args[0]);
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
