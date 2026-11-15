import assert from "node:assert/strict";
import { test } from "node:test";
import { positiveGroupProcessSchema, type RawProcess } from "./member-service-processes.mts";
import { assertContractHistory, contractRecoveryReportSchema, contractRunSchema, fixtureOwnerSchema,
  type ContractRecoveryReport, type ContractRoot } from "./member-service-recovery.mts";

function contract(directory = "/artifacts/crew-contract-first", options: {
  launch?: ContractRoot["run"]["launch"]["kind"]; worker?: Partial<RawProcess>;
} = {}): ContractRoot {
  return { directory, run: contractRunSchema.parse({ version: 1,
    worker: { pid: 401, parent: 399, group: 400, startTime: "1001", state: "S", ...options.worker },
    launch: { kind: options.launch ?? "requested" } }) };
}
function recovery(roots: ContractRecoveryReport["roots"] = []): ContractRecoveryReport {
  return { version: 1, kind: "contract-recovery", conclusion: "cancelled", started: "2026-11-15T00:00:00.000Z",
    completed: false, roots, failures: [] };
}
function recoveryRoot(root: ContractRoot): ContractRecoveryReport["roots"][number] {
  return { ...root, fixture: { kind: "unknown", reason: "Fixture owner not read" }, worker: "unknown", owner: "unknown",
    observed: [], originals: { before: [], after: [] },
    recovery: { failures: [], container: "unknown", directory: "unknown", processes: "unknown" }, failures: [] };
}

test("local contract history accepts empty initial reports and no previous reports", () => {
  const initial = contractRecoveryReportSchema.parse(recovery());
  assert.doesNotThrow(() => assertContractHistory([contract()], initial.roots));
  assert.doesNotThrow(() => assertContractHistory([contract()], []));
  assert.doesNotThrow(() => assertContractHistory([], []));
});

test("local contract history accepts repeated incomplete reports and identical current duplicates", () => {
  const root = contract(), prior = contractRecoveryReportSchema.parse(recovery([recoveryRoot(root)]));
  assert.doesNotThrow(() => assertContractHistory([root, root], [prior, prior].flatMap(report => report.roots)));
});

test("local contract history ignores transient parent and process state observations", () => {
  const before = contract(), after = contract(before.directory, { worker: { parent: 1, state: "Z" } });
  assert.doesNotThrow(() => assertContractHistory([after], [before]));
  assert.doesNotThrow(() => assertContractHistory([before, after], []));
});

test("local contract history accepts forward launches and additional recovery roots", () => {
  const before = contract(undefined, { launch: "not-requested" }), after = contract();
  const added = contract("/artifacts/crew-contract-added");
  assert.doesNotThrow(() => assertContractHistory([after, added], [before, after, before]));
  assert.doesNotThrow(() => assertContractHistory([before, added], [before]));
});

test("local contract history rejects a requested launch becoming not-requested", () => {
  const before = contract(), after = contract(before.directory, { launch: "not-requested" });
  assert.throws(() => assertContractHistory([after], [before]), /launch authority regressed/);
});

test("local contract history retains every acknowledged root despite a surviving nonlaunch root", () => {
  const missing = contract(), surviving = contract("/artifacts/crew-contract-surviving", { launch: "not-requested" });
  assert.throws(() => assertContractHistory([surviving], [missing, surviving]), /Previously acknowledged contract root missing/);
  assert.throws(() => assertContractHistory([], [missing]), /Previously acknowledged contract root missing/);
});

test("local contract history rejects same-directory worker PID start time and group changes", () => {
  const before = contract();
  for (const worker of [{ pid: 402 }, { startTime: "1002" }, { group: 402 }]) {
    const after = contract(before.directory, { worker });
    assert.throws(() => assertContractHistory([after], [before]), /Prior contract worker (authority|group) changed/);
  }
});

