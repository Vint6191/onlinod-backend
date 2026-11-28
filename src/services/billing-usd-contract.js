"use strict";

const { isCanonicalUsdCurrency } = require("./usd-money-contract");

function assertUsdBillingRow(row) {
  if (!isCanonicalUsdCurrency(row?.currency)) {
    throw Object.assign(new Error("NOD billing monetary records must use USD."), {
      code: "BILLING_CURRENCY_UNSUPPORTED", status: 409, permanent: true,
    });
  }
  return row;
}

module.exports = { assertUsdBillingRow };
