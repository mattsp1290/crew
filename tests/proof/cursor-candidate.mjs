import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
process.setUncaughtExceptionCaptureCallback((error) => {
  process.stderr.write(`Candidate audit failed: ${error.name}: ${error.message}\n`);
  process.exit(1);
});

const checks = [];
const contract = JSON.parse(await readFile(new URL('./contract.json', import.meta.url), 'utf8'));
async function check(name, run) {
  await run();
  checks.push(name);
}

await mkdir('/state/workspace', { recursive: true, mode: 0o700 });
await mkdir('/state/home', { recursive: true, mode: 0o700 });
await mkdir('/state/tmp', { recursive: true, mode: 0o700 });
const options = {
  cwd: '/state/workspace', sessionDirectory: '/state/session',
  apiKey: 'synthetic-key-no-inference', model: 'synthetic-model',
};

await check('hardened-linux-process', async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.versions.node, '24.22.3');
  assert.equal(process.getuid(), 10001);
  assert.equal(process.getgid(), 10001);
  const status = await readFile('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^CapPrm:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.match(status, /^Seccomp:\s+2$/m);
  await assert.rejects(writeFile('/audit-root-write-probe', 'probe'), { code: 'EROFS' });
});

await check('minimal-container-environment', async () => {
  const allowed = new Set(['PATH', 'PWD', 'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'TMPDIR', 'CURSOR_DATA_DIR', 'LANG', 'TZ']);
  assert.deepEqual(Object.keys(process.env).filter((key) => !allowed.has(key)), []);
  assert.equal(process.env.HOME, '/state/home');
  assert.equal(process.env.TMPDIR, '/state/tmp');
  assert.equal(process.env.CURSOR_DATA_DIR, '/state/home');
});

await check('user-namespace-denied', async () => {
  // A missing executable is a failure, not negative namespace evidence.
  try {
    execFileSync('/usr/bin/unshare', ['-Ur', 'true'], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('user namespace unexpectedly available');
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /Operation not permitted/);
  }
});

const { Agent, JsonlLocalAgentStore, emptyFs, tempFs } = await import('@cursor/sdk');
const { createCursorTextRuntime, CursorTextPolicyUnsupportedError } = await import('@operatorworks/switchboard/cursor');

// This seam belongs to the candidate artifact, not Crew's production runtime.
const { sdk } = await import(new URL('sdk.js', import.meta.resolve('@operatorworks/switchboard/cursor')));
await check('exact-sdk-and-exports', async () => {
  const sdkManifest = new URL('../../package.json', import.meta.resolve('@cursor/sdk'));
  const manifest = JSON.parse(await readFile(sdkManifest, 'utf8'));
  assert.equal(manifest.name, '@cursor/sdk');
  assert.equal(manifest.version, '1.4.2');
  for (const method of [Agent.create, Agent.resume, emptyFs, JsonlLocalAgentStore, createCursorTextRuntime]) {
    assert.equal(typeof method, 'function');
  }
});

await check('real-sdk-rejects-unknown-tool-before-inference', async () => {
  await assert.rejects(Agent.create({
    apiKey: options.apiKey, tools: ['crew-nonexistent-tool-sentinel'],
    local: { cwd: options.cwd, store: new JsonlLocalAgentStore('/state/invalid-tool') },
  }), /Unknown tool name/);
});

await check('empty-virtual-tree-and-observer-positive-control', async () => {
  const sentinel = 'synthetic-host-only-canary';
  await writeFile('/state/host-canary', sentinel);
  assert.equal(await readFile('/state/host-canary', 'utf8'), sentinel);
  const tree = emptyFs();
  await assert.rejects(tree.read('/state/host-canary'));
  await assert.rejects(tree.write('/virtual-only', 'virtual-content'), { name: 'ReadOnlyMountError' });
  const positiveControl = tempFs();
  await positiveControl.write('/virtual-only', 'virtual-content');
  assert.equal(await positiveControl.read('/virtual-only'), 'virtual-content');
  await assert.rejects(readFile('/virtual-only'), { code: 'ENOENT' });
  await assert.rejects(emptyFs().read('/virtual-only'));
});

await check('candidate-create-resume-send-controls', async () => {
  const original = { create: sdk.create, resume: sdk.resume };
  const captured = [];
  const sends = [];
  function handle(agentId) {
    return {
      agentId,
      async send(...args) {
        sends.push(args);
        return {
          supports: () => true,
          async *stream() { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic-reply' }] } }; },
          async wait() { return { status: 'finished' }; },
          async cancel() {},
        };
      },
      async [Symbol.asyncDispose]() {},
    };
  }
  sdk.create = async (launch) => { captured.push({ operation: 'create', launch }); return handle('synthetic-agent'); };
  sdk.resume = async (id, launch) => {
    assert.equal(id, 'synthetic-agent');
    captured.push({ operation: 'resume', launch });
    return handle(id);
  };
  let runtime;
  try {
    runtime = createCursorTextRuntime(options);
    for (const agentId of [undefined, 'synthetic-agent']) {
      const turn = await runtime.start({ text: 'synthetic-input', ...(agentId ? { agentId } : {}), onEvent() {} });
      assert.equal(await turn.finished, 'completed');
    }
    assert.deepEqual(captured.map(({ operation }) => operation), ['create', 'resume']);
    for (const { launch } of captured) {
      assert.deepEqual(Object.keys(launch).sort(), ['agents', 'apiKey', 'local', 'mcpServers', 'model', 'tools']);
      assert.deepEqual(launch.tools, []);
      assert.deepEqual(launch.agents, {});
      assert.deepEqual(launch.mcpServers, {});
      assert.deepEqual(launch.model, { id: options.model });
      const { local } = launch;
      assert.deepEqual(Object.keys(local).sort(), [
        'autoReview', 'customTools', 'cwd', 'dirs', 'enableAgentRetries', 'fs',
        'hostMcpBridgeUrls', 'reportedWorkspacePath', 'sandboxOptions', 'settingSources', 'store',
      ]);
      assert.equal(local.cwd, options.cwd);
      assert.ok(local.store instanceof JsonlLocalAgentStore);
      assert.deepEqual(local.settingSources, []);
      assert.deepEqual(local.sandboxOptions, { enabled: false });
      assert.equal(local.enableAgentRetries, false);
      assert.equal(local.autoReview, false);
      assert.equal(local.reportedWorkspacePath, '/');
      assert.deepEqual(local.customTools, {});
      assert.deepEqual(local.hostMcpBridgeUrls, []);
      assert.deepEqual(local.dirs, []);
      await assert.rejects(local.fs.read('/state/host-canary'));
    }
    assert.equal(captured[0].launch.local.fs, captured[1].launch.local.fs);
    assert.deepEqual(sends, [['synthetic-input'], ['synthetic-input']]);
    assert.equal(runtime.writerGroups, undefined);
  } finally {
    await runtime?.close();
    Object.assign(sdk, original);
  }
});

await check('missing-control-fails-closed', async () => {
  const original = sdk.emptyFs;
  try {
    sdk.emptyFs = undefined;
    assert.throws(() => createCursorTextRuntime(options), (error) => {
      assert.ok(error instanceof CursorTextPolicyUnsupportedError);
      assert.equal(error.code, 'cursor_policy_unsupported');
      assert.equal(error.message.includes(options.apiKey), false);
      return true;
    });
  } finally { sdk.emptyFs = original; }
});

// Success here is offline boundary evidence only. No forced executor call,
// provider transport, Grok result, or Crew API journey has been exercised.
process.stdout.write(`${JSON.stringify({
  ...contract,
  platform: process.platform, arch: process.arch, node: process.versions.node,
  uid: process.getuid(), gid: process.getgid(), checks,
  namespace: { command: '/usr/bin/unshare -Ur true', result: 'denied', errno: 'EPERM' },
  mountinfo: await readFile('/proc/self/mountinfo', 'utf8'),
})}\n`);
