"use strict";

const { trustedCollectionTimestamp, CAMPAIGN_FAN_VALUE_FRESHNESS_MS } = require("./analytics-freshness-policy");

const VALUE_FIELDS = Object.freeze(["platformReportedTotalSpendCents", "messagesSpentCents", "subscriptionsSpentCents", "tipsSpentCents", "postsSpentCents", "streamsSpentCents"]);

function fieldAuthority(version) {
  if (typeof version !== "string") return null;
  const [at, priority, source, digest] = version.split("|");
  const observedAt = new Date(at);
  if (!digest || !source || !Number.isFinite(+observedAt)) return null;
  return { authorityVersion: version, observedAt: observedAt.toISOString(), source, priority: Number(priority) };
}

function valueFieldAuthority(value) {
  return Object.fromEntries([...VALUE_FIELDS, "availability", "lastActivityAt"].map(field => [field, fieldAuthority(value?.[`${field}AuthorityVersion`])]));
}

function valueFieldState(value, now, freshnessMs = CAMPAIGN_FAN_VALUE_FRESHNESS_MS) {
  const authority = valueFieldAuthority(value);
  const fields = Object.fromEntries(VALUE_FIELDS.map(field => {
    // Legacy totals were always accompanied by the profile timestamp. Component
    // timestamps cannot be inferred from a later, unrelated profile field.
    const observed = trustedCollectionTimestamp(authority[field]?.observedAt
      ?? (field === "platformReportedTotalSpendCents" ? value?.valueObservedAt : null), now);
    const known = value?.[field] != null && Boolean(observed);
    const fresh = Boolean(known && observed && +observed + freshnessMs > +now);
    return [field, { known, fresh, observedAt: observed?.toISOString() || null,
      expiresAt: observed ? new Date(+observed + freshnessMs).toISOString() : null }];
  }));
  // Expiry limits claims of freshness, not the lifetime of a saved observation.
  // Keep `available` strict for collectors/decisions; display readers use `known`.
  return { authority, fields,
    known: value?.availability === "AVAILABLE" && fields.platformReportedTotalSpendCents.known,
    available: value?.availability === "AVAILABLE" && fields.platformReportedTotalSpendCents.fresh };
}

module.exports = { VALUE_FIELDS, fieldAuthority, valueFieldAuthority, valueFieldState };
