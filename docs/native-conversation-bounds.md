# Native conversation bounds

Temporal Continue-As-New changes execution history, not the model's context.
The member service retains the logical conversation and resumes the same engine's
native checkpoint. It does not summarize, truncate or translate native history.

## Finite admission and state budgets

- At most 128 application turns per logical conversation, enforced by the member
  workflow and database. Pi also validates at most 128 completed native turns.
- Application input: 16 KiB; committed reply: 64 KiB; serialized checkpoint: 4 MiB.
  Pi checks the serialized checkpoint before rebuilding its in-memory session.
- Claude original JSONL transcript: 32 MiB, checked before the SDK reads it;
  its parsed transcript is also limited to 32 MiB. Missing, linked, duplicate or
  oversized original transcript files fail closed. Transcript discovery is capped
  at 4096 directory entries.
- Codex original rollout: 32 MiB, checked before reading. Its existing identity,
  path, file-type and digest checks still apply.
- The transcript bounds are admission and completed-checkpoint bounds, not a
  filesystem quota during a running native call. The normal activity runtime
  deadline remains in force. Operators must also supply disk quotas where needed.

These are byte limits, not a promise that every configured model accepts this
much context. A provider can reject a shorter history for its own token limit.
That error does not trigger history truncation, a new native session or an
unapproved summarization request. Temporal rollover alone does not qualify
native compaction. Pi explicitly disables compaction and provider retry; Claude
and Codex retain their pinned SDK behavior. Forced native compaction is not
qualified by this change.

Existing per-turn guards remain: Claude permits one SDK turn for chat or at most
three for a protected tool continuation; Pi permits one proposal followed by its
authorized continuation (delegation at most two children); the application still
owns tool approval and durable effect receipts. Text output is capped at 64 KiB.
The proxy Pi profile requests at most 4096 output tokens. These controls are not a
universal live-provider spend limit: use operator-enforced account/model budgets
for live inference.

## Validation

`node --test tests/service/native-limits.test.ts` checks early rejection of raw
oversized, linked and oversized serialized history. `npm run test:proxy` restores
and recalls the same original session for twelve turns independently on Claude,
Codex and Pi, using local protocol fixtures and no real credentials. It also keeps
its original tool, renewal, error and cancellation tests. The native checks of all
three engines require Linux with Landlock (ABI 4+ for Codex, ABI 3+ for Claude and
Pi), Node 24.22.3 and a C compiler: Pi's SDK also runs in the launcher-confined worker.

This native test is separate from Temporal rollover/replay qualification. A
successful fixture run is not live-model acceptance or evidence of forced
compaction behavior.
