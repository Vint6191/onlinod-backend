"use strict";
const { adminError } = require("./admin-command-contract");
const { executeAdminCommand } = require("./admin-commit-authority-service");
const { POLICY_KEY, readCommercialPolicy } = require("./billing-commercial-policy-service");
async function setAdminCommercialPolicy({ db, actor, commandId, payload }) {
  return executeAdminCommand({ db, actor, commandId, action: "billing.commercial-policy.set", targetId: POLICY_KEY, payload,
    work: async ({ tx, payload: input }) => {
      await tx.$queryRawUnsafe('SELECT "key" FROM "SystemSetting" WHERE "key"=$1 FOR UPDATE', POLICY_KEY);
      const before = await readCommercialPolicy({ db: tx });
      if (before.revision !== input.expectedRevision) throw adminError("BILLING_COMMERCIAL_POLICY_CHANGED", "Global billing policy changed; reload before saving", 409, { currentRevision: before.revision });
      await tx.$executeRawUnsafe("SELECT set_config('onlinod.commercial_policy_command','v1',true)");
      await tx.systemSetting.update({ where: { key: POLICY_KEY }, data: { value: input.settings, updatedByAdminId: actor.adminId } });
      const after = await readCommercialPolicy({ db: tx });
      return { body: after, audit: { before, after } };
    },
  });
}
module.exports = { setAdminCommercialPolicy };
