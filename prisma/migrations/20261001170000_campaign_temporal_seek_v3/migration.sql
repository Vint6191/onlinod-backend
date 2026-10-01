BEGIN;

-- Generic plans can estimate one row for a hot creator/fan and prefer the
-- smaller (creatorId,fanId) index plus a full sort. A tuple range alone does
-- not prevent that plan. These two ordered seeks own a local planner policy:
-- retain the existing temporal index's order, never sort the fan's history.
-- Function SET is restored on return/error; publisher, queue, callers and the
-- rest of the transaction keep their own planner settings. No fleet-wide GUC.
-- The online index contract already requires CampaignFan_read_attribution_v1.
-- VOLATILE is intentional: trigger callers must see this command's new facts.
CREATE FUNCTION "onlinod_campaign_read_successor_v3"(a TEXT,c TEXT,f TEXT,source_id TEXT,t TIMESTAMP(3))
RETURNS TIMESTAMP(3) LANGUAGE plpgsql VOLATILE SET enable_sort=off AS $$
DECLARE successor TIMESTAMP(3); scope_agency TEXT;
BEGIN
  IF f IS NULL OR t IS NULL OR source_id IS NULL THEN RETURN NULL; END IF;
  -- Reject a mismatched scope with one PK lookup, before visiting memberships.
  SELECT "agencyId" INTO scope_agency FROM "CreatorAccount" WHERE "id"=c;
  IF scope_agency IS DISTINCT FROM a OR scope_agency IS NULL THEN RETURN NULL; END IF;
  SELECT m."attributedAt" INTO successor FROM "CreatorCampaignFan" m
    WHERE m."creatorId"=c AND m."agencyId"=a AND m."fanId"=f AND m."id"<>source_id
      AND (m."attributedAt",m."id")>(t,source_id)
    ORDER BY m."attributedAt",m."id" LIMIT 1;
  RETURN successor;
END $$;

CREATE FUNCTION "onlinod_campaign_read_attribution_v3"(a TEXT,c TEXT,f TEXT,t TIMESTAMP(3))
RETURNS TEXT LANGUAGE plpgsql VOLATILE SET enable_sort=off AS $$
DECLARE campaign TEXT; scope_agency TEXT;
BEGIN
  IF f IS NULL OR t IS NULL THEN RETURN NULL; END IF;
  SELECT "agencyId" INTO scope_agency FROM "CreatorAccount" WHERE "id"=c;
  IF scope_agency IS DISTINCT FROM a OR scope_agency IS NULL THEN RETURN NULL; END IF;
  SELECT m."campaignId" INTO campaign FROM "CreatorCampaignFan" m
    WHERE m."creatorId"=c AND m."agencyId"=a AND m."fanId"=f AND m."attributedAt"<=t
    ORDER BY m."attributedAt" DESC,m."id" DESC LIMIT 1;
  RETURN campaign;
END $$;

-- Keep the capture ABI: old and new writers acquire the same corrected
-- successor semantics immediately after this forward-only function cutover.
CREATE OR REPLACE FUNCTION "onlinod_campaign_read_repair_v2"(a TEXT,c TEXT,f TEXT,source_id TEXT,t TIMESTAMP(3))
RETURNS void LANGUAGE plpgsql AS $$
DECLARE successor TIMESTAMP(3);
BEGIN
  IF f IS NULL OR t IS NULL THEN RETURN; END IF;
  successor:="onlinod_campaign_read_successor_v3"(a,c,f,source_id,t);
  IF successor=t THEN RETURN; END IF;
  INSERT INTO "CampaignReadRepairInterval"("agencyId","creatorId","fanId","fromAt","untilAt") VALUES(a,c,f,t,successor);
  PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_ATTRIBUTION','CampaignFan',f,c,c);
END $$;

COMMIT;
