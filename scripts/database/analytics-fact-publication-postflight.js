"use strict";
const SPECS = [
  ...["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent", "CreatorPaidSubscription", "CreatorPostLike", "CreatorPostComment", "CreatorFinancialTransaction", "CreatorMessagesDaily"]
    .map(table => ({ table, name: table + "_analytics_publication_v1", fn: "analytics_capture_fact_v1", events: ["INSERT", "UPDATE", "DELETE"], marker: "analytics_stage_fact_v1" })),
  ...["FinancialReceiptRun", "FinancialObservedFact", "FinancialPageReceipt"].map(table => ({ table, name: table + "_writer_v1", fn: "financial_receipt_writer_v1", events: ["INSERT", "UPDATE"], marker: "FINANCIAL_RECEIPT_WRITER_REQUIRED" })),
  { table: "JobInstance", name: "JobInstance_financial_receipt_v1", fn: "financial_receipt_job_guard_v1", events: ["INSERT", "UPDATE"], marker: "FINANCIAL_RECEIPT_PROTOCOL_DOWNGRADE" },
  { table: "CreatorFinancialCollectionState", name: "CreatorFinancialCollectionState_receipt_v1", fn: "financial_receipt_coverage_guard_v1", events: ["INSERT", "UPDATE"], marker: "FINANCIAL_RECEIPT_COVERAGE_REQUIRED" },
  { table: "NotificationFactReceipt", name: "NotificationFactReceipt_guard_v1", fn: "notification_fact_receipt_guard_v1", events: ["UPDATE"], marker: "NOTIFICATION_FACT_RECEIPT_IMMUTABLE" },
  ...["CreatorAnalyticsDay", "CreatorAnalyticsDayMember"].map(table => ({ table, name: table + "_writer_v1", fn: "analytics_published_writer_v1", events: ["INSERT", "UPDATE"], marker: "ANALYTICS_PUBLICATION_WRITER_REQUIRED" })),
  { table: "CreatorAnalyticsFactPublication", name: "CreatorAnalyticsFactPublication_guard_v1", fn: "analytics_fact_publication_guard_v1", events: ["INSERT", "UPDATE"], marker: "ANALYTICS_PUBLICATION_SCOPE_IMMUTABLE" },
  { table: "CreatorAccount", name: "CreatorAccount_analytics_publication_v1", fn: "analytics_new_creator_v1", events: ["INSERT"], marker: "CreatorAnalyticsPublicationState" },
  ...["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent"].map(table => ({ table, name: table + "_phase5_notification_consequences", fn: "phase5_notification_fact_consequences", events: ["INSERT", "UPDATE"], marker: "NOTIFICATION_FACT_RECEIPTS" })),
];
async function verify(db) {
  const rows = await db.$queryRawUnsafe(`SELECT t.tgname AS name,c.relname AS "table",t.tgenabled AS enabled,p.proname AS fn,
    pg_get_functiondef(p.oid) AS body,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname=current_schema() AND t.tgname=ANY($1::text[])`, SPECS.map(x => x.name));
  for (const spec of SPECS) {
    const row = rows.find(x => x.name === spec.name);
    const timing = ["analytics_capture_fact_v1", "analytics_new_creator_v1", "phase5_notification_fact_consequences"].includes(spec.fn) ? "AFTER" : "BEFORE";
    if (!row || row.table !== spec.table || row.fn !== spec.fn || !["O", "A"].includes(row.enabled)
      || !row.definition.includes(timing) || !row.definition.includes("FOR EACH ROW")
      || !spec.events.every(event => row.definition.includes(event)) || !row.body.includes(spec.marker)) throw new Error("ANALYTICS_FACT_PUBLICATION_FENCE_INVALID:" + spec.name);
  }
  const functions = await db.$queryRawUnsafe(`SELECT proname,pg_get_functiondef(oid) AS body FROM pg_proc
    WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1::text[])`, ["analytics_stage_fact_v1", "analytics_publication_value_v1"]);
  if (functions.length !== 2 || !functions.find(row => row.proname === "analytics_stage_fact_v1")?.body.includes("NOT is_adoption")) throw new Error("ANALYTICS_FACT_ADOPTION_FENCE_INVALID");
  return { ready: true, fences: SPECS.length, functions: functions.length };
}
module.exports = { verify, SPECS };
if (require.main === module) {
  const db = require("../../src/prisma");
  verify(db).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}
