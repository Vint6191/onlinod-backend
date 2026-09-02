"use strict";

function registerSfsRoutes(router, deps) {
  const { automationServer, sendError, cleanString, requireSeniorAutomationWriter, requireAutomationCreatorAccess } = deps;

  async function creator(req) {
    const supplied = [
      req.params?.accountId,
      req.body?.accountId,
      req.body?.creatorId,
      req.query?.accountId,
      req.query?.creatorId,
    ].map((value) => cleanString(value, 100)).filter(Boolean);
    const unique = [...new Set(supplied)];
    if (unique.length === 0) {
      const err = new Error("creatorId is required");
      err.status = 400;
      err.code = "CREATOR_ID_REQUIRED";
      throw err;
    }
    if (unique.length > 1) {
      const err = new Error("Conflicting creator identifiers");
      err.status = 400;
      err.code = "CREATOR_IDENTITY_MISMATCH";
      throw err;
    }
    const creatorId = unique[0];
    await requireAutomationCreatorAccess(req, creatorId);
    return creatorId;
  }

  router.get("/sfs-comments", async (req, res) => { try { const creatorId = await creator(req); return res.json(await automationServer.listSfsComments({ agencyId: req.auth.agencyId, creatorId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENTS_FAILED"); } });
  router.post("/sfs-comments/upsert", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.saveSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: { ...(req.body || {}), creatorId: accountId, accountId } })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_SAVE_FAILED"); } });
  router.post("/sfs-comments/:id/trash", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_TRASH_FAILED"); } });
  router.post("/sfs-comments/:id/restore", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id, restore: true })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_RESTORE_FAILED"); } });
  router.delete("/sfs-comments/:id", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id, permanent: true })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_DELETE_FAILED"); } });

  // P15: all legacy SFS claim/result endpoints are physically removed. The
  // migration cancels remaining Alpha jobs and adopts safety cleanup rows.
}

module.exports = { registerSfsRoutes };
