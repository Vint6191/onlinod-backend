"use strict";

const { assertTeamControlPlaneWriteAdmission } = require("./phase2-release-compatibility-authority-service");

function normalizedAccessEpoch(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function withTeamControlPlaneWrite(db, work) {
  if (!db || typeof work !== "function") throw new Error("Team access-epoch write context is required");
  if (typeof db.$transaction === "function") {
    return db.$transaction(async (tx) => {
      await assertTeamControlPlaneWriteAdmission(tx);
      return work(tx);
    });
  }
  // Transaction adapters reach this branch. Callers that compose this helper
  // inside a larger transaction must invoke it before taking Team business locks
  // so the global M1 release fence remains the first lock in the graph.
  await assertTeamControlPlaneWriteAdmission(db);
  return work(db);
}

async function bumpMemberAccessEpoch({ db, memberId }) {
  if (!db || !memberId) throw new Error("db and memberId are required");
  return withTeamControlPlaneWrite(db, async (tx) => {
    const row = await tx.agencyMember.update({
      where: { id: String(memberId) },
      data: { accessEpoch: { increment: 1 } },
      select: { id: true, accessEpoch: true },
    });
    return normalizedAccessEpoch(row?.accessEpoch);
  });
}

async function bumpAgencyAccessEpoch({ db, agencyId }) {
  if (!db || !agencyId) throw new Error("db and agencyId are required");
  return withTeamControlPlaneWrite(db, (tx) => tx.agencyMember.updateMany({
    where: {
      agencyId: String(agencyId),
      deletedAt: null,
      deactivatedAt: null,
    },
    data: { accessEpoch: { increment: 1 } },
  }));
}

module.exports = {
  normalizedAccessEpoch,
  bumpMemberAccessEpoch,
  bumpAgencyAccessEpoch,
};
