"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const currency = require("./usd-money-contract");
const financial = require("./financial-transactions-service");
const notifications = require("./notification-facts-service");
const sourceLedger = require("./notification-source-ledger-service");
const analytics = require("./creator-analytics-ledger-service");
const subscriptions = require("./creator-analytics-projection-service");
const store = require("./subscription-projection-store");
const fan = require("./fan-data-authority-service");
const orders = require("./custom-orders-service");
const { normalizeBumpContent } = require("./bump-content");
const { normalizeUsageInput } = require("./message-library-usage-service");
const { financiallyActive, teamFinancialStatus } = require("./team-money-financial-state-service");
const { desiredContribution } = require("./team-money-rollup-authority-service");
const { payloads } = require("./human-control-command-contract");
const at = "2026-11-28T12:00:00.000Z";
const foreign = ["EUR", "GBP", "JPY", "USDT"];
const invalid = [null, "", " ", {}, [], 0, false];
const rejectsCurrency = error => error?.code === "UNSUPPORTED_CURRENCY";
const transaction = { externalTransactionId: "usd-transaction", transactionType: "tip", occurredAt: at,
  amountCents: 2500, netCents: 1701, transactionStatus: "done", fanOnlyFansUserId: "99101" };
const notification = { eventType: "tip_received", notificationId: "usd-notification", fanId: "99101", amountCents: 2500, occurredAt: at };
function observation(overrides = {}) {
  return { normalizerVersion: "notification-source-v3", identityKey: "notification:usd-observation", notificationId: "usd-observation",
    sourceType: "tip", category: "tips", eventType: "tip_received", fanOnlyFansUserId: "99101", occurredAt: at,
    disposition: "FACT", targetState: "NOT_APPLICABLE", amountCents: 2500, currency: "USD",
    sourceEvidence: { id: "usd-observation", type: "tip", amount: "25.00" }, ...overrides };
}
const noDatabase = new Proxy({}, { get(_target, key) { throw new Error(`Unexpected database access: ${String(key)}`); } });

test("USD source defaults distinguish omitted currency from explicit unknown or unsupported evidence", () => {
  assert.equal(currency.normalizeUsdCurrency(undefined), null);
  assert.equal(currency.normalizeUsdCurrency(undefined, { allowMissing: true }), "USD");
  for (const value of ["USD", "usd", " USD "]) assert.equal(currency.normalizeUsdCurrency(value), "USD");
  for (const value of [...foreign, ...invalid]) {
    assert.equal(currency.normalizeUsdCurrency(value, { allowMissing: true }), null);
    assert.throws(() => currency.requireUsdCurrency(value, { allowMissing: true }), rejectsCurrency);
  }
  assert.equal(currency.isCanonicalUsdCurrency("USD"), true);
  for (const value of [undefined, "usd", " USD ", ...foreign, ...invalid]) assert.equal(currency.isCanonicalUsdCurrency(value), false);
});

test("financial normalization preserves GROSS and NET independently and rejects every explicit foreign code", () => {
  for (const code of [undefined, "USD"]) {
    const value = financial.normalizeTransaction({ ...transaction, ...(code === undefined ? {} : { currency: code }) }, 0, 1);
    assert.equal(value.rejected, false); assert.equal(value.currency, "USD");
    assert.equal(value.amountCents, 2500); assert.equal(value.netCents, 1701);
  }
  for (const code of [...foreign, ...invalid]) assert.equal(financial.normalizeTransaction({ ...transaction, currency: code }, 0, 1).rejected, true);
  assert.equal(financial.normalizeTransaction({ ...transaction, amountCents: null, currency: "USD" }, 0, 1).amountCents, null);
});

test("exact live non-USD money is rejected before transaction lock, fan identity or canonical writes", async () => {
  await assert.rejects(financial.ingestExactLiveTransaction({ db: noDatabase, agencyId: "a", creatorId: "c",
    money: { ...transaction, transactionId: "usd-transaction", status: "done", currency: "EUR" }, observedAt: new Date(at), now: new Date(at) }), rejectsCurrency);
});

