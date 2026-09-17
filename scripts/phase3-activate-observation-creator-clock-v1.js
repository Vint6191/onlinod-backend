"use strict";

const prisma = require("../src/prisma");
const {
  activateFanObservationCreatorClockV1,
} = require("../src/services/fan-observation-clock-activation-service");

async function main() {
  const result = await activateFanObservationCreatorClockV1({
    db: prisma,
    activatedBy: process.env.RENDER_INSTANCE_ID || "operator",
  });
  console.log(JSON.stringify({ ok: true, ...result }));
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (Number.isFinite(Number(error?.futureSkewMs))) {
      console.error(JSON.stringify({
        code: error.message,
        futureSkewMs: Number(error.futureSkewMs),
        maxFutureSkewMs: Number(error.maxFutureSkewMs),
      }));
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
