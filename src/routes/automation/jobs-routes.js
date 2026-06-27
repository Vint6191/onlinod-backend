"use strict";

function registerJobRoutes(router, deps) {
  const { automationServer, sendError, requireSeniorAutomationWriter } = deps;

  router.get("/jobs", async (req, res) => { try { return res.json(await automationServer.listJobs({ agencyId: req.auth.agencyId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOBS_FAILED"); } });
  router.post("/jobs/enqueue", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.enqueueJob({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_ENQUEUE_FAILED"); } });
  router.post("/jobs/cancel", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.cancelJobs({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_CANCEL_FAILED"); } });
  router.post("/jobs/claim", async (req, res) => { try { return res.json(await automationServer.claimJobs({ agencyId: req.auth.agencyId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_CLAIM_FAILED"); } });
  router.get("/jobs/:id", async (req, res) => { try { return res.json(await automationServer.getJob({ agencyId: req.auth.agencyId, jobId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_GET_FAILED"); } });
  router.post("/jobs/:id/result", async (req, res) => { try { return res.json(await automationServer.completeJob({ agencyId: req.auth.agencyId, jobId: req.params.id, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_RESULT_FAILED"); } });
}

module.exports = { registerJobRoutes };
