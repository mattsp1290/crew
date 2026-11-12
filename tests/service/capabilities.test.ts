import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { z } from "zod";
import { capabilitiesWithin, CapabilityCeilingError, capabilityDigest, capabilityLimits, capabilitySchema, hasCapabilities, includesShell,
  storedCapabilities, type CapabilityInput, type CapabilitySet } from "../../src/service/capabilities.ts";
import { canonical } from "../../src/service/canonical-json.ts";
import type { MemberClient } from "../../src/service/client.ts";
import { registerProfiles } from "../../src/service/deployment.ts";
import { createGateway } from "../../src/service/gateway.ts";
import { canonicalHost, hostMatches } from "../../src/service/hosts.ts";
import { withNativeAdmission } from "../../src/service/native-admission.ts";
import type { MemberProfile } from "../../src/service/profiles.ts";
import { createProxyProfile, usesRelayCredential } from "../../src/service/proxy-profiles.ts";
import { InstallationRecovery, readRecoveryManifest, type RecoveryHooks, type RecoveryPins } from "../../src/service/recovery.ts";
import { FileRecoveryFence } from "../../src/service/recovery-fence.ts";
import { MemberStore } from "../../src/service/store.ts";

const url = process.env.BIRBCREW_TEST_DATABASE_URL;
if (!url) throw new Error("Set BIRBCREW_TEST_DATABASE_URL to a disposable PostgreSQL database.");
const pool = new Pool({ connectionString: url });
const store = new MemberStore(pool);
const plain = "capabilities-plain", bounded = "capabilities-ceiling";
/** What the operator allows members of the `bounded` profile: a shell without network, two
 * fetch destinations, and no search. */
const ceiling = { version: 1, workspace: { files: "write", shell: { network: "off" } },
  webFetch: { hosts: ["*.example.org", "docs.example.com"] } } as const;
before(async () => {
  await store.migrate();
  await pool.query(`INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,capabilities) VALUES ($1,'pi',$3,NULL),($2,'pi',$3,$4)
    ON CONFLICT DO NOTHING`, [plain, bounded, Buffer.alloc(32), JSON.stringify(ceiling)]);
});
after(() => pool.end());

const set = (input: CapabilityInput) => capabilitySchema.parse(input);

test("a capability set parses to one canonical form however it was written", () => {
  const parsed = set({ webSearch: {}, webFetch: { hosts: ["B.example.com.", "a.example.com", "b.example.com", "*.Example.ORG"] }, version: 1,
    workspace: { shell: { network: "proxied" }, files: "write" } });
  assert.deepEqual(parsed, { version: 1, workspace: { files: "write", shell: { network: "proxied" } },
    webFetch: { hosts: ["*.example.org", "a.example.com", "b.example.com"] }, webSearch: {} });
  assert.deepEqual(Object.keys(parsed), ["version", "workspace", "webFetch", "webSearch"]);
  assert.deepEqual(set({ version: 1 }), { version: 1 });
  assert.deepEqual(set({ version: 1, workspace: { files: "read" } }), { version: 1, workspace: { files: "read" } });
  assert.deepEqual(set({ version: 1, webFetch: { hosts: "any" } }), { version: 1, webFetch: { hosts: "any" } });
  // A key given as undefined is dropped, not kept: canonical JSON has no undefined.
  const loose = set({ version: 1, workspace: { files: "write", shell: undefined }, webFetch: undefined, webSearch: undefined });
  assert.deepEqual(Object.keys(loose), ["version", "workspace"]);
  assert.deepEqual(Object.keys(loose.workspace!), ["files"]);
  assert.equal(canonical(loose), '{"version":1,"workspace":{"files":"write"}}');
  assert.equal(hasCapabilities(set({ version: 1 })), false);
  assert.equal(hasCapabilities(null), false);
  assert.equal(hasCapabilities(loose), true);
  assert.equal(includesShell(loose), false);
  assert.equal(includesShell(parsed), true);
  assert.equal(includesShell(null), false);
});

