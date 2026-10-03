"use strict";

const { sealedDirectoryCount, revision } = require("./campaign-directory-count-authority");
const MAX_TARGETS = 200;
function enabled(job) { return Number(job?.params?.campaignBoundedTraversalVersion || 0) >= 1; }
function fault(code) { return Object.assign(new Error(code), { code }); }
function selection(state, scanRunId) {
  const value = state?.campaignFrontierSelection;
  if (value?.version !== 1 || value.scanRunId !== scanRunId || state?.campaignFrontierPlanRunId !== scanRunId) return null;
  if (!Array.isArray(value.ids) || value.ids.length > MAX_TARGETS || new Set(value.ids).size !== value.ids.length
    || value.ids.some(id => typeof id !== "string" || !id || id.length > 220)
    || typeof value.countExact !== "boolean" || value.ids.length !== state.campaignFrontierTargetCount) {
    throw fault("CAMPAIGN_FRONTIER_SELECTION_INVALID");
  }
  return value;
}
function assertBinding(state, plan, directory) {
  if (plan.directoryGeneration !== directory.generation || plan.directoryRevision !== directory.revision
    || plan.directoryRequestedAt !== new Date(directory.requestedAt).toISOString()
    || plan.directoryCount !== directory.campaignCount
    || revision(plan.countRevision) !== revision(state.campaignDirectoryCountRevision)
    || sealedDirectoryCount(state, directory) === null) throw fault("CAMPAIGN_FRONTIER_SELECTION_STALE");
}
function countsExact(state) { return selection(state, state?.campaignFrontierPlanRunId)?.countExact !== false; }
async function selectTargets(db, exactGeneration, now, budget) {
  const limit = Math.min(MAX_TARGETS, budget) + 1;
  // Separate indexed ranges avoid an OR bitmap+sort over the whole directory.
  // Each range includes one lookahead row; merging preserves an exact empty
  // result and an explicit lower bound when a population exceeds the budget.
  const predicates = [{ claimersNextDueAt: null }, { claimersNextDueAt: { lte: now } }];
  const found = new Map();
  for (const predicate of predicates) {
    const rows = await db.creatorCampaign.findMany({ where: { ...exactGeneration, ...predicate },
      orderBy: [{ claimersNextDueAt: "asc" }, { externalCampaignId: "asc" }], take: limit,
      select: { id: true, externalCampaignId: true, claimersNextDueAt: true } });
    for (const row of rows) found.set(row.id, row);
  }
  // The literal is the schema-version predicate of the partial index, not user
  // data. Parameterizing it makes PostgreSQL's generic prepared plan unable to
  // prove that predicate and turns the empty lookup into a full catalog scan.
  // All scope, time and size inputs remain bound parameters.
  const unknown = await db.$queryRawUnsafe(`SELECT "id", "externalCampaignId", "claimersNextDueAt"
    FROM "CreatorCampaign"
    WHERE "creatorId"=$1 AND "sourceScanRunId"=$2
      AND "sourceScanStartedAt"=($3::timestamptz AT TIME ZONE 'UTC')
      AND "claimersObservationVersion" < 1
    ORDER BY "claimersNextDueAt", "externalCampaignId" LIMIT $4`,
  exactGeneration.creatorId, exactGeneration.sourceScanRunId, exactGeneration.sourceScanStartedAt, limit);
  for (const row of unknown) found.set(row.id, row);
  const rows = [...found.values()].sort((a, b) => {
    const left = a.claimersNextDueAt == null ? -Infinity : +new Date(a.claimersNextDueAt);
    const right = b.claimersNextDueAt == null ? -Infinity : +new Date(b.claimersNextDueAt);
    return left < right ? -1 : left > right ? 1 : a.externalCampaignId < b.externalCampaignId ? -1 : a.externalCampaignId > b.externalCampaignId ? 1 : 0;
  });
  const targets = rows.slice(0, limit - 1), countExact = rows.length < limit;
  return { targets, countExact, dueCount: targets.length + (countExact ? 0 : 1),
    oldestDueAt: rows[0]?.claimersNextDueAt || (rows.length ? now : null) };
}
function createSelection(state, directory, scanRunId, targets, countExact) {
  return { version: 1, scanRunId, directoryGeneration: directory.generation,
    directoryRequestedAt: new Date(directory.requestedAt).toISOString(), directoryRevision: directory.revision,
    directoryCount: directory.campaignCount, countRevision: String(state.campaignDirectoryCountRevision),
    countExact, ids: targets.map(row => row.externalCampaignId).sort() };
}
function pageSelection(plan, cursor) {
  const index = cursor === null ? 0 : plan.ids.indexOf(cursor) + 1;
  if (cursor !== null && index === 0) throw fault("CAMPAIGN_FRONTIER_CURSOR_INVALID");
  const page = plan.ids.slice(index, index + 50);
  return { page: page.map(externalCampaignId => ({ externalCampaignId })), hasMore: index + page.length < plan.ids.length };
}
module.exports = { enabled, selection, assertBinding, countsExact, selectTargets, createSelection, pageSelection };
