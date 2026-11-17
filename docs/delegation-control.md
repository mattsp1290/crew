# Disable delegation and confirm its drain

Use the private operator CLI to stop delegation globally or for one exact engine
and profile. Run it from the Crew checkout or service image with
`BIRBCREW_DATABASE_URL` set to the application database. Apply migration 038 with
the matching gateway, worker, or members CLI first. The delegation-control CLI
does not run migrations.

This procedure is for a single-user installation reached through private
Tailscale or NetBird access. Keep database credentials, command files, receipts,
and diagnostics private. There is no public administration route or model tool
for these commands. They do not change gateway bearer-token scope.

## Record the current revision

Run the following command:

```sh
npm run --silent delegation-control -- status
```

The JSON result contains `installationId`, `instanceId`, `recoveryPhase`,
`revision`, `globalEnabled`, and `disabledTargets`. Keep `revision` as a decimal
string. A newly migrated installation starts at `"0"`, with `globalEnabled: true`
and no disabled targets. An upgraded installation gets the same initial state
when migration 038 first creates the control row.

Use the current revision in each new change. `expectedRevision` is a
compare-and-swap check against the installation-wide revision, including changes
to other targets. A successful new command increments that revision even if the
requested setting already has that value. Changes require an active recovery
instance. Finish the [recovery procedure](coordinated-recovery.md) before changing
a frozen or restored instance.

`status` and `change` access PostgreSQL only. They do not open a Temporal
connection or read Temporal TLS files. Use them to inspect or close admission
while Temporal is unavailable.

## Disable admission

Generate a fresh command UUID, for example with `node -p 'crypto.randomUUID()'`.
Save a command file in private operator storage. This is a complete global
disable command. Replace the example UUID, revision, actor, and reason before use:

```json
{
	"commandId": "741ad48c-c698-4e3b-9d30-b022290ed352",
	"expectedRevision": "0",
	"scope": { "kind": "global" },
	"enabled": false,
	"actor": "private-operator",
	"reason": "Drain delegation before application rollback"
}
```

To disable one destination, use its exact engine and registered profile name.
This is a complete target command:

```json
{
	"commandId": "daeaef30-a34e-41cb-a7aa-1ad5d598f39b",
	"expectedRevision": "1",
	"scope": {
		"kind": "target",
		"engine": "pi",
		"profile": "pi-go-glm-5.3-flash.crew.v1"
	},
	"enabled": false,
	"actor": "private-operator",
	"reason": "Retire children for this destination profile"
}
```

Use `pi`, `claude`, or `codex` for `engine`. A target identifies the child's
destination, not the parent profile or a role alias. The profile string must be
nonempty and at most 128 UTF-8 bytes. `actor` and `reason` must be nonempty, with
limits of 256 and 1,024 UTF-8 bytes. All three strings must contain valid Unicode
and no NUL. The revision accepts `"0"` through `"9223372036854775807"`, without
leading zeros. JSON numbers, unknown fields, and incomplete command objects are
refused. `enabled` must be a JSON boolean.

Submit the saved file and retain the result:

```sh
umask 077
npm run --silent delegation-control -- change \
	< /private/crew-control/disable.json \
	> /private/crew-control/disable-receipt.json
```

The receipt contains `commandId`, `installationId`, `instanceId`, `revision`,
`scope`, and `enabled`. Keep the command and receipt together. If an acknowledgement
is lost, retry the identical command with the same UUID. The retry returns the
original receipt without another mutation. Reusing that UUID with different
content is refused. A command from a previous recovery instance is also refused.
For a stale revision on a new command, read `status` again and submit a new UUID
with the current revision.

A refused or unavailable operation exits with code 1 and a generic JSON error
on stderr. Keep private operator and service diagnostics for investigation. The
CLI does not echo rejected command fields or connection details.

Disabling admission commits an immutable cohort of selected children. The cohort
includes unfinished children and completed children whose parent result or native
stop remains incomplete. Fully settled history is excluded. An unreadable child
destination is included conservatively, even for a target disable.

Unfinished children in the cohort are permanently retired. Their existing native
generations receive stop requests. Database guards refuse new child admission,
launch reservations, approval changes, protected effects, and successful child
completion after retirement. Work committed before the disable stays committed.
An approved recorder's effect receipt remains available for replay.

Keep matching workers running so they can reconcile the cohort. A retired child
settles as failed unless request cancellation already requires a cancelled
outcome. Reconciliation closes an unanswered approval card without inventing an
owner decision. A disable receipt alone does not prove that a native process has
stopped or that the parent has received the result.

## Observe the drain

Run `drain` with the UUID from the disable receipt:

```sh
npm run --silent delegation-control -- drain 741ad48c-c698-4e3b-9d30-b022290ed352 \
	> /private/crew-control/drain.json
```