test("a set that names an illegal state fails validation: a shell needs a writable workspace", () => {
  const shellInReadOnly = capabilitySchema.safeParse({ version: 1, workspace: { files: "read", shell: { network: "off" } } });
  assert.equal(shellInReadOnly.success, false);
  assert.match(JSON.stringify(shellInReadOnly.error!.issues), /A shell needs a writable workspace/);
  for (const invalid of [
    undefined, null, "any", [], {},
    { version: 2 }, { version: "1" }, { workspace: { files: "read" } },
    // A shell is part of a workspace, and never stands alone.
    { version: 1, shell: { network: "off" } }, { version: 1, workspace: { shell: { network: "off" } } },
    { version: 1, workspace: {} }, { version: 1, workspace: { files: "execute" } }, { version: 1, workspace: { files: "write", shell: {} } },
    { version: 1, workspace: { files: "write", shell: { network: "on" } } }, { version: 1, workspace: { files: "write", shell: { network: "off", sudo: true } } },
    { version: 1, workspace: { files: "write", root: "/" } }, { version: 1, workspace: "write" },
    { version: 1, webFetch: {} }, { version: 1, webFetch: { hosts: [] } }, { version: 1, webFetch: { hosts: "*" } }, { version: 1, webFetch: { hosts: ["*"] } },
    { version: 1, webFetch: { hosts: ["example.com:443"] } }, { version: 1, webFetch: { hosts: ["https://example.com"] } },
    { version: 1, webFetch: { hosts: ["user@example.com"] } }, { version: 1, webFetch: { hosts: ["*.com"] } }, { version: 1, webFetch: { hosts: [7] } },
    { version: 1, webFetch: { hosts: Array.from({ length: capabilityLimits.hostPatterns + 1 }, (_, i) => `h${i}.example.com`) } },
    { version: 1, webFetch: { hosts: "any", methods: ["POST"] } },
    { version: 1, webSearch: true }, { version: 1, webSearch: { engine: "x" } },
    { version: 1, browser: {} }, { version: 1, mcp: { servers: ["x"] } }, { version: 1, admin: true },
  ]) assert.equal(capabilitySchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  assert.equal(capabilitySchema.safeParse({ version: 1, webFetch: { hosts: Array.from({ length: capabilityLimits.hostPatterns }, (_, i) => `h${i}.example.com`) } }).success, true);
  // JSON.parse makes __proto__ an own key. It is an unknown key like any other, at any depth, and is refused rather than dropped.
  for (const json of ['{"version":1,"__proto__":{"webSearch":{}}}', '{"version":1,"workspace":{"files":"read","__proto__":{"files":"write"}}}',
    '{"version":1,"workspace":{"files":"write","shell":{"network":"off","__proto__":null}}}', '{"version":1,"webFetch":{"hosts":"any","__proto__":[]}}']) {
    assert.equal(capabilitySchema.safeParse(JSON.parse(json)).success, false, json);
  }
  assert.equal(({} as { webSearch?: unknown }).webSearch, undefined, "and nothing was polluted");
});

// Every combination of these: 5 workspaces x 5 fetch settings x 2 search settings.
const workspaces: CapabilityInput["workspace"][] = [undefined, { files: "read" }, { files: "write" },
  { files: "write", shell: { network: "off" } }, { files: "write", shell: { network: "proxied" } }];
const fetches: CapabilityInput["webFetch"][] = [undefined, { hosts: ["docs.example.com"] }, { hosts: ["*.example.org"] },
  { hosts: ["*.example.org", "docs.example.com"] }, { hosts: "any" }];
const family = workspaces.flatMap(workspace => fetches.flatMap(webFetch => [undefined, {}].map(webSearch =>
  set({ version: 1, ...(workspace && { workspace }), ...(webFetch && { webFetch }), ...(webSearch && { webSearch }) }))));
const sampleHosts = ["docs.example.com", "a.example.org", "b.a.example.org", "example.org", "evil.test", "127.0.0.1"].map(host => canonicalHost(host)!);
/** An independent reading of what a set lets a member do, for comparing two sets. */
function allowed(capabilities: CapabilitySet) {
  const atoms = new Set<string>();
  const { workspace, webFetch } = capabilities;
  if (workspace) atoms.add("read files");
  if (workspace?.files === "write") {
    atoms.add("write files");
    if (workspace.shell) atoms.add("run commands");
    if (workspace.shell?.network === "proxied") atoms.add("reach the network from a command");
  }
  if (webFetch) {
    const patterns = webFetch.hosts;
    if (patterns === "any") atoms.add("fetch from a host nobody listed");
    for (const host of sampleHosts) if (patterns === "any" || patterns.some(pattern => hostMatches(pattern, host))) atoms.add("fetch from " + host);
  }
  if (capabilities.webSearch) atoms.add("search the web");
  return atoms;
}

test("a requested set is within a ceiling only when the ceiling allows everything it allows", () => {
  const within = (requested: CapabilityInput, limit: CapabilityInput | null) => capabilitiesWithin(set(requested), limit && set(limit));
  const full = { version: 1, workspace: { files: "write", shell: { network: "proxied" } }, webFetch: { hosts: "any" }, webSearch: {} } as const;
  for (const [requested, limit] of [
    [{ version: 1 }, null], [{ version: 1 }, { version: 1 }], [{ version: 1 }, full], [full, full],
    [{ version: 1, workspace: { files: "read" } }, { version: 1, workspace: { files: "read" } }],
    [{ version: 1, workspace: { files: "read" } }, { version: 1, workspace: { files: "write" } }],
    [{ version: 1, workspace: { files: "write" } }, { version: 1, workspace: { files: "write", shell: { network: "off" } } }],
    [{ version: 1, workspace: { files: "write", shell: { network: "off" } } }, { version: 1, workspace: { files: "write", shell: { network: "proxied" } } }],
    [{ version: 1, webFetch: { hosts: ["a.example.org", "docs.example.com"] } }, ceiling],
    [{ version: 1, webFetch: { hosts: ["*.eu.example.org"] } }, ceiling],
    [{ version: 1, webFetch: { hosts: ["docs.example.com"] } }, { version: 1, webFetch: { hosts: "any" } }],
    [ceiling, ceiling],
  ] as [CapabilityInput, CapabilityInput | null][]) assert.equal(within(requested, limit), true, `${JSON.stringify(requested)} within ${JSON.stringify(limit)}`);
  for (const [requested, limit] of [
    [{ version: 1, workspace: { files: "read" } }, null], [{ version: 1, webSearch: {} }, null], [{ version: 1, webFetch: { hosts: ["docs.example.com"] } }, null],
    [{ version: 1, workspace: { files: "read" } }, { version: 1 }], [{ version: 1, workspace: { files: "read" } }, { version: 1, webSearch: {} }],
    [{ version: 1, workspace: { files: "write" } }, { version: 1, workspace: { files: "read" } }],
    [{ version: 1, workspace: { files: "write", shell: { network: "off" } } }, { version: 1, workspace: { files: "write" } }],
    [{ version: 1, workspace: { files: "write", shell: { network: "off" } } }, { version: 1, workspace: { files: "read" } }],
    [{ version: 1, workspace: { files: "write", shell: { network: "proxied" } } }, ceiling],
    [{ version: 1, webSearch: {} }, ceiling],
    [{ version: 1, webFetch: { hosts: "any" } }, ceiling],
    [{ version: 1, webFetch: { hosts: ["example.org"] } }, ceiling],
    [{ version: 1, webFetch: { hosts: ["*.example.com"] } }, ceiling],
    [{ version: 1, webFetch: { hosts: ["docs.example.com", "evil.test"] } }, ceiling],
    [{ version: 1, webFetch: { hosts: ["*.example.org"] } }, { version: 1, webFetch: { hosts: ["*.eu.example.org"] } }],
    [{ version: 1, webFetch: { hosts: ["*.co.org"] } }, ceiling],
    [{ version: 1, webFetch: { hosts: ["docs.example.com"] } }, { version: 1, webSearch: {} }],
    [full, ceiling],
  ] as [CapabilityInput, CapabilityInput | null][]) assert.equal(within(requested, limit), false, `${JSON.stringify(requested)} within ${JSON.stringify(limit)}`);

  assert.equal(family.length, 50);
  for (const a of family) {
    assert.equal(capabilitiesWithin(a, a), true);
    assert.equal(capabilitiesWithin(set({ version: 1 }), a), true);
    assert.equal(capabilitiesWithin(a, null), !hasCapabilities(a));
    assert.equal(capabilitiesWithin(a, set(full)), true);
    for (const b of family) {
      const yes = capabilitiesWithin(a, b);
      // Never more than the ceiling: everything `a` lets a member do, `b` lets it do.
      if (yes) for (const atom of allowed(a)) assert.ok(allowed(b).has(atom), `${canonical(a)} within ${canonical(b)} but adds: ${atom}`);
      // And on this family the answer is exactly that comparison.
      assert.equal(yes, [...allowed(a)].every(atom => allowed(b).has(atom)), `${canonical(a)} within ${canonical(b)}`);
      if (yes && capabilitiesWithin(b, a)) assert.equal(capabilityDigest(a), capabilityDigest(b));
      if (yes) for (const c of family) if (capabilitiesWithin(b, c)) assert.equal(capabilitiesWithin(a, c), true);
    }
  }
});

test("the digest is the same for every spelling of one set and different for every other set", () => {
  const a = set({ version: 1, workspace: { files: "write", shell: { network: "off" } }, webFetch: { hosts: ["docs.example.com", "*.example.org"] } });
  const b = set({ webFetch: { hosts: ["*.EXAMPLE.org.", "Docs.Example.Com", "docs.example.com"] }, workspace: { shell: { network: "off" }, files: "write" }, version: 1 });
  assert.equal(capabilityDigest(a), capabilityDigest(b));
  assert.match(capabilityDigest(a), /^[0-9a-f]{64}$/);
  assert.equal(capabilityDigest(a), createHash("sha256").update(canonical(a)).digest("hex"));
  assert.equal(new Set(family.map(capabilityDigest)).size, family.length);
  for (const member of family) assert.equal(canonical(member).includes("undefined"), false);
  // A stored set reads back as itself; a value this release cannot read is an error, never "none".
  assert.deepEqual(storedCapabilities(JSON.parse(JSON.stringify(a))), a);
  assert.equal(storedCapabilities(null), null);
  // A set built in code, with its patterns in another order, has the digest of its canonical form.
  const unsorted = { version: 1, webFetch: { hosts: [...a.webFetch!.hosts as string[]].reverse() }, workspace: a.workspace } as CapabilitySet;
  assert.notDeepEqual(unsorted, a);
  assert.equal(capabilityDigest(unsorted), capabilityDigest(a));
  for (const unreadable of [{ version: 2, workspace: { files: "read" } }, { version: 1 }, "any", { version: 1, teleport: {} }]) {
    assert.throws(() => storedCapabilities(unreadable), /Unknown stored capabilities/);
  }
});

// Compile-time only: the illegal states do not type-check either.
function typeChecks() {
  // @ts-expect-error a shell needs a writable workspace
  const readOnlyShell: CapabilityInput = { version: 1, workspace: { files: "read", shell: { network: "off" } } };
  // @ts-expect-error a shell is part of a workspace
  const bareShell: CapabilityInput = { version: 1, shell: { network: "off" } };
  // @ts-expect-error the canonical type agrees
  const stored: CapabilitySet = { version: 1, workspace: { files: "read", shell: { network: "off" } } };
  // @ts-expect-error a profile's ceiling is checked as it is written
  const profile: MemberProfile = { accountId: "a", capabilities: { version: 1, workspace: { files: "read", shell: { network: "off" } } } };
  return [readOnlyShell, bareShell, stored, profile];
}
void typeChecks;

/** An in-process gateway over the real store. */
async function gateway(t: TestContext, on: MemberStore = store) {
  const token = randomUUID(), stranger = randomUUID();
  const owners = { [token]: "owner-" + randomUUID(), [stranger]: "owner-" + randomUUID() };
  const server = createGateway(on, {} as unknown as MemberClient, Object.fromEntries(Object.entries(owners)
    .map(([secret, owner]) => [createHash("sha256").update(secret).digest("hex"), owner])));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  async function api(path: string, body?: unknown, credential = token) {
    const response = await fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const rows = async (table: "members" | "member_capabilities" | "audit_events", ownerId = owners[token]) =>
    (await on.pool.query(`SELECT * FROM birbcrew_ts.${table} WHERE owner_id=$1`, [ownerId])).rows;
  return { api, rows, token, stranger, ownerId: owners[token], strangerId: owners[stranger] };
}

test("a client that names no capabilities sees its member exactly as before", async (t) => {
  const g = await gateway(t);
  for (const profile of [plain, bounded]) {
    const requestId = randomUUID();
    const spawned = await g.api("/v1/members", { requestId, engine: "pi", profile });
    assert.equal(spawned.status, 201);
    assert.deepEqual(spawned.body, { ownerId: g.ownerId, memberId: spawned.body.memberId, engine: "pi", profile });
    assert.deepEqual((await g.api("/members", { requestId, engine: "pi", profile })).body, spawned.body, "the unversioned route and a retry");
    const listed = (await g.api("/v1/members")).body.members.find((member: { memberId: string }) => member.memberId === spawned.body.memberId);
    assert.deepEqual(listed, { memberId: spawned.body.memberId, engine: "pi", profile });
    const event = (await g.api("/v1/audit")).body.events.find((row: { memberId: string }) => row.memberId === spawned.body.memberId);
    assert.deepEqual(event.payload, { spawnRequestId: requestId, engine: "pi", profile });
  }
  assert.deepEqual(await g.rows("member_capabilities"), []);
  const report = (await g.api("/v1/capabilities")).body.memberCapabilities;
  assert.deepEqual(report, { version: 1, spawnField: "capabilities", memberField: "capabilities", auditField: "capabilityDigest",
    default: "none", ceiling: "operator-profile", fixedAtSpawn: true, kinds: ["workspace", "webFetch", "webSearch"],
    workspaceFiles: ["read", "write"], shellNetwork: ["off", "proxied"], maximumHostPatterns: 32, toolExecution: "not-implemented" });
});

test("an owner picks a set within the ceiling at spawn; it is reported, audited by digest and fixed", async (t) => {
  const g = await gateway(t);
  const requestId = randomUUID();
  const asked = { version: 1, webFetch: { hosts: ["Docs.Example.com.", "a.example.org", "docs.example.com"] },
    workspace: { files: "write", shell: { network: "off" } } };
  const held = { version: 1, workspace: { files: "write", shell: { network: "off" } }, webFetch: { hosts: ["a.example.org", "docs.example.com"] } };
  const spawned = await g.api("/v1/members", { requestId, engine: "pi", profile: bounded, capabilities: asked });
  assert.equal(spawned.status, 201);
  const { memberId } = spawned.body;
  assert.deepEqual(spawned.body, { ownerId: g.ownerId, memberId, engine: "pi", profile: bounded, capabilities: held });

  // A retry is the same request however the set is spelled; any other set is another request.
  const respelled = { workspace: { shell: { network: "off" }, files: "write" }, webFetch: { hosts: ["docs.example.com", "A.Example.Org"] }, version: 1 };
  assert.deepEqual(await g.api("/v1/members", { requestId, engine: "pi", profile: bounded, capabilities: respelled }), spawned);
  for (const other of [undefined, { version: 1 }, { version: 1, workspace: { files: "write" } }, { ...asked, webFetch: { hosts: ["docs.example.com"] } }]) {
    assert.deepEqual(await g.api("/v1/members", { requestId, engine: "pi", profile: bounded, ...(other && { capabilities: other }) }),
      { status: 409, body: { error: "conflict" } }, JSON.stringify(other));
  }
  // A retry is judged as a retry: one that differs is a conflict even when what it asks for would be refused as a new request.
  for (const differing of [{ profile: plain, capabilities: asked }, { profile: bounded, capabilities: { ...ceiling, webSearch: {} } }, { profile: plain }]) {
    assert.deepEqual(await g.api("/v1/members", { requestId, engine: "pi", ...differing }), { status: 409, body: { error: "conflict" } }, JSON.stringify(differing));
  }
  // Three spawns of one request race with three different sets: one member, holding the winner's set.
  const racing = randomUUID();
  const raced = await Promise.all([{ version: 1, workspace: { files: "read" } }, { version: 1, workspace: { files: "write" } }, undefined].map(capabilities =>
    g.api("/v1/members", { requestId: racing, engine: "pi", profile: bounded, ...(capabilities && { capabilities }) })));
  assert.deepEqual(raced.map(response => response.status).sort(), [201, 409, 409]);
  const winner = raced.find(response => response.status === 201)!.body;
  assert.deepEqual((await g.rows("member_capabilities")).filter(row => row.member_id === winner.memberId).map(row => row.capabilities),
    winner.capabilities ? [winner.capabilities] : []);
  const sibling = (await g.api("/v1/members", { requestId: randomUUID(), engine: "pi", profile: bounded })).body.memberId;
  const listed = (await g.api("/v1/members")).body.members;
  assert.deepEqual(listed.find((member: { memberId: string }) => member.memberId === memberId), { memberId, engine: "pi", profile: bounded, capabilities: held });
  assert.deepEqual(listed.find((member: { memberId: string }) => member.memberId === sibling), { memberId: sibling, engine: "pi", profile: bounded });
  assert.deepEqual((await g.api("/v1/members", undefined, g.stranger)).body.members, []);

  const events = (await g.api("/v1/audit")).body.events.filter((row: { memberId: string }) => row.memberId === memberId);
  assert.deepEqual(events.map((row: { type: string; payload: unknown }) => [row.type, row.payload]),
    [["member.spawned", { spawnRequestId: requestId, engine: "pi", profile: bounded, capabilityDigest: capabilityDigest(set(held as CapabilityInput)) }]]);
  assert.equal(JSON.stringify(events).includes("example"), false, "the trail holds the digest, never the set");
  assert.deepEqual((await g.rows("member_capabilities")).filter(row => row.member_id === memberId).map(row => row.capabilities), [held]);

  // The whole ceiling is itself a legal request.
  const whole = await g.api("/v1/members", { requestId: randomUUID(), engine: "pi", profile: bounded, capabilities: ceiling });
  assert.deepEqual([whole.status, whole.body.capabilities], [201, ceiling]);
});

test("a set above the ceiling is refused with 400 and nothing is written", async (t) => {
  const g = await gateway(t);
  for (const [profile, capabilities] of [
    [plain, { version: 1, workspace: { files: "read" } }], [plain, { version: 1, webSearch: {} }], [plain, ceiling],
    [bounded, { version: 1, webSearch: {} }],
    [bounded, { version: 1, workspace: { files: "write", shell: { network: "proxied" } } }],
    [bounded, { version: 1, webFetch: { hosts: "any" } }],
    [bounded, { version: 1, webFetch: { hosts: ["evil.test"] } }],
    [bounded, { version: 1, webFetch: { hosts: ["docs.example.com", "example.org"] } }],
    [bounded, { version: 1, webFetch: { hosts: ["*.example.com"] } }],
    [bounded, { ...ceiling, webSearch: {} }],
  ] as const) {
    assert.deepEqual(await g.api("/v1/members", { requestId: randomUUID(), engine: "pi", profile, capabilities }),
      { status: 400, body: { error: "capabilities_exceed_profile" } }, JSON.stringify(capabilities));
  }
  // The store refuses the same request from any caller, and an unregistered profile has no ceiling.
  await assert.rejects(store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: "capabilities-unregistered",
    capabilities: { version: 1, workspace: { files: "read" } } }), CapabilityCeilingError);
  // Another engine of the same profile name is another registration.
  await assert.rejects(store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "claude", profile: bounded,
    capabilities: { version: 1, workspace: { files: "read" } } }), CapabilityCeilingError);
  for (const invalid of [
    { version: 1, workspace: { files: "read", shell: { network: "off" } } }, { version: 1, shell: { network: "off" } }, { version: 2 },
    { version: 1, webFetch: { hosts: ["docs.example.com:443"] } }, { version: 1, webFetch: { hosts: ["user@docs.example.com"] } },
    { version: 1, browser: {} }, "all", null, [],
  ]) {
    assert.deepEqual(await g.api("/v1/members", { requestId: randomUUID(), engine: "pi", profile: bounded, capabilities: invalid }),
      { status: 400, body: { error: "invalid_input" } }, JSON.stringify(invalid));
  }
  assert.deepEqual([await g.rows("members"), await g.rows("member_capabilities"), await g.rows("audit_events")], [[], [], []]);
});

