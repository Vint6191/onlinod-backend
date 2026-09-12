-- ONLINOD Phase 2 / Actual56 final closure C.
-- C3/C4: one current OperationalPendingOwner authority shared by Pending UI,
-- summaries, Team Analytics metrics/overview and alerts.
-- Historical ownerMemberId remains attribution only.

CREATE OR REPLACE VIEW "TeamOperationalPendingCurrent" AS
SELECT
  p.*,
  CASE
    WHEN m."id" IS NOT NULL
     AND u."id" IS NOT NULL
     AND "phase2_scope_allows_creator"(m."assignedCreators",p."creatorId")
      THEN p."ownerMemberId"
    ELSE NULL
  END AS "operationalOwnerMemberId"
FROM "TeamPendingDialogStateCurrent" p
JOIN "CreatorAccount" c
  ON c."id"=p."creatorId"
 AND c."agencyId"=p."agencyId"
 AND c."deletedAt" IS NULL
LEFT JOIN "AgencyMember" m
  ON m."id"=p."ownerMemberId"
 AND m."agencyId"=p."agencyId"
 AND m."deletedAt" IS NULL
 AND m."deactivatedAt" IS NULL
LEFT JOIN "User" u
  ON u."id"=m."userId"
 AND u."disabledAt" IS NULL;

-- The base-table current-generation index already provides the bounded pending
-- scan. Add owner-first support for team/member dashboards that select one current
-- operational owner after the view joins the primary-key Member/User identities.
CREATE INDEX IF NOT EXISTS "TeamPendingDialogState_operational_owner_scan_idx"
  ON "TeamPendingDialogStateCurrent"(
    "agencyId","derivationVersion","projectionState","status","ownerMemberId","firstIncomingAt","id"
  );
