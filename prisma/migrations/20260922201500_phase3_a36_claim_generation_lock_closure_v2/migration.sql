-- ONLINOD Phase 3 / A36 follow-up — claim generation + lock authority closure.
--
-- A36 makes the deferred statement-level locator flush the only writer of the
-- complete partition -> shard -> Agency hierarchy.  The retired Actual56
-- per-row counter trigger still acquired exact-partition advisory/row locks in
-- physical write order.  Two transactions touching the same two partitions in
-- opposite orders could therefore deadlock before the globally ordered deferred
-- flush ran.  outstandingCount is no longer execution/freshness authority;
-- physical DomainWorkItem truth plus bounded reconciliation is authoritative.

BEGIN;

DROP TRIGGER IF EXISTS "trg_phase2_domain_work_current_partition" ON "DomainWorkItem";
DROP FUNCTION IF EXISTS "phase2_track_domain_work_current_partition"();
DROP FUNCTION IF EXISTS "phase2_lock_domain_work_current_partition"(TEXT,TEXT,TEXT);
DROP FUNCTION IF EXISTS "phase2_domain_work_current_partition_lock_key"(TEXT,TEXT,TEXT);

COMMIT;
