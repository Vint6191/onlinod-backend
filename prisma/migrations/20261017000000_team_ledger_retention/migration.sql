-- V8: retention changes storage detail, not money. Never disable lifecycle fences.
-- Historical migrations stay immutable; existing monetary facts and identities survive.

CREATE OR REPLACE FUNCTION public.onlinod_project_team_ppv_fact_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  business_key TEXT;
  previous_business_key TEXT;
  first_lock_key TEXT;
  second_lock_key TEXT;
BEGIN

  -- A verified compaction-only transition must not rewrite the attribution fact
  -- or enqueue TEAM_READ_SUMMARY. Every semantic field still participates in
  -- equality; a concurrent monetary/ownership correction takes the full path.
  IF TG_OP='UPDATE' AND OLD."compactedAt" IS NULL AND NEW."compactedAt" IS NOT NULL
     AND OLD."historicalFactVersion"='team_money_fact_v2'
     AND OLD."historicalFactProjectedAt" IS NOT NULL
     AND NEW."rootVersion"='team_money_root_v2'
     AND (to_jsonb(NEW) - ARRAY['compactedAt','updatedAt']) = (to_jsonb(OLD) - ARRAY['compactedAt','updatedAt'])
     AND EXISTS (SELECT 1 FROM "TeamMoneyAttributionFact" f
       WHERE f."agencyId"=NEW."agencyId" AND f."sourceType"='PPV' AND f."sourceRowId"=NEW.id
         AND f."projectionVersion"='team_money_fact_v2' AND f."rootId"=NEW.id
         AND f."rootVersion"='team_money_root_v2') THEN
    RETURN NEW;
  END IF;
  business_key := CASE
    WHEN NEW."creatorSaleId" IS NOT NULL THEN 'sale:' || NEW."creatorSaleId"
    WHEN NEW."financialTransactionId" IS NOT NULL THEN 'financial:' || NEW."financialTransactionId"
    ELSE NULL
  END;

  SELECT "canonicalBusinessKey" INTO previous_business_key
  FROM "TeamMoneyAttributionFact"
  WHERE "agencyId" = NEW."agencyId" AND "sourceType" = 'PPV' AND "sourceRowId" = NEW."id";

  -- Lock both the former and current peer-set identities in deterministic
  -- lexical order. Concurrent duplicate generations therefore cannot each see
  -- themselves as the sole canonical peer and commit two CANONICAL facts.
  IF previous_business_key IS NOT NULL AND business_key IS NOT NULL AND previous_business_key <> business_key THEN
    first_lock_key := LEAST(previous_business_key, business_key);
    second_lock_key := GREATEST(previous_business_key, business_key);
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || first_lock_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || second_lock_key, 0));
  ELSIF COALESCE(business_key, previous_business_key) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || COALESCE(business_key, previous_business_key), 0));
  END IF;

  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'ppv_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'PPV', NEW."id", NEW."purchaseId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", COALESCE(NEW."fanId", NEW."buyerFanId"), NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."purchasedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    COALESCE(NEW."financialTransactionId", NEW."creatorSaleId"), NEW."creatorSaleId", NEW."financialTransactionId", NULL,
    NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP), NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'PENDING' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE 'PEER_SET_RECLASSIFICATION_PENDING' END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey",
    "classificationState"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'INCOMPLETE'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationState"
    END,
    "classificationReason"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PEER_SET_RECLASSIFICATION_PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationReason"
    END,
    "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'PPV', business_key);
  IF previous_business_key IS NOT NULL AND previous_business_key IS DISTINCT FROM business_key THEN
    PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'PPV', previous_business_key);
  END IF;

  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_project_team_tip_fact_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  business_key TEXT;
  previous_business_key TEXT;
  first_lock_key TEXT;
  second_lock_key TEXT;
