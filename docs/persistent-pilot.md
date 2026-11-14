# Approved documentation delivery pilot

Birbforge owns approval and the delivery workflow. Crew runs four versioned Temporal activities on the subscription-authenticated executor host. Three author an approved documentation change, obtain an independent review from the installed reviewer, and publish the reviewed commit as a draft GitHub PR. They do not merge or deploy it. The fourth, `birbcrew.check_review_recovery.v1`, is read-only: it reports whether a stored legacy review was misclassified and is eligible for recovery.

The public contract is generated from `execution/contract.py` into `contracts/execution.v1/schema.json`. Approval binds an immutable goal record, its content digest, repository, base commit, installed policy revision, exact documentation paths and trusted acceptance identifier. Birbforge computes the offer digest and clients echo it. Digests use UTF-8 JSON with sorted object keys, no insignificant whitespace and unescaped Unicode. Contract offers contain no floating-point values. The installation selects one record from a dedicated Beans hub; it must not read the owner's default hub or reuse `FixtureHub` as a live adapter.

## Persistent processes

Run the idempotent migration once with the database migration identity.

```sh
BIRBCREW_CONFIG=/private/crew.json python -m birbcrew.migrate
```

Every file named by `BIRBCREW_CONFIG` must set `mode`, including the migration and executor store files. There is no default, and a file without it fails to load. Run the API alongside Birbforge's loopback gateway. Set `mode` to `approved-goal`. This mode stores owner-scoped conversations without starting the synthetic conversation workflow or invoking an OpenCode model. Existing proof modes remain separate.

```sh
BIRBCREW_CONFIG=/private/crew.json python -m uvicorn birbcrew.api:app --host 127.0.0.1 --port 8000
```

Run the activity worker on the host containing the existing managed Codex daemon and, when the Claude reviewer is selected, the Claude subscription login. [The in-cluster executor](in-cluster-executor.md) describes the container image and the OpenCode Go reviewer.

```sh
BIRBCREW_CONFIG=/private/executor-store.json BIRBCREW_EXECUTION_CONFIG=/private/execution.json python -m birbcrew.execution.worker
```

The worker registers activities only. It does not start another scheduler or manage the Codex daemon lifecycle. `Settings` supports an explicit Temporal namespace and optional mTLS CA, client certificate, private key and server name. The executor database role needs only SELECT, INSERT and UPDATE on `execution.operations`. API storage and Temporal persistence use separate roles.

`ExecutionSettings` is the private installation contract. All binary, checkout, artifact and worktree paths are absolute. The one repository binding contains the exact GitHub remote, base branch, allowed Markdown paths and acceptance command. `reviewer` selects exactly one review engine: `{"kind": "claude"}` or `{"kind": "opencode-go", ...}`. When it is absent, the Claude reviewer is selected, so an existing configuration keeps its behavior. `claude` is required with the Claude reviewer and rejected with any other reviewer. There is no fallback between engines. The optional `codex_socket` is passed to `codex app-server proxy --sock`. The client cannot submit a shell command or choose an execution host. Acceptance runs the installed command, never a script from the candidate. Set the command to a trusted check for the intended document, including its length and required topics. Its output is retained privately.

## Recovery and cancellation

Each of the three delivery activities claims `(kind, operation_id)` before effects. A changed payload conflicts. A repeat reconciles the same identity. Author checkpoints use whole-record compare-and-swap, so two attempts cannot both freeze the candidate or overwrite a terminal result. The claim, known thread and turn remain durable in PostgreSQL.

A lost turn-start reply is reconciled only against the new, owned thread. Exactly one turn can be adopted. Zero or several turns leave uncertainty; the activity never blindly submits a replacement turn. A worker shutdown is not a cancellation request and must not interrupt the daemon. Interrupted preparation or candidate freezing also leaves uncertainty instead of repeating an ambiguous mutation.

A daemon `interrupted` turn does not confirm that its shell children stopped. Cancellation sends an interrupt and observes the owned turn, then remains uncertain because this daemon interface supplies no process-stop boundary. An idle interval or an empty open-file listing cannot confirm cancellation. Retain the author scratch directory for operator reconciliation. Do not reuse or delete it based on a terminal turn label.

