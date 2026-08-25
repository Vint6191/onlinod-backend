const { PrismaClient, Prisma } = require("@prisma/client");

function assertGeneratedPrismaClientContract() {
  const models = Prisma?.dmmf?.datamodel?.models;
  const creator = Array.isArray(models) ? models.find((model) => model?.name === "CreatorAccount") : null;
  if (!creator || !Array.isArray(creator.fields)) {
    throw new Error("PRISMA_CLIENT_SCHEMA_STALE: CreatorAccount metadata is missing; run prisma generate");
  }

  const fields = new Set(creator.fields.map((field) => String(field?.name || "")));
  const forbidden = ["partition", "sessionMode"].filter((field) => fields.has(field));
  const required = ["sessionState", "networkProfile"].filter((field) => !fields.has(field));
  if (forbidden.length || required.length) {
    throw new Error(
      `PRISMA_CLIENT_SCHEMA_STALE: regenerate Prisma Client (forbidden=${forbidden.join(",") || "none"}; missing=${required.join(",") || "none"})`
    );
  }
}

assertGeneratedPrismaClientContract();

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
