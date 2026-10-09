"use strict";
// Adapter for query/selection fixtures, not a database rollback simulation.
// Real rollback, retry and savepoint assertions live in the PostgreSQL proof.
function withTransactionClient(db) {
  db.$transaction = async work => {
    const { $transaction, ...tx } = db;
    const execute = tx.$executeRawUnsafe;
    if (execute) tx.$executeRawUnsafe = (sql, ...args) => sql === "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('TimeZone', 'UTC', true), set_config('onlinod.campaign_projection_writer', 'campaign_projection_v2', true)" ? 1 : execute(sql, ...args);
    return work(tx);
  };
  return db;
}
module.exports = { withTransactionClient };
