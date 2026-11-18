-- Indexes for the GET /v1/audit filters (docs/audit-filters.md). A read walks one owner's rows in
-- event_id order from its cursor, through audit_events_owner_page (or scans the table when that owner
-- holds most of it), and a filter only skips rows on that walk. The walk stops after limit + 1 matches or at the horizon. When a filter's rows are
-- sparse it reaches the horizon, and an empty page leaves the cursor where it was, so a client
-- that polls such a filter walks the owner's trail from its last match on every poll. Each index
-- below lets one such filter read only its matching rows, as audit_events_conversation_page does
-- for conversationId. One member, one type, one routine or one handoff is a single (owner, value) range
-- already in event_id order. Several types read their few rows and sort them. initiatorKind=routine
-- or handoff alone reads every row a routine or a handoff started, keeps its kind's and sorts them.
--   member_page: one member among all the owner's members.
--   type_page: one or a few of the event types; grants, memories, spawns and routine changes are rare.
--   initiator_page: one routine's or one handoff's requests. Partial, so it holds only rows that a
--   routine or a handoff started; an owner row stores the owner ID as initiator_id.
-- No index for actorKind or initiatorKind=owner: in a typical trail each matches a large share
-- (every spawn, open and routine change names the owner; every finish and commit names the system),
-- so the walk finds its matches quickly.
-- No index for from/to: event_id order and occurred_at order differ (concurrent inserts, clock
-- steps, restores), so a time index cannot return rows in page order, and every page would read
-- and sort the rest of the window. A bounded window is an export, not a tail: across its pages it
-- walks the owner's trail once, as an unfiltered export does.
--
-- Each build reads audit_events once and holds SHARE on it until migrate() commits: audited writes
-- wait for the builds. Applied alone, from version 29, audit reads continue meanwhile; applied with
-- earlier migrations in one transaction, from version 28 or earlier, it builds under the ACCESS
-- EXCLUSIVE lock that 027, 028 or 029 already holds on audit_events, so reads wait too. As
-- in 025 to 029 the lock is taken with NOWAIT and retried, so the migration never waits in a lock
-- queue, and writes never queue behind it while an open audited write finishes. A native turn's
-- admission transaction holds nothing on audit_events, so a running turn never delays it. A long
-- autovacuum of audit_events conflicts with SHARE too, and NOWAIT never asks it to yield. After 60 s
-- without the lock the migration fails with 55P03 and applies nothing. The append-only, ordering,
-- binding and recovery triggers are unchanged.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.audit_events IN SHARE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

CREATE INDEX audit_events_member_page ON birbcrew_ts.audit_events (owner_id, member_id, event_id);
CREATE INDEX audit_events_type_page ON birbcrew_ts.audit_events (owner_id, event_type, event_id);
CREATE INDEX audit_events_initiator_page ON birbcrew_ts.audit_events (owner_id, initiator_id, event_id)
    WHERE initiator_kind <> 'owner';
