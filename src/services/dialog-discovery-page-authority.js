"use strict";
const { createHash } = require("node:crypto");

const fail = code => { throw Object.assign(new Error(code), { code, retryable: false, status: 422 }); };

// The offset is chosen by the client, so increasing it alone proves nothing.
// Keep one indexed fingerprint per actual provider page under the durable run.
// Receipt rows share the batch transaction and survive process/device changes.
async function commitDiscoveryPages(db, job, run, chunk) {
  if (job.params?.discoveryTraversalVersion !== 1) return;
  const pages = chunk.pageProofs;
  if (!Array.isArray(pages) || !pages.length || pages.length > 100
    || !Number.isSafeInteger(chunk.pageStart) || !Number.isSafeInteger(chunk.pageEnd)
    || chunk.pageEnd - chunk.pageStart !== pages.length || typeof chunk.hasMore !== "boolean") fail("DIALOG_DISCOVERY_PAGE_PROOF_INVALID");
  let offset = Number(chunk.cursorIn);
  if (!Number.isSafeInteger(offset) || offset < 0) fail("DIALOG_DISCOVERY_PAGE_PROOF_INVALID");
  const durablePage = Number(run.continuation?.page ?? run.pagesProcessed ?? 0);
  const durableOffset = Number(run.continuation?.offset ?? 0);
  if (chunk.pageStart !== durablePage || offset !== durableOffset) fail("DIALOG_DISCOVERY_CHECKPOINT_MISMATCH");
  const fingerprints = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (page.page !== chunk.pageStart + index + 1 || page.offset !== offset || typeof page.hasMore !== "boolean"
      || !Number.isSafeInteger(page.nextOffset) || page.nextOffset < offset
      || !Array.isArray(page.ids) || page.ids.length > 100
      || page.ids.some(id => typeof id !== "string" || !id || id.length > 180)
      || page.hasMore && (!page.ids.length || page.nextOffset <= offset)
      || index < pages.length - 1 && !page.hasMore) fail("DIALOG_DISCOVERY_PAGE_PROOF_INVALID");
    offset = page.nextOffset;
    const digest = createHash("sha256").update([...page.ids].sort().join("\n")).digest("hex");
    fingerprints.push({ ...page, key: `discovery-source:${digest}:${page.hasMore ? "more" : "end"}` });
  }
  if (String(offset) !== String(chunk.cursorOut) || pages.at(-1).hasMore !== chunk.hasMore) fail("DIALOG_DISCOVERY_PAGE_PROOF_INVALID");
  const keys = fingerprints.map(page => page.key);
  if (new Set(keys).size !== keys.length) fail("DIALOG_DISCOVERY_PAGE_CYCLE");
  const old = await db.dialogScanChunkCommit.findMany({ where: { runId: run.id, chunkKey: { in: keys } }, select: { id: true }, take: 1 });
  if (old.length) fail("DIALOG_DISCOVERY_PAGE_CYCLE");
  await db.dialogScanChunkCommit.createMany({ data: fingerprints.map(page => ({
    agencyId: job.agencyId, creatorId: job.creatorId, runId: run.id, jobId: job.id,
    dialogId: "__dialog_discovery__", chunkKey: page.key, mode: "discovery_source_page",
    cursorIn: String(page.offset), cursorOut: String(page.nextOffset), page: page.page,
    hasMore: page.hasMore, result: { providerPage: true, rows: page.ids.length },
  })) });
  return { fromPage: durablePage, toPage: chunk.pageEnd, pages: pages.length };
}

module.exports = { commitDiscoveryPages };