BEGIN

  -- A verified compaction-only transition must not rewrite the attribution fact
  -- or enqueue TEAM_READ_SUMMARY. Every semantic field still participates in
  -- equality; a concurrent monetary/ownership correction takes the full path.
  IF TG_OP='UPDATE' AND OLD."compactedAt" IS NULL AND NEW."compactedAt" IS NOT NULL
     AND OLD."historicalFactVersion"='team_money_fact_v2'
     AND OLD."historicalFactProjectedAt" IS NOT NULL
     AND NEW."rootVersion"='team_money_root_v2'
     AND NEW."candidates" IS NULL
     AND NEW."weakCandidates" IS NULL
     AND NEW."result" IS NULL
     AND (to_jsonb(NEW) - ARRAY['compactedAt','updatedAt','candidates','weakCandidates','result']) = (to_jsonb(OLD) - ARRAY['compactedAt','updatedAt','candidates','weakCandidates','result'])
     AND EXISTS (SELECT 1 FROM "TeamMoneyAttributionFact" f
       WHERE f."agencyId"=NEW."agencyId" AND f."sourceType"='TIP' AND f."sourceRowId"=NEW.id
         AND f."projectionVersion"='team_money_fact_v2' AND f."rootId"=NEW.id
         AND f."rootVersion"='team_money_root_v2') THEN
    RETURN NEW;
  END IF;
  business_key := CASE WHEN NEW."creatorTipId" IS NOT NULL THEN 'tip:' || NEW."creatorTipId" ELSE NULL END;

  SELECT "canonicalBusinessKey" INTO previous_business_key
  FROM "TeamMoneyAttributionFact"
  WHERE "agencyId" = NEW."agencyId" AND "sourceType" = 'TIP' AND "sourceRowId" = NEW."id";

  IF previous_business_key IS NOT NULL AND business_key IS NOT NULL AND previous_business_key <> business_key THEN
    first_lock_key := LEAST(previous_business_key, business_key);
    second_lock_key := GREATEST(previous_business_key, business_key);
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || first_lock_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || second_lock_key, 0));
  ELSIF COALESCE(business_key, previous_business_key) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || COALESCE(business_key, previous_business_key), 0));
  END IF;

  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'tip_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'TIP', NEW."id", NEW."tipId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", NEW."fanId", NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."receivedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'claimed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    NEW."creatorTipId", NULL, NULL, NEW."creatorTipId", NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'PENDING' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE 'PEER_SET_RECLASSIFICATION_PENDING' END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey",
    "classificationState"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'INCOMPLETE'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationState"
    END,
    "classificationReason"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PEER_SET_RECLASSIFICATION_PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationReason"
    END,
    "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'TIP', business_key);
  IF previous_business_key IS NOT NULL AND previous_business_key IS DISTINCT FROM business_key THEN
    PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'TIP', previous_business_key);
  END IF;

  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$function$;

-- Bounded global maintenance selectors, including already-compacted histories.
CREATE INDEX "TeamTipLedger_retention_compact_v8_idx" ON "TeamTipLedger"("receivedAt",id)
  WHERE "compactedAt" IS NULL AND "historicalFactVersion"='team_money_fact_v2' AND "historicalFactProjectedAt" IS NOT NULL;
CREATE INDEX "TeamPpvPurchaseLedger_retention_compact_v8_idx" ON "TeamPpvPurchaseLedger"("purchasedAt",id)
  WHERE "compactedAt" IS NULL AND "historicalFactVersion"='team_money_fact_v2' AND "historicalFactProjectedAt" IS NOT NULL
    AND status IN ('resolved','expired','attributed','unresolved','rejected','creator_revenue');
CREATE INDEX "TeamPpvResolveJob_retention_pending_v8_idx" ON "TeamPpvResolveJob"("expiresAt",id) WHERE status='pending';
CREATE INDEX "TeamPpvResolveJob_retention_expired_v8_idx" ON "TeamPpvResolveJob"("expiresAt",id) WHERE status IN ('resolved','expired','rejected');
CREATE INDEX "TeamPpvResolveJob_retention_old_v8_idx" ON "TeamPpvResolveJob"("createdAt",id) WHERE status IN ('resolved','expired','rejected');
