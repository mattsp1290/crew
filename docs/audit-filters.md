# Audit filters

`GET /v1/audit` used to accept only `after`, `limit`, `conversationId` and
`format`. An owner who wanted everything one routine did last week, or every
denial for one member, had to download the whole trail and filter it. The route
now also filters by member, event type, actor kind, initiator kind, initiator ID
and a time window, in JSON and in CSV. Filters combine with AND. Paging, limits,
the CSV cursor headers and `503 audit_unsettled` are unchanged. Migration 30 adds
three indexes so that the selective filters do not walk an owner's whole trail.

## Parameters

| Parameter | Keeps rows whose | Value |
| --- | --- | --- |
| `conversationId` | conversation is this one | a UUID, any case (unchanged) |
| `memberId` | member is this one | a UUID, any case |
| `eventType` | type is one of these | registered types, comma-separated, each at most once |
| `actorKind` | actor kind is this | `owner` or `system` |
| `initiatorKind` | initiator kind is this | `owner`, `routine` or `handoff` |
| `initiatorId` | request was started by this non-owner initiator | a UUID, any case: a routine ID or a handoff ID |
| `from` | `occurredAt` is at or after this instant | an RFC 3339 timestamp |
| `to` | `occurredAt` is before this instant | an RFC 3339 timestamp |

`after`, `limit` and `format` keep their meaning, and every filter works with
both formats. Examples:

```text
# Every row a routine's requests caused in one week
GET /v1/audit?initiatorId=ROUTINE_UUID&from=2026-11-02T00:00:00Z&to=2026-11-09T00:00:00Z

# Every approval decision for one member; keep the rows whose payload.choice is "deny"
GET /v1/audit?memberId=MEMBER_UUID&eventType=approval.decided

# Grant and memory changes, as CSV
GET /v1/audit?eventType=grant.created,grant.revoked,memory.created,memory.deleted&format=csv&limit=10000
```

## What each filter matches

The owner comes only from the bearer token, and every filter narrows that
owner's rows. Another owner's member, conversation, routine or handoff returns
`200` with an empty page, never `404`, so a filter cannot confirm that an ID
exists. This is how `conversationId` already behaved.

- `memberId` matches every row of the member, including the routine and memory
  rows, which name the routine's or the entry's member, and
  `member.instructions_set` and `member.instruction_packs_attached`. A `conversation.handed_off` row names the source
  conversation and its member, so the source member's ID matches it and the
  target member's ID does not, unless the target is the source's own member. The
  target member's ID matches the target's `conversation.opened` row and its
  reserved request's rows. The [webhook](webhooks.md#audit) and
  [instruction pack](instruction-packs.md#audit) rows name no member (`memberId` is
  `null`), so no `memberId` matches them; `eventType` selects them.
- `eventType` takes names from `audit.eventTypes`. A name is case-sensitive. A
  registered type with no rows yet returns an empty page.
