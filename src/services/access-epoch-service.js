"use strict";

function normalizedAccessEpoch(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function bumpMemberAccessEpoch({ db, memberId }) {
  if (!db || !memberId) throw new Error("db and memberId are required");
  const row = await db.agencyMember.update({
    where: { id: String(memberId) },
    data: { accessEpoch: { increment: 1 } },
    select: { id: true, accessEpoch: true },
  });
  return normalizedAccessEpoch(row?.accessEpoch);
}

async function bumpAgencyAccessEpoch({ db, agencyId }) {
  if (!db || !agencyId) throw new Error("db and agencyId are required");
  return db.agencyMember.updateMany({
    where: {
      agencyId: String(agencyId),
      deletedAt: null,
      deactivatedAt: null,
    },
    data: { accessEpoch: { increment: 1 } },
  });
}

module.exports = {
  normalizedAccessEpoch,
  bumpMemberAccessEpoch,
  bumpAgencyAccessEpoch,
};
