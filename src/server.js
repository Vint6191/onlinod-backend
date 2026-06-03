require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("node:path");

const authRoutes = require("./routes/auth");
const creatorRoutes = require("./routes/creators");
const creatorConnectRoutes = require("./routes/creator-connect");
const accessSnapshotRoutes = require("./routes/access-snapshots");
const adminRoutes = require("./routes/admin");
const adminDataRoutes = require("./routes/admin-data");
const adminBillingRoutes = require("./routes/admin-billing");
const adminAuthRoutes = require("./routes/admin-auth");
const impersonateRoutes = require("./routes/impersonate");
const workspaceRoutes = require("./routes/workspace");
const devicesRoutes = require("./routes/devices");
const teamRoutes = require("./routes/team");
const invitationRoutes = require("./routes/invitations");
const statsRoutes = require("./routes/stats");
const jobsRoutes = require("./routes/jobs");
const vaultUnsortedRoutes = require("./routes/vault-unsorted");
const automationRoutes = require("./routes/automation");
const messageLibraryRoutes = require("./routes/message-library");
const settingsRoutes = require("./routes/settings");
const modulesRoutes = require("./routes/modules");
const auditRoutes = require("./routes/audit");
const teamAnalyticsRoutes = require("./routes/team-analytics");
const teamClaimsRoutes = require("./routes/team-claims");
const homeRoutes = require("./routes/home");
const telemetryRoutes = require("./routes/telemetry");
const analyticsRoutes = require("./routes/analytics");
const presenceRoutes = require("./routes/presence");
const contentStoreRoutes = require("./routes/content-store");
const crmStoreRoutes = require("./routes/crm-store");
const fanListsRoutes = require("./routes/fan-lists");
const segmentsRoutes = require("./routes/segments");
const campaignsRoutes = require("./routes/campaigns");
const automationStoreRoutes = require("./routes/automation-store");
const vaultSalesRoutes = require("./routes/vault-sales");
const serverStoreDiagnosticsRoutes = require("./routes/server-store-diagnostics");
const { authRequired } = require("./middleware/auth");
const { startRecurringScheduler } = require("./services/job-scheduler");
const { startPresenceScheduler } = require("./services/presence-scheduler");

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    service: "onlinod-backend",
    version: "0.8.0-server-stores",
    time: new Date().toISOString(),
  });
});

app.get("/api", (_req, res) => {
  res.json({
    ok: true,
    service: "onlinod-backend",
    version: "0.8.0-server-stores",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin-auth", adminAuthRoutes);
app.use("/api/admin/data", adminDataRoutes);
app.use("/api/admin/billing", adminBillingRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/impersonate", impersonateRoutes);
app.use("/api/workspace", workspaceRoutes);
app.use("/api/devices", devicesRoutes);
app.use("/api/team", authRequired, teamRoutes);
app.use("/api/invitations", invitationRoutes);
app.use("/api/stats", authRequired, statsRoutes);
app.use("/api/jobs", authRequired, jobsRoutes);
app.use("/api/telemetry", authRequired, telemetryRoutes);
app.use("/api/analytics", authRequired, analyticsRoutes);
app.use("/api/presence", authRequired, presenceRoutes);
app.use("/api/server/content", authRequired, contentStoreRoutes);
app.use("/api/server/crm", authRequired, crmStoreRoutes);
app.use("/api/server/fan-lists", authRequired, fanListsRoutes);
app.use("/api/server/segments", authRequired, segmentsRoutes);
app.use("/api/server/campaigns", authRequired, campaignsRoutes);
app.use("/api/server/automation", authRequired, automationStoreRoutes);
app.use("/api/server/vault-sales", authRequired, vaultSalesRoutes);
app.use("/api/server/diagnostics", authRequired, serverStoreDiagnosticsRoutes);
app.use("/api/home", authRequired, homeRoutes);
app.use("/api/team/analytics", authRequired, teamAnalyticsRoutes);
app.use("/api/team/claims", authRequired, teamClaimsRoutes);
app.use("/api/audit", authRequired, auditRoutes);
app.use("/api/modules", authRequired, modulesRoutes);
app.use("/api/settings", authRequired, settingsRoutes);
app.use("/api/message-library", authRequired, messageLibraryRoutes);
app.use("/api/automation", authRequired, automationRoutes);
app.use("/api/vault", authRequired, vaultUnsortedRoutes);
app.use("/api/creators", creatorRoutes);
app.use("/api/creator-connect", creatorConnectRoutes);
app.use("/api", accessSnapshotRoutes);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) {
    return next();
  }

  // Admin frontend — own SPA at /admin/* and /admin-login.
  if (
    req.path.startsWith("/admin") ||
    req.path === "/admin-login" ||
    req.path.startsWith("/admin-login")
  ) {
    return res.sendFile(path.join(__dirname, "..", "public", "admin", "index.html"));
  }

  // Customer frontend.
  return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    code: "NOT_FOUND",
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);

  res.status(500).json({
    ok: false,
    code: "SERVER_ERROR",
    error: "Internal server error",
  });
});

const port = Number(process.env.PORT || 10000);

app.listen(port, () => {
  console.log(`Onlinod backend running on port ${port}`);
});

startRecurringScheduler();
startPresenceScheduler();
