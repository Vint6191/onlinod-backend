"use strict";
const { DEFAULT_SETTINGS, POLICY_KEY } = require("../../src/services/billing-commercial-policy-service");
const policyFixture = () => ({ ok: true, revision: 1, settings: { ...DEFAULT_SETTINGS } });
const policyModelFixture = () => ({ findUnique: async ({where}) => where.key === POLICY_KEY ? { key: POLICY_KEY, value: {...DEFAULT_SETTINGS}, revision: 1 } : null });
module.exports = { policyFixture, policyModelFixture };
