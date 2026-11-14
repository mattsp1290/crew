# Quiesced installation recovery (v1)

This is an operator-controlled **stop-the-world** recovery protocol, not live
snapshots, arbitrary-clone detection, or exactly-once external effects after
restoring old state. It deliberately holds the entire installation until the
operator has reconciled possible effects and lost acknowledgements.

## State inventory: one generation, not one database

Keep all of the following at the same quiesced boundary:

| Artifact | Required contents |
| --- | --- |
| `application-postgres` | Entire Crew application database: schema/version table, members/profiles, volume identities and account digests, conversation mappings, native checkpoints, admissions/turns, effect and delivery receipts, decisions, observation snapshots/events/cursors, append-only audit events, standing grants, conversation handoffs (including their transcripts), scheduled routines and their firings, member memory entries (including their text) and each conversation's references to them, member instructions (including their text), instruction packs (including their text) and each member's attached packs, the usage ledger and member usage budgets, webhook endpoints (including their URLs and signing secrets), deliveries and fan-out cursor, trusted sessions/generations and historical receipt authority, and recovery control row. |
| `native-volumes` | Full private Claude and Codex native session trees, SQLite indexes and sidecars (after teardown), rollout/transcript bytes, identity markers, and any consumer-owned native stores. A checkpoint digest is not the underlying file. Pi context normally lives in application checkpoints. |
| `temporal-persistence` | Supported consistent backup of the actual self-hosted Temporal persistence, visibility and required cluster/configuration state. Include all relevant stores in one opaque archive or provider snapshot export. A workflow-history export is insufficient to recreate the service's execution identities, queues and cluster persistence. |
| `configuration` | Non-secret deployment configuration, application commit, lockfile, image/package/native pins, profile identities, models/tool schemas, logical native mount paths, PostgreSQL/Temporal server versions and store layout. |
| `consumer-state` | Optional only if no consumer-owned durable records exist. Otherwise include consumer receipts/policy/records at the same boundary via the hooks. |

The public manifest contains artifact basenames, sizes and SHA-256 checksums,
compatibility pins, generation/installation/instance IDs, aggregate table counts,
and the policy `hold-until-reconciled`. It does **not** contain prompts, native
contents, endpoint URLs, credential headers, secrets, or the database connection
string. Artifacts themselves are private and may contain sensitive application
state: encrypt/access-control them in operator storage. Provision credentials,
private keys, proxy credential helpers and secret configuration separately on the
target. Do not put a secret-bearing environment file in `configuration` or copy an
engine's global authentication file as a recovery mechanism.

A checksum detects corruption, not a maliciously replaced bundle. Keep the
manifest checksum in an independently trusted backup catalog; authenticate and
verify the bundle before invoking restore. Never extract an untrusted archive.

## Operator interface

`src/service/recovery.ts` exports `InstallationRecovery`, `RecoveryPins`,
`RecoveryHooks`, and `readRecoveryManifest`. `src/service/recovery-cli.ts` provides
scheduler-friendly JSON receipts and exit codes. An operator module exports:

```ts
export const operator = {
  recovery: new InstallationRecovery(pool, externalFence),
  pins: {
    applicationCommit: "<exact 40-character commit>",
    lockfileSha256: "<sha256 of package-lock.json>",
    temporal: {
      serverVersion: "<installed server version>",
      persistenceFormat: "<matching documented store/configuration version>",
      mode: "persistent", // 'development-fixture' is not production acceptance
    },
    logicalNativeRoot: "/var/lib/birbcrew/native",
  },
  hooks: {
    async quiesce() {
      // Stop admission at consumer ingress, including every gateway (each runs the
      // scheduled-routine dispatcher); stop/drain consumers and all worker,
      // supervisor, SDK descendant processes. Await termination, then stop the
      // Temporal server. Throw if teardown or the consumer boundary is uncertain.
    },
    async snapshot(directory) {
      // Run supported PostgreSQL/Temporal backup tools and archive stopped native
      // volumes into this new private directory. Await success and durable output.
      // No live copying, no private Temporal table rewriting. Return exactly one
      // artifact per required kind, with safe basename (no absolute paths).
      return [
        {kind: "application-postgres", file: "application.dump"},
        {kind: "temporal-persistence", file: "temporal.tar"},
        {kind: "native-volumes", file: "native.tar"},
        {kind: "configuration", file: "configuration.tar"},
        // {kind: "consumer-state", file: "consumer.dump"},
      ];
    },
    async reconcile(manifest) {
      // Explicitly verify source isolation, pending/uncertain effects and delivery
      // acknowledgements with external systems/consumer records. Throw if not safe
      // to resume. Never simply return success for an unreconciled restored copy.
    },
  },
  async close() { await pool.end(); },
};
```

