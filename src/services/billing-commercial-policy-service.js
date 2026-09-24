"use strict";

const { z } = require("zod");
const POLICY_KEY = "billing.commercial.policy.v1";
// Used only to seed the migration and by explicit fixtures. Runtime reads never
// fall back to defaults: missing/corrupt policy must not produce a cheap charge.
const DEFAULT_SETTINGS = Object.freeze({ trialDays: 14, starterPriceCents: 2000,
  growthPriceCents: 3000, proPriceCents: 5000, elitePriceCents: 15000,
  aiChatterPriceCents: 10000, outreachPriceCents: 2900 });
const price = z.number().int().min(1).max(1000000);
const addon = z.number().int().min(0).max(1000000);
const commercialSettingsSchema = z.object({ trialDays: z.number().int().min(1).max(365),
  starterPriceCents: price, growthPriceCents: price, proPriceCents: price,
  elitePriceCents: price, aiChatterPriceCents: addon, outreachPriceCents: addon }).strict();
function unavailable(cause) {
  return Object.assign(new Error("Global billing policy is unavailable"), { code: "BILLING_COMMERCIAL_POLICY_UNAVAILABLE", status: 503, cause });
}
async function readCommercialPolicy({ db = null, lock = false } = {}) {
  const client = db || require("../prisma");
  // Call lock:true only inside a transaction. Concurrent debits share the row;
  // the admin update waits until already-priced transactions have committed.
  if (lock) await client.$executeRawUnsafe('SELECT "key" FROM "SystemSetting" WHERE "key"=$1 FOR SHARE', POLICY_KEY);
  const row = await client.systemSetting.findUnique({ where: { key: POLICY_KEY } });
  const parsed = commercialSettingsSchema.safeParse(row?.value);
  if (!row || !parsed.success || !Number.isSafeInteger(row.revision) || row.revision < 1) throw unavailable(parsed.error);
  return { ok: true, revision: row.revision, settings: parsed.data, updatedAt: row.updatedAt,
    trialAppliesTo: "NEW_AGENCIES", pricesApplyTo: "FUTURE_PURCHASES_AND_RENEWALS", currency: "USD" };
}
async function enableCommercialPricingWrite(tx) {
  await tx.$executeRawUnsafe("SELECT set_config('onlinod.commercial_pricing_writer','v1',true)");
}
module.exports = { POLICY_KEY, DEFAULT_SETTINGS, commercialSettingsSchema, readCommercialPolicy, enableCommercialPricingWrite };
