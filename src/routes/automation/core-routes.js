"use strict";

function registerCoreRoutes(router, _deps) {
  function tasksGone(_req, res) {
    return res.status(410).json({
      ok: false,
      code: "LEGACY_AUTOMATION_TASK_API_GONE",
      error: "Use product-specific Automation configuration APIs.",
    });
  }

  router.get("/tasks", tasksGone);
  router.post("/tasks", tasksGone);
  router.patch("/tasks/:id", tasksGone);
  router.post("/tasks/:id/trash", tasksGone);
  router.post("/tasks/:id/restore", tasksGone);
  router.delete("/tasks/:id", tasksGone);
}

module.exports = { registerCoreRoutes };