This is a contract example, **not** a ready-to-run no-op deployment module. The
hooks are trusted local operator code and must actually perform the indicated
steps. They are deliberately not shell strings, request fields or AG-UI input.
They must not emit secrets in their own logs. Crew neither guesses systemd /
Kubernetes service names nor fabricates database/provider backup success.

```
npm run recovery -- initialize-fence /absolute/operator.ts
npm run recovery -- capture /absolute/operator.ts /private/new-generation-directory
npm run recovery -- verify /absolute/operator.ts /private/generation-directory
npm run recovery -- status /absolute/operator.ts 24
```

Create the destination directory with mode 0700 under a pre-provisioned durable backup root first. `capture` never overwrites
manifest files: interrupted attempts use a fresh destination. The source remains
held after capture; explicitly `resume` it only if it is not being relocated.
`status 24` returns exit 2 if no successful backup exists or the latest completed
backup is older than 24 hours. Commands return exit 1 on failure without printing
raw provider/DB errors. The operator owns scheduling, missed-backup alert delivery,
retention, off-host replication, encryption and RPO/RTO. A local successful capture
is not proof that an off-host copy exists.

## Stable boundary and failure recovery

The authority distinguishes `preparing` from `held`: a crash before database
freeze/teardown cannot authorize transfer to a restored copy. Only completed
capture or explicit `hold-for-restore` seals that transfer permission.

1. Initialize the external authority once for the active installation. Never
   initialize a fresh authority from a restored backup to bypass a source fence.
2. `capture` durably assigns a generation and atomically changes its application
   database to `frozen`, then prepares the external authority. A failed authority
   call leaves the durable generation available for a safe retry.
3. A statement trigger rejects INSERT/UPDATE/DELETE/TRUNCATE on every domain table.
   The transition waits for already admitted writer transactions to commit.
   All supported native admission lanes check the recovery phase, poll it to
   cancel, and retain a shared native lifetime lease. New native launches fail.
4. The operator quiesces external writers and services. Crew additionally waits
   for its instrumented native lifetime leases before snapshotting. Running work
   that cannot finish after the barrier retains its started/pending/uncertain
   record; it is not silently marked successful or replayed. Consumer activity
   outside Crew must be stopped by the consumer hook.
5. Operator snapshots all state, including **stopped** Temporal persistence. The
   manifest pins the schema and version. Capture flushes artifacts and manifest files, fsyncs the bundle directory and its parent,
   and verifies checksums/the fence before recording success. New domain tables without the barrier are
   rejected, so schema upgrades need recovery integration, not implicit coverage.
6. Failed/interrupted maintenance stays held, with no success receipt. Fix the
   failing hook and retry in a new directory. Native teardown and backup hooks
   must be idempotent. If a writer times out during freeze, stop services and retry; never call
   this a snapshot boundary. If authority preparation fails after the database
   freeze, the database stays held and retry uses its durable generation. In-flight external effects may be uncertain.

The protocol assumes trusted database administrators. Runtime roles must not
alter/drop triggers, use replication-role bypass, change recovery control rows,
or create unfenced tables. Keep migration/recovery credentials operator-only;
provision ordinary runtime privileges separately. This is not protection against
a malicious database owner or a process writing native files outside the protocol.

## Source fencing and restore

Use a linearizable external fencing authority shared by source and destination.
`RecoveryFence` makes this explicit. The included `FileRecoveryFence` requires a
private shared POSIX filesystem with atomic mkdir/rename semantics. Its state is
**outside all backup artifacts** and must never be rolled back alongside a
snapshot. Transitions flush both the state file and containing directory before acknowledging ownership. Its crash lock fails closed, without lease timeout/stealing. Only remove
lock debris after independently establishing there is no running controller.
A filesystem copy local to each host is not a shared authority. For a multi-host
installation, supply a real shared authority or enforce operator isolation before
moving state. Independent restored databases cannot discover arbitrary clones.

