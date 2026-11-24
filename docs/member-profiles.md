# Run a member with a live model

The worker reads its provider configuration from a trusted module on the server.
The built-in module supports Pi on OpenCode Go, Claude on the Anthropic API, Codex with either a ChatGPT subscription or an OpenAI API key, Cursor through the Cursor SDK, and OpenCode through ACP.
The member's spawn request selects one of the configured profile names. Create a
new member to select a different model or engine.

## Configure a live account

The worker reads one setting, `BIRBCREW_LIVE_PROFILES`. Its value is a JSON object
with one entry for each engine this worker serves. Nothing else selects a live
profile. Without the variable, with a value that is not valid, or without the API
key of a configured engine, the worker stops at startup. It never starts with
fewer profiles than the setting names. A Codex subscription has no API key. The
worker reads its sign-in on every turn, and a turn fails when the sign-in is
missing, expired or belongs to another account.

```json
{
  "pi": {"provider": "opencode-go", "account": "ACCOUNT LABEL"},
  "claude": {"provider": "anthropic-api", "account": "ACCOUNT LABEL", "model": "claude-sonnet-4-6"},
  "codex": {"provider": "chatgpt-subscription", "account_id": "CHATGPT_ACCOUNT_ID", "model": "gpt-5.4"},
  "cursor": {"account": "ACCOUNT LABEL", "model": "grok-4.7", "cwd": "/legacy/profile-metadata", "requestTextBytes": 65536},
  "opencode": {
    "account": "ACCOUNT LABEL",
    "model": "provider/model",
    "cwd": "/absolute/workspace",
    "executable": "/absolute/opencode",
    "env": ["OPENCODE_API_KEY"]
  }
}
```

`cursor` and `opencode` are optional. A worker that sets `cursor` reads the API key from `BIRBCREW_CURSOR_API_KEY` and registers `cursor.v1`. A worker that sets `opencode` reads each name in `env` from its own environment and registers `opencode.v1`. That map replaces the child process environment. The spawn argv is `[executable, "acp"]`. These profiles are not copied into tool profiles.

These turns run in the supervisor runner. Production Cursor profiles select
Switchboard's fixed `cursor-text-v1` policy: no model tools, MCP servers, custom
tools, agents, settings sources or retries, an empty virtual filesystem, and
reported workspace `/`. The SDK sandbox is disabled; this lane must work without
user namespaces. Unexpected tool events also fail the turn. This policy isolates
model tool execution; opaque SDK code still has the process's filesystem and
network access. See the [qualification status](cursor-restricted-text-qualification.md)
before advertising deployment support. OpenCode's process is not sandboxed to
`cwd`; its tool, permission, filesystem and terminal requests fail the turn.

Cursor's `cwd` remains required profile/checkpoint metadata. Execution uses a
fresh `workspace` below the private conversation root, alongside its SDK store,
HOME, TMPDIR and CURSOR_DATA_DIR. Crew does not move or delete the old `cwd`.
The credential-free registration probe requires Node 24.22.3, SDK 1.4.2 and the
vendored Switchboard pin, checks exports without inference, and fails with
`cursor_policy_unsupported` before profile or volume registration writes.
It checks that Crew and Switchboard resolve the same SDK installation. The
worker runs this probe at startup; per-turn registration does not repeat it.
A trusted module supplying `runtime` bypasses this production boundary and is
outside its guarantee; `loadLiveProfiles` never supplies one.

The dedicated Cursor runner retains its private environment until process exit.
An abandoned SDK admission can settle after `close()` returns and recreate files
under that private root. Such a turn still has unknown writer inventory and
requires the trusted drain before erasure.

Unknown keys are refused. The setting carries no date and does not expire. The
credentials it points at are real ones and keep their own lifetimes: a provider
can revoke a key, and a Codex sign-in must stay current.

1. `account` is a label you choose for the account, without a secret. The worker
   stores its digest with each registered profile and refuses to start when a
   profile name is already registered for a different label. Keep it stable.