test("live USD evidence cannot override a foreign or rejected monetary notification", () => {
  const live = require("./live-earnings-projection-service");
  const event = { moneyObservation: { version: 1, ...transaction, transactionId: "usd-transaction", status: "done", currency: "USD" } };
  assert.equal(live.exactMoney(event).netCents, 1701);
  for (const notice of [{ category: "tips", currency: "EUR" }, { category: "tips", currency: "USD", sourceEvidence: { currency: "GBP" } },
    { category: "tips", disposition: "REJECTED", currency: null, reasonCode: "UNSUPPORTED_CURRENCY" }]) {
    assert.equal(live.exactMoney({ ...event, notificationObservation: notice }), null);
  }
});

test("receipt chart and direct accepted-fact owners reject foreign money before receipt or generation writes", async () => {
  const receipts = require("./financial-receipt-authority");
  await assert.rejects(financial.ingestFinancialChartChunk({ db: noDatabase, chunk: { currency: "EUR", grossCents: 2500, netCents: 1701 } }), rejectsCurrency);
  await assert.rejects(receipts.commitChart(noDatabase, {}, { currency: "GBP", grossCents: 2500, netCents: 1701 }), rejectsCurrency);
  await assert.rejects(receipts.commitPage(noDatabase, {}, {}, {}, [{ currency: "EUR" }], 0), rejectsCurrency);
});

test("compacted historic receipt requires a creation certificate; remaining old evidence must be complete and USD", async () => {
  const receipts = require("./financial-receipt-authority");
  const row = { id: "receipt", proof: { windows: [{ count: 2 }, { count: 1 }] } };
  const check = async counts => receipts.currencyAuthority({ $queryRawUnsafe: async () => counts }, row);
  assert.deepEqual(await check([{ windowIndex: 0, retained: 2n, unsupported: 0n }, { windowIndex: 1, retained: 1n, unsupported: 0n }]),
    { currencySupported: true, unavailableReason: null });
  assert.equal((await check([{ windowIndex: 0, retained: 2n, unsupported: 1n }, { windowIndex: 1, retained: 1n, unsupported: 0n }])).unavailableReason, "UNSUPPORTED_CURRENCY");
  assert.equal((await check([{ windowIndex: 0, retained: 2n, unsupported: 0n }])).unavailableReason, "CURRENCY_EVIDENCE_UNAVAILABLE");
  assert.equal((await check([])).unavailableReason, "CURRENCY_EVIDENCE_UNAVAILABLE");
  assert.equal((await receipts.currencyAuthority(noDatabase, { ...row, proof: { ...row.proof, currencyContract: "USD_ONLY_V1" } })).currencySupported, true);
  assert.equal(row.proof.currencyContract, undefined);
});

test("direct canonical publication cannot bypass USD admission", async () => {
  await assert.rejects(require("./financial-canonical-publication-repository").publish({ db: noDatabase, rows: [{ ...transaction, currency: "GBP" }] }), rejectsCurrency);
  for (const code of [undefined, "EUR"]) await assert.rejects(financial.publishVerifiedFinancialFactsPage({ db: noDatabase, facts: [{ value: { ...transaction, currency: code } }] }), rejectsCurrency);
});

test("notification sale, tip and subscription money reject foreign currencies but non-money observations stay independent", () => {
  for (const eventType of ["tip_received", "purchase", "paid_subscribed"]) {
    for (const code of [undefined, "USD"]) {
      const result = notifications.normalizeEvent({ ...notification, eventType, ...(code === undefined ? {} : { currency: code }) }, "creator");
      assert.equal(result.rejected, undefined); assert.equal(result.currency, "USD");
    }
    for (const code of [...foreign, ...invalid]) assert.ok(notifications.normalizeEvent({ ...notification, eventType, currency: code }, "creator").rejected);
  }
  const liked = notifications.normalizeEvent({ ...notification, eventType: "post_liked", postId: "111", currency: null, amountCents: null }, "creator");
  assert.equal(liked.kind, "like"); assert.equal(liked.currency, null);
});

