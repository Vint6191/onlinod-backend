"use strict";

// A test fixture must model the real Prisma root/TransactionClient boundary.
// This is not a production adapter and does not emulate database rollback.
function transactionClient(root) {
  const tx = { ...root };
  for (const method of ["$transaction", "$connect", "$disconnect", "$on", "$use", "$extends"]) delete tx[method];
  return tx;
}

module.exports = { transactionClient };
