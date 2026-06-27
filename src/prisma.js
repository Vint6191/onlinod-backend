const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  log: ["warn", "error"],
});

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
