"use strict";

const SUBSCRIBER_PUBLICATION_IN_PROGRESS_STATUSES = Object.freeze([
  "PENDING",
  "CURRENT",
  "PREVIOUS",
  "FINALIZE",
]);

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

async function getSubscriberPublicationFence({ db = null, agencyId, creatorId }) {
  const client = db || require("../prisma");
  const scopedAgencyId = clean(agencyId);
  const scopedCreatorId = clean(creatorId);
  if (!scopedAgencyId || !scopedCreatorId) return { active: false, run: null };
  if (typeof client?.subscriberScanRun?.findFirst !== "function") return { active: false, run: null };
  const run = await client.subscriberScanRun.findFirst({
    where: {
      agencyId: scopedAgencyId,
      creatorId: scopedCreatorId,
      hasMore: false,
      fanProjectionStatus: "COMPLETE",
      publicationStatus: { in: [...SUBSCRIBER_PUBLICATION_IN_PROGRESS_STATUSES] },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, publicationStatus: true, updatedAt: true },
  });
  return { active: Boolean(run), run: run || null };
}

async function assertSubscriberPublicationIdle({ db = null, agencyId, creatorId, retryMs = 30_000, now = new Date() }) {
  const fence = await getSubscriberPublicationFence({ db, agencyId, creatorId });
  if (!fence.active) return fence;
  const error = new Error("Subscriber snapshot publication is still committing derived state");
  error.code = "subscriber_publication_in_progress";
  error.status = 409;
  error.retryAt = new Date(now.getTime() + Math.max(1_000, Number(retryMs) || 30_000));
  error.publicationRunId = fence.run?.id || null;
  error.publicationStatus = fence.run?.publicationStatus || null;
  throw error;
}

async function validateSubscriberPublicationIdle({ db = null, agencyId, creatorId, retryMs = 30_000, now = new Date() }) {
  const fence = await getSubscriberPublicationFence({ db, agencyId, creatorId });
  if (!fence.active) return { ok: true };
  return {
    ok: false,
    terminal: false,
    status: "SKIPPED",
    code: "subscriber_publication_in_progress",
    retryAt: new Date(now.getTime() + Math.max(1_000, Number(retryMs) || 30_000)),
    publicationRunId: fence.run?.id || null,
    publicationStatus: fence.run?.publicationStatus || null,
  };
}

module.exports = {
  SUBSCRIBER_PUBLICATION_IN_PROGRESS_STATUSES,
  getSubscriberPublicationFence,
  assertSubscriberPublicationIdle,
  validateSubscriberPublicationIdle,
};
