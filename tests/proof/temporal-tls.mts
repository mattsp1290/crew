import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { createServer } from "node:tls";
import { Connection } from "@temporalio/client";
import { temporalConnectionOptions, temporalSettings } from "../../src/service/temporal-config.ts";
import { run, withServices, until } from "./member-services.mts";
import { before as boundedWait, now } from "./member-service-diagnostics.mts";

type Outcome = { kind: "passed" } | { kind: "failed"; error: unknown };

// Temporal's development server has no TLS listener, so a TLS terminator that requires a client
// certificate from the proof CA is the only route from the gateway, worker and SDK children.
assert.equal(process.version, "v24.22.3");
const serverName = "temporal.crew.test", clientName = "crew-proof-client";
await withServices({ label: "temporal-tls" }, async s => {
  const temporalCli = process.env.TEMPORAL_CLI ?? "temporal";
  await s.startTemporal();
  const plaintext = s.env.BIRBCREW_TEMPORAL_ADDRESS!;
  const namespace = "crew-tls-" + randomUUID().slice(0, 8);
  await run(temporalCli, ["operator", "namespace", "create", "--namespace", namespace, "--address", plaintext]);

  const file = (name: string) => join(s.directory, name);
  const openssl = (...args: string[]) => run("openssl", args, { cwd: s.directory });
  await openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=crew-proof-ca",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout", "ca.key", "-out", "ca.pem");
  for (const [name, subject, extensions] of [["server", serverName, `subjectAltName=DNS:${serverName}\nextendedKeyUsage=serverAuth\n`],
    ["client", clientName, "extendedKeyUsage=clientAuth\n"]]) {
    await writeFile(file(name + ".ext"), extensions);
    await openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + subject, "-keyout", name + ".key", "-out", name + ".csr");
    await openssl("x509", "-req", "-in", name + ".csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1",
      "-extfile", name + ".ext", "-out", name + ".pem");
  }

  const handshakes: { servername: unknown; client: unknown }[] = [];
  let refused = 0;
  const sockets = new Set<Socket>();
  const terminator = createServer({ key: await readFile(file("server.key")), cert: await readFile(file("server.pem")),
    ca: await readFile(file("ca.pem")), requestCert: true, rejectUnauthorized: true, ALPNProtocols: ["h2"] }, (socket) => {
    handshakes.push({ servername: socket.servername, client: socket.getPeerCertificate().subject?.CN });
    const upstream = connect(Number(plaintext.split(":")[1]), "127.0.0.1");
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.once("close", () => sockets.delete(connection));
    }
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  let outcome: Outcome = { kind: "passed" };
  try {
    terminator.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    terminator.on("tlsClientError", () => { refused++; });
    terminator.listen(0, "127.0.0.1");
    await once(terminator, "listening");
    const address = terminator.address();
    assert.ok(address && typeof address === "object");
    const env = { ...s.env, BIRBCREW_TEMPORAL_ADDRESS: "127.0.0.1:" + address.port, BIRBCREW_TEMPORAL_NAMESPACE: namespace,
      BIRBCREW_TEMPORAL_TLS_CA_PATH: file("ca.pem"), BIRBCREW_TEMPORAL_TLS_CERTIFICATE_PATH: file("client.pem"),
      BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH: file("client.key"), BIRBCREW_TEMPORAL_TLS_SERVER_NAME: serverName };

    const settings = temporalSettings(env);
    const options = await temporalConnectionOptions(settings);
    const connectTimeout = 3000;
    await assert.rejects(Connection.connect({ address: options.address, connectTimeout }), "plaintext must not reach the TLS endpoint");
    const before = refused;
    await assert.rejects(Connection.connect({ address: options.address, connectTimeout,
      tls: { serverNameOverride: serverName, serverRootCACertificate: options.tls!.serverRootCACertificate } }), "client certificate is required");
    assert.ok(refused > before, "the endpoint refused the handshake without a client certificate");
    await assert.rejects(Connection.connect({ ...await temporalConnectionOptions(temporalSettings({ ...env, BIRBCREW_TEMPORAL_TLS_SERVER_NAME: "wrong.crew.test" })),
      connectTimeout }), "server name override is used for verification");
    const direct = await Connection.connect({ ...options, connectTimeout });
    let described: Outcome = { kind: "passed" };
    try { await direct.workflowService.describeNamespace({ namespace }); }
    catch (error) { described = { kind: "failed", error }; }
    try { await direct.close(); }
    catch (error) {
      if (described.kind === "passed") throw error;
      console.error("TLS direct connection cleanup also failed", error);
    }
    if (described.kind === "failed") throw described.error;
    console.log("TLS endpoint refused plaintext, a missing client certificate and a wrong server name; configured mTLS connected");

    const absent = "crew-missing-" + randomUUID().slice(0, 8);
    const missing = spawn(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"],
      { env: { ...env, BIRBCREW_TEMPORAL_NAMESPACE: absent, BIRBCREW_PROOF_ENGINE: "pi" }, stdio: ["ignore", "ignore", "pipe"] });
    const missingExit = once(missing, "exit");
    void missingExit.catch(() => {});
    const stderr = missing.stderr.toArray().then((chunks) => chunks.join(""));
    void stderr.catch(() => {});
    const deadline = setTimeout(() => missing.kill("SIGKILL"), 30_000);
    let missingOutcome: Outcome = { kind: "passed" };
    try {
      assert.deepEqual(await missingExit, [1, null], "a worker with a missing namespace exits nonzero");
      assert.match(await stderr, new RegExp(`Namespace ${absent} (was not found|is not found)`));
    } catch (error) { missingOutcome = { kind: "failed", error }; }
    clearTimeout(deadline);
    try {
      if (missing.exitCode === null && missing.signalCode === null) missing.kill("SIGKILL");
      await boundedWait(missingExit, now() + 2_000, "Missing namespace worker disposal");
    } catch (error) {
      if (missingOutcome.kind === "passed") throw error;
      console.error("TLS negative worker cleanup also failed", error);
    }
    if (missingOutcome.kind === "failed") throw missingOutcome.error;
    console.log("A worker configured with a missing namespace reported it and exited with status 1");

    const ownerId = randomUUID(), token = randomUUID();
    const config = file("gateway.json");
    await writeFile(config, JSON.stringify({ port: 0, tokenHashes: { [createHash("sha256").update(token).digest("hex")]: ownerId } }), { mode: 0o600 });
    const unreadable = join(s.directory, "absent", "client.key");
    const misconfigured = spawn(process.execPath, ["src/service/gateway.ts", config],
      { env: { ...env, BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH: unreadable }, stdio: ["ignore", "ignore", "pipe"] });
    const misconfiguredExit = once(misconfigured, "exit");
    void misconfiguredExit.catch(() => {});
    const misconfiguredDeadline = setTimeout(() => misconfigured.kill("SIGKILL"), 30_000);
    let report = "";
    let misconfiguredOutcome: Outcome = { kind: "passed" };
    try {
      report = (await misconfigured.stderr.toArray()).join("");
      assert.deepEqual(await misconfiguredExit, [1, null]);
      assert.match(report, /Cannot read BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH \(ENOENT\)/);
      assert.ok(!report.includes(unreadable), "the gateway does not print the private key path");
    } catch (error) { misconfiguredOutcome = { kind: "failed", error }; }
    clearTimeout(misconfiguredDeadline);
    try {
      if (misconfigured.exitCode === null && misconfigured.signalCode === null) misconfigured.kill("SIGKILL");
      await boundedWait(misconfiguredExit, now() + 2_000, "Misconfigured gateway disposal");
    } catch (error) {
      if (misconfiguredOutcome.kind === "passed") throw error;
      console.error("TLS negative gateway cleanup also failed", error);
    }
    if (misconfiguredOutcome.kind === "failed") throw misconfiguredOutcome.error;
    console.log("A gateway with an unreadable key file named the variable without its path and exited with status 1");
    const heartbeat = file("worker.heartbeat");
    await s.child(process.execPath, ["src/service/cli.ts", "worker", "tests/proof/fixture-profiles.mts"],
      { ...env, BIRBCREW_WORKER_HEARTBEAT_FILE: heartbeat });
    const { url: endpoint } = await s.gateway(config, env);
    await until(async () => {
      try { return await s.sql("SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.approval.v1'") === "3" || undefined; }
      catch { return undefined; }
    }, "worker registration");
    if (process.version === "v24.22.3") throw new Error("CI_PRIMARY_TLS_BODY_CANARY_c83f093");
    const api = async (path: string, body?: unknown, expected?: number) => {
      const response = await fetch(endpoint + path, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }) });
      if (expected !== undefined) assert.equal(response.status, expected, path);
      return response.json();
    };
    async function open(engine: string, profile: string) {
      const { memberId } = await api("/v1/members", { requestId: randomUUID(), engine, profile }, 201);
      const conversationId = randomUUID();
      await api("/v1/conversations", { memberId, conversationId }, 201);
      return { memberId, conversationId, path: `/v1/conversations/${conversationId}` };
    }
    async function completed(path: string, requestId: string) {
      return until(async () => {
        const receipt = await api(`${path}/requests/${requestId}`, undefined, 200);
        assert.ok(!["failed", "uncertain", "cancelled"].includes(receipt.status), JSON.stringify(receipt));
        return receipt.status === "completed" ? receipt.result.text as string : undefined;
      }, "completed request " + requestId, 90_000);
    }

    const pi = await open("pi", "fixture.v1"), marker = randomUUID();
    for (const [text, reply] of [["remember " + marker, "stored " + marker], ["recall", "recalled " + marker]]) {
      const requestId = randomUUID();
      await api(pi.path + "/requests", { requestId, text }, 202);
      assert.equal(await completed(pi.path, requestId), reply);
    }
    console.log("Pi fixture turns completed through /v1 with gateway and worker on mTLS in namespace " + namespace);
    const beat = await until(async () => (await stat(heartbeat).catch(() => undefined))?.mtimeMs, "first worker heartbeat");
    await until(async () => (await stat(heartbeat)).mtimeMs > beat || undefined, "refreshed worker heartbeat", 15_000);
    // The exec liveness probe from docs/persistent-deployment.md, aimed at this gateway's port.
    await run(process.execPath, ["-e", `fetch('${endpoint}/v1/capabilities', { signal: AbortSignal.timeout(3000) })` +
      ".then(r => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"]);
    assert.equal((await fetch(endpoint + "/healthz")).status, 401);
    console.log("The worker refreshed its heartbeat file; the gateway liveness probe passed on 401 and /healthz needs a token");

    async function cli(operation: string, input: object) {
      const child = spawn(process.execPath, ["src/service/cli.ts", operation], { env, stdio: ["pipe", "pipe", "inherit"] });
      const exited = once(child, "exit");
      void exited.catch(() => {});
      let command: Outcome = { kind: "passed" }, output = "";
      try {
        child.stdin.end(JSON.stringify(input));
        output = (await child.stdout.toArray()).join("");
        assert.deepEqual(await exited, [0, null], "members CLI " + operation);
      } catch (error) { command = { kind: "failed", error }; }
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await boundedWait(exited, now() + 2_000, "TLS CLI disposal");
      } catch (error) {
        if (command.kind === "passed") throw error;
        console.error("TLS CLI cleanup also failed", error);
      }
      if (command.kind === "failed") throw command.error;
      return JSON.parse(output);
    }
    const cliConversation = randomUUID();
    await cli("open", { ownerId, memberId: pi.memberId, conversationId: cliConversation });
    assert.deepEqual(await cli("turn", { ownerId, conversationId: cliConversation, requestId: randomUUID(), text: "remember cli" }),
      { text: "stored cli" });
    console.log("Members CLI opened a conversation and completed a turn on mTLS");

    const codex = await open("codex", "fixture.approval.v1"), requestId = randomUUID();
    const sessions = handshakes.length;
    await api(codex.path + "/requests", { requestId, text: "record " + requestId }, 202);
    const card = await until(async () => (await api(codex.path, undefined, 200)).state.pendingApprovals?.[0], "Codex live approval card", 90_000);
    const workflowId = `birbcrew-ts/member/${codex.memberId}/conversation/${codex.conversationId}`;
    const history = async () => (await run(temporalCli, ["workflow", "show", "--namespace", namespace, "--workflow-id", workflowId,
      "--address", plaintext, "--output", "json"], { maxBuffer: 16 * 1024 * 1024 })).stdout;
    // The SDK runner process sends this signal on its own connection; the TLS endpoint is its only route.
    await until(async () => (await history()).includes('"liveProposal"') || undefined, "liveProposal signal from the SDK runner");
    assert.ok(handshakes.length > sessions, "the runner opened its own TLS session");
    await api(codex.path + "/human", { memberId: codex.memberId, requestId, invocationId: card.invocationId,
      approvalId: card.approvalId, version: card.version, choice: "approve" }, 200);
    assert.match(await completed(codex.path, requestId), /^settled .*recorded/);
    console.log("Codex live proposal signal from the SDK runner arrived over mTLS; approved turn completed");

    const listed = async (ns: string) => (await run(temporalCli, ["workflow", "list", "--namespace", ns, "--address", plaintext,
      "--output", "json"])).stdout;
    assert.ok((await listed(namespace)).includes(workflowId));
    assert.ok(!(await listed("default")).includes("birbcrew-ts/member/"), "no workflow was started in the default namespace");
    assert.ok(handshakes.length >= 3);
    assert.ok(handshakes.every(({ servername, client }) => servername === serverName && client === clientName), JSON.stringify(handshakes));
    console.log(`${handshakes.length} accepted TLS sessions all presented SNI ${serverName} and client certificate ${clientName}`);
  } catch (error) { outcome = { kind: "failed", error }; }
  const cleanup = await Promise.allSettled([
    ...[...sockets].map(socket => Promise.resolve().then(() => socket.destroy())),
    Promise.resolve().then(() => boundedWait(new Promise<void>((resolve, reject) => terminator.close(error => {
      if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error); else resolve();
    })), now() + 2_000, "TLS terminator disposal")).then(() => {
      if (process.version === "v24.22.3") throw new Error("CI_SECONDARY_TLS_CLEANUP_CANARY_c83f093");
    }),
  ]);
  const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
  if (outcome.kind === "failed") {
    for (const error of failures) console.error("TLS terminator cleanup also failed", error);
    throw outcome.error;
  }
  if (failures.length) throw new AggregateError(failures, "TLS terminator cleanup failed");
});
console.log("Temporal mTLS and namespace proof passed; no live inference.");
