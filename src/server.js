require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
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
const messageLibraryRoutes = require("./routes/message-library");
const settingsRoutes = require("./routes/settings");
const modulesRoutes = require("./routes/modules");
const systemRoutes = require("./routes/system");
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
const dialogIntelligenceRoutes = require("./routes/dialog-intelligence");
const trafficRoutes = require("./routes/traffic");
const subscribersRoutes = require("./routes/subscribers");
const automationControlRoutes = require("./routes/automation-control");
const serverStoreDiagnosticsRoutes = require("./routes/server-store-diagnostics");
const { authRequired } = require("./middleware/auth");
const { createIdempotencyMiddleware } = require("./middleware/idempotency");
const prisma = require("./prisma");
const logger = require("./utils/logger");
const { buildBackendHealthSnapshot } = require("./utils/health-snapshot");
const { startRecurringScheduler } = require("./services/job-scheduler");
const { startPresenceScheduler } = require("./services/presence-scheduler");

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", { error: String(reason?.message || reason), stack: reason?.stack || null });
});

process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", { error: String(err?.message || err), stack: err?.stack || null });
});

const app = express();

app.set("trust proxy", 1);

const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.onlinod.com",
  "https://onlinod.com",
  "https://www.onlinod.com",
  "null",
];

function readAllowedOrigins() {
  const extra = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

function isAllowedDevOrigin(origin) {
  if (process.env.NODE_ENV === "production") return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || ""));
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    credentials: true,
    origin(origin, cb) {
      // Native Electron/file requests often have no Origin. Keep them working,
      // but do not allow arbitrary browser origins to use credentialed CORS.
      if (!origin) return cb(null, true);
      if (origin === "null" || String(origin).startsWith("file://")) return cb(null, true);
      if (readAllowedOrigins().has(origin) || isAllowedDevOrigin(origin)) return cb(null, true);
      return cb(new Error(`CORS origin blocked: ${origin}`));
    },
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MIN || 1000),
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_PER_15_MIN || 10),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

app.use("/api", apiLimiter);
app.use("/api/auth/login", authLimiter);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/api", createIdempotencyMiddleware());

app.use("/uploads", express.static(path.join(__dirname, "..", "uploads"), {
  setHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'none'; script-src 'none'; sandbox");
  },
}));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({
      ok: true,
      status: "healthy",
      service: "onlinod-backend",
      version: "0.8.0-server-stores",
      database: "ok",
      time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[health] database check failed:", err?.message || err);
    return res.status(503).json({
      ok: false,
      status: "unhealthy",
      service: "onlinod-backend",
      version: "0.8.0-server-stores",
      database: "error",
      time: new Date().toISOString(),
    });
  }
});

app.get("/health/details", async (_req, res) => {
  if (process.env.ONLINOD_EXPOSE_HEALTH_DETAILS !== "1") {
    return res.status(404).json({ ok: false, code: "NOT_FOUND" });
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json(buildBackendHealthSnapshot({ database: "ok" }));
  } catch (err) {
    logger.warn("health details database check failed", { error: err?.message || String(err) });
    return res.status(503).json(buildBackendHealthSnapshot({ database: "error" }));
  }
});

app.get("/api", (_req, res) => {
  res.json({
    ok: true,
    service: "onlinod-backend",
    version: "0.8.0-server-stores",
  });
});

app.use("/api/system", systemRoutes);
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
app.use("/api/traffic", authRequired, trafficRoutes);
app.use("/api/subscribers", authRequired, subscribersRoutes);
app.use("/api/automation", authRequired, automationControlRoutes);
app.use("/api/server/content", authRequired, contentStoreRoutes);
app.use("/api/server/crm", authRequired, crmStoreRoutes);
app.use("/api/server/fan-lists", authRequired, fanListsRoutes);
app.use("/api/server/segments", authRequired, segmentsRoutes);
app.use("/api/server/campaigns", authRequired, campaignsRoutes);
app.use("/api/server/automation", authRequired, automationStoreRoutes);
app.use("/api/dialog-intelligence", authRequired, dialogIntelligenceRoutes);
app.use("/api/server/vault-sales", authRequired, vaultSalesRoutes);
app.use("/api/server/diagnostics", authRequired, serverStoreDiagnosticsRoutes);
app.use("/api/home", authRequired, homeRoutes);
app.use("/api/team/analytics", authRequired, teamAnalyticsRoutes);
app.use("/api/team/claims", authRequired, teamClaimsRoutes);
app.use("/api/audit", authRequired, auditRoutes);
app.use("/api/modules", authRequired, modulesRoutes);
app.use("/api/settings", authRequired, settingsRoutes);
app.use("/api/message-library", authRequired, messageLibraryRoutes);
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

const httpServer = app.listen(port, () => {
  logger.info("backend listening", { port });
});

startRecurringScheduler();
startPresenceScheduler();

async function gracefulShutdown(signal) {
  logger.info("shutdown requested", { signal });
  httpServer.close(async () => {
    try {
      await prisma.$disconnect();
    } catch (err) {
      console.warn("[server] prisma disconnect failed:", err?.message || err);
    } finally {
      process.exit(0);
    }
  });

  setTimeout(() => {
    logger.warn("graceful shutdown timed out");
    process.exit(1);
  }, 10_000).unref?.();
}

process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
