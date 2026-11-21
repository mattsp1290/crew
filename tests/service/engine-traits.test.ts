import assert from "node:assert/strict";
import test from "node:test";
import { engineSchema, engineTraits, isTextEngine } from "../../src/service/domain.ts";

// isTextEngine drives the text protocol (one-turn budget, environment scrub, reconcile, workflow patch);
// engineTraits drives the capability gates. A new engine must agree on both, or the workflow would
// treat it as native while the gates treat it as text.
test("engine traits and the text-engine protocol agree for every engine", () => {
  for (const engine of engineSchema.options) {
    const traits = engineTraits[engine];
    for (const [name, value] of Object.entries(traits)) assert.equal(value, !isTextEngine(engine), `${engine}.${name}`);
  }
});
