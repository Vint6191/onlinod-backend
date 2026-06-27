const { PrismaClient } = require("@prisma/client");

const enableQueryLog = String(process.env.PRISMA_QUERY_LOG || "").trim() === "1";
const slowQueryMs = Math.max(100, Number(process.env.PRISMA_SLOW_QUERY_MS || 500));

const prisma = new PrismaClient({
  log: enableQueryLog
    ? [{ emit: "event", level: "query" }, "warn", "error"]
    : ["warn", "error"],
});

if (enableQueryLog) {
  prisma.$on("query", (event) => {
    if (Number(event.duration || 0) >= slowQueryMs) {
      console.warn("[prisma] slow query", {
        durationMs: event.duration,
        target: event.target,
        query: String(event.query || "").slice(0, 500),
      });
    }
  });
}

let disconnecting = false;
async function disconnectPrisma() {
  if (disconnecting) return;
  disconnecting = true;
  try {
    await prisma.$disconnect();
  } catch (err) {
    console.warn("[prisma] disconnect failed:", err?.message || err);
  }
}

process.once("SIGTERM", () => void disconnectPrisma());
process.once("SIGINT", () => void disconnectPrisma());

module.exports = prisma;
