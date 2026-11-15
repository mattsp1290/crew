import assert from "node:assert/strict";
import { boundedCommand, completedCommandFailure, describe, now } from "./member-service-diagnostics.mts";

export type ContainerAllocation = { kind: "not-started" } | { kind: "pending" } | { kind: "settled"; container: string };

export function isMissingDockerInspection(failure: ReturnType<typeof completedCommandFailure>, fullId: string) {
  return failure?.code === 1 && failure.diagnostics.trim() === "Error: No such object: " + fullId;
}
export async function disposeContainer(evidence: { container: string; allocation: ContainerAllocation }, deadline: number) {
  assert.match(evidence.container, /^birb-proof-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  if (evidence.allocation.kind === "settled") assert.match(evidence.allocation.container, /^[a-f0-9]{64}$/);
  if (evidence.allocation.kind === "not-started") return;
  const selectors = ["name=^/" + evidence.container + "$", ...(evidence.allocation.kind === "settled" ? ["id=" + evidence.allocation.container] : [])];
  const query = async () => {
    const results = await Promise.all(selectors.map(selector => boundedCommand("docker", ["ps", "--no-trunc", "-aq", "--filter", selector],
      Math.min(deadline, now() + 1_500))));
    return results.flatMap(result => {
      assert.ok(result.stdout.kind === "complete", "Docker disposal query stdout was truncated");
      const ids = result.stdout.text.trim() ? result.stdout.text.trim().split(/\s+/) : [];
      for (const id of ids) assert.match(id, /^[a-f0-9]{64}$/, "Docker query returned an invalid identity");
      return ids;
    });
  };
  const found = new Set(await query());
  if (evidence.allocation.kind === "settled") for (const foundId of found)
    assert.equal(foundId, evidence.allocation.container, "Allocated container identity changed");
  for (const foundId of found) {
    let inspected: Awaited<ReturnType<typeof boundedCommand>>;
    try {
      inspected = await boundedCommand("docker", ["inspect", "--format",
        '{{.Id}} {{.Name}} {{index .Config.Labels "birb-proof-owner"}}', foundId], Math.min(deadline, now() + 1_500));
    } catch (error) {
      if (evidence.allocation.kind !== "settled" || !isMissingDockerInspection(completedCommandFailure(error), foundId)) throw error;
      try { assert.deepEqual(await query(), [], "Exact owned container remains after missing inspection"); }
      catch (observationError) { throw new AggregateError([error, observationError],
        "Docker absence unproven after missing inspection\n" + [error, observationError].map(describe).join("\n")); }
      console.error(`Docker inspection target ${foundId} disappeared; exact-name and settled-ID queries are empty`);
      continue;
    }
    assert.ok(inspected.stdout.kind === "complete", "Docker disposal inspection stdout was truncated");
    const fields = inspected.stdout.text.trim().split(/\s+/);
    assert.equal(fields.length, 3, "Unexpected Docker inspection fields");
    const [id, name, marker] = fields;
    assert.ok(id && /^[a-f0-9]{64}$/.test(id), "Container identity missing");
    assert.equal(id, foundId, "Inspected container identity changed");
    assert.equal(name, "/" + evidence.container, "Container name disagrees with ownership");
    assert.equal(marker, evidence.container, "Container label disagrees with ownership");
    if (evidence.allocation.kind === "settled") assert.equal(id, evidence.allocation.container, "Allocated container identity changed");
    await boundedCommand("docker", ["rm", "-f", id], Math.min(deadline, now() + 2_000));
  }
  const remaining = await query();
  assert.deepEqual(remaining, [], "Exact owned container remains");
  assert.notEqual(evidence.allocation.kind, "pending", "Docker allocation pending; eventual absence unknown");
}
