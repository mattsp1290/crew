import type { Pool } from "pg";
import type { DelegationReconciler } from "./delegation-control.ts";

const passEveryMs = 2_000, healthyForMs = 60_000;

export function startDelegationReconciliation(control: Pick<DelegationReconciler, "flush">, pool: Pool) {
  let lastHealthyAt: number | undefined;
  let pass: Promise<void> | undefined;
  const failed = (source: "pool" | "reconciliation") => () => {
    lastHealthyAt = undefined;
    console.error(JSON.stringify({ event: "delegation_control_failed", source }));
  };
  pool.on("error", failed("pool"));
  const run = () => {
    if (pass) return;
    pass = control.flush().then(result => {
      const healthy = !result.children.some(child => child.wake.kind === "unavailable");
      lastHealthyAt = healthy ? performance.now() : undefined;
      if (!healthy || result.children.some(child => child.settlement === "pending")) {
        console.error(JSON.stringify({ event: "delegation_control_pending", ...result }));
      }
    }, failed("reconciliation")).finally(() => { pass = undefined; });
  };
  run();
  const timer = setInterval(run, passEveryMs);
  return {
    healthy: () => lastHealthyAt !== undefined && performance.now() - lastHealthyAt <= healthyForMs,
    stop(): Promise<void> {
      clearInterval(timer);
      return pass ?? Promise.resolve();
    },
  };
}
