import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { historyFromJSON } from "@temporalio/common/proto-utils";
import { Worker } from "@temporalio/worker";
import { z } from "zod";

// The proof starts this process in a separate network namespace with loopback down.
assert.deepEqual(networkInterfaces(), {}, "Offline replay needs an isolated network namespace");
let activityLoads = 0;
const allowed = new Set(["workflow.ts", "queues.ts", "domain.ts", "limits.ts", "deferral.ts", "failure-type.ts", "child-target.ts"]);
const product = new URL("../../src/service/", import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url.startsWith(product) && !allowed.has(url.slice(product.length))) {
      activityLoads++;
      throw new Error("Offline replay attempted to load a service implementation");
    }
    return next(url, context);
  },
});
const directory = process.argv[2];
const ids = z.array(z.string().regex(/^birbcrew-ts\/(child\/[\da-f-]{36}|member\/[\da-f-]{36}\/conversation\/[\da-f-]{36})$/)).nonempty()
  .parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
async function* histories() {
  for (const [index, workflowId] of ids.entries()) {
    const history = historyFromJSON(JSON.parse(await readFile(join(directory, index + ".json"), "utf8")));
    yield { workflowId, history };
  }
}
const verified: string[] = [];
for await (const result of Worker.runReplayHistories({
  workflowsPath: fileURLToPath(new URL("../../src/service/workflow.ts", import.meta.url)),
}, histories())) {
  if (result.error) throw result.error;
  verified.push(result.workflowId);
}
assert.deepEqual(verified.sort(), [...ids].sort());
assert.equal(activityLoads, 0);
console.log(JSON.stringify({ replayed: verified.length, activityLoads }));
