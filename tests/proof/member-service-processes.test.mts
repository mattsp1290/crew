import assert from "node:assert/strict";
import { test } from "node:test";
import { ownedProcessMapSchema, parseProcess, positiveGroupProcessSchema, positiveGroupSchema, processKey,
  rawProcessSchema, selectOwnedProcesses } from "./member-service-processes.mts";

const retainedKernelStat = "2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 6 0 0 20 0 1 0 0 0 0 18446744073709551615 0 0 0 0 0 0 0 2147483647 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
const leader = { pid: 23, parent: 1, group: 23, startTime: "123", state: "S" };
const descendant = { pid: 24, parent: 23, group: 23, startTime: "124", state: "S" };
const owned = () => ownedProcessMapSchema.parse(new Map([[processKey(leader), leader]]));

test("local raw process parser accepts the retained Colima host kthreadd row", () => {
  assert.deepEqual(parseProcess(2, retainedKernelStat), { pid: 2, parent: 0, group: 0, startTime: "0", state: "S" });
});

test("local raw process parser rejects malformed observed fields", () => {
  const fields = ["S", "0", "23", ...Array<string>(16).fill("0"), "0"];
  const row = (parts: string[]) => "23 (payload with spaces) " + parts.join(" ");
  assert.deepEqual(parseProcess(23, row(fields)), { pid: 23, parent: 0, group: 23, startTime: "0", state: "S" });
  for (const [index, value] of [[1, "invalid"], [1, "-1"], [2, "-1"], [2, "1.5"], [19, "missing"]] satisfies [number, string][]) {
    assert.throws(() => parseProcess(23, row(fields.with(index, value))));
  }
  assert.throws(() => parseProcess(23, row(fields.slice(0, 19))));
  for (const pid of [0, -0, -1, 1.5, NaN, Infinity]) assert.throws(() => parseProcess(pid, row(fields)));
});

test("local positive group authority accepts leaders and nonleaders", () => {
  assert.deepEqual(positiveGroupProcessSchema.parse(leader), leader);
  assert.deepEqual(positiveGroupProcessSchema.parse(descendant), descendant);
  assert.deepEqual(positiveGroupProcessSchema.parse({ ...leader, startTime: "0" }), { ...leader, startTime: "0" });
});

test("local positive group authority rejects invalid numeric capability and incomplete identity", () => {
  for (const group of [0, -0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => positiveGroupSchema.parse(group));
    assert.throws(() => positiveGroupProcessSchema.parse({ ...leader, group }));
  }
  for (const pid of [0, -0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => positiveGroupProcessSchema.parse({ ...leader, pid }));
  }
  for (const startTime of [undefined, "", "-1", 123]) {
    assert.throws(() => positiveGroupProcessSchema.parse({ ...leader, startTime }));
  }
});

test("local owned process collection accepts empty and complete positive maps", () => {
  assert.deepEqual(ownedProcessMapSchema.parse(new Map()), new Map());
  const input = new Map([[processKey(leader), leader], [processKey(descendant), descendant]]);
  assert.deepEqual(ownedProcessMapSchema.parse(input), input);
});

test("local owned process collection rejects missing malformed mismatched and mixed authority", () => {
  for (const input of [undefined, null, {}, [], [[processKey(leader), leader]]]) {
    assert.throws(() => ownedProcessMapSchema.parse(input));
  }
  const invalidValues = [undefined, { ...leader, group: 0 }, { ...leader, group: -0 }, { ...leader, group: -1 },
    { ...leader, group: 1.5 }, { ...leader, pid: 0 }, { ...leader, startTime: undefined }];
  for (const invalid of invalidValues) {
    assert.throws(() => ownedProcessMapSchema.parse(new Map([[processKey(leader), invalid]])));
    const mixed = new Map<string, unknown>([[processKey(descendant), descendant], [processKey(leader), invalid]]);
    assert.throws(() => ownedProcessMapSchema.parse(mixed));
    assert.deepEqual([...mixed.keys()], [processKey(descendant), processKey(leader)]);
  }
  assert.throws(() => ownedProcessMapSchema.parse(new Map([["23:reused", leader]])));
  assert.throws(() => ownedProcessMapSchema.parse(new Map([[23, leader]])));
  const mutated = owned();
  const record = mutated.get(processKey(leader));
  assert.ok(record);
  record.group = 0;
  assert.throws(() => ownedProcessMapSchema.parse(mutated));
});

test("local raw census retains unrelated group zero without acquiring it", () => {
  const kernel = parseProcess(2, retainedKernelStat), authority = owned();
  const selected = selectOwnedProcesses(authority, [kernel, leader, descendant]);
  assert.deepEqual(selected.live, [kernel, leader, descendant]);
  assert.equal(selected.owned.has(processKey(kernel)), false);
  assert.deepEqual([...selected.owned.values()], [leader, descendant]);
  assert.deepEqual([...authority.values()], [leader]);
});

test("local raw census rejects changed owned groups and zero group descendants", () => {
  const authority = owned();
  assert.throws(() => selectOwnedProcesses(authority, [{ ...leader, group: 0 }]), /Owned process changed its group/);
  assert.throws(() => selectOwnedProcesses(authority, [{ ...leader, group: 99 }]), /Owned process changed its group/);
  const zeroDescendant = rawProcessSchema.parse({ ...descendant, group: 0 });
  assert.throws(() => selectOwnedProcesses(authority, [leader, zeroDescendant]));
  assert.deepEqual([...authority.values()], [leader]);
});

test("local raw census requires owned lineage before acquiring another positive group", () => {
  assert.throws(() => selectOwnedProcesses(owned(), [leader, { ...descendant, group: 99 }]), /without an owned leader/);
  const unrelated = { ...leader, pid: 99, group: 99, startTime: "999" };
  assert.deepEqual([...selectOwnedProcesses(owned(), [leader, unrelated]).owned.values()], [leader]);
  const detached = { ...descendant, group: descendant.pid };
  const grandchild = { pid: 25, parent: detached.pid, group: detached.group, startTime: "125", state: "S" };
  assert.deepEqual([...selectOwnedProcesses(owned(), [leader, detached, grandchild]).owned.values()], [leader, detached, grandchild]);
});

test("local raw census preserves acquired descendants after leader exit without acquiring reused PIDs", () => {
  const authority = ownedProcessMapSchema.parse(new Map([[processKey(leader), leader], [processKey(descendant), descendant]]));
  const selected = selectOwnedProcesses(authority, [descendant, { ...leader, startTime: "999", group: 99 }]);
  assert.deepEqual([...selected.owned.values()], [leader, descendant]);
  assert.equal(selected.owned.has("23:999"), false);
  assert.deepEqual([...selectOwnedProcesses(owned(), [{ ...leader, state: "Z" }]).owned.values()], [leader]);
});
