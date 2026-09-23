-- Phase 3 domain-work temporal API contract.
--
-- Prisma/Node binds JavaScript Date values as PostgreSQL timestamptz.  The
-- canonical DomainWork projection columns intentionally remain UTC
-- TIMESTAMP(3) values, and DB-internal callers already use TIMESTAMP(3).
-- Keep the existing timestamp overloads as the storage/internal API and add
-- an explicit timestamptz boundary for application and CURRENT_TIMESTAMP
-- callers.  Conversion is always UTC and never depends on the session
-- TimeZone setting.

BEGIN;

CREATE OR REPLACE FUNCTION "phase3_utc_timestamp"(p_value TIMESTAMPTZ)
RETURNS TIMESTAMP(3)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT (p_value AT TIME ZONE 'UTC')::TIMESTAMP(3);
$$;

CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_partition"(
  p_agency TEXT,
  p_work_class TEXT,
  p_generation TEXT,
  p_partition TEXT,
  p_touched_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
AS $$
  SELECT "phase3_reconcile_domain_work_claim_partition"(
    p_agency,
    p_work_class,
    p_generation,
    p_partition,
    "phase3_utc_timestamp"(p_touched_at)
  );
$$;

CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_shard"(
  p_agency TEXT,
  p_work_class TEXT,
  p_generation TEXT,
  p_shard INTEGER,
  p_touched_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
AS $$
  SELECT "phase3_reconcile_domain_work_claim_shard"(
    p_agency,
    p_work_class,
    p_generation,
    p_shard,
    "phase3_utc_timestamp"(p_touched_at)
  );
$$;

CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_agency"(
  p_agency TEXT,
  p_work_class TEXT,
  p_generation TEXT,
  p_touched_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
AS $$
  SELECT "phase3_reconcile_domain_work_claim_agency"(
    p_agency,
    p_work_class,
    p_generation,
    "phase3_utc_timestamp"(p_touched_at)
  );
$$;

COMMENT ON FUNCTION "phase3_utc_timestamp"(TIMESTAMPTZ) IS
  'Canonical UTC millisecond conversion for Node/Prisma timestamptz inputs into Phase 3 timestamp(3) storage APIs.';

COMMENT ON FUNCTION "phase3_reconcile_domain_work_claim_partition"(TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ) IS
  'Application temporal boundary for partition reconciliation; delegates to the canonical timestamp(3) implementation.';

COMMENT ON FUNCTION "phase3_reconcile_domain_work_claim_shard"(TEXT,TEXT,TEXT,INTEGER,TIMESTAMPTZ) IS
  'Application temporal boundary for shard reconciliation; delegates to the canonical timestamp(3) implementation.';

COMMENT ON FUNCTION "phase3_reconcile_domain_work_claim_agency"(TEXT,TEXT,TEXT,TIMESTAMPTZ) IS
  'Application temporal boundary for Agency reconciliation; delegates to the canonical timestamp(3) implementation.';

COMMIT;
