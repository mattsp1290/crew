import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import manifest from "../../../vendor/ag-ui/manifest.json" with { type: "json" };

const root = new URL("../../../", import.meta.url);

for (const pkg of manifest) {
  test(`${pkg.name} matches its qualified archive`, async () => {
    const bytes = await readFile(new URL(`vendor/ag-ui/${pkg.archive}`, root));
    const digest = createHash("sha512").update(bytes).digest("base64");
    assert.equal(`sha512-${digest}`, pkg.integrity);

    const installed = new URL(`node_modules/${pkg.name}/`, root);
    const metadata = JSON.parse(await readFile(new URL("package.json", installed), "utf8"));
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
    assert.equal(metadata.license, pkg.license);
    for (const notice of pkg.notices) {
      assert.ok((await readFile(new URL(notice, installed))).length > 0, notice);
    }
  });
}

// The archive, its pin record, the dependency spec and the lock must name the same bytes. AgentUI pins the same
// record fields for the same artifact, so the two pins compare mechanically.
test("Switchboard matches its pin, dependency, lock and installed package", async () => {
  const pin = JSON.parse(await readFile(new URL("vendor/switchboard/switchboard.json", root), "utf8"));
  assert.match(pin.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(pin.artifact, `switchboard-${pin.sourceRevision}.tgz`);
  const bytes = await readFile(new URL(`vendor/switchboard/${pin.artifact}`, root));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, pin.integrity);
  const spec = `file:vendor/switchboard/${pin.artifact}`;
  const { dependencies } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(dependencies[pin.name], spec);
  const { packages } = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  assert.equal(packages[""].dependencies[pin.name], spec);
  const locked = packages[`node_modules/${pin.name}`];
  assert.deepEqual([locked.version, locked.resolved, locked.integrity, locked.license], [pin.version, spec, pin.integrity, pin.license]);
  const installed = new URL(`node_modules/${pin.name}/`, root);
  const metadata = JSON.parse(await readFile(new URL("package.json", installed), "utf8"));
  assert.deepEqual([metadata.name, metadata.version, metadata.license], [pin.name, pin.version, pin.license]);
  for (const notice of pin.notices) assert.ok((await readFile(new URL(notice, installed))).length > 0, notice);
  const { createEventStream } = await import(pin.name);
  assert.equal(typeof createEventStream, "function");
});

// npm ci can install a cached copy under the lock's integrity, so a repacked archive must match it here.
test("the packed pi-subagents archive is the one the lock names", async () => {
  const { packages } = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const { resolved, integrity } = packages["node_modules/@birbcrew/pi-subagents"];
  const bytes = await readFile(new URL(resolved.slice("file:".length), root));
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, integrity);
});

test("Pi's public coding-session example loads in the consumer", async () => {
  const { createExampleServer } = await import("@ag-ui/pi/examples/server");
  assert.equal(typeof createExampleServer, "function");
});

test("the locked official Codex packages launch the pinned Linux CLI", async () => {
  const { execFileSync } = await import("node:child_process");
  const pins = JSON.parse(await readFile(new URL("vendor/ag-ui/codex-packages.json", root), "utf8"));
  const { packages } = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  for (const pin of pins.packages) {
    const pkg = packages[pin.installPath];
    assert.deepEqual([pkg.version, pkg.integrity, pkg.resolved, pkg.license], [pin.version, pin.integrity, pin.download, pin.license]);
  }
  const binary = new URL("node_modules/@openai/codex/bin/codex.js", root);
  assert.equal(execFileSync(process.execPath, [binary.pathname,"--version"], {encoding:"utf8"}).trim(), "codex-cli 0.167.1");
});
