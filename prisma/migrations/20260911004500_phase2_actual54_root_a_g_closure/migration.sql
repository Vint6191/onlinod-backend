BEGIN;

-- ONLINOD Phase 2 / Actual54 closure continuation
-- Root A: scoped claim access path + concurrent ready-head correctness.

-- F54-01: scoped workers read only their admitted creator work.  This partial
-- index intentionally lives in SQL because Prisma 5.22 cannot model its WHERE
-- predicate without pretending a different physical index exists.
CREATE INDEX IF NOT EXISTS "DomainWorkItem_scoped_creator_due_current_idx"
  ON "DomainWorkItem"("agencyId","workClass","activeGeneration","creatorId","availableAt","id")
  WHERE "isOutstanding"=TRUE AND "creatorId" IS NOT NULL;

-- Head identity locks are transaction-scoped.  The DWI trigger pre-locks both
-- old/new partition identities in lexical order when a row changes partition,
-- preventing the classic P1<->P2 swap deadlock before any head is recomputed.
CREATE OR REPLACE FUNCTION "phase2_lock_domain_work_partition_head"(
  p_agency TEXT,p_class TEXT,p_partition TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_partition IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'phase2:dwrp:' || p_agency || E'\\x1f' || p_class || E'\\x1f' || p_partition, 0
  ));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "phase2_lock_domain_work_agency_head"(
  p_agency TEXT,p_class TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_agency IS NULL OR p_class IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'phase2:dwra-scope:' || p_agency, 0
  ));
END;
$$ LANGUAGE plpgsql;

-- All DomainWorkItem mutation side effects must enter the tenant authority before
-- any AFTER trigger can lock per-family state or per-partition heads. PostgreSQL
-- fires same-kind triggers by name, and the family-state AFTER trigger sorts before
-- the ready-head AFTER trigger; relying on the latter to acquire the agency lock is
-- therefore too late for multi-class UPDATE/DELETE transactions.
CREATE OR REPLACE FUNCTION "phase2_lock_domain_work_mutation_scope"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='UPDATE'
     AND (OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
       OR OLD."workClass" IS DISTINCT FROM NEW."workClass") THEN
    RAISE EXCEPTION 'DomainWorkItem agencyId/workClass authority identity is immutable'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='DELETE' THEN
    PERFORM "phase2_lock_domain_work_agency_head"(OLD."agencyId",OLD."workClass");
    RETURN OLD;
  END IF;

  PERFORM "phase2_lock_domain_work_agency_head"(NEW."agencyId",NEW."workClass");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_00_phase2_domain_work_mutation_scope" ON "DomainWorkItem";
CREATE TRIGGER "trg_00_phase2_domain_work_mutation_scope"
BEFORE INSERT OR UPDATE OR DELETE ON "DomainWorkItem"
FOR EACH ROW EXECUTE FUNCTION "phase2_lock_domain_work_mutation_scope"();

