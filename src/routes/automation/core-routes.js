"use strict";

function registerCoreRoutes(router, deps) {
  const { automationServer, sendError, requireSeniorAutomationWriter } = deps;

  router.get("/tasks", async (req, res) => { try { return res.json(await automationServer.listTasks({ agencyId: req.auth.agencyId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_TASKS_FAILED"); } });
  router.post("/tasks", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.upsertTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_UPSERT_FAILED"); } });
  router.patch("/tasks/:id", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.patchTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id, patch: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_PATCH_FAILED"); } });
  router.post("/tasks/:id/trash", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.trashTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_TRASH_FAILED"); } });
  router.post("/tasks/:id/restore", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.restoreTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_RESTORE_FAILED"); } });
  router.delete("/tasks/:id", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.trashTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id, permanent: req.query?.permanent === "1" || req.query?.permanent === "true" })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_DELETE_FAILED"); } });
}

module.exports = { registerCoreRoutes };