test("an empty set is no capabilities: the member, a retry and the trail read as if none were named", async (t) => {
  const g = await gateway(t);
  const requestId = randomUUID();
  const spawned = await g.api("/v1/members", { requestId, engine: "pi", profile: plain, capabilities: { version: 1 } });
  assert.deepEqual(spawned, { status: 201, body: { ownerId: g.ownerId, memberId: spawned.body.memberId, engine: "pi", profile: plain } });
  assert.deepEqual(await g.api("/v1/members", { requestId, engine: "pi", profile: plain }), spawned);
  assert.deepEqual(await g.rows("member_capabilities"), []);
  assert.deepEqual((await g.rows("audit_events")).map(row => row.payload), [{ spawnRequestId: requestId, engine: "pi", profile: plain }]);
});

test("the database binds a stored set to its member and ceiling, checks its shape and never lets it change", async (t) => {
  const g = await gateway(t);
  const without = await store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: plain });
  const bare = await store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: bounded });
  const other = await store.spawn({ ownerId: g.strangerId, requestId: randomUUID(), engine: "pi", profile: bounded });
  const held = await store.spawn({ ownerId: g.ownerId, requestId: randomUUID(), engine: "pi", profile: bounded,
    capabilities: { version: 1, workspace: { files: "read" } } });
  const insert = (ownerId: string, memberId: string, capabilities: unknown) => pool.query(
    "INSERT INTO birbcrew_ts.member_capabilities (owner_id,member_id,capabilities) VALUES ($1,$2,$3)", [ownerId, memberId, JSON.stringify(capabilities)]);
  const readOnly = { version: 1, workspace: { files: "read" } };
  // A member whose profile registers no ceiling, a member of another owner, and no member at all.
  await assert.rejects(insert(g.ownerId, without.memberId, readOnly), { code: "23503", message: /no capability ceiling/ });
  await assert.rejects(insert(g.ownerId, other.memberId, readOnly), { code: "23503" });
  await assert.rejects(insert(g.ownerId, randomUUID(), readOnly), { code: "23503" });
  for (const shape of [{ version: 1 }, { version: 2, workspace: { files: "read" } }, { workspace: { files: "read" } }, [1], "any", null,
    { version: 1, workspace: { files: "read", shell: { network: "off" } } }, { version: 1, workspace: { shell: { network: "off" } } },
    // A key that is not a capability, a capability that is not an object, and a shell outside a workspace.
    { version: 1, x: 1 }, { version: 1, workspace: { files: "read" }, admin: true }, { version: 1, workspace: null }, { version: 1, workspace: "write" },
    { version: 1, workspace: {} }, { version: 1, workspace: { files: "execute" } }, { version: 1, workspace: ["write"] },
    { version: 1, shell: { network: "proxied" }, workspace: { files: "read" } }, { version: 1, webFetch: {} }, { version: 1, webFetch: "any" },
    { version: 1, webSearch: true }, { version: 1, webSearch: null }, { version: "1", webSearch: {} },
    { version: 1, webFetch: { hosts: Array.from({ length: 80 }, (_, i) => `${"h".repeat(200)}${i}.example.com`) } }]) {
    // JSON null is a value, not the absence of one.
    await assert.rejects(insert(g.ownerId, bare.memberId, shape), { code: "23514" }, JSON.stringify(shape));
    await assert.rejects(pool.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,capabilities) VALUES ($1,'pi',$2,$3)",
      ["capabilities-" + randomUUID(), Buffer.alloc(32), JSON.stringify(shape)]), { code: "23514" }, JSON.stringify(shape));
  }
  await assert.rejects(pool.query("INSERT INTO birbcrew_ts.member_capabilities (owner_id,member_id,capabilities) VALUES ($1,$2,NULL)",
    [g.ownerId, bare.memberId]), { code: "23502" });
  // Fixed once stored, on the member and on the registration.
  await assert.rejects(pool.query("UPDATE birbcrew_ts.member_capabilities SET capabilities=$2 WHERE member_id=$1",
    [held.memberId, JSON.stringify({ version: 1, workspace: { files: "write" } })]), { code: "23514", message: /fixed/ });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.member_capabilities SET capabilities=capabilities WHERE false"), { code: "23514" });
  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.member_capabilities WHERE member_id=$1", [held.memberId]), { code: "23514" });
  await assert.rejects(pool.query("TRUNCATE birbcrew_ts.member_capabilities"), { code: "23514" });
  for (const widened of [JSON.stringify({ ...ceiling, webSearch: {} }), null]) {
    await assert.rejects(pool.query("UPDATE birbcrew_ts.profiles SET capabilities=$2 WHERE name=$1 AND engine='pi'", [bounded, widened]),
      { code: "23514", message: /fixed/ });
  }
  await assert.rejects(pool.query("UPDATE birbcrew_ts.profiles SET capabilities=$2 WHERE name=$1 AND engine='pi'", [plain, JSON.stringify(ceiling)]),
    { code: "23514", message: /fixed/ });
  // A registration with a ceiling stays under its name: removing or renaming it would let the name
  // be registered again with another ceiling, or none, under members that keep their sets.
  await assert.rejects(pool.query("DELETE FROM birbcrew_ts.profiles WHERE name=$1", [bounded]), { code: "23514", message: /fixed/ });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.profiles SET name=$2 WHERE name=$1", [bounded, "capabilities-renamed"]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE birbcrew_ts.profiles SET engine='claude', volume=gen_random_uuid() WHERE name=$1", [bounded]), { code: "23514" });
  await assert.rejects(pool.query("TRUNCATE birbcrew_ts.profiles"), { code: "23514", message: /kept/ });
  assert.deepEqual((await pool.query("SELECT capabilities FROM birbcrew_ts.profiles WHERE name=$1", [bounded])).rows, [{ capabilities: ceiling }]);
  // Each minimal set is a legal ceiling, and a registration without one is not held by the rule.
  const disposable = "capabilities-" + randomUUID();
  await pool.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest) VALUES ($1,'pi',$2)", [disposable, Buffer.alloc(32)]);
  assert.equal((await pool.query("DELETE FROM birbcrew_ts.profiles WHERE name=$1", [disposable])).rowCount, 1);
  for (const minimal of [{ version: 1, webSearch: {} }, { version: 1, workspace: { files: "read" } }, { version: 1, webFetch: { hosts: "any" } },
    { version: 1, workspace: { files: "write", shell: { network: "proxied" } }, webFetch: { hosts: ["a.example.com"] }, webSearch: {} }]) {
    await pool.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,capabilities) VALUES ($1,'pi',$2,$3)",
      ["capabilities-" + randomUUID(), Buffer.alloc(32), JSON.stringify(minimal)]);
  }
  assert.deepEqual((await g.rows("member_capabilities")).map(row => [row.member_id, row.capabilities]), [[held.memberId, readOnly]]);
  assert.equal((await pool.query("SELECT 1 FROM pg_trigger WHERE tgrelid='birbcrew_ts.member_capabilities'::regclass AND tgname='recovery_write_barrier' AND tgenabled='O'")).rowCount, 1);
});

