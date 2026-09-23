-- Phase 3 DomainWork Prisma numeric ABI contract.
--
-- Prisma binds JavaScript integer Number values used by raw queries as
-- PostgreSQL int8.  DomainWork storage deliberately keeps claim shards and
-- bounded batch sizes as int4, and DB-internal callers use those int4 APIs.
-- PostgreSQL does not perform an implicit narrowing cast while resolving an
-- overloaded function, so application calls must terminate at explicit int8
-- entry points.  These entry points validate/clamp before narrowing and then
-- delegate to the canonical storage implementations.  This keeps wire-type
-- compatibility in one database API instead of distributing casts through
-- claimers, fixtures and maintenance callers.

BEGIN;

CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_shard"(
  p_agency TEXT,
  p_work_class TEXT,
  p_generation TEXT,
  p_shard BIGINT,
  p_touched_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
AS $$
  SELECT CASE
    WHEN p_shard >= 0 AND p_shard < 128 THEN
      "phase3_reconcile_domain_work_claim_shard"(
        p_agency,
        p_work_class,
        p_generation,
        p_shard::INTEGER,
        "phase3_utc_timestamp"(p_touched_at)
      )
    ELSE FALSE
  END;
$$;

CREATE OR REPLACE FUNCTION "phase3_wake_domain_dependency_batch"(
  p_agency TEXT,
  p_kind TEXT,
  p_key TEXT,
  p_revision BIGINT,
  p_limit BIGINT
)
RETURNS TABLE("woken" INTEGER,"remaining" BOOLEAN)
LANGUAGE sql
VOLATILE
AS $$
  SELECT wake_result."woken",wake_result."remaining"
    FROM "phase3_wake_domain_dependency_batch"(
      p_agency,
      p_kind,
      p_key,
      p_revision,
      GREATEST(
        1::BIGINT,
        LEAST(COALESCE(p_limit,100::BIGINT),500::BIGINT)
      )::INTEGER
    ) AS wake_result;
$$;

COMMENT ON FUNCTION "phase3_reconcile_domain_work_claim_shard"(TEXT,TEXT,TEXT,BIGINT,TIMESTAMPTZ) IS
  'Prisma int8/timestamptz boundary for bounded claim-shard reconciliation; validates before delegating to int4/timestamp(3) storage authority.';

COMMENT ON FUNCTION "phase3_wake_domain_dependency_batch"(TEXT,TEXT,TEXT,BIGINT,BIGINT) IS
  'Prisma int8 boundary for dependency wake batches; clamps the batch limit before delegating to the canonical int4 implementation.';

COMMIT;