test("notification source ledger quarantines a stale FACT with foreign code or contradictory original money evidence", () => {
  for (const input of [observation({ currency: "EUR" }), observation({ sourceEvidence: { currency: "EUR", amount: "25.00" } }),
    observation({ sourceEvidence: { replacePairs: { "{AMOUNT}": "€25.00" } } })]) {
    const result = sourceLedger.normalizeObservation(input);
    assert.equal(result.disposition, "REJECTED"); assert.equal(result.reasonCode, "UNSUPPORTED_CURRENCY");
    assert.deepEqual(result.sourceEvidence, input.sourceEvidence);
  }
  assert.equal(sourceLedger.normalizeObservation(observation()).disposition, "FACT");
  const omitted = observation(); delete omitted.currency;
  assert.equal(sourceLedger.normalizeObservation(omitted).currency, "USD");
});

test("earnings chart input admits USD only and never converts an explicit foreign total", () => {
  const raw = { date: "2026-11-28", sourceTimezone: "UTC", totalCents: 12345 };
  assert.equal(analytics.normalizeEarningsRow(raw).currency, "USD");
  assert.equal(analytics.normalizeEarningsRow({ ...raw, currency: "USD" }).totalCents, 12345);
  for (const code of [...foreign, ...invalid]) assert.equal(analytics.normalizeEarningsRow({ ...raw, currency: code }), null);
});

test("subscription state retains known lifecycle but unsupported latest price is unknown", () => {
  const rows = [{ id: "one", eventType: "SUBSCRIBED_PAID", occurredAt: at, currency: "USD", observedPriceCents: 1200 },
    { id: "two", eventType: "RENEWED", occurredAt: "2026-11-28T13:00:00.000Z", currency: "EUR", observedPriceCents: 1900 }];
  const state = subscriptions.projectSubscriptionState(rows);
  assert.equal(state.status, "ACTIVE"); assert.equal(state.currentPriceCents, null); assert.equal(state.currency, "USD");
  assert.equal(rows[1].currency, "EUR"); assert.equal(rows[1].observedPriceCents, 1900);
  rows.push({ id: "three", eventType: "RENEWED", occurredAt: "2026-11-28T14:00:00.000Z", currency: "USD", observedPriceCents: 2300 });
  assert.equal(subscriptions.projectSubscriptionState(rows).currentPriceCents, 2300);
});

test("subscription SQL writer rejects foreign state/payment records before issuing SQL", async () => {
  for (const write of [store.writeStates, store.writePayments]) await assert.rejects(write(noDatabase, [{ currency: "EUR" }]), rejectsCurrency);
});

test("Team eligibility and rollup cannot activate foreign or unknown money even with an attributed owner", () => {
  const fact = { id: "fact", agencyId: "agency", creatorId: "creator", memberId: "member", sourceType: "TIP",
    occurredAt: new Date(at), amountCents: 2500, currency: "USD", financialStatus: "done", attributionActive: true, classificationState: "CANONICAL" };
  assert.equal(desiredContribution(fact).active, true);
  for (const code of [undefined, null, ...foreign]) {
    const row = { ...fact, currency: code };
    assert.equal(financiallyActive(row), false); assert.equal(desiredContribution(row).active, false);
    assert.equal(teamFinancialStatus({ ...row, transactionStatus: "done" }), "unsupported_currency");
  }
  assert.equal(teamFinancialStatus({ currency: "USD", amountCents: null, transactionStatus: "done" }), "gross_unknown");
});

test("unsupported tip claim DTO preserves the accepted owner but exposes no USD amount", () => {
  const source = { currency: "EUR", amountCents: 2500, attributedMemberId: "member", status: "claimed", receivedAt: at };
  const row = require("./team-tip-ledger-service").tipRowForClaims(source);
  assert.equal(row.amountCents, null); assert.equal(row.currency, null); assert.equal(row.attributedToMemberId, "member");
  assert.equal(source.amountCents, 2500); assert.equal(source.currency, "EUR");
});

test("FanData value and relationship reject unsupported money before any fan or token side effect", async () => {
  for (const project of [fan._test.projectFanValue, fan.projectFanRelationship]) await assert.rejects(project(noDatabase, { currency: "EUR" }), rejectsCurrency);
  const input = { agencyId: "agency", creatorId: "creator", receivedAt: new Date(at), causalObservedAt: new Date(at),
    allowedSources: ["USER_PROFILE"], observedAtPolicy: "SERVER_GENERATION",
    items: [{ onlyFansUserId: "99101", value: { source: "USER_PROFILE", observedAt: at, availability: "AVAILABLE", totalSpentCents: 5000, currency: "EUR" } }] };
  await assert.rejects(fan.commitFanFacts(noDatabase, input), rejectsCurrency);
  await assert.rejects(fan.applyFanDataPointRefreshChunk({ db: noDatabase, job: { agencyId: "agency", creatorId: "creator", params: { fanIds: ["99101"] } },
    chunkResult: { kind: "fan_data_point_refresh", items: input.items } }), rejectsCurrency);
});

