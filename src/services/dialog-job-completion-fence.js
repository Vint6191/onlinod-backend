"use strict";

/**
 * Completes a dialog job and applies its durable run/state side effect only
 * after the current lease tuple wins the database fence. The caller owns the
 * surrounding transaction.
 */
async function completeDialogJobFenced({ tx, fenceWhere, completionData, staleError, applySideEffect }) {
  const updated = await tx.jobInstance.updateMany({ where: fenceWhere, data: completionData });
  if (!updated.count) {
    throw typeof staleError === "function"
      ? staleError()
      : Object.assign(new Error("Job lease changed before completion"), { code: "JOB_LEASE_STALE", status: 409 });
  }
  const sideEffect = await applySideEffect(tx);
  return { sideEffect };
}

module.exports = { completeDialogJobFenced };