const relay = (engine: "pi" | "claude" = "pi") => createProxyProfile({ engine, model: "fixture-model", accountId: "fixture-account",
  protocol: engine === "pi" ? "openai-chat-completions" : "anthropic-messages", endpoint: "https://proxy.example.invalid/v1/x",
  resolveCredential: async () => ({ headers: { authorization: "Bearer synthetic" }, expiresAt: Date.now() + 60_000 }) });

test("a registration stores its ceiling once, refuses a different one, and needs a relay credential for a shell", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "birb-capabilities-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = () => "capabilities-" + randomUUID();
  const direct = (capabilities?: CapabilityInput): MemberProfile => ({ accountId: "fixture-account", pi: {} as never, ...(capabilities && { capabilities }) });
  const stored = async (profile: string) => (await pool.query("SELECT engine,capabilities FROM birbcrew_ts.profiles WHERE name=$1 ORDER BY engine", [profile])).rows;
  const register = (profile: string, entry: MemberProfile) => registerProfiles(pool, new Map([[profile, entry]]), directory);

  // A ceiling without a shell needs no relay. It is stored in canonical form.
  const reader = name();
  await register(reader, direct({ version: 1, webFetch: { hosts: ["Docs.Example.com", "*.example.org", "docs.example.com."] }, workspace: { files: "write" } }));
  assert.deepEqual(await stored(reader), [{ engine: "pi", capabilities: { version: 1, workspace: { files: "write" }, webFetch: { hosts: ["*.example.org", "docs.example.com"] } } }]);
  await register(reader, direct({ workspace: { files: "write" }, version: 1, webFetch: { hosts: ["docs.example.com", "*.EXAMPLE.org"] } }));
  for (const changed of [undefined, { version: 1 }, { version: 1, workspace: { files: "write" } }, { version: 1, workspace: { files: "read" }, webFetch: { hosts: ["*.example.org", "docs.example.com"] } },
    { version: 1, workspace: { files: "write" }, webFetch: { hosts: "any" } }] as (CapabilityInput | undefined)[]) {
    await assert.rejects(register(reader, direct(changed)), /different tools or capabilities/, JSON.stringify(changed));
  }
  // A registration without a ceiling never gains one; an empty ceiling is no ceiling.
  const none = name();
  await register(none, direct());
  await register(none, direct({ version: 1 }));
  await assert.rejects(register(none, direct({ version: 1, workspace: { files: "read" } })), /different tools or capabilities/);
  assert.deepEqual(await stored(none), [{ engine: "pi", capabilities: null }]);

  // A shell: refused for options Crew did not build around a relay, before anything is written.
  const shell = { version: 1, workspace: { files: "write", shell: { network: "off" } } } as const;
  const refused = name(), bystander = name();
  await assert.rejects(registerProfiles(pool, new Map([[bystander, direct()], [refused, direct(shell)]]), directory), /shell in its capability ceiling.*relay credential/);
  assert.deepEqual([await stored(refused), await stored(bystander)], [[], []]);
  await assert.rejects(register(refused, direct({ version: 1, workspace: { files: "read", shell: { network: "off" } } } as never)), z.ZodError);

  const proxy = await relay();
  t.after(() => proxy.close());
  assert.equal(usesRelayCredential(proxy.profile.pi), true);
  // The marked options cannot be given another credential afterwards.
  assert.equal(Object.isFrozen(proxy.profile.pi), true);
  assert.throws(() => { (proxy.profile.pi as unknown as { model: unknown }).model = { id: "another" }; }, TypeError);
  assert.equal(usesRelayCredential({ ...proxy.profile.pi }), false, "a copy of the options is not what Crew built");
  assert.equal(usesRelayCredential(direct().pi), false);
  for (const nothing of [undefined, null, "relay", 1]) assert.equal(usesRelayCredential(nothing), false);
  const granted = name();
  await register(granted, { ...proxy.profile, capabilities: shell });
  assert.deepEqual(await stored(granted), [{ engine: "pi", capabilities: shell }]);
  await assert.rejects(register(name(), { ...proxy.profile, pi: { ...proxy.profile.pi! }, capabilities: shell }), /relay credential/);
  // Every engine of the profile must hold a relay credential, not just one of them.
  await assert.rejects(register(name(), { ...proxy.profile, claude: { apiKey: "provider-key", model: "fixture-model" }, capabilities: shell }), /relay credential/);
  // Members of the registered profile can now ask for the shell, and for nothing above it.
  const ownerId = "owner-" + randomUUID();
  const member = await store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: granted, capabilities: shell });
  assert.deepEqual(member.capabilities, shell);
  await assert.rejects(store.spawn({ ownerId, requestId: randomUUID(), engine: "pi", profile: granted,
    capabilities: { version: 1, workspace: { files: "write", shell: { network: "proxied" } } } }), CapabilityCeilingError);
});