`RecoveryFence.transfer(installation, source, target, generation, minimumEpoch)`
returns the authority's epoch, which orders restored audit event IDs. Moving
authority from the held source sets it to the larger of the stored epoch plus one
and `minimumEpoch`. A retried transfer to the same target returns the stored
epoch, raised to `minimumEpoch` if lower. Nothing lowers or resets it. When the
result would reach 2^19 (524,288), `transfer` must throw a `RecoveryRefusedError`
(exported by `src/service/recovery-fence.ts`) before changing anything, so
authority stays with the source. The CLI shows that error's message, which must
hold no paths, connection strings or provider output, and hides any other error's
message, so the operator would not learn that the source can resume. Acceptance computes `minimumEpoch` from the
restored database and refuses before any transfer when it has already reached
2^19. This changes the interface: a fence implemented before audit IDs existed
must store the epoch, honour `minimumEpoch` and return the epoch. Acceptance
refuses a fence that returns no epoch, or one below `minimumEpoch`, only after the
transfer: upgrade the fence, then retry `accept-restore` with the same target
instance UUID.

`FileRecoveryFence` keeps the epoch in `epoch.json`, beside `state.json`, and
reads a missing file as 0. `state.json` keeps the format of earlier releases, so
after a rollback an earlier release still runs every recovery command against the
fence and ignores `epoch.json`. Its transfers leave the epoch behind. That is
harmless only because acceptance requires the application commit of the release
that captured the generation. This release therefore never retries a transfer an
earlier release made, which would return the stale epoch of an earlier timeline,
and its own moves from a held source take the stored epoch plus one, raised past
every ID in the restored database. The same pin means that only an earlier
release can accept a generation captured while it ran, and it does not move the
audit identity. [The audit trail](audit-trail.md#after-an-earlier-release-accepted-a-restore)
says how to move it by hand before a later release writes to that timeline.

Keep `epoch.json` with `state.json`: on the same shared authority, covered by
whatever replication and monitoring protect the fence, never restored from a
snapshot or copied from another fence, and never deleted. See
[below](#if-the-fence-epoch-file-is-lost-or-damaged) if it is lost or damaged.

1. Stop/fence the source and keep it held. Disable source service auto-restart and
   ingress, and isolate it from effect destinations when relocating. A backup
   previously followed by source resume cannot be restored while the authority
   is active. For an older generation, stop the source again and call
   `holdForRestore(manifest.generation, hooks)` (or CLI `hold-for-restore`)
   through the operator interface before restore;
   reconcile all changes/effects since that recovery point.
2. Verify the complete trusted bundle. Use supported database restore tooling into
   an isolated, stopped target; restore every artifact from **one** generation.
   Install matching application/lockfile/schema/Temporal versions, public config,
   profile identities, and separate credentials. Do not auto-migrate during this
   process. Keep the source database frozen and retain the external authority.
3. For a different physical host root, bind-mount the restored native tree at the
   **same logical absolute path** inside the target container. For example,
   `/srv/host-a/birbcrew/native` and `/mnt/host-b/restore/native` both mount at
   `/var/lib/birbcrew/native`. Preserve volume markers, owner IDs and permissions.
   Do not symlink the runtime root or rewrite Codex SQLite indexes: native paths
   and digests are validated. Arbitrary in-process absolute path rewriting is
   unsupported. This protocol relocates storage with a stable mount contract.
4. With services still stopped:

   ```
   npm run recovery -- accept-restore /absolute/target-operator.ts /private/generation <new-instance-uuid>
   ```

   For a retained backup made on A after the installation moved A→B, first
   quiesce B with `hold-for-restore <backup-generation>`, then pass B’s current
   instance UUID as the optional final `accept-restore` argument. The manifest
   remains unchanged: A identifies artifact provenance, while B is the owner that
   must actually be fenced. An active B, stale A identity or second concurrent
   target is rejected.

   This verifies artifacts/pins and the restored database generation, then
   atomically transfers authority to the new instance. Source resume and another
   clone's transfer are rejected. The target remains `restored`, blocking writes
   and native execution. Read-only committed receipt/history queries can work.
   Acceptance also moves the audit event identity to the fence epoch times 2^44.
   Audit events committed after the recovery point are gone from the trail. New
   event IDs are larger than any ID an earlier timeline issued, including an
   earlier restore of this generation, whatever the database clocks say, so an
   audit consumer's saved cursor never skips a new event. This holds while the
   fence's state is never reset, replaced or rolled back, no timeline draws 2^44
   IDs and fewer than 2^19 transfers are made. If the restored identity is already
   past the fence's next epoch, acceptance starts above it instead. If no epoch is
   left, acceptance refuses before the transfer, and the held source can resume. A
   fence that returns no usable epoch is refused after the transfer, when the
   source can no longer resume: upgrade the fence and retry with the same target
   instance UUID. These checks run on every restore, whether or not anyone reads
   `GET /v1/audit`. See [the audit trail](audit-trail.md) for the details and what
   consumers see.
5. Reconcile effects/decisions first, then explicitly resume:

   ```
   npm run recovery -- resume /absolute/target-operator.ts /private/generation
   ```

   Activating a restored installation revokes every standing grant that is not
   already revoked, with reason `recovery_restore`, in the same transaction, and
   audits each one: the restore can bring back grants revoked after its recovery
   point. Owners answer cards again to create new ones. A held source that resumes
   without a restore keeps its grants. See [standing grants](standing-grants.md#recovery).

   In the same transaction it suspends every active member memory entry and audits
   each `memory.suspended` with reason `recovery_restore`: the restore can bring back
   entries the owner deleted after the recovery point, text and all. A suspended entry
   reaches no later launch; the owner reads it, deletes it and creates it again if it
   still applies. A held source that resumes without a restore keeps its entries. The
   restored native volumes still hold the system context that Claude and Codex
   sessions recorded. See [member memory](memories.md#recovery).

   Member instructions are kept as they were at the recovery point, and nothing is
   audited about them: they are fixed at spawn and never removed, so a restore cannot
   bring back text an owner took away. See [member instructions](member-instructions.md#recovery).

   Instruction packs and each member's packs are kept as they were at the recovery point,
   and nothing is audited about them: a member's packs never change, and a pack any member
   has can never be deleted. A pack the owner deleted after the recovery point comes back,
   text and all, unattached; it reaches no model until a spawn names it, so owners delete
   it again. See [instruction packs](instruction-packs.md#recovery).

   Resume changes neither the usage ledger nor usage budgets. Tokens spent after the
   recovery point are no longer in the ledger, so for the rest of that UTC day each
   member's budget counts less than it used, and a budget set, changed or cleared
   after the recovery point is back to its earlier state. Owners check each member's
   budget after a restore. The ledger reissues the record IDs drawn after the recovery
   point, so before resuming, read `SELECT max(usage_id) FROM birbcrew_ts.usage_ledger`
   on the restored database and give it to consumers that mirror usage records. See
   [usage metering](usage-metering.md#upgrade-and-recovery).

   In the same transaction it disables every enabled webhook endpoint with reason
   `recovery_restore`, auditing each `webhook.disabled`, cancels every undelivered
   webhook delivery, and moves the webhook cursor past every restored audit event,
   so no event from before the restore is sent: an undelivered row may already have
   reached its receiver on the discarded timeline, and the restore can bring back an
   endpoint the owner deleted. The owner enables each endpoint again. A held source
   that resumes without a restore keeps its endpoints. See
   [outbound webhooks](webhooks.md#recovery).

   After successful reconciliation and activation, restart matching Temporal
   services/workers **with consumer ingress still disabled**. Let recovery
   reconcile lost native processes and verify the required held/interrupted/
   uncertain outcomes before enabling consumer ingress or accepting old approval
   cards. Activation alone does not reconstruct a process-bound native callback. A failed reconciliation keeps the
   target held. Activation retains its generation in the external authority, so
   interruption between authority activation and database activation is safely
   retryable. Reconciliation hooks must be idempotent. Do not resume a process-bound approval just because its durable
   row survived. Its native process no longer exists; retain a safe hold or use
   the supported cancellation/uncertain recovery procedure for that engine.

An acknowledgement may have been delivered **after** the backup recovery point.
The restored database cannot know that. An external operation ledger/idempotency
key may prove an effect already happened; otherwise retain hold/uncertainty and
ask the consumer/operator to reconcile. Never treat missing restored receipts as
permission to execute the effect again. Backup tooling never resets effect,
decision, delivery, generation or native launch identity rows.

### If the fence epoch file is lost or damaged

A missing `epoch.json` reads as 0, so its loss is silent. The next acceptance
still starts above every audit ID in the restored database, because it takes at
least the minimum epoch that database needs. It cannot see IDs other timelines
drew, though, so it reissues IDs when another timeline has drawn IDs in that
minimum epoch or above. That happens when the same generation, or one captured
before a later restore, was restored before, or when the dump's own timeline had
drawn no ID in its epoch by the capture and drew some afterwards. Restoring a
generation captured on the latest timeline after it drew an ID gets the same
epoch it would have got from the file.

A damaged file fails every fence operation, including `resume`, which does not
use the epoch. The CLI reports the generic failure. Deleting the file looks like
the fix, but it resets the epoch to 0. Repair a lost or damaged file instead,
before any recovery command runs against the fence. `$FENCE` is the
`FileRecoveryFence` directory.

1. Stop every Crew process and recovery command, and take the fence's lock:
   `mkdir -m 700 "$FENCE/lock"`. If `lock` already exists, establish that no
   controller is running before you go on, as for any lock debris.
2. Choose an epoch `N` no lower than any epoch the fence has assigned. Every
   transfer sets its target's audit identity to the new epoch before the target
   serves, so for each database of the installation still in use, read the epoch
   of its identity's position and its highest ID:

   ```sql
   SELECT greatest((SELECT last_value FROM birbcrew_ts.audit_events_event_id_seq),
                   (SELECT coalesce(max(event_id), 0) FROM birbcrew_ts.audit_events)) >> 44;
   ```

   Take the largest of those, of the highest event ID any audit consumer holds,
   shifted right by 44, and of the last `epoch.json` value you know of. Then add
   a margin for timelines you cannot inspect, for example 1000. An unused epoch
   costs nothing but one of the 524,288. A timeline you missed, with an epoch
   above `N`, is the remaining risk: a later restore can reissue its IDs.
3. Write the file with an atomic replace:

   ```sh
   (umask 077 && printf '{"epoch":%d}' "$N" > "$FENCE/.epoch-manual")
   sync "$FENCE/.epoch-manual"
   mv "$FENCE/.epoch-manual" "$FENCE/epoch.json"
   sync "$FENCE"
   ```

4. Release the lock: `rmdir "$FENCE/lock"`.
5. Check that `$FENCE/epoch.json` holds `N`. The next fence operation, such as
   `resume` of a held installation or `initialize-fence` on an active one, which
   changes nothing, now succeeds, and the next transfer gets epoch `N + 1`.

## Scheduled routines are consumer ingress

Every gateway runs the [scheduled-routine](scheduled-routines.md) dispatcher, which
submits turns with nobody present. Treat the gateways as consumer ingress: the
`quiesce` hook stops them with the other consumers, and after `resume` they stay
stopped while the restarted workers reconcile lost native processes, until the last
step of the restore procedure in [source fencing and restore](#source-fencing-and-restore)
(its step 5, not the fence-epoch repair steps) allows consumer ingress. A Temporal
Schedule would fire whenever the Temporal server runs, including before `resume`;
the dispatcher instead runs only in a gateway and checks the recovery phase before
every pass, and both routine tables carry the write barrier, so a held or restored
installation records no firing even if a gateway was left running. The
[webhook](webhooks.md) dispatcher runs in gateways too, checks the phase the same
way, and its three tables carry the barrier, so a held installation starts no new
delivery; an attempt already in flight at the hold may still reach its receiver.

Windows that fall while the installation is held or its gateways are stopped are
never run late. The first gateway to start is armed from then on; a window it was not
armed for is recorded as skipped (`missed`) once it is 5 minutes late. A firing that
was `claimed` at the recovery point, so its conversation and request UUIDs are in the
database but its admission may or may not be, is restored `claimed`. The first
gateway after `resume` retries it with those stored UUIDs once its 2-minute lease has
expired, never under new ones, so it runs once whether or not its admission reached
the recovery point. Unlike a window, such a firing is not dropped for being late: it
starts when the first gateway does, however long after its window that is, and even
if its owner's token was removed meanwhile. A firing waiting on an approval is restored `waiting`, under the
same rules as any other pending decision. There is no gateway option to run without
the dispatcher, and disabling a routine needs a gateway, so the first gateway after a
restore fires any routine due from the moment it starts.

## Temporal responsibilities and qualification

Production uses a persistent self-hosted Temporal deployment with explicit server
image/version, SQL or Cassandra persistence, visibility store and namespace/cluster
configuration. Stop all Temporal writers and use the backing store's supported
consistent backup/restore procedure. See the [Temporal self-hosted guide](https://docs.temporal.io/self-hosted-guide).
Do not query or rewrite private Temporal tables or substitute exported workflow
histories for a persistence backup. Crew validates the operator's declared
pins and artifact checksums; the operator owns the service/store restore itself.

The existing proxy restart proof uses Temporal CLI 1.10.0 development SQLite
persistence. That is **development fixture evidence only**, not support for using
`start-dev` as production persistence, nor an in-flight multi-store restore proof.

## Reproduce checks

Use Node 24.22.3 and disposable PostgreSQL 17, with permission to create/drop test
databases. `BIRBCREW_PG_BIN` may name the directory containing matching `pg_dump`
and `pg_restore`, or `BIRBCREW_RECOVERY_POSTGRES_CONTAINER` may name the PostgreSQL
17 container for `docker exec`. These tools operate only on randomly named test
DBs. Full native coverage additionally needs Docker, Linux Landlock ABI 4+ and the
repository's C build prerequisites.

```
npm ci
npm run build
export BIRBCREW_TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/disposable
npm run test:recovery
npm run test:recovery:native
# Also needs Temporal CLI 1.10.0 on PATH (or TEMPORAL_CLI):
npm run test:recovery:coordinated
```

The database suite exercises actual dump/restore to a second database, preserved
conversation/checkpoint/observation state, completed replay and held pending work, a
routine firing claimed at the recovery point and retried after restore with its
stored identity,
write/native fences, interrupted capture, checksums, version mismatch and source /
clone overlap. It also checks that audit event IDs are never reissued when one
generation is restored twice and the first target drew its whole ID range; that
a restore whose identity is past the fence's epoch, because its epoch file is
missing or behind, starts above every ID in the restored database; that an
unreadable epoch file fails every fence operation; that an exhausted epoch is
refused before authority moves; and that after a fence returns no epoch or one
below the minimum, the fence can be upgraded and the restore retried. It restores an
archive taken before a grant was revoked and checks that the resumed target revokes
every grant while a source that resumed without a restore keeps its own. It restores an archive taken before a member memory entry was
deleted and checks that the resumed target suspends every active entry, that a held
installation refuses every memory write, and that capture counts both memory tables. The native fixture archives stopped Claude/Codex/Pi session state,
restores it under a different host root mounted at `/native`, and performs actual
SDK follow-ups with fresh synthetic proxy credentials. It makes no live requests.
The coordinated proof additionally backs up and restores one actual generation
across PostgreSQL, stopped Temporal development SQLite, and native archives into
a second isolated service. It checks all three engines’ completed replay, native
recall and committed observations. Claude/Pi durable paused decisions remain
cancellable without effects. Codex live process-bound decisions are not resumed:
the required safe outcome is an interrupted callback, uncertain turn, no pending
actionable card, rejection of the stale approval and no effects. This follows the
existing `reconcileTurn`/`interruptLiveLocked` contract, rather than claiming
that a process-bound pending decision was recovered. This is not persistent production Temporal
installation disaster-recovery certification. Qualify the deployment's real
backup hooks, Temporal backend, consumer state and all engine pending-decision
outcomes before declaring production acceptance. Keep the Beans request open
until that deployment-specific evidence exists.
