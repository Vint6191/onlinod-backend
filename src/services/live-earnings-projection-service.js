"use strict";

// Published transaction identities, not notification amounts, own NET. Scan
// receipts publish atomically; live writes use that same identity and revision.
const { hashCanonicalJson: hash } = require("./realtime-receipt-hash");
const date = (value) => {
  const d = value ? new Date(value) : null;
  return d && Number.isFinite(+d) ? d : null;
};
const safe = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const status = (value) => (["done", "loading", "undo"].includes(value) ? value : null);

const generation = require("./earnings-generation-service");
const { normalizeTransactionType, categoryForTransactionType: categoryFor } = require("./financial-transaction-category");
const lock = generation.lock;
const publishScan = generation.publish;

function exactMoney(event) {
  const raw = event.moneyObservation;
  if (!raw || raw.version !== 1) return null;
  const occurredAt = date(raw.occurredAt),
    revisionAt = date(raw.revisionAt);
  if (
    typeof raw.transactionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,180}$/.test(raw.transactionId) ||
    !occurredAt ||
    !safe(raw.amountCents) ||
    !safe(raw.netCents) ||
    raw.currency !== "USD" ||
    !status(raw.status) ||
    typeof raw.transactionType !== "string" ||
    !normalizeTransactionType(raw.transactionType) ||
    raw.transactionType.length > 80
  )
    return null;
  return { ...raw, transactionType: normalizeTransactionType(raw.transactionType), occurredAt, revisionAt };
}

async function ingestLive({ db, agencyId, creatorId, deviceId, events, capturedAt, capturedTimes = null, now }) {
  await lock(db, creatorId);
  let applied = 0,
    pending = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const eventCapturedAt = date(capturedTimes?.[index]) || capturedAt;
    const n = event.notificationObservation || {},
      money = exactMoney(event);
    if (!money && n.category === "subscriptions" && n.amountCents === 0) continue;
    if (
      !money &&
      !["purchases", "tips", "subscriptions"].includes(n.category) &&
      !/tip_received|paid_subscribed|purchase/i.test(String(event.eventType || "")) &&
      !event.moneyObservation &&
      !/refund|chargeback|revers/i.test(String(n.sourceType || n.notificationType || event.eventType || ""))
    )
      continue;
    const occurredAt = money?.occurredAt || date(n.occurredAt) || eventCapturedAt;
    // Revisions need their own resolution state. A previous APPLIED notice
    // must not hide a later ambiguous correction of that same notification.
    const id = hash([creatorId, n.identityKey || event.eventKey || hash(event), event.moneyObservation || n]);
    const observedAt = date(event.moneyObservation?.revisionAt) || eventCapturedAt;
    let reason = money ? null : "EXACT_TRANSACTION_NET_REQUIRED";
    if (+observedAt > +now + 30_000 || +occurredAt > +now + 30_000 || +occurredAt < +new Date("2016-01-01T00:00:00Z")) reason = "SOURCE_TIME_INVALID";
    const reversal = /refund|chargeback|revers/i.test(String(n.sourceType || n.notificationType || event.eventType || ""));
    const identifiable = /^[A-Za-z0-9_-]{1,180}$/.test(event.moneyObservation?.transactionId || "");
    if (!money && reversal && !identifiable) reason = "TRANSACTION_ID_REQUIRED_FOR_REVERSAL";
    if ((event.moneyObservation?.currency || n.currency) && (event.moneyObservation?.currency || n.currency) !== "USD") reason = "MONEY_CURRENCY_UNSUPPORTED";
    const blocked = ["SOURCE_TIME_INVALID","TRANSACTION_ID_REQUIRED_FOR_REVERSAL","MONEY_CURRENCY_UNSUPPORTED"].includes(reason);
    if (money && !reason) {
      const previous = await generation.activeEntry(db, creatorId, money.transactionId);
      // Unversioned corrections cannot override a different financial fact.
      const changed =
        previous &&
        (Number(previous.netCents) !== money.netCents ||
          previous.status !== money.status ||
          +previous.occurredAt !== +money.occurredAt ||
          previous.category !== categoryFor(money.transactionType));
      if (changed && !money.revisionAt) reason = "TRANSACTION_REVISION_REQUIRED";
      else if (changed && +observedAt === +previous.observedAt) reason = "TRANSACTION_REVISION_CONFLICT";
      else if (!previous || +observedAt >= +previous.observedAt) {
        await generation.writeLive(db, {agencyId, creatorId}, {
          transactionId: money.transactionId, occurredAt: money.occurredAt, netCents: money.netCents,
          status: money.status, observedAt, category: categoryFor(money.transactionType),
        });
        await require("./financial-transactions-service").ingestExactLiveTransaction({
          db,
          agencyId,
          creatorId,
          deviceId,
          money,
          observedAt,
          now,
        });
        applied++;
      }
    }
    if (reason) pending++;
    await db.$executeRawUnsafe(
      `INSERT INTO "CreatorMoneyObservation"(id,"agencyId","creatorId","transactionId","occurredAt","capturedAt",status,reason,"resolutionBlockedAt","resolutionError")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET status=CASE WHEN EXCLUDED.status='APPLIED' THEN 'APPLIED' ELSE "CreatorMoneyObservation".status END,
      reason=CASE WHEN EXCLUDED.status='APPLIED' THEN NULL ELSE "CreatorMoneyObservation".reason END`,
      id,
      agencyId,
      creatorId,
      money?.transactionId || (/^[A-Za-z0-9_-]{1,180}$/.test(event.moneyObservation?.transactionId || "") ? event.moneyObservation.transactionId : null),
      occurredAt,
      eventCapturedAt,
      reason ? "PENDING" : "APPLIED",
      reason,
      blocked ? now : null,
      blocked ? reason : null
    );
  }
  await db.$executeRawUnsafe(
    `DELETE FROM "CreatorMoneyObservation" WHERE id IN (
    SELECT id FROM "CreatorMoneyObservation" WHERE "creatorId"=$1 AND status IN ('APPLIED','COVERED')
      AND "occurredAt"<$2 ORDER BY "occurredAt",id LIMIT 100)`,
    creatorId,
    new Date(+now - 30 * 86400000)
  );
  if (applied || pending) require("./analytics-change-hint-service").publish(agencyId);
  if (pending) await require("./money-resolution-service").enqueue({db,agencyId,creatorId,now});
  return { applied, pending };
}
module.exports = { publishScan, ingestLive, exactMoney };
