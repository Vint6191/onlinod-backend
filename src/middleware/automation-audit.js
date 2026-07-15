"use strict";

const { automationAudit } = require("../services/automation-audit-service");

function clean(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function creatorIdFromRequest(req) {
  return clean(req.params?.creatorId || req.params?.accountId || req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId);
}

function moduleFromPath(path) {
  const value = String(path || "");
  if (value.includes("follow-back")) return "follow_back";
  if (/\/follow\//.test(value)) return "follow";
  if (value.includes("likes")) return "likes";
  if (value.includes("sfs")) return "sfs";
  if (value.includes("bump") || value.includes("hidden-online")) return "bumps";
  return null;
}

function actionFromRequest(req) {
  const path = String(req.path || req.originalUrl || "").toLowerCase();
  const method = String(req.method || "POST").toLowerCase();
  const candidateAction = clean(req.body?.action, 80);
  if (path.includes("/controls")) return "control.updated";
  if (path.includes("/retry-safe")) return "delivery.retry_safe";
  if (/\/deliveries\/[^/]+\/retry$/.test(path)) return "delivery.retried";
  if (/\/deliveries\/[^/]+\/cancel$/.test(path)) return "delivery.canceled";
  if (/\/deliveries\/[^/]+\/release$/.test(path)) return "delivery.claim_released";
  if (path.endsWith("/discover")) return `${moduleFromPath(path) || "module"}.discovery_started`;
  if (path.endsWith("/plan") || path.endsWith("/plan-auto")) return `${moduleFromPath(path) || "module"}.run_started`;
  if (path.includes("/candidates/") && candidateAction) return `${moduleFromPath(path) || "module"}.candidate_${candidateAction}`;
  if (path.includes("/scan") || path.includes("scan-jobs/enqueue")) return `${moduleFromPath(path) || "module"}.scan_started`;
  if (path.includes("/trash")) return `${moduleFromPath(path) || "template"}.template_trashed`;
  if (path.includes("/restore")) return `${moduleFromPath(path) || "template"}.template_restored`;
  if (method === "delete") return `${moduleFromPath(path) || "template"}.template_deleted`;
  if (path.includes("/upsert") || path.includes("/tasks")) return `${moduleFromPath(path) || "automation"}.template_saved`;
  if (path.includes("/status")) return `${moduleFromPath(path) || "module"}.candidate_status_changed`;
  if (path.includes("/clear")) return `${moduleFromPath(path) || "module"}.cleared`;
  return `mutation.${method}`;
}

function safeDetails(req, responseBody) {
  const result = responseBody && typeof responseBody === "object" ? responseBody : {};
  const delivery = result.delivery && typeof result.delivery === "object" ? result.delivery : null;
  const item = result.item && typeof result.item === "object" ? result.item : null;
  return {
    method: req.method,
    path: String(req.route?.path || req.path || "").slice(0, 220),
    scope: clean(req.body?.scope, 40),
    enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : null,
    action: clean(req.body?.action, 80),
    fanId: clean(req.params?.fanId || req.body?.fanId || delivery?.fanId, 160),
    candidateId: clean(req.params?.candidateId || req.body?.candidateId, 160),
    deliveryId: clean(req.params?.id || delivery?.id, 160),
    taskId: clean(req.params?.id || item?.id, 160),
    moduleKey: clean(req.body?.moduleKey || delivery?.moduleKey || moduleFromPath(req.path), 80),
    created: result.created === true,
    duplicate: result.duplicate === true,
    count: Number.isFinite(Number(result.count)) ? Number(result.count) : null,
  };
}

function shouldAudit(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(String(req.method || "").toUpperCase())) return false;
  if (String(req.path || "").includes("/controls")) return false;
  const path = String(req.path || "");
  if (path.startsWith("/worker/") || path === "/worker/claim") return false;
  // Runtime event ingestion is machine telemetry, not a user business action.
  // Auditing every WS flush produced hundreds of meaningless mutation.post rows.
  if (path.endsWith("/events")) return false;
  if (path.includes("/result") || path.includes("/intel-bulk") || path.includes("/worker/")) return false;
  return true;
}

function attachAutomationAudit(router) {
  router.use((req, res, next) => {
    if (!shouldAudit(req)) return next();
    const originalJson = res.json.bind(res);
    let recorded = false;
    res.json = (body) => {
      if (!recorded && res.statusCode < 400 && body?.ok !== false) {
        recorded = true;
        const creatorId = creatorIdFromRequest(req) || clean(body?.delivery?.creatorId || body?.candidate?.creatorId || body?.item?.creatorId);
        const moduleKey = clean(req.body?.moduleKey || body?.delivery?.moduleKey || moduleFromPath(req.path), 80);
        void automationAudit({
          agencyId: req.auth?.agencyId,
          actorUserId: req.auth?.userId || null,
          creatorId,
          moduleKey,
          action: actionFromRequest(req),
          targetType: body?.delivery ? "delivery" : body?.candidate ? "candidate" : moduleKey || "automation",
          targetId: clean(req.params?.id || req.params?.fanId || req.params?.candidateId || body?.delivery?.id || body?.candidate?.id || creatorId),
          details: safeDetails(req, body),
        }).finally(() => originalJson(body));
        return res;
      }
      return originalJson(body);
    };
    return next();
  });
}

module.exports = {
  attachAutomationAudit,
  creatorIdFromRequest,
  moduleFromPath,
  actionFromRequest,
  safeDetails,
  shouldAudit,
};