test("local contract history rejects contradictory prior worker records even when the latest agrees", () => {
  const current = contract(), conflicting = contract(current.directory, { worker: { startTime: "1002" } });
  assert.throws(() => assertContractHistory([current], [conflicting, current]), /Prior contract worker authority changed/);
});

test("local contract history rejects conflicting current directory records before selecting a winner", () => {
  const root = contract();
  const conflicts = [contract(root.directory, { launch: "not-requested" }),
    ...[{ pid: 402 }, { startTime: "1002" }, { group: 402 }].map(worker => contract(root.directory, { worker }))];
  for (const conflict of conflicts) {
    assert.throws(() => assertContractHistory([root, conflict], []), /Conflicting current/);
    assert.throws(() => assertContractHistory([conflict, root], []), /Conflicting current/);
  }
});

test("local contract history rejects cross-directory group conflicts for the same worker incarnation", () => {
  const root = contract(), conflict = contract("/artifacts/crew-contract-conflict", { worker: { group: 402 } });
  assert.throws(() => assertContractHistory([root, conflict], []), /Conflicting worker group authority/);
});

test("local contract history permits distinct worker incarnations across different roots", () => {
  const first = contract(), later = contract("/artifacts/crew-contract-later", { worker: { startTime: "1002", group: 402 } });
  assert.doesNotThrow(() => assertContractHistory([first, later], [first, later]));
});

test("local contract observation coverage accepts stable snapshots with reordered roots", () => {
  const first = [contract(), contract("/artifacts/crew-contract-idle", { launch: "not-requested" })];
  const second = [...first].reverse();
  assert.doesNotThrow(() => assertContractHistory(second, first));
  assert.doesNotThrow(() => assertContractHistory(first, second));
});

test("local contract observation coverage rejects roots missing from the second sample", () => {
  const first = [contract(), contract("/artifacts/crew-contract-retained")], second = first.slice(1);
  assert.throws(() => assertContractHistory(second, first), /Previously acknowledged contract root missing/);
});

test("local contract observation coverage rejects roots that received only the second sample", () => {
  const first = [contract()], second = [...first, contract("/artifacts/crew-contract-added")];
  assert.doesNotThrow(() => assertContractHistory(second, first));
  assert.throws(() => assertContractHistory(first, second), /Previously acknowledged contract root missing/);
});

test("local contract observation coverage requires two requested-fixture observations after a forward launch", () => {
  const first = [contract(undefined, { launch: "not-requested" })], second = [contract()];
  assert.doesNotThrow(() => assertContractHistory(second, first));
  assert.throws(() => assertContractHistory(first, second), /launch authority regressed/);
});

test("local recovery report boundary rejects nonlaunch roots with known fixtures or retained descendants", () => {
  const root = recoveryRoot(contract(undefined, { launch: "not-requested" }));
  const owner = fixtureOwnerSchema.parse({ version: 1, fixtureOwner: positiveGroupProcessSchema.parse({ pid: 501, parent: 401,
    group: 501, startTime: "1002", state: "S" }) });
  const known: ContractRecoveryReport["roots"][number] = { ...root,
    fixture: { kind: "known", artifacts: root.directory + "/contract-fixture", owner } };
  for (const invalid of [known, { ...root, observed: [owner.fixtureOwner] },
    { ...root, fixture: { kind: "not-requested" }, observed: [owner.fixtureOwner] }]) {
    assert.equal(contractRecoveryReportSchema.safeParse({ ...recovery(), roots: [invalid] }).success, false);
  }
  assert.deepEqual(contractRecoveryReportSchema.parse(recovery([root])), recovery([root]));
  const nonlaunch: ContractRecoveryReport["roots"][number] = { ...root, fixture: { kind: "not-requested" }, owner: "not-requested" };
  assert.deepEqual(contractRecoveryReportSchema.parse(recovery([nonlaunch])), recovery([nonlaunch]));
  const requested = { ...known, run: contract().run, observed: [owner.fixtureOwner] };
  assert.deepEqual(contractRecoveryReportSchema.parse(recovery([requested])), recovery([requested]));
});
