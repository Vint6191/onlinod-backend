"use strict";

function registerBumpRoutes(router, deps) {
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

  router.get("/bumps", async (req, res) => { try { const creatorId = await creator(req); return res.json(await automationServer.listBumps({ agencyId: req.auth.agencyId, creatorId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMPS_FAILED"); } });
  router.post("/bumps/gc", requireSeniorAutomationWriter, async (req, res) => { try { const creatorId = await creator(req); return res.json(await automationServer.gcExpiredBumps({ agencyId: req.auth.agencyId, creatorId })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMPS_GC_FAILED"); } });
  router.get("/bumps/:accountId", async (req, res) => { try { const creatorId = await creator(req); return res.json(await automationServer.listBumps({ agencyId: req.auth.agencyId, creatorId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMPS_FAILED"); } });
  router.post("/bumps/upsert", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.saveBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: { ...(req.body || {}), creatorId: accountId, accountId } })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_SAVE_FAILED"); } });
  router.post("/bumps/:accountId/upsert", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.saveBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: { ...(req.body || {}), creatorId: accountId, accountId } })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_SAVE_FAILED"); } });
  router.patch("/bumps/:id", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.saveBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: { ...(req.body || {}), id: req.params.id, creatorId: accountId, accountId } })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_PATCH_FAILED"); } });
  router.post("/bumps/:id/trash", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.trashBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, bumpId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_TRASH_FAILED"); } });
  router.post("/bumps/:id/restore", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.trashBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, bumpId: req.params.id, restore: true })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_RESTORE_FAILED"); } });
  router.delete("/bumps/:id", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = await creator(req); return res.json(await automationServer.trashBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, bumpId: req.params.id, permanent: true })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_DELETE_FAILED"); } });
}

module.exports = { registerBumpRoutes };