2. For Pi, add the `pi` entry and provide the Go credential in
   `OPENCODE_GO_API_KEY`. Spawn with engine `pi` and profile
   `pi-go-glm-5.3-flash.v1`. Each turn asks the provider for its model list with
   that key before inference and stops when the request fails or the model is
   not listed. The worker checks the returned model identity before saving a
   result. [OpenCode Go model routes](https://opencode.ai/docs/console/go/)
3. For Claude, add the `claude` entry with the exact API model ID and provide the
   Anthropic API key in `BIRBCREW_CLAUDE_API_KEY`. Spawn with engine `claude` and
   profile `anthropic-<model>.v1`. For example, model `claude-sonnet-4-6` gives
   profile `anthropic-claude-sonnet-4-6.v1`.
4. For an OpenAI API-key Codex member, add a `codex` entry with provider
   `openai-api`, an `account` label and the exact GPT model. Provide the key in
   `BIRBCREW_CODEX_API_KEY`. Spawn with engine `codex` and profile
   `openai-<model>.v1`.
5. For a subscription-backed Codex member, use the worker operator's ChatGPT
   sign-in. Run `codex login status` in the operator's environment. If needed,
   run `codex login` and choose ChatGPT. The worker reads the CLI login from
   `auth.json` in `CODEX_HOME` (default `~/.codex`), or in the absolute directory
   named by `BIRBCREW_CODEX_AUTH_HOME`. A login kept in the operating system
   keyring is not read. The worker never writes that directory and never
   refreshes the login, so the directory can be read-only and the CLI that owns
   the login must keep it current. [OpenAI sign-in documentation](https://developers.openai.com/codex/auth/)

   Add a `codex` entry with provider `chatgpt-subscription`, `account_id` set to
   the signed-in ChatGPT workspace ID, and `model` set to a model listed in the
   Codex CLI’s `/model` picker. To display just the workspace ID with the
   repository's pinned Node and dependencies installed, run

   ```sh
   .proof/bin/node --input-type=module -e '
     import { codexSubscriptionHome } from "./src/service/accounts.ts";
     import { readCodexSubscription } from "./src/service/codex-subscription.ts";
     const { accountId } = await readCodexSubscription(codexSubscriptionHome(process.env));
     console.log(accountId);'
   ```

   Spawn engine `codex` with `chatgpt-<model>.v1` for chat,
   `chatgpt-<model>.approval.v1` for protected writes, or
   `chatgpt-<model>.next-step.v1` for human input. Each turn reads the sign-in
   and stops unless it is current and belongs to `account_id`. The native
   session volume stores conversation state; the operator's CLI manages the
   subscription login separately.
6. For Cursor, add the `cursor` entry with the account label, the SDK catalog
   model ID and an absolute `cwd` metadata value. Use `grok-4.7` only when the
   account's SDK catalog lists it; CLI effort variants are not SDK model IDs.
   Provide the key in `BIRBCREW_CURSOR_API_KEY`. Spawn with engine `cursor` and
   profile `cursor.v1`. Optional `requestTextBytes` is an immutable registered
   input limit; omit it for the existing default. Each conversation accepts one
   input identity and starts a fresh agent. No checkpoint resume or second turn
   is enabled.
7. For OpenCode ACP, add the `opencode` entry with the account label, the caller
   model id, absolute `cwd` and `executable`, and the environment variable names
   the child needs. Spawn with engine `opencode` and profile `opencode.v1`.
8. Start the worker with the service database, Temporal address, and absolute
   durable state directory configured.

   ```sh
   npm run members -- worker src/service/providers.ts
   ```

Restart the worker to change the setting or to rotate a provider key. Pi, Claude,
and Codex require independent live-account acceptance using the intended account
and model.

### What replaced provider attestations

Earlier releases read a dated owner statement for each account
(`BIRBCREW_PI_ATTESTATION`, `BIRBCREW_CLAUDE_ATTESTATION`,
`BIRBCREW_CODEX_ATTESTATION`) and refused live turns when it was more than 12
hours old. Those variables and files are no longer read. An old, expired or
missing statement has no effect.

| Statement field | Now |
| --- | --- |
| `provider`, `model`, `account_id` | Explicit in `BIRBCREW_LIVE_PROFILES`. |
| `account_path` | The `account` label. Use the same text to keep registered profiles. |
| `extra_usage_disabled`, `eligible_coding_use`, `approved_sdk_use` | Not asserted by anyone. No code ever checked them against the provider. Keep overage billing off in the provider's console. |
| `checked_at`, `evidence` | Removed. No statement expires. |

The credential checks did not change: the API key variable or the Codex sign-in,
the Go model list on each Pi turn, the returned Go model identity, and the
ChatGPT account on each Codex turn. Request limits did not change either: no
SDK retries, 1200 output tokens for Pi, and the member's
[usage budget](usage-metering.md).

## Verify the profiles offline

With the project's Node version and dependencies installed, run
`node --test tests/service/providers.test.ts`. The suite uses synthetic keys and
a loopback HTTP server. It checks that only the explicit setting selects
profiles, that each engine needs its own credential, that a leftover attestation
file that is absent, expired or invalid changes nothing, the model ID in both directions, redirect
refusal, a refused key, and Pi's session headers across checkpoint restore.

## Approve a protected work item

Profiles ending in `.approval.v1` add the host-owned `record_work_item` tool.
For example, select `fixture.approval.v1` for a local test or
`pi-go-glm-5.3-flash.approval.v1` for the Pi account that the `pi` entry of
`BIRBCREW_LIVE_PROFILES` configures. Each member
retains the account, tools and native storage associated with its selected
profile. A worker registering different settings for that name is rejected.

For the fixture, submit `record <request UUID>` as the turn text. While the
turn waits, use `npm run --silent members -- pending` in another terminal.
Supply the owner ID and conversation ID as a JSON object on standard input.
The returned approval includes the native call ID, a public summary, and a
digest of the private arguments.

To submit a decision, pass its ownerId, memberId, conversationId, requestId,
invocationId, nativeCallId, approvalId, version and argumentDigest to
`members -- decide` with `choice` set to `approve` or `deny`. To cancel while
waiting, pass ownerId, conversationId and requestId to `members -- cancel-pending`.
Each command reads a single JSON object on standard input. The original turn
finishes after the same SDK receives its native tool result. A retry of the
same decision returns the recorded choice.

## Delegate tasks from a Pi member

Spawn a Pi member with the `fixture.crew.v1` profile to try delegation locally.
For example, submit the following text as a turn.

```text
delegate [{"role":"analyst","task":"recall"},{"role":"recorder","task":"record assigned cedar"}]
```

The parent may assign up to two tasks in one turn. Each child runs in its own
Pi coding session with a pinned role, model and tool list. An analyst receives
only its task. A recorder can request the same work-item approval as the parent.
Use the invocation and approval IDs from the pending list to answer the intended
child. The entire turn has one work-item budget. The parent receives both
results in its original call order, even when the second child finishes first.

Use `members -- cancel-pending` with the parent request ID to cancel active and
waiting children. With the `pi` entry of `BIRBCREW_LIVE_PROFILES`, the live
Pi profile that delegates is `pi-go-glm-5.3-flash.crew.v1`.

## Answer a next-step question

Profiles ending in `.next-step.v1` give the member the `choose_next_step`
tool. For the local fixture, spawn a Claude or Pi member with
`fixture.next-step.v1`, open a conversation and submit `next step`. The turn
waits while the worker releases the SDK process. Another worker can continue
it from the saved native call.

Use the same `members -- pending` and `members -- decide` commands above.
Copy the pending call's identity fields and set `choice` to `inspect` or
`test`. The SDK receives that word as the tool result. A repeated answer
returns the recorded choice. A different answer conflicts. Cancellation
while waiting returns a cancelled tool result. Neither path creates a work item.

## Run the account acceptance proof

After `scripts/setup --mode fixture`, run the following command on a supported Linux host with Docker and the pinned Node and Temporal binaries. Select one account per run. The ten-minute deadline covers service startup and the provider journey.

```sh
.proof/bin/node tests/proof/live-members.ts --engine pi --approval /absolute/private/pi-proof.json
```

With the pinned Node on `PATH`, `npm run test:live -- --engine pi --approval /absolute/private/pi-proof.json` runs the same entry. The runner uses `.proof/bin/temporal` unless `TEMPORAL_CLI` names the pinned executable elsewhere.

The approval is the owner's decision to spend up to `max_requests` provider requests on one run. Use a private file owned by the invoking user outside the checkout (`chmod 600`). Give each newly approved journey its own `approval_id` UUID. Specify `approved_live_proof: true`, `max_requests` as an integer from 1 through 24, the account fields from the table below, and the exact endpoint and model. Unknown fields are refused. The approval carries no date and does not expire; to withdraw it, change or remove the file. The first provider submission permanently reserves the approval in the invoking OS user's private `~/.local/state/birbcrew/live-proof-claims` directory. Use each approval on the machine where it was granted. Concurrent or repeated invocations, including after an interruption, require a fresh owner-approved UUID. Keep this directory across restarts. The request limit covers provider model discovery, token counts and SDK retries as well as inference. For API-key providers, supply the credential through the selected environment variable. For a ChatGPT subscription, use the operator’s Codex login.

| Engine | Provider and credential | Endpoint and model | Account field |
|---|---|---|---|
| `pi` | `opencode-go` / `OPENCODE_GO_API_KEY` | `https://opencode.ai/inference/go/openai/v1` / `glm-5.3-flash` | `account` label |
| `claude` | `anthropic-api` / `BIRBCREW_CLAUDE_API_KEY` | `https://api.anthropic.com` / exact Claude model ID | `account` label |
| `codex` | `chatgpt-subscription` / Codex ChatGPT login | `https://chatgpt.com/backend-api/codex` / a GPT model | the signed-in `account_id` |
| `codex` | `openai-api` / `BIRBCREW_CODEX_API_KEY` | `https://api.openai.com/v1` / exact GPT model ID | `account` label |

A subscription proof uses the same Codex verifier command with its own approval:

```sh
.proof/bin/node tests/proof/live-members.ts --engine codex --approval /absolute/private/codex-subscription.json
```

The verifier creates a disposable database, Temporal server, authenticated gateway and worker. Two independent observation clients compare their histories with the gateway. The verifier approves one synthetic work item, checks the provider's returned receipt, replaces the worker container and asks the member to recall a random marker. Pi also delegates to a separate analyst. Codex checks the native rollout contains exactly the two submitted user messages on the same thread.

A private loopback relay signs provider requests, rereads the approval before each upstream request and enforces the model, official route and request limit. The worker presents a disposable credential to that endpoint. API-key Codex uses the stock OpenAI provider and its HTTP Responses fallback. Subscription Codex uses ChatGPT’s Codex Responses endpoint and the approved workspace header. The hosted verifier keeps the operator’s login on the host. The verifier does not check billing or any console setting, and its result says so. The command emits one redacted JSON result and removes its private transcripts and service state. A nonzero exit marks an incomplete gate. To rehearse all three journeys with synthetic accounts and local responses, run `PATH="$PWD/.proof/bin:$PATH" node --test tests/proof/live-controlled.test.ts tests/proof/live-native-controlled.test.ts`.


## Configure named child destinations

Use a new parent profile name when first enabling named delegation. Add fixed role destinations to the trusted profile module before the first worker registers that name. Both profiles must exist in the same exported map.

```ts
profiles.set("research.v1", {
  accountId: "parent-account",
  pi: parentPiOptions,
  delegateTask: true,
  childTargets: {
    pi: { analyst: { engine: "pi", profile: "analysis.v1" } },
  },
});
profiles.set("analysis.v1", {
  accountId: "analysis-account",
  pi: analystPiOptions,
});
```

Start workers for both profiles, then spawn a Pi member with `research.v1`. Its spawn response and member listing include `subagents`. Confirm the destination model, provider host, and account digest before submitting work. Availability is `executable` for an active Pi-to-Pi role, `unsupported_engine` for a future engine combination, or `removed` after removal. Availability does not report worker liveness. The client accepts an absent `subagents` field from an older v1 server as legacy with no named targets.

Use `recorder` only when both parent and target have `protectedTool: "record_work_item"`. Analyst has no tools. Named child targets do not need `delegateTask`. Children cannot delegate further. The runner and HTTP schemas accept no destination override.

To remove a role, publish an explicit narrower map. Use `childTargets: { pi: {} }` to remove all named roles for a Pi parent. Omitting the engine's declaration leaves existing authority unchanged. A stale configuration that names an original removed role can start, but cannot restore that role. Changing an original destination or adding a role fails registration, even after removal. Use a new parent profile name for either change.

Keep target configurations available for recorded children after removal. Ready children and approval resumes use their recorded identity. Changing the target's model, provider host, account, or engine prevents the next provider call. The identity uses canonical `URL.host`, including a non-default port. It excludes scheme and path. Endpoints containing userinfo, query, or fragment are refused.

For proxy profiles, use `createProxyProfile`. It captures immutable `upstreamIdentity` from the same copied endpoint and model used by the relay. It also binds that metadata to the local relay host. Registration never calls credential or transport callbacks. Operator-authored transport code and identity metadata remain trusted. A custom callback's honest routing cannot be proved by metadata. Unknown routing fails registration.

Before upgrading to migration 037, inventory nonterminal historical targeted children:

```sql
SELECT child_id, conversation_id, request_id, phase
FROM birbcrew_ts.pi_children
WHERE role_profile ? 'target'
  AND NOT (role_profile->'target' ? 'version')
  AND phase NOT IN ('complete', 'failed', 'cancelled');
```

Finish or reconcile those children under the prerequisite release, or explicitly accept that the new release refuses their launch. Their original provider identity is unknown. The migration preserves their stored data for inspection and settlement.

Drain native calls before the upgrade. Migration 037 needs exclusive locks on profiles, members, and children. It retries `NOWAIT` acquisition for up to 60 seconds and rolls back the migration if those tables stay busy. Retry after the calls drain. This does not change model or approval deadlines.

After restoring a backup, reconcile outstanding work through the existing recovery procedure. Activation permanently removes all named roles under restored profile names. It also globally disables delegation and permanently retires unfinished restored children without changing their sealed identity. Matching workers reconcile those children as failed, or cancelled when request cancellation already applies. Re-enabling delegation permits future children only. Create a new parent profile name to enable new named delegation, then use the private [delegation-control CLI](delegation-control.md#re-enable-future-delegation). Backups do not retain removals made after the backup was captured.

Text profiles can configure `requestTextBytes`. See [request text limits](request-text-limits.md) for configuration, discovery, and qualification.