test("campaign cost command accepts USD and rejects foreign or unspecified currency", () => {
  const payload = { sourceId: "source", expectedRevision: 1, costCents: 2500 };
  assert.equal(payloads["traffic.cost"].safeParse({ ...payload, currency: "USD" }).success, true);
  for (const code of [undefined, ...foreign, ...invalid]) assert.equal(payloads["traffic.cost"].safeParse({ ...payload, currency: code }).success, false);
});

test("automation and Message Library commands reject explicit foreign currency without altering USD prices", () => {
  assert.equal(normalizeBumpContent({ price: 25 }).priceCents, 2500);
  for (const code of [...foreign, ...invalid]) assert.throws(() => normalizeBumpContent({ price: 25, currency: code }), rejectsCurrency);
  const usage = { eventId: "usd-usage-fixture-0001", creatorId: "creator", scriptId: "script", amount: 25, metadata: { price: 25 } };
  assert.equal(normalizeUsageInput(usage).data.metadata.currency, "USD");
  for (const code of foreign) {
    assert.throws(() => normalizeUsageInput({ ...usage, currency: code }), rejectsCurrency);
    assert.throws(() => normalizeUsageInput({ ...usage, currency: "USD", metadata: { price: 25, currency: code } }), rejectsCurrency);
  }
});

test("retained foreign automation template cannot be selected or exposed as a free USD template", () => {
  const task = { id: "old-task", enabled: true, status: "active", config: { currency: "EUR", price: 25, messageText: "retained" }, triggers: { fanOnline: true } };
  const rules = require("./bump-rules"), template = rules.taskToTemplate(task);
  assert.equal(template.price, null); assert.equal(rules.triggerEnabled(template, "online"), false);
  const shown = require("./automation-server-service").taskToBump(task);
  assert.equal(shown.price, null); assert.equal(shown.currency, null); assert.equal(shown.enabled, false);
  assert.equal(task.config.currency, "EUR"); assert.equal(task.config.price, 25);
  const event = { id: "old-usage", metadata: { currency: "EUR", amount: 25, price: 25, mediaCount: 2 } };
  const usage = require("./message-library-usage-service").usageEventForRead(event);
  assert.equal(usage.metadata.amount, null); assert.equal(usage.metadata.price, null); assert.equal(usage.metadata.currency, null);
  assert.equal(usage.metadata.mediaCount, 2); assert.equal(event.metadata.amount, 25);
});

test("Custom create, pending edits and completed payment edits cannot ignore foreign currency", async () => {
  for (const code of foreign) {
    assert.throws(() => orders.normalizeCreateInput({ currency: code }), rejectsCurrency);
    assert.throws(() => orders.buildUpdateData({}, { currency: code, priceCents: 2000 }), rejectsCurrency);
    assert.throws(() => orders.normalizePaidAmountCents({ currency: code, paidAmountCents: 1000 }), rejectsCurrency);
    await assert.rejects(orders.updateCustomOrder({ db: noDatabase, input: { currency: code, paidAmountCents: 1000 } }), rejectsCurrency);
  }
  assert.equal(orders.normalizePaidAmountCents({ currency: "USD", paidAmountCents: 1000 }), 1000);
});

test("Custom send authority rejects foreign currency before physical commit authority or receipt work", async () => {
  await assert.rejects(require("./custom-manual-delivery-authority-service").prepareCustomManualDeliveryCommit({ db: noDatabase, currency: "EUR", priceCents: 1000 }), rejectsCurrency);
  await assert.rejects(require("./custom-content-delivery-tracking-service").recordCustomDeliverySend({ db: noDatabase, currency: "EUR", priceCents: 1000 }), rejectsCurrency);
});
