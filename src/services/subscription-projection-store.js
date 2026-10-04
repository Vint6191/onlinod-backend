"use strict";

// Identifiers/types are code-owned. Values travel as one bound JSON parameter,
// so a 2000-event page cannot become thousands of hosted-Postgres round trips.
const common = { id: "text", agencyId: "text", creatorId: "text", fanId: "text", createdAt: "timestamp", updatedAt: "timestamp" };
const stateColumns = { ...common, status: '"CreatorSubscriptionStateStatus"', currentPriceCents: "integer", currency: "text",
  startedAt: "timestamp", expiresAt: "timestamp", lastRenewedAt: "timestamp", endedAt: "timestamp",
  autoRenewEnabled: "boolean", lastEventAt: "timestamp", updatedFromEventId: "text" };
const paidColumns = { ...common, fanOnlyFansUserIdAtEvent: "text", fanUsernameAtEvent: "text", fanDisplayNameAtEvent: "text", fanAvatarUrlAtEvent: "text",
  eventFingerprint: "text", externalTransactionId: "text", subscriptionEventId: "text", paymentType: '"CreatorPaidSubscriptionPaymentType"',
  amountCents: "integer", currency: "text", paidAt: "timestamp", periodFrom: "timestamp", periodTo: "timestamp",
  source: '"CreatorFactSource"', sourceUpdatedAt: "timestamp", collectedAt: "timestamp", sourceDeviceId: "text", sourceJobId: "text" };
function statement(table, columns, conflict) {
  const names = Object.keys(columns), quoted = name => '"' + name + '"';
  const immutable = new Set(["id", "agencyId", "creatorId", "createdAt"]);
  return `INSERT INTO "${table}" (${names.map(quoted).join(",")})
    SELECT ${names.map(quoted).join(",")} FROM jsonb_to_recordset($1::jsonb) AS rows(${Object.entries(columns).map(([name, type]) => `${quoted(name)} ${type}`).join(",")})
    ON CONFLICT (${conflict.map(quoted).join(",")}) DO UPDATE SET ${names.filter(name => !immutable.has(name)).map(name => `${quoted(name)}=EXCLUDED.${quoted(name)}`).join(",")}`;
}
const stateSql = statement("CreatorSubscriptionState", stateColumns, ["creatorId", "fanId"]);
const paidSql = statement("CreatorPaidSubscription", paidColumns, ["id"]);
async function write(db, sql, rows) {
  if (!rows.length) return;
  await db.$executeRawUnsafe(sql, JSON.stringify(rows.map(({ fanRecordId, ...row }) => ({ ...row, fanId: fanRecordId }))));
}
module.exports = { writeStates: (db, rows) => write(db, stateSql, rows), writePayments: (db, rows) => write(db, paidSql, rows) };
