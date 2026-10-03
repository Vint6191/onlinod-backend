"use strict";

function revision(value) {
  try { return value === null || value === undefined ? null : BigInt(value); } catch { return null; }
}
function directoryCountCurrent(state) {
  const verified = revision(state?.campaignDirectoryCountRevision);
  return verified !== null && verified >= 0n && verified === revision(state?.campaignDirectoryFactsRevision);
}
function directoryCountInvalidated(state) {
  const verified = revision(state?.campaignDirectoryCountRevision);
  const facts = revision(state?.campaignDirectoryFactsRevision) ?? 0n;
  return verified === null ? facts > 0n && Boolean(state?.campaignDirectoryGeneration) : verified !== facts;
}
function directoryIdentityMatches(state, binding) {
  return Boolean(state?.campaignDirectoryVerifiedAt && binding
    && state.campaignDirectoryGeneration === binding.generation
    && +new Date(state.campaignDirectoryRequestedAt) === +new Date(binding.requestedAt)
    && (binding.revision === undefined || Number(state.campaignDirectoryRevision) === binding.revision)
    && (binding.campaignCount === undefined || Number(state.campaignDirectoryCampaignCount) === binding.campaignCount));
}
function sealedDirectoryCount(state, binding) {
  const count = state?.campaignDirectoryCampaignCount;
  return directoryCountCurrent(state) && directoryIdentityMatches(state, binding)
    && Number.isSafeInteger(count) && count >= 0 ? count : null;
}
module.exports = { revision, directoryCountCurrent, directoryCountInvalidated, directoryIdentityMatches, sealedDirectoryCount };
