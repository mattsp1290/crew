import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const root = process.env.BIRBCREW_PROOF_ARTIFACTS;
assert(root && isAbsolute(root));
const primary = "CI_PRIMARY_TLS_BODY_CANARY_c83f093";
const secondary = "CI_SECONDARY_TLS_CLEANUP_CANARY_c83f093";
const checks = [];
let passed = false;
try {
  const owners = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name, "ownership.json"));
  assert.equal(owners.length, 1, "Expected the late TLS fixture only");
  const log = readFileSync(join(root, "tls.stdout.log"), "utf8");
  for (const ready of [
    "TLS endpoint refused plaintext, a missing client certificate and a wrong server name; configured mTLS connected",
    "A worker configured with a missing namespace reported it and exited with status 1",
    "A gateway with an unreadable key file named the variable without its path and exited with status 1",
  ]) assert(log.includes(ready), `Missing TLS setup evidence ${ready}`);
  assert.equal(log.match(/temporal-tls first failure: Error: ([^\n]+)/)?.[1], primary);
  assert.equal(log.match(/TLS terminator cleanup also failed Error: ([^\n]+)/)?.[1], secondary);
  assert(log.includes(`\nError: ${primary}\n`), "The command must terminate with the primary body error");
  assert(!log.includes("Pi fixture turns completed"), "Late TLS canary must precede provider turns");
  const processes = readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const text = readFileSync(`/proc/${name}/stat`, "utf8");
      const [state, , group] = text.slice(text.lastIndexOf(")") + 2).split(" ");
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      assert(Number.isSafeInteger(Number(name)) && Number(name) > 0);
      assert(Number.isSafeInteger(Number(group)) && Number(group) >= 0);
      return state === "Z" || state === "X" ? [] : [{ pid: Number(name), group: Number(group), args }];
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return []; throw error; }
  });
  for (const path of owners) {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(owner.label, "temporal-tls");
    assert.match(owner.container, /^birb-proof-[a-f0-9-]+$/);
    assert(isAbsolute(owner.directory) && /^birb-members-[a-zA-Z0-9]+$/.test(owner.directory.split("/").at(-1)));
    assert.equal(owner.allocation.kind, "settled");
    assert.match(owner.allocation.container, /^[a-f0-9]{64}$/);
    assert(Array.isArray(owner.processes) && owner.processes.length >= 3);
    for (const owned of owner.processes) {
      assert(Number.isSafeInteger(owned.pid) && owned.pid > 0, "Missing owned process identity");
      assert.equal(owned.identity.kind, "known");
      assert.equal(owned.identity.group, owned.pid);
      assert.match(owned.identity.startTime, /^\d+$/);
    }
    assert.equal(new Set(owner.processes.map(owned => owned.pid)).size, owner.processes.length);
    const container = execFileSync("docker", ["ps", "-aq", "--filter", `name=^/${owner.container}$`],
      { encoding: "utf8", timeout: 3000 });
    const byId = execFileSync("docker", ["ps", "-aq", "--no-trunc", "--filter", `id=${owner.allocation.container}`],
      { encoding: "utf8", timeout: 3000 });
    const collector = JSON.parse(readFileSync(join(dirname(path), "collector.json"), "utf8"));
    assert(Number.isSafeInteger(collector.pid) && collector.pid > 0, "Missing collector process identity");
    assert.equal(collector.truncated, false);
    assert.deepEqual(collector.failures, []);
    const liveGroups = processes.filter(proc => proc.group === collector.pid || owner.processes.some(owned => owned.pid === proc.group));
    const lingeringCommands = processes.filter(proc => proc.args.some(arg => arg === owner.container || arg.startsWith(owner.directory) || arg.startsWith(dirname(path))));
    assert.deepEqual(lingeringCommands, []);
    const first = readFileSync(join(dirname(path), "first-failure.txt"), "utf8");
    assert(first.startsWith(`Error: ${primary}\n`));
    assert(!first.includes(secondary));
    const cleanup = JSON.parse(readFileSync(join(dirname(path), "cleanup.json"), "utf8"));
    assert.deepEqual(cleanup.failures, []);
    assert.equal(cleanup.outcome.kind, "failed");
    assert.equal(cleanup.outcome.status, 1);
    assert.equal(cleanup.outcome.error, first);
    assert.equal(cleanup.resources.container, "absent");
    assert.equal(cleanup.resources.directory, "absent");
    assert.deepEqual(cleanup.resources.processes, owner.processes.map(({ pid }) => ({ pid, status: "absent" })));
    let directoryAbsent = false;
    try { lstatSync(owner.directory); } catch (error) { if (error.code !== "ENOENT") throw error; directoryAbsent = true; }
    checks.push({ primary, secondary, container: owner.container, containerAbsent: container === "", allocatedIdAbsent: byId === "", checkedGroups: [...owner.processes.map(proc => proc.pid), collector.pid], liveGroups, directory: owner.directory, directoryAbsent });
    assert.equal(container, "");
    assert.equal(byId, "");
    assert.deepEqual(liveGroups, []);
    assert.equal(directoryAbsent, true);
  }
  const commands = readdirSync(root).filter(name => name.endsWith(".stdout.log.result.json"));
  assert.deepEqual(commands, ["tls.stdout.log.result.json"], "Expected the exact retained TLS command receipt");
  const command = JSON.parse(readFileSync(join(root, commands[0]), "utf8"));
  assert(Number.isSafeInteger(command.pid) && command.pid > 0, "Missing command process identity");
  assert.deepEqual(command.outcome, { kind: "exited", code: 1 });
  assert.equal(command.deadlineExceeded, false);
  assert.equal(command.interrupted, undefined);
  assert.equal(command.truncated, false);
  assert.equal(command.received, command.retained);
  assert.equal(command.retained, Buffer.byteLength(log));
  assert(Number.isSafeInteger(command.retained) && command.retained > 0);
  assert.deepEqual(command.failures, []);
  const liveGroups = processes.filter(proc => proc.group === command.pid);
  checks.push({ command: commands[0], group: command.pid, liveGroups });
  assert.deepEqual(liveGroups, []);
  passed = true;
} finally {
  writeFileSync(join(root, "independent-resource-check.json"), JSON.stringify({ independent: true, passed, checks }, null, 2));
}