CREATE OR REPLACE FUNCTION "phase2_refresh_domain_work_agency_head"(p_agency TEXT,p_class TEXT)
RETURNS VOID AS $$
DECLARE v_generation TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL THEN RETURN; END IF;
  PERFORM "phase2_lock_domain_work_agency_head"(p_agency,p_class);
  v_generation := "phase2_current_domain_work_generation"(p_class);
  SELECT MIN(p."nextDueAt") INTO v_due
    FROM "DomainWorkReadyPartition" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_class AND p."activeGeneration"=v_generation;
  v_id := 'dwra_' || md5(p_agency || E'\\x1f' || p_class);
  IF v_due IS NULL THEN
    DELETE FROM "DomainWorkReadyAgency" WHERE "agencyId"=p_agency AND "workClass"=p_class;
  ELSE
    INSERT INTO "DomainWorkReadyAgency"("id","agencyId","workClass","activeGeneration","nextDueAt","createdAt","updatedAt")
    VALUES(v_id,p_agency,p_class,v_generation,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("agencyId","workClass") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration","nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "phase2_refresh_domain_work_partition_head"(p_agency TEXT,p_class TEXT,p_partition TEXT)
RETURNS VOID AS $$
DECLARE v_generation TEXT;
DECLARE v_work TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_partition IS NULL THEN RETURN; END IF;
  -- Global lock order for head maintenance is agency scope -> partition. The
  -- agency lock intentionally ignores workClass so a multi-class mutation inside
  -- one tenant transaction cannot create class-order cycles.
  PERFORM "phase2_lock_domain_work_agency_head"(p_agency,p_class);
  PERFORM "phase2_lock_domain_work_partition_head"(p_agency,p_class,p_partition);
  v_generation := "phase2_current_domain_work_generation"(p_class);
  SELECT d."id",
         GREATEST(
           d."availableAt",
           COALESCE(d."nextAttemptAt",d."availableAt"),
           CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
         )
    INTO v_work,v_due
    FROM "DomainWorkItem" d
   WHERE d."agencyId"=p_agency
     AND d."workClass"=p_class
     AND d."partitionKey"=p_partition
     AND d."activeGeneration"=v_generation
     AND d."isOutstanding"=TRUE
     AND d."state" IN ('READY','CLAIMED')
   ORDER BY GREATEST(
           d."availableAt",
           COALESCE(d."nextAttemptAt",d."availableAt"),
           CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
         ),d."id"
   LIMIT 1;

  v_id := 'dwrp_' || md5(p_agency || E'\\x1f' || p_class || E'\\x1f' || p_partition);
  IF v_work IS NULL THEN
    DELETE FROM "DomainWorkReadyPartition"
     WHERE "agencyId"=p_agency AND "workClass"=p_class AND "partitionKey"=p_partition;
  ELSE
    INSERT INTO "DomainWorkReadyPartition"(
      "id","agencyId","workClass","partitionKey","activeGeneration","headWorkId","nextDueAt","createdAt","updatedAt"
    ) VALUES(v_id,p_agency,p_class,p_partition,v_generation,v_work,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration","headWorkId"=EXCLUDED."headWorkId",
      "nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
  END IF;
  PERFORM "phase2_refresh_domain_work_agency_head"(p_agency,p_class);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "phase2_domain_work_ready_head_trigger"()
RETURNS TRIGGER AS $$
DECLARE old_key TEXT;
DECLARE new_key TEXT;
BEGIN
  IF TG_OP='DELETE' THEN
    -- The agency authority must always be obtained before any partition authority.
    PERFORM "phase2_lock_domain_work_agency_head"(OLD."agencyId",OLD."workClass");
    PERFORM "phase2_refresh_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
    RETURN OLD;
  END IF;

  IF TG_OP='UPDATE'
     AND (OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
       OR OLD."workClass" IS DISTINCT FROM NEW."workClass") THEN
    RAISE EXCEPTION 'DomainWorkItem agencyId/workClass authority identity is immutable'
      USING ERRCODE='23514';
  END IF;

  -- Every normal DWI transaction is tenant-scoped.  Acquire the tenant head
  -- authority first; broad scheduler claims are split into one agency per DB
  -- transaction by claimDomainWorkBatch(), so this lock cannot participate in a
  -- cross-agency cycle.
  PERFORM "phase2_lock_domain_work_agency_head"(NEW."agencyId",NEW."workClass");

  IF TG_OP='UPDATE' AND OLD."partitionKey" IS DISTINCT FROM NEW."partitionKey" THEN
    old_key := OLD."workClass" || E'\x1f' || OLD."partitionKey";
    new_key := NEW."workClass" || E'\x1f' || NEW."partitionKey";
    IF old_key <= new_key THEN
      PERFORM "phase2_lock_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
      PERFORM "phase2_lock_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
    ELSE
      PERFORM "phase2_lock_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
      PERFORM "phase2_lock_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
    END IF;
    PERFORM "phase2_refresh_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
    PERFORM "phase2_refresh_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
    RETURN NEW;
  END IF;

  PERFORM "phase2_refresh_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- F54-02 cutover barrier: until this transaction commits, concurrent sessions
-- can still execute the previously committed (unserialized) DWI trigger body.
-- Drain existing DWI writers and block new INSERT/UPDATE/DELETE while the current
-- heads are revalidated. COMMIT then publishes the serialized trigger/functions
-- and the repaired locator state atomically. This is migration-only, not a runtime
-- global mutex.
LOCK TABLE "DomainWorkItem" IN SHARE ROW EXCLUSIVE MODE;

-- F54-02 migration convergence: installing the serialized algorithm is not
-- enough if a ready head was already corrupted by the pre-fix race. Revalidate
-- every currently represented/current outstanding identity once. These helpers
-- intentionally use session advisory locks and release them per identity so a
-- large current workset does not accumulate transaction-scoped advisory locks.
CREATE OR REPLACE FUNCTION "phase2_repair_domain_work_partition_head_once"(
  p_agency TEXT,p_class TEXT,p_partition TEXT
) RETURNS VOID AS $$
DECLARE v_lock BIGINT;
DECLARE v_generation TEXT;
DECLARE v_work TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_partition IS NULL THEN RETURN; END IF;
  v_lock := hashtextextended('phase2:dwrp:' || p_agency || E'\\x1f' || p_class || E'\\x1f' || p_partition, 0);
  PERFORM pg_advisory_lock(v_lock);
  BEGIN
    v_generation := "phase2_current_domain_work_generation"(p_class);
    SELECT d."id",
           GREATEST(
             d."availableAt",
             COALESCE(d."nextAttemptAt",d."availableAt"),
             CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
           )
      INTO v_work,v_due
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency
       AND d."workClass"=p_class
       AND d."partitionKey"=p_partition
       AND d."activeGeneration"=v_generation
       AND d."isOutstanding"=TRUE
       AND d."state" IN ('READY','CLAIMED')
     ORDER BY GREATEST(
             d."availableAt",
             COALESCE(d."nextAttemptAt",d."availableAt"),
             CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
           ),d."id"
     LIMIT 1;

    v_id := 'dwrp_' || md5(p_agency || E'\\x1f' || p_class || E'\\x1f' || p_partition);
    IF v_work IS NULL THEN
      DELETE FROM "DomainWorkReadyPartition"
       WHERE "agencyId"=p_agency AND "workClass"=p_class AND "partitionKey"=p_partition;
    ELSE
      INSERT INTO "DomainWorkReadyPartition"(
        "id","agencyId","workClass","partitionKey","activeGeneration","headWorkId","nextDueAt","createdAt","updatedAt"
      ) VALUES(v_id,p_agency,p_class,p_partition,v_generation,v_work,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
        "activeGeneration"=EXCLUDED."activeGeneration","headWorkId"=EXCLUDED."headWorkId",
        "nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(v_lock);
    RAISE;
  END;
  PERFORM pg_advisory_unlock(v_lock);
END;
$$ LANGUAGE plpgsql;

DO $phase2_repair_partition_heads$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT x."agencyId",x."workClass",x."partitionKey"
      FROM (
        SELECT p."agencyId",p."workClass",p."partitionKey" FROM "DomainWorkReadyPartition" p
        UNION
        SELECT d."agencyId",d."workClass",d."partitionKey"
          FROM "DomainWorkItem" d
         WHERE d."isOutstanding"=TRUE AND d."state" IN ('READY','CLAIMED')
      ) x
     ORDER BY x."agencyId",x."workClass",x."partitionKey"
  LOOP
    PERFORM "phase2_repair_domain_work_partition_head_once"(r."agencyId",r."workClass",r."partitionKey");
  END LOOP;
END;
$phase2_repair_partition_heads$;

CREATE OR REPLACE FUNCTION "phase2_repair_domain_work_agency_head_once"(
  p_agency TEXT,p_class TEXT
) RETURNS VOID AS $$
DECLARE v_lock BIGINT;
DECLARE v_generation TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL THEN RETURN; END IF;
  v_lock := hashtextextended('phase2:dwra-scope:' || p_agency, 0);
  PERFORM pg_advisory_lock(v_lock);
  BEGIN
    v_generation := "phase2_current_domain_work_generation"(p_class);
    SELECT MIN(p."nextDueAt") INTO v_due
      FROM "DomainWorkReadyPartition" p
     WHERE p."agencyId"=p_agency AND p."workClass"=p_class AND p."activeGeneration"=v_generation;
    v_id := 'dwra_' || md5(p_agency || E'\\x1f' || p_class);
    IF v_due IS NULL THEN
      DELETE FROM "DomainWorkReadyAgency" WHERE "agencyId"=p_agency AND "workClass"=p_class;
    ELSE
      INSERT INTO "DomainWorkReadyAgency"("id","agencyId","workClass","activeGeneration","nextDueAt","createdAt","updatedAt")
      VALUES(v_id,p_agency,p_class,v_generation,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT ("agencyId","workClass") DO UPDATE SET
        "activeGeneration"=EXCLUDED."activeGeneration","nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(v_lock);
    RAISE;
  END;
  PERFORM pg_advisory_unlock(v_lock);
END;
$$ LANGUAGE plpgsql;

DO $phase2_repair_agency_heads$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT x."agencyId",x."workClass"
      FROM (
        SELECT a."agencyId",a."workClass" FROM "DomainWorkReadyAgency" a
        UNION
        SELECT p."agencyId",p."workClass" FROM "DomainWorkReadyPartition" p
      ) x
     ORDER BY x."agencyId",x."workClass"
  LOOP
    PERFORM "phase2_repair_domain_work_agency_head_once"(r."agencyId",r."workClass");
  END LOOP;
END;
$phase2_repair_agency_heads$;

DROP FUNCTION "phase2_repair_domain_work_partition_head_once"(TEXT,TEXT,TEXT);
DROP FUNCTION "phase2_repair_domain_work_agency_head_once"(TEXT,TEXT);

COMMIT;
