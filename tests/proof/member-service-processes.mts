import assert from "node:assert/strict";
import { z } from "zod";

export const positiveGroupSchema = z.number().int().positive();
export const rawProcessSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(),
  group: z.number().int().nonnegative(), startTime: z.string().regex(/^\d+$/), state: z.string() });
export const positiveGroupProcessSchema = rawProcessSchema.extend({ group: positiveGroupSchema }).brand<"PositiveGroupProcess">();
export type RawProcess = z.infer<typeof rawProcessSchema>;
export type PositiveGroupProcess = z.infer<typeof positiveGroupProcessSchema>;

export function parseProcess(pid: number, text: string): RawProcess {
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return rawProcessSchema.parse({ pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), startTime: fields[19] });
}
export const processKey = (proc: Pick<RawProcess, "pid" | "startTime">) => `${proc.pid}:${proc.startTime}`;
export const ownedProcessMapSchema = z.map(z.string(), positiveGroupProcessSchema).superRefine((owned, context) => {
  for (const [key, proc] of owned) if (key !== processKey(proc)) {
    context.addIssue({ code: "custom", message: "Owned process key disagrees with its identity" });
  }
});

export function selectOwnedProcesses(owned: ReadonlyMap<string, PositiveGroupProcess>, table: readonly RawProcess[]) {
  const nextOwned = new Map(owned);
  const live = table.filter(proc => proc.state !== "Z" && proc.state !== "X");
  const anchors = live.filter(proc => owned.has(processKey(proc)));
  for (const proc of anchors) assert.equal(proc.group, owned.get(processKey(proc))?.group, "Owned process changed its group");
  const related = new Set(anchors.map(proc => proc.pid));
  const groups = new Set(anchors.map(proc => proc.group));
  for (let size = -1; size !== related.size;) {
    size = related.size;
    for (const proc of live) if (related.has(proc.parent) || groups.has(proc.group)) {
      related.add(proc.pid);
      if (proc.group === proc.pid) groups.add(proc.group);
    }
  }
  for (const proc of live) if (related.has(proc.pid)) {
    const positive = positiveGroupProcessSchema.parse(proc);
    assert.ok(groups.has(positive.group), "Descendant joined a process group without an owned leader");
    nextOwned.set(processKey(positive), positive);
  }
  return { live, owned: nextOwned };
}
