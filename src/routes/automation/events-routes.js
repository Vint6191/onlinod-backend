"use strict";

function registerEventRoutes(router, deps) {
  const { automationServer, sendError } = deps;

  router.get("/events", async (req, res) => { try { return res.json(await automationServer.listEvents({ agencyId: req.auth.agencyId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_EVENTS_FAILED"); } });
  router.post("/events", async (req, res) => { try { return res.json(await automationServer.logEvent({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_EVENT_LOG_FAILED"); } });
  router.get("/activity", async (req, res) => { try { return res.json(await automationServer.listActivity({ agencyId: req.auth.agencyId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_ACTIVITY_FAILED"); } });
}

module.exports = { registerEventRoutes };
