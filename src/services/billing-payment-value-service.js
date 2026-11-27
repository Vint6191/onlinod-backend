"use strict";

// Wallet credit uses the payment's USD quote: received crypto / quoted crypto
// times the quoted USD price, rounded down to whole cents. A changing spot-fiat
// estimate cannot revalue an already credited deposit. The provider quote also
// preserves the invoice's fee terms instead of crediting user-paid fees again.
// Source: https://documenter.getpostman.com/view/7907941/S1a32n38
function decimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const source = String(value).trim();
  if (source.length > 100) return null;
  const match = source.match(/^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,2}))?$/);
  if (!match) return null;
  const fraction = match[2] || "", exponent = Number(match[3] || 0);
  let n = BigInt(match[1] + fraction), scale = fraction.length - exponent;
  if (Math.abs(scale) > 60) return null;
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  return { n, d: 10n ** BigInt(scale) };
}
function cents(value) { const amount = decimal(value); return amount ? amount.n * 100n / amount.d : null; }
function greaterDecimal(a, b) {
  const left = decimal(a), right = decimal(b);
  return !!left && !!right && left.n * right.d > right.n * left.d;
}
function valuePayment(order, payload) {
  const evidence = {
    version: 1, currency: "USD", feePolicy: "PROVIDER_QUOTE", rounding: "FLOOR_CENTS", toleranceCents: 0,
    priceAmount: payload.price_amount == null ? null : String(payload.price_amount),
    priceCurrency: String(payload.price_currency || "").toUpperCase(),
    payAmount: payload.pay_amount == null ? null : String(payload.pay_amount),
    payCurrency: String(payload.pay_currency || "").toLowerCase(),
    actuallyPaid: payload.actually_paid == null ? null : String(payload.actually_paid),
    actuallyPaidAtFiat: payload.actually_paid_at_fiat == null ? null : String(payload.actually_paid_at_fiat),
  };
  const unavailable = reason => ({ ok: false, reason, evidence });
  if (String(order.currency).toUpperCase() !== "USD" || evidence.priceCurrency !== "USD") return unavailable("SETTLEMENT_CURRENCY_UNSUPPORTED");
  const actual = decimal(payload.actually_paid);
  if (!actual || actual.n <= 0n || !evidence.payCurrency) return unavailable("SETTLEMENT_RECEIVED_AMOUNT_UNPROVEN");
  const price = decimal(payload.price_amount), quote = decimal(payload.pay_amount);
  if (!price || price.n <= 0n || !quote || quote.n <= 0n) return unavailable("SETTLEMENT_QUOTE_UNAVAILABLE");
  const amountCents = price.n * actual.n * quote.d * 100n / (price.d * actual.d * quote.n);
  const basis = "PROVIDER_PAYMENT_QUOTE_V1";
  if (amountCents <= 0n || amountCents > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable("SETTLEMENT_VALUE_OUT_OF_RANGE");
  return { ok: true, amountCents, basis, evidence };
}
function equalDecimal(a, b) {
  const left = decimal(a), right = decimal(b);
  return !!left && !!right && left.n * right.d === right.n * left.d;
}
function sameQuote(a, b) {
  return !!a && !!b && a.priceCurrency === b.priceCurrency && a.payCurrency === b.payCurrency
    && equalDecimal(a.priceAmount, b.priceAmount) && equalDecimal(a.payAmount, b.payAmount);
}
module.exports = { decimal, cents, greaterDecimal, equalDecimal, sameQuote, valuePayment };
