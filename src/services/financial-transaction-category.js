"use strict";

// Financial pages and live revisions describe the same provider transaction.
// Keep its fact classification and earnings category at one boundary.
const SALE_TYPES = new Map([["message", "MESSAGE"], ["post", "POST"], ["stream", "STREAM"]]);
function normalizeTransactionType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function classifyTransactionType(value) {
  const type = normalizeTransactionType(value);
  if (SALE_TYPES.has(type)) return { factType: "SALE", projectionStatus: "PROJECTED", saleType: SALE_TYPES.get(type), reasonCode: null };
  if (type === "tip" || type === "tips") return { factType: "TIP", projectionStatus: "PROJECTED", saleType: null, reasonCode: null };
  if (/^(subscribe|subscribes|subscription|renew|renewal|resubscribe|resubscription)/.test(type)) {
    return { factType: "PAID_SUBSCRIPTION", projectionStatus: "STORED_ONLY", saleType: null, reasonCode: "subscription_payment_type_not_proven" };
  }
  return { factType: "OTHER", projectionStatus: "STORED_ONLY", saleType: null, reasonCode: "unmapped_transaction_type" };
}
function earningsCategory(fact) {
  if (fact.factType === "TIP") return "tips";
  if (fact.factType === "PAID_SUBSCRIPTION") return "subscriptions";
  return { message: "messages", post: "posts", stream: "streams" }[normalizeTransactionType(fact.transactionType)] || "other";
}
function categoryForTransactionType(value) {
  return earningsCategory({ ...classifyTransactionType(value), transactionType: value });
}
module.exports = { normalizeTransactionType, classifyTransactionType, earningsCategory, categoryForTransactionType };
