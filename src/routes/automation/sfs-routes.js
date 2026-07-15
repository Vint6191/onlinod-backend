"use strict";

const { adoptLegacySfsUnfollow } = require("../../services/sfs-service");

function registerSfsRoutes(router, deps) {
  const { automationServer, sendError, cleanString, requireSeniorAutomationWriter } = deps;

  router.get("/sfs-comments", async (req, res) => { try { const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100); return res.json(await automationServer.listSfsComments({ agencyId: req.auth.agencyId, creatorId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENTS_FAILED"); } });
  router.post("/sfs-comments/upsert", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.body?.creatorId, 100); return res.json(await automationServer.saveSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_SAVE_FAILED"); } });
  router.post("/sfs-comments/:id/trash", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_TRASH_FAILED"); } });
  router.post("/sfs-comments/:id/restore", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id, restore: true })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_RESTORE_FAILED"); } });
  router.delete("/sfs-comments/:id", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id, permanent: true })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_DELETE_FAILED"); } });


  // P14: legacy Alpha claim/settings routes are physically disabled. Two
  // completion-only routes remain as a drain adapter for work that was already
  // running during deploy; they never create new legacy claims.
  router.post("/sfs-hunter/targets/:id/result", async (req, res) => {
    try {
      const completed = await automationServer.completeSfsTarget({ agencyId: req.auth.agencyId, jobId: req.params.id, input: req.body || {} });
      const item = completed?.item || {};
      const payload = item.payload && typeof item.payload === "object" ? item.payload : {};
      const result = item.result && typeof item.result === "object" ? item.result : {};
      const inputResult = req.body?.result && typeof req.body.result === "object" ? req.body.result : req.body || {};
      const creatorId = cleanString(item.creatorId || item.accountId, 100);
      const targetUserId = cleanString(inputResult.targetUserId || result.targetUserId || payload.targetUserId || item.fanId, 100);
      const targetUsername = cleanString(inputResult.targetUsername || result.targetUsername || payload.targetUsername, 80);
      const unfollowAt = inputResult.unfollowAt || result.unfollowAt || payload.unfollowAt || null;
      const adopted = creatorId && targetUserId && unfollowAt
        ? await adoptLegacySfsUnfollow({ agencyId: req.auth.agencyId, creatorId, targetUserId, targetUsername, runAfter: unfollowAt, sourceJobId: item.id })
        : null;
      return res.json({ ...completed, p14Cleanup: adopted });
    } catch (err) { return sendError(res, err, "SFS_TARGET_RESULT_DRAIN_FAILED"); }
  });
  router.post("/sfs-hunter/unfollow/:id/result", async (req, res) => {
    try {
      return res.json(await automationServer.completeSfsUnfollow({ agencyId: req.auth.agencyId, jobId: req.params.id, input: req.body || {} }));
    } catch (err) { return sendError(res, err, "SFS_UNFOLLOW_RESULT_DRAIN_FAILED"); }
  });

  // SFS templates remain available here; all new execution lives under
  // /api/automation/sfs and uses JobInstance + AutomationDelivery only.

}

module.exports = { registerSfsRoutes };
