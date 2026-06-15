"use strict";

const express = require("express");
const prisma = require("../prisma");

const router = express.Router();

function iso(value) {
  if (!value) return null;
  try {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch (_) {
    return null;
  }
}

async function safeCount(modelName, where = {}) {
  try {
    const model = prisma[modelName];
    if (!model || typeof model.count !== "function") {
      return { ok: false, count: 0, error: `Prisma model missing: ${modelName}` };
    }
    const count = await model.count({ where });
    return { ok: true, count: Number(count || 0), error: null };
  } catch (err) {
    return { ok: false, count: 0, error: String(err?.message || err) };
  }
}

async function safeLatest(modelName, where = {}, field = "updatedAt") {
  try {
    const model = prisma[modelName];
    if (!model || typeof model.findFirst !== "function") return null;
    const item = await model.findFirst({
      where,
      orderBy: [{ [field]: "desc" }],
      select: { [field]: true },
    });
    return iso(item?.[field]);
  } catch (_) {
    return null;
  }
}

async function moduleCounts(label, key, checks = []) {
  const counts = {};
  const errors = [];

  for (const check of checks) {
    const res = await safeCount(check.model, check.where || {});
    counts[check.name] = res.count;
    if (!res.ok) errors.push({ name: check.name, model: check.model, error: res.error });
  }

  const total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
  return {
    key,
    label,
    ok: errors.length === 0,
    empty: total === 0,
    total,
    counts,
    errors,
  };
}

router.get("/status", async (req, res) => {
  const agencyId = String(req.auth?.agencyId || "").trim();
  if (!agencyId) {
    return res.status(401).json({ ok: false, code: "AGENCY_ID_MISSING", error: "Agency id is missing" });
  }

  try {
    const modules = [];

    const content = await moduleCounts("Content store", "content", [
      { name: "collections", model: "contentCollection", where: { agencyId, deletedAt: null } },
      { name: "blocks", model: "contentBlock", where: { collection: { agencyId, deletedAt: null } } },
      { name: "usageEvents", model: "contentUsageEvent", where: { agencyId } },
    ]);
    content.lastUpdatedAt = await safeLatest("contentCollection", { agencyId }, "updatedAt");
    modules.push(content);

    const crm = await moduleCounts("CRM", "crm", [
      { name: "profiles", model: "crmProfile", where: { agencyId } },
      { name: "tags", model: "crmProfileTag", where: { agencyId } },
      { name: "rawTags", model: "crmProfileRawTag", where: { agencyId } },
      { name: "notes", model: "crmNote", where: { agencyId, deletedAt: null } },
      { name: "analysisRuns", model: "crmAnalysisRun", where: { agencyId } },
    ]);
    crm.lastUpdatedAt = await safeLatest("crmProfile", { agencyId }, "updatedAt");
    modules.push(crm);

    const lists = await moduleCounts("Fan lists / segments", "segments", [
      { name: "fanLists", model: "fanList", where: { agencyId, deletedAt: null } },
      { name: "fanListMembers", model: "fanListMember", where: { agencyId } },
      { name: "savedSegments", model: "savedSegment", where: { agencyId, deletedAt: null } },
    ]);
    lists.lastUpdatedAt = await safeLatest("fanList", { agencyId }, "updatedAt") || await safeLatest("savedSegment", { agencyId }, "updatedAt");
    modules.push(lists);

    const campaigns = await moduleCounts("Campaigns", "campaigns", [
      { name: "drafts", model: "campaignDraft", where: { agencyId, deletedAt: null } },
      { name: "queueStatuses", model: "campaignQueueStatus", where: { agencyId } },
    ]);
    campaigns.lastUpdatedAt = await safeLatest("campaignDraft", { agencyId }, "updatedAt") || await safeLatest("campaignQueueStatus", { agencyId }, "updatedAt");
    modules.push(campaigns);

    const automation = await moduleCounts("Automation", "automation", [
      { name: "tasks", model: "automationTask", where: { agencyId, deletedAt: null } },
      { name: "jobs", model: "automationJob", where: { agencyId } },
      { name: "events", model: "automationEvent", where: { agencyId } },
      { name: "deliveries", model: "automationDelivery", where: { agencyId } },
      { name: "hiddenOnline", model: "hiddenOnlineUser", where: { agencyId } },
      { name: "followBackTasks", model: "followBackTask", where: { agencyId } },
    ]);
    automation.lastUpdatedAt = await safeLatest("automationTask", { agencyId }, "updatedAt") || await safeLatest("automationJob", { agencyId }, "updatedAt") || await safeLatest("automationDelivery", { agencyId }, "updatedAt") || await safeLatest("hiddenOnlineUser", { agencyId }, "updatedAt") || await safeLatest("followBackTask", { agencyId }, "updatedAt");
    modules.push(automation);

    const vault = await moduleCounts("Vault sales", "vaultSales", [
      { name: "purchaseMessages", model: "vaultPurchaseMessage", where: { agencyId } },
      { name: "mediaSales", model: "vaultMediaSale", where: { agencyId } },
    ]);
    vault.lastUpdatedAt = await safeLatest("vaultPurchaseMessage", { agencyId }, "updatedAt") || await safeLatest("vaultMediaSale", { agencyId }, "updatedAt");
    modules.push(vault);

    const creatorCount = await safeCount("creatorAccount", { agencyId, deletedAt: null });
    const broken = modules.filter((m) => !m.ok);
    const totalRecords = modules.reduce((sum, m) => sum + Number(m.total || 0), 0);

    const recommendations = [];
    if (broken.length) {
      recommendations.push("Some server-store tables are not reachable. Run Prisma migration and restart backend.");
    }
    if (!totalRecords) {
      recommendations.push("Server stores are connected but empty. Create/update one script, bump, CRM profile, or campaign to verify writes.");
    }

    return res.json({
      ok: broken.length === 0,
      service: "onlinod-server-stores",
      status: broken.length ? "degraded" : "healthy",
      time: new Date().toISOString(),
      agencyId,
      summary: {
        healthyModules: modules.filter((m) => m.ok).length,
        moduleCount: modules.length,
        totalRecords,
        creatorCount: creatorCount.count,
      },
      modules,
      recommendations,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: "SERVER_STORE_DIAGNOSTICS_FAILED",
      error: String(err?.message || err),
    });
  }
});

module.exports = router;
