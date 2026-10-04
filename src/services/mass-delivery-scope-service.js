"use strict";
const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
const { error } = require("./mass-delivery-contract");
function isMass(kind) { return ["MASS_QUEUE_CREATE", "MASS_QUEUE_CANCEL", "MASS_NATIVE_QUEUE_CREATE", "MASS_NATIVE_QUEUE_CANCEL"].includes(kind); }
async function lockMassDeliveryScope({ db, agencyId, creatorId, allowDeleted = true }) {
  await lockAgencyPipelineLifecycle({ db, agencyId, allowDeleted });
  await lockCreatorPipelineLifecycle({ db, agencyId, creatorId, allowDeleted });
}
async function assertMassCreateAdmission({ db, agencyId, creatorId }) {
  const [state] = await db.$queryRawUnsafe(`SELECT "retirementId" FROM "MassCreatorDeliveryState" WHERE "agencyId"=$1 AND "creatorId"=$2`, agencyId, creatorId);
  if (state?.retirementId) throw error("MASS_CREATOR_RETIREMENT_IN_PROGRESS", "MASS is paused for creator retirement; resume it before starting a new send", 409, { retirementId: state.retirementId });
}
module.exports = { isMass, lockMassDeliveryScope, assertMassCreateAdmission };