const sql = new URL("../../src/service/sql/", import.meta.url);
/** A separate database migrated only up to `version`, as that release left it; dropped after the test. */
async function databaseAt(t: TestContext, version: number) {
  const source = new URL(url!);
  const admin = new Pool({ connectionString: source.href });
  const database = "capabilities_" + randomUUID().replaceAll("-", "");
  await admin.query("CREATE DATABASE " + database);
  source.pathname = "/" + database;
  const separate = new Pool({ connectionString: source.href });
  t.after(async () => {
    try {
      await separate.end();
      await admin.query(`DROP DATABASE ${database}`);
    } finally { await admin.end(); }
  });
  await separate.query("CREATE SCHEMA birbcrew_ts");
  await separate.query("CREATE TABLE birbcrew_ts.schema_versions (version integer PRIMARY KEY)");
  for (const file of (await readdir(sql)).sort()) {
    const applied = Number(file.split("-")[0]);
    if (applied > version) continue;
    await separate.query(await readFile(new URL(file, sql), "utf8"));
    await separate.query("INSERT INTO birbcrew_ts.schema_versions VALUES ($1)", [applied]);
  }
  return separate;
}

test("migration 32 upgrades a v26 database without rewriting a table or waiting for a native turn; its members keep no capabilities", async (t) => {
  const upgraded = await databaseAt(t, 26);
  const current = new MemberStore(upgraded);
  const ownerId = "owner-" + randomUUID(), conversationId = randomUUID();
  // Rows as the v26 release wrote them.
  await upgraded.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,protected_tool) VALUES ($1,'pi',$2,'record_work_item')",
    [plain, createHash("sha256").update("fixture-account").digest()]);
  const spawn = { ownerId, requestId: randomUUID(), engine: "pi" as const, profile: plain };
  const member = await current.spawn(spawn);
  await upgraded.query("INSERT INTO birbcrew_ts.conversations (owner_id,member_id,conversation_id) VALUES ($1,$2,$3)", [ownerId, member.memberId, conversationId]);
  const running = { ownerId, conversationId, requestId: randomUUID(), text: "running at upgrade" };
  await upgraded.query(`INSERT INTO birbcrew_ts.request_admissions (conversation_id,request_id,prompt_digest,initiator_kind)
    VALUES ($1,$2,$3,'owner')`, [conversationId, running.requestId, createHash("sha256").update(running.text).digest()]);
  const execution = { workflowRunId: randomUUID(), activityId: "turn", attempt: 1 };
  const start = await current.beginTurn(running, execution);
  assert.equal(start.kind, "start"); if (start.kind !== "start") return;
  await upgraded.query(`INSERT INTO birbcrew_ts.native_launches (conversation_id,request_id,token,workflow_run_id,activity_id,attempt)
    VALUES ($1,$2,$3,$4,$5,1)`, [conversationId, running.requestId, start.token, execution.workflowRunId, execution.activityId]);

  // Exclusive only on profiles; neither existing table is rewritten. The locks on turns and
  // tool_grants are migration 33's, taken here so that the pair never retries for them while
  // profiles is locked exclusively.
  const db = await upgraded.connect();
  try {
    await db.query("BEGIN");
    const files = "SELECT pg_relation_filenode('birbcrew_ts.profiles') AS profiles, pg_relation_filenode('birbcrew_ts.members') AS members";
    const { rows: [before] } = await db.query(files);
    await db.query(await readFile(new URL("032-capabilities.sql", sql), "utf8"));
    assert.deepEqual((await db.query(files)).rows[0], before);
    const { rows } = await db.query(`SELECT c.relname AS relation, l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND c.relkind='r' AND c.relnamespace='birbcrew_ts'::regnamespace
        AND c.relname<>'member_capabilities' ORDER BY 1,2`);
    assert.deepEqual(rows, [
      { relation: "members", mode: "AccessShareLock" }, { relation: "members", mode: "ShareRowExclusiveLock" },
      { relation: "profiles", mode: "AccessExclusiveLock" }, { relation: "profiles", mode: "ShareRowExclusiveLock" },
      { relation: "tool_grants", mode: "ShareRowExclusiveLock" }, { relation: "turns", mode: "ShareRowExclusiveLock" },
    ]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }

  await withNativeAdmission(upgraded, { ...running, token: start.token, execution }, AbortSignal.timeout(30_000), async () => {
    const migrated = await Promise.race([current.migrate().then(() => true), delay(5_000, false)]);
    assert.equal(migrated, true, "migration 32 must not wait for a running native turn");
    await current.appendText({ ownerId, conversationId, requestId: running.requestId, token: start.token },
      running.requestId + "/assistant", 0, "still running");
  });

  const { rows: constraints } = await upgraded.query(`SELECT conname AS name, convalidated AS validated FROM pg_constraint
    WHERE conname IN ('profiles_capabilities_check','member_capabilities_check') ORDER BY 1`);
  assert.deepEqual(constraints, [{ name: "member_capabilities_check", validated: true }, { name: "profiles_capabilities_check", validated: false }]);
  // The old registration has no ceiling, and the old member replays as it was spawned.
  assert.deepEqual((await upgraded.query("SELECT capabilities,protected_tool FROM birbcrew_ts.profiles")).rows, [{ capabilities: null, protected_tool: "record_work_item" }]);
  assert.deepEqual(await current.spawn(spawn), member);
  assert.deepEqual(Object.keys(member), ["ownerId", "memberId", "engine", "profile"]);
  await assert.rejects(current.spawn({ ...spawn, requestId: randomUUID(), capabilities: { version: 1, workspace: { files: "read" } } }), CapabilityCeilingError);
  await assert.rejects(current.spawn({ ...spawn, capabilities: { version: 1, workspace: { files: "read" } } }), { code: "conflict" });
  // The worker's registration of the old profile, which names no capabilities, still matches;
  // the same name cannot be given a ceiling afterwards.
  const directory = await mkdtemp(join(tmpdir(), "birb-capabilities-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old: MemberProfile = { accountId: "fixture-account", pi: {} as never, protectedTool: "record_work_item" };
  await registerProfiles(upgraded, new Map([[plain, old]]), directory);
  await assert.rejects(registerProfiles(upgraded, new Map([[plain, { ...old, capabilities: { version: 1, workspace: { files: "read" } } }]]), directory),
    /different tools or capabilities/);
  assert.deepEqual((await upgraded.query("SELECT capabilities FROM birbcrew_ts.profiles")).rows, [{ capabilities: null }]);
});

const pins: RecoveryPins = { applicationCommit: "a".repeat(40), lockfileSha256: "b".repeat(64),
  temporal: { mode: "development-fixture", serverVersion: "1.10.0", persistenceFormat: "dev-sqlite-fixture" }, logicalNativeRoot: "/var/lib/birbcrew/native" };

test("capture counts member capabilities, a held installation refuses to write them, and a restore keeps them", async (t) => {
  const separate = await databaseAt(t, Infinity);
  const local = new MemberStore(separate);
  const directory = await mkdtemp(join(tmpdir(), "birb-capabilities-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recovery = new InstallationRecovery(separate, new FileRecoveryFence(join(directory, "fence")));
  await recovery.initializeFence();
  const bundle = join(directory, "bundle");
  await mkdir(bundle);
  const hooks: RecoveryHooks = { quiesce: async () => {}, reconcile: async () => {}, snapshot: async (into) => {
    const artifacts = [];
    for (const kind of ["application-postgres", "temporal-persistence", "native-volumes", "configuration"] as const) {
      await writeFile(join(into, kind + ".fixture"), "fixture " + kind);
      artifacts.push({ kind, file: kind + ".fixture" });
    }
    return artifacts;
  } };
  await separate.query("INSERT INTO birbcrew_ts.profiles (name,engine,account_digest,capabilities) VALUES ($1,'pi',$2,$3)",
    [bounded, Buffer.alloc(32), JSON.stringify(ceiling)]);
  const ownerId = "owner-" + randomUUID();
  const asked = { ownerId, engine: "pi" as const, profile: bounded, capabilities: { version: 1 as const, workspace: { files: "read" as const } } };
  const member = await local.spawn({ ...asked, requestId: randomUUID() });

  await recovery.capture(bundle, pins, hooks);
  const manifest = await readRecoveryManifest(bundle);
  assert.equal(manifest.inventory.member_capabilities, 1, "capture refuses a table without the write barrier, so this one has it");
  await assert.rejects(local.spawn({ ...asked, requestId: randomUUID() }), { code: "55000" });
  await assert.rejects(separate.query("INSERT INTO birbcrew_ts.member_capabilities (owner_id,member_id,capabilities) VALUES ($1,$2,$3)",
    [ownerId, member.memberId, JSON.stringify(asked.capabilities)]), { code: "55000" });
  // Capabilities are fixed at spawn and nothing revokes them, so a restore has nothing to settle.
  await recovery.acceptRestore(bundle, pins, randomUUID());
  await recovery.resume(hooks, manifest);
  assert.deepEqual((await separate.query("SELECT member_id,capabilities FROM birbcrew_ts.member_capabilities")).rows,
    [{ member_id: member.memberId, capabilities: asked.capabilities }]);
  assert.deepEqual((await local.spawn({ ...asked, requestId: randomUUID() })).capabilities, asked.capabilities);
});
