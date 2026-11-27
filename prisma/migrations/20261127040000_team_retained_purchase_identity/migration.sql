BEGIN;
SET LOCAL lock_timeout = '5s';
-- Nullable canonical links may be cleared by retention. The durable, typed
-- aliases keep that root's operation identity after those FK rows disappear.
CREATE OR REPLACE FUNCTION onlinod_guard_team_purchase_identity_v3() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE has_aliases boolean; matches_sale boolean := false; matches_financial boolean := false;
BEGIN
 IF TG_TABLE_NAME='TeamPpvPurchaseAlias' THEN
  IF ROW(NEW."agencyId",NEW."creatorId",NEW.namespace,NEW."externalId",NEW."rootId")
    IS DISTINCT FROM ROW(OLD."agencyId",OLD."creatorId",OLD.namespace,OLD."externalId",OLD."rootId")
  THEN RAISE EXCEPTION 'TEAM_PURCHASE_ALIAS_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF NEW."agencyId" IS DISTINCT FROM OLD."agencyId"
   OR (OLD."creatorId" IS NOT NULL AND NEW."creatorId" IS DISTINCT FROM OLD."creatorId")
   OR (OLD."creatorSaleId" IS NOT NULL AND NEW."creatorSaleId" IS NOT NULL AND NEW."creatorSaleId"<>OLD."creatorSaleId")
   OR (OLD."financialTransactionId" IS NOT NULL AND NEW."financialTransactionId" IS NOT NULL AND NEW."financialTransactionId"<>OLD."financialTransactionId")
 THEN RAISE EXCEPTION 'TEAM_PURCHASE_ROOT_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM "TeamPpvPurchaseAlias" a WHERE a."rootId"=OLD.id
   AND (a."agencyId" IS DISTINCT FROM NEW."agencyId" OR a."creatorId" IS DISTINCT FROM NEW."creatorId"))
 THEN RAISE EXCEPTION 'TEAM_PURCHASE_ROOT_SCOPE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 SELECT EXISTS(SELECT 1 FROM "TeamPpvPurchaseAlias" a WHERE a."rootId"=OLD.id) INTO has_aliases;
 IF has_aliases AND ((OLD."creatorSaleId" IS NULL AND NEW."creatorSaleId" IS NOT NULL)
   OR (OLD."financialTransactionId" IS NULL AND NEW."financialTransactionId" IS NOT NULL)) THEN
  SELECT EXISTS(SELECT 1 FROM "CreatorSale" s WHERE s.id=NEW."creatorSaleId"
    AND s."agencyId"=NEW."agencyId" AND s."creatorId"=NEW."creatorId"
    AND EXISTS(SELECT 1 FROM "TeamPpvPurchaseAlias" a WHERE a."rootId"=OLD.id
      AND a."agencyId"=NEW."agencyId" AND a."creatorId"=NEW."creatorId" AND (
      (a.namespace='creator_sale' AND a."externalId"=s.id)
      OR (a.namespace='transaction' AND a."externalId"=s."externalTransactionId")
      OR (a.namespace='notification' AND a."externalId"=s."externalNotificationId")
      OR (a.namespace='event' AND a."externalId"=s."eventFingerprint")))) INTO matches_sale;
  SELECT EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" f WHERE f.id=NEW."financialTransactionId"
    AND f."agencyId"=NEW."agencyId" AND f."creatorId"=NEW."creatorId" AND (
      EXISTS(SELECT 1 FROM "TeamPpvPurchaseAlias" a WHERE a."rootId"=OLD.id
        AND a."agencyId"=NEW."agencyId" AND a."creatorId"=NEW."creatorId"
        AND a.namespace='transaction' AND a."externalId"=f."externalTransactionId")
      OR (matches_sale AND EXISTS(SELECT 1 FROM "CreatorSale" s WHERE s.id=NEW."creatorSaleId"
        AND s."externalTransactionId"=f."externalTransactionId")))) INTO matches_financial;
  IF (OLD."creatorSaleId" IS NULL AND NEW."creatorSaleId" IS NOT NULL AND NOT matches_sale)
    OR (OLD."financialTransactionId" IS NULL AND NEW."financialTransactionId" IS NOT NULL AND NOT matches_financial)
  THEN RAISE EXCEPTION 'TEAM_PURCHASE_RETAINED_IDENTITY_MISMATCH' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $body$;
COMMIT;