Configure the same Temporal address, namespace, and TLS settings as the workers.
`drain` observes PostgreSQL and Temporal. It does not run reconciliation or wait
until work finishes. Repeat the command while matching workers make progress.
A successful CLI exit means that an observation was returned. Require
`complete: true` in that observation before treating the cohort as drained.

Check that the result has `kind: "observed_snapshot"`, `valid: true`,
`admissionClosed: true`, `complete: true`, and an empty `blockers` array. Preserve
the result with its `startedAt`, `completedAt`, and receipt. Completion requires
terminal child rows, closed retired-child cards, closed child workflows,
committed parent replies, observed parent follow-up results, and confirmed native
stops. A terminal database row or an accepted workflow signal is insufficient.

Use each blocker to decide what remains:

- For `child_pending` or `card_open`, keep the worker reconciliation loop running
  and inspect its private diagnostics.
- For `child_workflow`, inspect the recorded child execution. `not_started`,
  `missing`, `unavailable`, `unknown`, and an open execution all block completion.
- For `parent_pending` or `parent_workflow`, wait for the parent follow-up to commit
  and for Temporal to observe the matching result. A missing or unknown workflow
  does not establish completion. Some of these blockers never clear; see
  [blockers that never clear](#blockers-that-never-clear).
- For `native_unconfirmed`, establish that every listed launch token has stopped
  through the supported native reconciliation path. Do not substitute a process
  restart or a manually changed database flag for that evidence.
- For `sibling_pending`, inspect the unaffected child listed in `siblings`.
  A target disable leaves other destinations eligible, but the shared parent still
  needs their results. Let that sibling finish, or issue a global disable with a
  fresh UUID and current revision, then drain the new receipt.
- For `target_unreadable`, keep delegation disabled for operator investigation.
  The command does not invent a destination or silently omit the child.
- For `control_changed` or `admission_open`, inspect the current control state.

### Blockers that never clear

Waiting does not clear three kinds of blocker:

- A parent turn that ended `uncertain` reports `parent_pending`. An uncertain
  turn never returns to `committed`.
- A parent run whose history Temporal no longer retains reports
  `parent_workflow` with `missing`. This includes delegations made before
  migration 038 and every delegation restored by a coordinated restore, unless
  a worker observed the history before it expired.
- A native launch left unstopped by a worker that was killed or lost PostgreSQL
  during teardown reports `native_unconfirmed`. Only the supervisor's own
  teardown records a stop.

Each disable selects every child of such a request again, including finished
children, so no later disable that covers it can report `complete: true`. Crew
offers no override, because none of these states proves that delegated work and
its effects have ended. List the requests that can block a drain, read-only:

```sql
SELECT d.conversation_id, d.request_id, t.phase,
       birbcrew_ts.delegation_parent_result_observed(d.conversation_id, d.request_id) AS observed,
       EXISTS (SELECT 1 FROM birbcrew_ts.native_launches n
               WHERE (n.conversation_id, n.request_id) = (d.conversation_id, d.request_id)
                 AND NOT n.stopped) AS unstopped_launch
FROM birbcrew_ts.delegations d
JOIN birbcrew_ts.turns t USING (conversation_id, request_id)
WHERE t.phase <> 'committed' OR d.resume_activity_id IS NULL
   OR NOT birbcrew_ts.delegation_parent_result_observed(d.conversation_id, d.request_id)
   OR EXISTS (SELECT 1 FROM birbcrew_ts.native_launches n
              WHERE (n.conversation_id, n.request_id) = (d.conversation_id, d.request_id)
                AND NOT n.stopped);
```

Rows that keep a running worker busy can still clear. Rows with an uncertain
phase, rows whose parent stays `missing` while workers run, and unstopped
launches with no live worker cannot. Run this soon after upgrading, while
workers can still observe recent histories, and before relying on a drain.
  Drain requires a current disable receipt for the same installation, recovery
  instance, and revision, with recovery phase `active`.

The observation starts with a repeatable-read database snapshot, checks Temporal,
then reads control state again. Any intervening control revision, recovery phase,
or instance change invalidates it. An enable receipt and a superseded disable
receipt cannot produce a complete drain. A later command also makes a previously
saved observation stale. If necessary, issue a new disable command and drain its
new cohort. Do not reuse an old result as a lasting certificate of quiescence.

## Inspect worker reconciliation

The worker starts a reconciliation pass immediately and retries every two
seconds, without overlapping passes. Each pass examines at most four retired
children and, independently, four historical delegation requests. Separate
cursors advance past pending and already-observed requests so later requests
receive attention. Retirement survives worker restart and later enable commands.

The worker records parent observation only after Temporal confirms the exact
committed reply for the recorded workflow run and resume activity. The database
accepts that evidence only for the current active installation and recovery
instance. A completed child, a committed reply, and stopped native processes do
not establish parent observation. Disable commands include matching children
whose parents lack this evidence, including children that already finished.
Missing or unrecognized historical workflow evidence remains a conservative
drain blocker without suppressing worker heartbeats. A history read that fails
for another reason fails the control pass.

A drain can use recorded parent evidence when the exact reply, workflow run,
resume activity, and recovery instance still match. The drain remains read-only.
It independently checks child workflows and native stops. Recording parent
observation never removes children from an existing receipt's cohort.

Inspect stderr for `delegation_control_pending`, which includes child settlement
and wake results, or `delegation_control_failed`, whose `source` is
`reconciliation` for a failed pass or `pool` for a failed idle controller
connection. An unavailable Temporal wake or either failure suppresses heartbeat
touches until a later healthy pass. A pending native stop can log `delegation_control_pending`
while the heartbeat continues. A missing workflow wake also does not suppress
the heartbeat. Use `drain` to check completion.

The heartbeat advances every five seconds only while all Temporal workers report
`RUNNING` and a healthy reconciliation pass completed within the last 60 seconds.
The first touch waits for a successful pass. A long-running pass cannot keep an
old success healthy indefinitely. Follow the
[worker health instructions](persistent-deployment.md#worker) for probe setup.

The controller uses a separate database pool with two connections. Connection
acquisition times out after five seconds, SQL statements after ten seconds, and
client queries after twelve seconds. These limits apply to individual operations,
not the whole pass or native SDK execution. Shutdown waits for the current pass
and closes its pool. Native work keeps its existing database settings.

## Re-enable future delegation

Read `status`, generate a new command UUID, and submit the same complete command
shape with `enabled: true` and the current revision. Global and target settings
compose. Global enable leaves disabled targets disabled. Target enable removes
that target's restriction but cannot override a global disable.

Re-enablement admits future eligible children only. It never removes cohort
membership, clears retirement, reopens a card, or revives an old child. Profile
consent, sealed destinations, recovery admission, and other existing checks still
apply.

After a restore, activation creates a new global disable command for the new
instance and permanently retires unfinished restored children in the same
transaction. Restored parent observations belong to the previous instance and
cannot establish observation for the new instance. Matching workers must observe
the parent histories again. A restored parent whose history Temporal no longer
retains becomes a permanent blocker; see
[blockers that never clear](#blockers-that-never-clear). Old enable commands
cannot return a valid receipt for that instance. Keep ingress disabled while workers reconcile those children.
Re-enable only future work after reconciliation. Named roles removed by restore
activation also require a new parent profile name, as described in
[named child destinations](member-profiles.md#configure-named-child-destinations).

## Upgrade or roll back with retained state

Before upgrading, stop every previous-release worker, gateway, and CLI process,
including scheduled jobs. Migration 038 runs in the migration transaction under
the existing advisory lock. It creates the control tables and installs triggers
on child, approval, effect, and native-launch tables. It uses normal PostgreSQL
DDL locks without a migration-specific `NOWAIT` retry loop. A transaction that
still uses those tables can delay migration. Do not run old and new pollers
together.

For an application rollback with the upgraded database, the accepted rollback
floor is commit `f3327346d979270a18c9f46b9cfe6a075b1cb157`.
Use this sequence:

1. While the new application still runs, submit a global disable and save its
   receipt.
2. Keep its workers running until an actual `drain` observation for that receipt
   reports `complete: true`. Resolve every blocker first. If a
   [blocker never clears](#blockers-that-never-clear), this rollback is not
   qualified for that installation.
3. Stop all Crew pollers, workers, native descendants, gateways, and CLI processes,
   including scheduled jobs, before starting the older application.
4. Retain the application database, Temporal persistence, and native state. Keep
   migration 038, its guards, command history, cohorts, and retirement records.
5. Start only the accepted older application against that retained state. Keep
   delegation globally disabled throughout the rollback.

Do not delete schema-version rows, undo the control tables, or restore only one
store to make an older application start. This procedure makes no compatibility
claim for arbitrary older versions. It is separate from a coordinated restore,
which requires the application and state pins recorded in the recovery manifest.
Do not use the older release to activate a restored snapshot while relying on
delegation control. Its restore activation lacks the new global disable and
retirement policy. Perform that recovery with the matching new release.

The retained-state rollback fixture exercises Pi against the exact accepted
older commit with delegation globally disabled. It retains the database and
Temporal persistence, verifies Pi checkpoint continuation, and replays six
histories with the older workflow code. It does not qualify Claude or Codex
native filesystem rollback, arbitrary older releases, or restore activation.

The selected PostgreSQL dump-and-restore case checks delegation retirement and
instance authority. Whole-installation coordinated restore with native teardown
and workflow recovery remains unqualified. SQL race checks alone do not establish
those behaviors.