Candidate creation does not require a claim that the author stopped writing. The author writes only in a separate detached scratch worktree. The trusted worker captures the allowed document bytes with no symlink traversal and rejects observed changes during capture. It copies those bytes into a separate candidate worktree outside the author's writable roots. Acceptance runs there. The worker verifies that the accepted and committed bytes match the captured bytes. Review and publication use only that candidate worktree and exact commit. A late write to the retained scratch cannot change the candidate. This is a trusted-owner documentation pilot, not hostile-code isolation or a process containment claim. The executor's subscription credentials are not suitable for arbitrary untrusted workloads.

The trusted worker checks exact changed paths, regular nonexecutable files, no symlink traversal and the unchanged base. It records each worktree Git directory and `.git` marker privately before exposing the author scratch. Every later Git command verifies that marker, selects the recorded Git directory explicitly, and disables hooks and filesystem monitors. Retain these Git identity records with the private execution artifacts.

Before creating a candidate, the worker rejects recognizable private-key headers and GitHub, OpenAI, Anthropic, Slack, AWS, JWT and age credential formats. This deterministic check does not detect every secret or restrict what the author can read. It supports the bounded, trusted-owner documentation goal; it is not a general data-loss prevention system. Independent review receives the exact diff with text conversion and external diff disabled. Claude has no tools or MCP servers, hooks are disabled, and API/provider environment overrides are removed so the normal subscription login is used. OpenCode Go receives the same prompt as one Chat Completions request whose only tool is the required verdict schema; output is not retried. Its structured verdict is persisted once. A lost review reply never causes another reviewer invocation.

Publication verifies the stored author and review receipts, clean candidate SHA, explicit installed remote, deterministic branch and ownership marker. It uses a normal push. Existing PR lookup includes closed PRs. Before a new push, the worker fetches the installed base branch tip and requires the approved base commit to be its ancestor. A foreign or closed PR blocks a fresh publication attempt. After publication has started, any conflicting or malformed readback remains uncertain and does not write a terminal receipt. A lost create reply reconciles the matching open draft rather than creating another. User-visible review summaries contain bounded findings; full evidence stays private.

After restoring a database, keep dispatch disabled until an operator reconciles known worktrees, daemon threads and remote branches/PRs. Do not treat an absent restored journal row as proof that no external work happened. Existing work without a matching record stays uncertain. Storage backup and restoration are installation gates, not claims made by these local tests.

## Verification

Run `uv run --group dev pytest` and `uv run --group dev ruff check src tests`. The execution tests exercise actual temporary Git repositories, PostgreSQL concurrent claims, Temporal activity-worker restart, strict receipt binding, lost turn and publication acknowledgements, and a live shell that writes after a simulated terminal label. The PostgreSQL checks require local binaries. The Temporal test uses `TEMPORAL_TEST_SERVER` or `/opt/homebrew/bin/temporal`.

Injected daemon and GitHub responses establish failure handling, not live provider or device acceptance. The persistent installation must separately prove the actual Codex subscription journey and the selected reviewer's live call, exact draft PR, service recovery, and shared physical-phone/Mac controls. Fixture checks do not establish k3s candidate verification or native candidate isolation.

Build the container with digest-pinned `PYTHON_IMAGE` (Python 3.13 Debian slim) and `UV_IMAGE` build arguments. The Dockerfile installs the frozen dependency lock under `/venv` and runs as UID/GID 10001. Runtime configuration and credentials are mounted privately and excluded from the build context.

## Recent conversations

Conversation listing orders owner-scoped results by persisted activity. Creation, new events and changed snapshots advance activity. Reads and replayed writes do not. The additive migration gives existing conversations the same initial timestamp; those ties sort by identity until new activity occurs. Temporal-only delivery progress and opening a conversation do not change this ordering. Clients may show the first five of the bounded list.

## Independent review retry

An owner can request another review only after a confirmed terminal inconclusive receipt. Numbered attempts retain the frozen candidate, original author receipt and earlier reviews. A specific Claude CLI usage-credit error can fall back once to Sonnet through the existing subscription. The OpenCode Go reviewer has no model fallback. A valid rejection never triggers fallback. The English error classifier fails closed if the CLI changes its wording; check it when upgrading the installed CLI. Model labels in private evidence report what the CLI or provider returned and are not independent model attestation.

Worker loss or an interrupted claim does not establish a stopped reviewer. Unconfirmed attempts require operator reconciliation; do not manufacture a terminal receipt or blindly start another reviewer. Deploy the updated Crew activity worker before a Forge workflow that sends numbered attempts.
