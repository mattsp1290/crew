import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedCommand, CommandFailure, completedCommandFailure, now } from "./member-service-diagnostics.mts";
import { isMissingDockerInspection } from "./member-service-recovery.mts";

const calibratedId = "d8ac0d68c2470b03a25f61c8ed5f6160822a2ae650f659946c30b1cbeeeb9708";
const missingInspection = "\nError: No such object: " + calibratedId + "\n";

test("local completed command failure exposes complete diagnostics and rejects compound outcomes", { timeout: 8_000 }, async () => {
  const diagnostics = "ordinary child failure\n";
  await assert.rejects(boundedCommand(process.execPath,
    ["-e", "process.stderr.write(process.argv[1], () => { process.exitCode = 1; })", diagnostics], now() + 4_000), (error: unknown) => {
    assert.deepEqual(completedCommandFailure(error), { code: 1, diagnostics });
    assert.ok(error instanceof AggregateError);
    const failure: unknown = error.errors[0];
    assert.ok(failure instanceof CommandFailure);
    failure.message = "A caller changed the formatted error message";
    assert.deepEqual(completedCommandFailure(error), { code: 1, diagnostics });
    for (const additional of [new Error("deadline exceeded"), new Error("aborted"), new Error("client close failed")]) {
      error.errors.push(additional);
      assert.equal(completedCommandFailure(error), undefined);
      error.errors.pop();
    }
    for (const nested of [new CommandFailure("child", { kind: "signalled", signal: "SIGTERM" }),
      new Error("spawn failed"), new AggregateError([failure], "nested command failure")]) {
      error.errors.splice(0, 1, nested);
      assert.equal(completedCommandFailure(error), undefined);
    }
    assert.equal(completedCommandFailure(new AggregateError([failure], "unverified capture")), undefined);
    assert.equal(completedCommandFailure(failure), undefined);
    return true;
  });
});

test("local completed command failure rejects diagnostics beyond the capture bound", { timeout: 8_000 }, async () => {
  await assert.rejects(boundedCommand(process.execPath,
    ["-e", "process.stderr.write('x'.repeat(128 * 1024 + 1), () => { process.exitCode = 1; })"], now() + 4_000), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    const failure: unknown = error.errors[0];
    assert.ok(failure instanceof CommandFailure);
    assert.deepEqual(failure.result, { kind: "exited", code: 1 });
    assert.equal(completedCommandFailure(error), undefined);
    return true;
  });
});

test("local missing Docker inspection policy accepts only the observed exact target diagnostic", () => {
  assert.equal(isMissingDockerInspection({ code: 1, diagnostics: missingInspection }, calibratedId), true);
  assert.equal(isMissingDockerInspection(undefined, calibratedId), false);
  for (const code of [0, 2, 125, 137])
    assert.equal(isMissingDockerInspection({ code, diagnostics: missingInspection }, calibratedId), false);
  const otherId = "c1c9c4d1d560c42ef2c5b260aedde50115a32516257c92b5474f7e7747d1a1f5";
  assert.equal(isMissingDockerInspection({ code: 1, diagnostics: missingInspection }, otherId), false);
  for (const diagnostics of ["", "Error: permission denied", "Cannot connect to the Docker daemon",
    "Warning: daemon unavailable\n" + missingInspection, missingInspection + "permission denied\n",
    "Error: No such object: " + calibratedId + "extra", "Error: No such object: " + calibratedId.slice(0, 12),
    "Error response from daemon: No such container: " + calibratedId + "\n"])
    assert.equal(isMissingDockerInspection({ code: 1, diagnostics }, calibratedId), false, diagnostics);
});
