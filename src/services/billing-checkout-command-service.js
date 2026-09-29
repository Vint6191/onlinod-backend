"use strict";
const { z } = require("zod");
const { createWalletTopUpCheckout } = require("./billing-nowpayments-service");
const { assertManagementCommitAuthority } = require("./management-commit-authority-service");
const { isOwner } = require("./team-access-control");

const schema = z
  .object({
    commandId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    action: z.literal("wallet.topup"),
    targetId: z.literal(""),
    payload: z.object({ amountCents: z.number().int().min(100).max(10_000_000), testMode: z.boolean() }).strict(),
  })
  .strict();

function billingCheckoutAuthority({ agencyId, userId, actorMember }) {
  return async (tx) => {
    const { member } = await assertManagementCommitAuthority({ tx, agencyId, actorMember: { ...actorMember, userId } });
    if (!isOwner(member))
      throw Object.assign(new Error("Plan & Billing is available to workspace owners only"), {
        code: "BILLING_OWNER_ONLY",
        status: 403,
      });
  };
}
async function executeBillingCheckoutCommand({ agencyId, userId, actorMember, input, db }) {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw Object.assign(new Error("Invalid top-up command"), { code: "BILLING_COMMAND_INVALID", status: 400 });
  const c = parsed.data;
  const authorize = billingCheckoutAuthority({ agencyId, userId, actorMember });
  const result = await createWalletTopUpCheckout({
    agencyId,
    actorUserId: userId,
    checkoutKey: c.commandId,
    amountCents: c.payload.amountCents,
    expectedTestMode: c.payload.testMode,
    authorize,
    recoverReserved: true,
    db,
  });
  return { ok: true, commandId: c.commandId, ...result };
}
module.exports = { executeBillingCheckoutCommand, billingCheckoutAuthority };
