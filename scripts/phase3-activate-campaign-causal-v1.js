"use strict";

const prisma = require("../src/prisma");
const { activateCampaignCausalV1 } = require("../src/services/campaign-causal-activation-service");

async function main() {
  const result = await activateCampaignCausalV1({ db: prisma, activatedBy: process.env.RENDER_INSTANCE_ID || "operator" });
  console.log(JSON.stringify({ ok: true, ...result }));
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
