"use strict";
const { resolveMaintenanceLanes, MAINTENANCE_ADMISSION_GENERATION } = require("./maintenance-lane-registry");
const { readMaintenanceAdmissionProgress } = require("./phase2-maintenance-admission-service");
async function verifyMaintenanceRuntime({ db } = {}) {
  const handlers = resolveMaintenanceLanes({ db });
  const progress = await readMaintenanceAdmissionProgress({ db });
  const indexes = await require("../../scripts/database/background-maintenance-indexes").ensureIndexes(db);
  return { ready: true, generation: MAINTENANCE_ADMISSION_GENERATION, handlers: handlers.size, catalog: progress.totalLanes, indexes: indexes.contracts };
}
module.exports = { verifyMaintenanceRuntime };
