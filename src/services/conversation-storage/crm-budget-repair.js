"use strict";
const c = require("./common");
const { CrmRepository } = require("./crm-repository");

/** Read only; each candidate carries its exact revision and original values. */
async function inventoryInvalidBudgets({ db, agencyId, after = null, limit = 100 }) {
  c.text(agencyId);
  const take = Math.min(500, Math.max(1, c.integer(limit, 100, 500)));
  let cursor = { scopeId: "", fanId: "" };
  if (after) {
    try {
      c.check(typeof after === "string" && after.length <= 1024, "CRM_REPAIR_CURSOR_INVALID", 400);
      const decoded = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
      c.check(decoded.agencyId === agencyId && decoded.policyVersion === 1, "CRM_REPAIR_CURSOR_INVALID", 400);
      c.text(decoded.scopeId); c.platformId(decoded.fanId); cursor = decoded;
    } catch { throw c.fail("CRM_REPAIR_CURSOR_INVALID", 400); }
  }
  const rows = await c.rows(db, `SELECT p.scope_id,p.fan_id,p.revision,p.profile->'budgetMin' AS "budgetMin",p.profile->'budgetMax' AS "budgetMax",s.platform_creator_id
    FROM crm_profile p JOIN crm_scope s USING(scope_id)
    WHERE s.agency_id=$1 AND (p.scope_id,p.fan_id)>($2,$3)
      AND jsonb_typeof(p.profile->'budgetMin')='number' AND jsonb_typeof(p.profile->'budgetMax')='number'
      AND (p.profile->>'budgetMin')::numeric>(p.profile->>'budgetMax')::numeric
    ORDER BY p.scope_id,p.fan_id LIMIT $4`, agencyId, cursor.scopeId, cursor.fanId, take + 1);
  const selected = rows.slice(0, take), last = selected[selected.length - 1];
  return { ok: true, policyVersion: 1, mode: "dry-run", agencyId,
    candidates: selected.map(row => ({ scopeId: row.scope_id, platformCreatorId: row.platform_creator_id,
      fanId: row.fan_id, expectedRevision: Number(row.revision), before: { budgetMin: row.budgetMin, budgetMax: row.budgetMax }, requiresReview: true })),
    hasMore: rows.length > take,
    nextCursor: rows.length > take && last ? Buffer.from(JSON.stringify({ policyVersion: 1, agencyId, scopeId: last.scope_id, fanId: last.fan_id })).toString('base64url') : null };
}

/** Explicit reviewed repair. It never guesses, swaps or zeros the intended bounds. */
async function repairInvalidBudget({ db, agencyId, platformCreatorId, fanId, expectedRevision, before, after, reason, commandId, actorId }) {
  c.text(actorId); c.text(reason, 1000); c.platformId(platformCreatorId); c.platformId(fanId);
  c.check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "CRM_EXPECTED_REVISION_REQUIRED", 400);
  for (const key of ["budgetMin", "budgetMax"]) {
    c.check(Object.hasOwn(after || {}, key), "CRM_REPAIR_BOUNDS_REQUIRED", 400);
    c.check(after[key] === null || (Number.isFinite(after[key]) && after[key] >= 0), "CRM_BUDGET_INVALID", 400);
  }
  c.check(after.budgetMin == null || after.budgetMax == null || after.budgetMin <= after.budgetMax, "CRM_BUDGET_INVALID", 400);
  const ctx = { agencyId, platformCreatorId, scopeId: c.scopeId(agencyId, platformCreatorId), actorId, deviceId: "reviewed-budget-repair-v1" };
  const repository = new CrmRepository(db, null);
  const payload = { kind: "budget.repair.v1", fanId, expectedRevision, before, after, reason };
  return repository.command(ctx, commandId, payload, async tx => {
    const row = await c.one(tx, "SELECT * FROM crm_profile WHERE scope_id=$1 AND fan_id=$2 FOR UPDATE", ctx.scopeId, fanId);
    c.check(row, "CRM_REPAIR_TARGET_MISSING", 404);
    c.check(Number(row.revision) === expectedRevision && row.profile.budgetMin === before?.budgetMin && row.profile.budgetMax === before?.budgetMax, "CRM_EDIT_CONFLICT", 409);
    c.check(row.profile.budgetMin != null && row.profile.budgetMax != null && row.profile.budgetMin > row.profile.budgetMax, "CRM_REPAIR_NOT_REQUIRED", 409);
    const revision = expectedRevision + 1, profile = { ...row.profile, budgetMin: after.budgetMin, budgetMax: after.budgetMax };
    const fields = { ...row.field_versions, budgetMin: revision, budgetMax: revision };
    const manual = [...new Set([...row.manual_fields, "budgetMin", "budgetMax"])];
    await c.exec(tx, "UPDATE crm_profile SET profile=$3::jsonb,revision=$4,field_versions=$5::jsonb,manual_fields=$6::jsonb,updated_at=now() WHERE scope_id=$1 AND fan_id=$2", ctx.scopeId, fanId, JSON.stringify(profile), revision, JSON.stringify(fields), JSON.stringify(manual));
    const result = { ok: true, policyVersion: 1, commandId, fanId, expectedRevision, revision, before, after, reason };
    await repository.touch(ctx, fanId, tx, "budget.repair.reviewed", result);
    return result;
  });
}
module.exports = { inventoryInvalidBudgets, repairInvalidBudget };
