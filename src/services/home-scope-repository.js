"use strict";

// Compact, versioned membership authority. Never exports assignedCreators or
// materializes all permitted ids in Node. A36's current projection is required
// for a restricted scope; an incomplete rollout must not look like an empty team.
const TOPOLOGY = "phase3_domain_work_claim_topology_a36_v1";
const MEMBER_CURRENT = "MEMBER_CURRENT";
function scopeError(code, status = 403) { return Object.assign(new Error(code), { code, status }); }
function scopeParams({ agencyId, member, billing = false }) {
  if (!agencyId || member?.agencyId !== agencyId || !member?.id || !member?.userId
      || !Number.isInteger(Number(member.accessEpoch)) || Number(member.accessEpoch) < 1) {
    throw scopeError("HOME_ACCESS_FENCE_REQUIRED");
  }
  return [agencyId, member.id, member.userId, Number(member.accessEpoch), billing === true];
}
function scopeSql({ cursor = false, cursorParameter = 6, ready = false, broad = null } = {}) {
  // SQL text choices are internal constants, never supplied by HTTP.
  if (![6,12].includes(cursorParameter)) throw new Error("HOME_CURSOR_PARAMETER_INVALID");
  const boundary = cursor ? `AND c."id">$${cursorParameter}::text` : '';
  const status = ready ? 'AND c."status"=\'READY\'' : '';
  const columns = 'c."agencyId",c."displayName",c."username",c."avatarUrl",c."status",c."remoteId"';
  const broadBranch = `SELECT c."id",${columns} FROM authority m JOIN "CreatorAccount" c ON c."agencyId"=m."agencyId"
      WHERE c."agencyId"=$1 AND m.broad AND c."deletedAt" IS NULL ${boundary} ${status}`;
  // OFFSET 0 preserves the parameterized primary-key lookup even before ANALYZE.
  // Without this fence PG can underestimate a new membership and re-scan the
  // entire agency for each access row. Return x.creatorId as the sort key so the
  // (memberId,creatorId) index can stop at the page limit without sorting C rows.
  const scopedBranch = `SELECT x."creatorId" AS id,${columns} FROM authority m JOIN "AgencyMemberCreatorAccessCurrent" x
      ON x."memberId"=m."id" AND x."agencyId"=m."agencyId" AND x."accessEpoch"=m."accessEpoch"
      JOIN LATERAL (SELECT c.* FROM "CreatorAccount" c WHERE c."id"=x."creatorId" AND c."agencyId"=$1
        AND c."deletedAt" IS NULL ${status} OFFSET 0) c ON true
      WHERE x."memberId"=$2 AND x."accessEpoch"=$4 AND NOT m.broad AND m.projected
        ${cursor ? `AND x."creatorId">$${cursorParameter}::text` : ''}`;
  return `WITH authority AS MATERIALIZED (
    SELECT m."id",m."userId",m."agencyId",m."accessEpoch",m."role",m."roleKey",m."permissions",
      "phase3_member_has_broad_creator_access"(m."role"::text,m."roleKey",m."assignedCreators") AS broad,
      EXISTS (SELECT 1 FROM "DomainWorkClaimTopologyState" t WHERE t."id"='${TOPOLOGY}'
        AND t."generation"='${TOPOLOGY}' AND t."activationState"='ACTIVE') AS projected
    FROM "AgencyMember" m JOIN "Agency" a ON a."id"=m."agencyId" AND a."deletedAt" IS NULL
      JOIN "User" u ON u."id"=m."userId" AND u."disabledAt" IS NULL
    WHERE m."agencyId"=$1 AND m."id"=$2 AND m."userId"=$3 AND m."accessEpoch"=$4
      AND m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
  ), billing AS MATERIALIZED (
    SELECT a."billingSupportHold",a."trialEndsAt",COALESCE(s."billingMode"::text,'MANUAL') AS mode,
      clock_timestamp() AT TIME ZONE 'UTC' AS at
    FROM "Agency" a LEFT JOIN LATERAL (SELECT "billingMode" FROM "AgencySubscription"
      WHERE "agencyId"=a."id" ORDER BY "createdAt" DESC,"id" DESC LIMIT 1) s ON true WHERE a."id"=$1
  ), membership_creators AS (
    ${broad === true ? broadBranch : broad === false ? scopedBranch : broadBranch+' UNION ALL '+scopedBranch}
  ), visible AS (
    SELECT c.* FROM membership_creators c CROSS JOIN billing b
    WHERE NOT $5::boolean OR (NOT b."billingSupportHold" AND (b.mode='FREE_INTERNAL' OR b."trialEndsAt">b.at
      OR EXISTS (SELECT 1 FROM (SELECT e."agencyId",e."coreValidUntil",e."coreValidFrom"
        FROM "CreatorBillingEntitlement" e WHERE e."creatorId"=c."id" OFFSET 0) e WHERE e."agencyId"=$1
        AND e."coreValidUntil">b.at AND (e."coreValidFrom" IS NULL OR e."coreValidFrom"<=b.at))))
  )`;
}
async function readHomeAuthority({ db, ...input }) {
  const [row] = await db.$queryRawUnsafe(`${scopeSql()} SELECT * FROM authority`, ...scopeParams(input));
  if (!row) throw scopeError("HOME_ACCESS_CHANGED");
  if (!row.broad && !row.projected) throw scopeError("HOME_SCOPE_PROJECTION_NOT_READY", 503);
  return row;
}
async function readDemandCreatorPage({ db, agencyId, member, cursor = null, take, creatorIds = null, billing = false }) {
  const size = Math.max(1, Math.min(501, Math.floor(Number(take) || 1)));
  return db.$queryRawUnsafe(`${scopeSql({ cursor: true, ready: true, broad: typeof member.broad === "boolean" ? member.broad : null })}
    SELECT "id","agencyId" FROM visible WHERE ($7::text[] IS NULL OR "id"=ANY($7::text[]))
    ORDER BY "id" LIMIT $8`, ...scopeParams({ agencyId, member, billing }), cursor || '', creatorIds, size);
}
module.exports = { MEMBER_CURRENT, scopeSql, scopeParams, readHomeAuthority, readDemandCreatorPage, scopeError };
