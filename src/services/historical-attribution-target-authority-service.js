"use strict";

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

const INVALID_TARGET_CODE = "HISTORICAL_ATTRIBUTION_TARGET_INVALID";

/**
 * Canonical target authority for explicit manager adjudication of historical
 * Team money. A deactivated member remains a valid historical attribution
 * target; a removed member does not become a new target again.
 *
 * Automatic attribution is intentionally outside this authority and remains
 * evidence-based in the PPV/Tip reconciliation paths.
 */
async function resolveHistoricalAttributionTarget({ tx, agencyId, targetMemberId }) {
  const safeAgencyId = clean(agencyId, 180);
  const safeMemberId = clean(targetMemberId, 180);
  if (!tx || !safeAgencyId || !safeMemberId) {
    return { ok: false, code: INVALID_TARGET_CODE, member: null };
  }
  if (!tx?.agencyMember?.findFirst) {
    const error = Object.assign(new Error("Agency member storage is required for historical attribution target resolution"), {
      code: "HISTORICAL_ATTRIBUTION_TARGET_STORAGE_REQUIRED",
      status: 500,
    });
    throw error;
  }

  const member = await tx.agencyMember.findFirst({
    where: {
      agencyId: safeAgencyId,
      id: safeMemberId,
      deletedAt: null,
    },
    select: {
      id: true,
      userId: true,
      deactivatedAt: true,
    },
  });

  if (!member) return { ok: false, code: INVALID_TARGET_CODE, member: null };
  return {
    ok: true,
    code: null,
    member,
    status: member.deactivatedAt ? "deactivated" : "active",
  };
}

module.exports = {
  HISTORICAL_ATTRIBUTION_TARGET_INVALID: INVALID_TARGET_CODE,
  resolveHistoricalAttributionTarget,
};
