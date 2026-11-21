import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@ag-ui/core";
import manifest from "../../../vendor/ag-ui/manifest.json" with { type: "json" };

const root = new URL("../../../", import.meta.url);

test("the installed AG-UI core uses the qualified wire protocol", () => {
  assert.equal(PROTOCOL_VERSION, "1.0");
});

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
  const { createCursorRuntime } = await import("@mattsp1290/switchboard/cursor");
  assert.equal(typeof createCursorRuntime, "function");
  const { opencodeHostAdapter, OPENCODE_HOST_ACP_VERSION } = await import("@mattsp1290/switchboard/host/opencode");
  assert.deepEqual(opencodeHostAdapter.identity, { engine: "opencode", adapter: "opencode-host", version: "1", contractVersion: 1 });
  assert.equal(OPENCODE_HOST_ACP_VERSION, "1");
});

// npm ci can install a cached copy under the lock's integrity, so a repacked archive must match it here.
test("the packed pi-subagents archive is the one the lock names", async () => {
  const { packages } = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const { resolved, integrity } = packages["node_modules/@birbcrew/pi-subagents"];
  const bytes = await readFile(new URL(resolved.slice("file:".length), root));
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, integrity);
});

test("the bounded OTLP archive is selected by direct and trace-exporter consumers", async () => {
  const pin = z.object({
    package: z.literal("@opentelemetry/otlp-exporter-base"), version: z.literal("0.208.0"),
    archive: z.object({ filename: z.string(), sha256: z.string(), integrity: z.string() }),
    candidatePublishedFiles: z.record(z.string(), z.string()),
  }).parse(JSON.parse(await readFile(new URL("vendor/opentelemetry/otlp-exporter-base-0.208.0-crew.1/pins.json", root), "utf8")));
  const bytes = await readFile(new URL(`vendor/opentelemetry/${pin.archive.filename}`, root));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.archive.sha256);
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, pin.archive.integrity);
  const spec = `file:vendor/opentelemetry/${pin.archive.filename}`;
  const dependency = z.record(z.string(), z.string());
  const pkg = z.object({ dependencies: dependency, overrides: dependency })
    .parse(JSON.parse(await readFile(new URL("package.json", root), "utf8")));
  assert.equal(pkg.dependencies[pin.package], spec);
  assert.equal(pkg.overrides[pin.package], `$${pin.package}`);
  const lock = z.object({ packages: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(await readFile(new URL("package-lock.json", root), "utf8")));
  assert.deepEqual(Object.keys(lock.packages).filter(name => name.endsWith(`node_modules/${pin.package}`)),
    [`node_modules/${pin.package}`]);
  const locked = z.object({ version: z.string(), resolved: z.string(), integrity: z.string() })
    .parse(lock.packages[`node_modules/${pin.package}`]);
  assert.deepEqual(locked, { version: pin.version, resolved: spec, integrity: pin.archive.integrity });
  const require = createRequire(import.meta.url);
  const trace = createRequire(require.resolve("@opentelemetry/exporter-trace-otlp-http"));
  assert.equal(await realpath(require.resolve(pin.package)), await realpath(trace.resolve(pin.package)));
  const installed = new URL(`node_modules/${pin.package}/`, root);
  assert.equal(Object.keys(pin.candidatePublishedFiles).length, 327);
  for (const [name, expected] of Object.entries(pin.candidatePublishedFiles)) {
    assert.equal(createHash("sha256").update(await readFile(new URL(name, installed))).digest("hex"), expected, name);
  }
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
  assert.equal(execFileSync(process.execPath, [binary.pathname,"--version"], {encoding:"utf8"}).trim(), "codex-cli 0.169.0");
});
