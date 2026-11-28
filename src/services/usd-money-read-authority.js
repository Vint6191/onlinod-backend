"use strict";

// SQL expressions below are source-owned aliases/parameters, never request
// values. Partial indexes make these existence witnesses bounded by the first
// unsupported row. Preserve the original evidence; it cannot be converted or
// silently dropped from a supposedly complete USD total.
function windowSql(alias, { from = null, to = null } = {}) {
  return `${from ? ` AND ${alias}."occurredAt">=${from}` : ''}${to ? ` AND ${alias}."occurredAt"<${to}` : ''}`;
}

function unsupportedFinancialCurrencySql(creator, window = {}) {
  return `EXISTS(SELECT 1 FROM "CreatorFinancialTransaction" usd_fact
    WHERE usd_fact."creatorId"=${creator} AND usd_fact."currency" IS DISTINCT FROM 'USD'${windowSql('usd_fact', window)})`;
}

function unsupportedLedgerCurrencySql(creator, generation, window = {}) {
  return `(${unsupportedFinancialCurrencySql(creator, window)}
    OR EXISTS(SELECT 1 FROM "CreatorEarningsGenerationEntry" usd_entry
      WHERE usd_entry.generation=${generation} AND ${unsupportedEntryCurrencySql('usd_entry')}${windowSql('usd_entry', window)})
    OR EXISTS(SELECT 1 FROM "CreatorEarningsGeneration" usd_generation
      JOIN "CreatorEarningsGenerationEntry" usd_receipt_entry ON usd_receipt_entry.generation=usd_generation.id
        AND usd_receipt_entry."observedAt"=usd_generation."snapshotAt"
      JOIN "FinancialObservedFact" usd_receipt ON usd_receipt."runId"=usd_generation."runId"
        AND usd_receipt."windowIndex"=0 AND usd_receipt."externalId"=usd_receipt_entry."transactionId"
      WHERE usd_generation.id=${generation} AND usd_generation."creatorId"=${creator}
        AND usd_receipt.value->>'currency' IS DISTINCT FROM 'USD'${windowSql('usd_receipt_entry', window)})
    OR (${generation} IS NULL AND EXISTS(SELECT 1 FROM "CreatorEarningsLedgerEntry" usd_entry
      WHERE usd_entry."creatorId"=${creator} AND ${unsupportedEntryCurrencySql('usd_entry')}${windowSql('usd_entry', window)})))`;
}

function unsupportedEntryCurrencySql(alias) {
  return `((${alias}."financialFact" ? 'currency' AND ${alias}."financialFact"->>'currency' IS DISTINCT FROM 'USD')
    OR (${alias}."financialFact"->'value' ? 'currency' AND ${alias}."financialFact"->'value'->>'currency' IS DISTINCT FROM 'USD'))`;
}

async function readUnsupportedFinancialCurrency(db, creatorId, window = {}) {
  const params = [creatorId], bounds = {};
  if (window.from) { params.push(new Date(window.from)); bounds.from = `$${params.length}`; }
  if (window.to) { params.push(new Date(window.to)); bounds.to = `$${params.length}`; }
  const [row] = await db.$queryRawUnsafe(`SELECT ${unsupportedFinancialCurrencySql('$1', bounds)} AS unsupported`, ...params);
  return row?.unsupported === true;
}

module.exports = { unsupportedFinancialCurrencySql, unsupportedLedgerCurrencySql, readUnsupportedFinancialCurrency };