- `actorKind` and `initiatorKind` match the `actor.kind` and `initiator.kind`
  fields of each event. See [the audit trail](audit-trail.md#contract) for who is
  named in each.
- `initiatorId` matches the rows tied to the requests that a routine or a
  handoff started, such as `request.accepted`, `approval.decided`,
  `approval.expired`, `work_item.committed`, `request.cancellation_requested` and
  `request.finished`. A handoff ID matches the rows of the one request it
  reserved in the target. `initiatorId` does not match the routine's own rows
  (`routine.created`, `routine.enabled`, `routine.disabled`, `routine.deleted`,
  `routine.firing_settled`), the `conversation.opened` row of a firing or of a
  handoff's target, the `usage.request_refused` row of a firing that its
  member's [usage budget](usage-metering.md) refused, or the
  `conversation.handed_off` row. Those rows name the owner as initiator. The
  routine's rows, a firing's `conversation.opened` and `usage.request_refused`
  carry `routineId` in their payload, and `conversation.handed_off` carries
  `handoffId`, which no filter reads. For everything in a handoff's target, pass
  the `targetConversationId` of its `conversation.handed_off` row as
  `conversationId`. An owner-initiated row stores the owner ID as its initiator
  ID, and `initiatorId` skips owner-initiated rows, so it never matches one, even
  when the owner ID is itself a UUID. Select the owner's own rows with
  `initiatorKind=owner`. `initiatorId` combines
  with `initiatorKind` like any filter, so `initiatorKind=owner&initiatorId=...`
  matches nothing, and `initiatorKind=routine` with a handoff ID matches nothing.
- `from` and `to` form a half-open window: `from` is inclusive and `to` is
  exclusive, so consecutive windows never share a row. Either may be given alone.
  A window whose `to` is not after its `from` returns an empty page.
  `occurredAt` is the database clock when the row was inserted, not when it
  committed.

Event ID order and `occurredAt` order can differ slightly. Concurrent writers
draw IDs and read the clock in separate steps, the clock can step back, and a
restore can move the trail to a host with another clock. So a window is a row
filter, not a cursor. Pages stay in `eventId` order, and a page can hold an
event whose `occurredAt` is slightly earlier than the one before it.

### Timestamps

`from` and `to` take an RFC 3339 date-time with an explicit offset, for example
`2026-11-12T08:15:30Z` or `2026-11-12T08:15:30.123456+05:30`. Lowercase `t` and
`z` are accepted. Every `occurredAt` the trail returns can be passed back
unchanged. Encode `+` as `%2B` in the query string: an unencoded `+` reads as a
space, and the value is refused.

These values return `400`:

- a date without a time, a time without an offset, or a space instead of `T`;
- a date or time that does not exist, such as `2026-02-29` or `24:00:00`;
- more than six fractional digits. The trail stores microseconds, and a finer
  bound would be rounded;
- a leap second (`:60`), which PostgreSQL reads as the next minute;
- year `0000`, and offsets beyond `±15:59`, which PostgreSQL cannot store.

## Validation, paging and limits

Validation stays strict, and every rule answers `400 invalid_input`: an unknown
or repeated parameter, a malformed UUID, an unregistered or repeated event type,
an empty item in the type list, an unknown kind, or a malformed timestamp. To
select several types, separate them with commas in one `eventType` parameter.

A filter selects rows inside the existing cursor. `after` and `nextAfter` are
event IDs as before. `nextAfter` is the last returned ID, or your own `after` for
an empty page. `hasMore` is true when more matching rows existed at read time.
CSV carries the same rows with `Audit-Next-After` and `Audit-Has-More`. A read
waits for in-flight audited writes before it pages, whatever the filters, so a
filtered page never skips a late commit either, and a read that cannot settle
within 5 s still answers `503 audit_unsettled` with `Retry-After: 1`. The limits
do not change: 100 rows by default, at most 1000 for JSON and 10000 for CSV.

`GET /v1/capabilities` lists the filter names under `audit.filters` and the actor
kinds under `audit.actorKinds`. `audit.eventTypes` and the top-level
`initiatorKinds` list the other accepted values. `audit.version` stays `1`. A
server without `audit.filters` accepts only `conversationId` and answers the other
filters with `400`.

## Indexes

A read walks the owner's rows in event ID order from its cursor and stops after
`limit + 1` matches or at the read horizon. A filter only skips rows on that
walk. When a filter's rows are rare, the walk reaches the horizon. An empty page
leaves the cursor where it was, so a client polling such a filter would walk the
owner's trail from its last match on every poll. Migration 30 adds an index for
each filter where that happens, so the read touches only matching rows. One
member, one type, one routine or one handoff reads a single range that is already
in event ID order. Several types read their matching rows and sort them.
`initiatorKind=routine` or `initiatorKind=handoff` alone reads every row that a
routine or a handoff started, keeps the rows of its kind and sorts them.

| Index | Columns | Serves |
| --- | --- | --- |
| `audit_events_member_page` | `owner_id, member_id, event_id` | `memberId` |
| `audit_events_type_page` | `owner_id, event_type, event_id` | `eventType`; grant, memory, spawn and routine changes are rare |
| `audit_events_initiator_page` | `owner_id, initiator_id, event_id`, only rows whose initiator is not the owner | `initiatorId`, and `initiatorKind=routine` or `handoff` |

`conversationId` already had `audit_events_conversation_page`. Each index leads
with `owner_id`, so another owner's ID reads an empty range. The other filters
have no index. In a typical trail `actorKind` and `initiatorKind=owner` each match
a large share of the rows, so the walk finds its matches quickly. A time index
cannot return rows in event ID order, because the two orders differ, so every page
would read and sort the rest of the window. A bounded window is an export rather
than a tail: across its pages it walks the owner's trail once, as an unfiltered
export does. Its first page walks the rows before `from`, so a window that starts
late in a long trail costs most on that first page.

So a read whose unindexed filters match few rows, such as `to` in the distant
past, walks the owner's rows from the cursor to the horizon in one statement. When
the owner holds a large share of the table, the planner may scan the whole table
instead. That read costs the database up to one pass over the owner's trail, or
over the table, and holds one of the gateway's pooled connections meanwhile. The
gateway sets no statement timeout on it. It never returns another owner's rows.

A manual `EXPLAIN ANALYZE` on PostgreSQL 17, which is not part of the suites, ran
on a trail of 200,000 rows for one owner. It used these indexes for member, type
and routine filters and read only the matching rows. A single type read its range
in page order without a sort. Several types read their rows and sorted them. On
that trail (58 MB of heap) the migration built all three indexes in 0.4 s. The
member and type indexes took 18 MB each, against 15 MB for the existing owner
index. Each audited insert now also writes those two indexes, and writes the
initiator index when a routine or a handoff started the request. On a small
trail with sequential scans disabled, a handoff's ID and `initiatorKind=handoff`
read the initiator index as a routine's do.

## Upgrade and recovery

Migration 30 adds the three indexes and nothing else: no table, column,
constraint, trigger or audit event type. The append-only, ordering, binding and
recovery barrier triggers on `audit_events` are unchanged.

Until `migrate()` commits, the migration holds `SHARE` on `audit_events`, as
measured with `pg_locks` on PostgreSQL 17, and no lock on any other table that
requests use. Each index build reads `audit_events` once, so audited writes wait
for the three builds, for a time that grows with the table. Applied alone, from
version 29, audit reads continue meanwhile. Applied in one `migrate()` transaction
with earlier migrations, from version 28 or earlier, it builds under the `ACCESS
EXCLUSIVE` lock on `audit_events` that migration 27, 28 or 29 already holds, so
audit reads wait too.

As in migrations 25 to 29 it takes the lock with `NOWAIT` and retries for up to
60 s, so it never waits in a lock queue, and writes never queue behind it while
an open audited transaction finishes. A running native turn's admission
transaction holds nothing on `audit_events`, so it does not delay the migration.
A long autovacuum of `audit_events` also conflicts with `SHARE`, and `NOWAIT`
never asks it to yield. After 60 s without the lock the migration fails with
`55P03` and applies nothing; start the process again once the holder is done.

This migration gives no reason of its own to stop the previous release first: a
process of that release writes the same rows, which the indexes cover, and
answers a filter with `400`. Stop it anyway, as
[persistent deployment](persistent-deployment.md#upgrades) requires for every
upgrade. Rolling back leaves the indexes in place. The earlier release keeps
working with them, and its `migrate()` ignores version 30. No workflow code
changes, so Temporal histories are unaffected.

Before conversation handoff took number 27, this change was migration 27. A
development database that applied it then has version 27 recorded, so
`migrate()` skips migration 27 (conversation handoff), applies 28 and 29, and
fails on 30 with `42P07` because the indexes already exist. Its transaction
rolls back, so nothing is applied and the process does not start. Recreate such
a database.

`pg_dump` and `pg_restore` recreate the indexes, so a restored trail answers the
same filters with the same rows. Restore does not change what a filter means:
the cursor rules in [the audit trail](audit-trail.md#retention-upgrade-and-recovery)
apply to filtered reads too.

## Not covered

- Payload fields: a routine's `routineId` on its own rows, an approval's
  `choice`, a request's `status`, a tool name. Filter those on the client.
- One filter for everything about a routine or a handoff: its requests through
  `initiatorId` together with the routine's lifecycle and firing rows, or the
  handoff's `conversation.handed_off` row.
- OR across different filters, negation, and filters on `requestId` or `actorId`.
- Pages in time order, counts and other aggregates.
- Indexes for time windows and kinds, for the reasons above.

## Validation

Use Node 24.22.3 on Linux and a disposable PostgreSQL 17 database whose role may
create databases. `BIRBCREW_PG_BIN` must name PostgreSQL 17 `pg_dump` and
`pg_restore` for the recovery suite.

```sh
npm ci
npm run typecheck
export BIRBCREW_TEST_DATABASE_URL='postgresql://birbcrew:fixture-only@127.0.0.1:55432/integration_test'
npm run test:audit
npm run test:recovery
```

`audit.test.ts` checks through the HTTP gateway and `GET /v1/audit`, with two
members, a denied card and a routine that fires and completes:

- every filter, alone and combined, returns exactly the rows that match all of
  them, in JSON and CSV, with the same cursor headers;
- UUIDs in any case, several event types, offset timestamps, lowercase `t` and
  `z`, the extreme accepted timestamps, and empty or inverted windows;
- keyset pages over a filter, `nextAfter` on an empty page, a retried read, a
  replayed spawn that still shows as one row, and the JSON and CSV limits;
- another owner's member, routine and conversation return empty pages, and their
  rows never appear in this owner's pages;
- two owners, each with a member spawned with instructions, a card that expires
  and a delivered handoff: `initiatorKind=handoff`, a handoff's `initiatorId`,
  `actorKind=system`, each registered event type, and the member, conversation
  and kind combinations around them return exactly the matching rows of the
  reading owner, with CSV equal cell for cell to JSON, and the other owner's
  members, handoff and conversations return empty pages; a handoff to the
  source's own member shows under that member, and an owner ID that is a UUID
  never matches its own rows through `initiatorId`;
- two owners, each with a pending card and an endpoint created, disabled, enabled
  and deleted, plus a system `webhook.disabled`: `memberId` never returns a
  webhook row, alone or with `eventType`, each registered type, actor and
  initiator kinds and the conversation return exactly the reading owner's rows,
  CSV equals JSON with empty member, conversation and request cells on webhook
  rows, and neither format holds a secret or a URL path;
- a filtered read waits for a late commit like an unfiltered one, and answers
  `503 audit_unsettled` when a writer stays open;
- each malformed value above returns `400 invalid_input`;
- the capability report lists the filters and actor kinds, and the actor kinds
  match the SQL CHECK;
- migration 30 on a version-29 database locks only `audit_events` in `SHARE` mode,
  rewrites nothing, retries rather than queue behind an open audited write,
  completes while a native turn holds its admission, filters rows written before
  it, and leaves the table append-only.

`recovery.test.ts` checks that a restored trail has the same indexes and returns
the same rows for a filtered read.
