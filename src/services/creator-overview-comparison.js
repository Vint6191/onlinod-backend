"use strict";

const { previousDisplayRange, displayRangeBounds } = require("./analytics-range-contract");
const { readPublishedFinancialSummary } = require("./published-financial-read-repository");
const { readLiveEarningsCoverage } = require("./earnings-live-read-sql");
const { percentChange } = require("./analytics-comparison");

function financeComparison({ current, previous, coverage, range, now }) {
  const previousRange = previousDisplayRange(range, now), currentRange = displayRangeBounds(range, now);
  const result = {
    range: { startAt: previousRange.startAt.toISOString(), endAt: previousRange.endAt.toISOString() },
    ready: false,
    netCents: null, transactions: null, averageSaleCents: null,
    netDeltaCents: null, netDeltaPct: null, averageSaleDeltaPct: null,
  };
  // The two amounts must refer to the same published authority. A fresh current
  // head does not prove a historical range before the retained baseline.
  const through = coverage?.throughAt && new Date(coverage.throughAt);
  const from = coverage?.fromAt && new Date(coverage.fromAt);
  const ready = current?.ready === true && previous?.ready === true && coverage?.fresh === true
    && current.generation === previous.generation && Boolean(current.generation)
    && from && through && from <= previousRange.startAt && through >= previousRange.endAt
    && through >= currentRange.endDay
    && [current.finance.netCents, previous.finance.netCents, current.finance.transactions, previous.finance.transactions].every(Number.isSafeInteger)
    && current.finance.transactions >= 0 && previous.finance.transactions >= 0
    && Number.isSafeInteger(current.finance.netCents - previous.finance.netCents);
  if (!ready) return result;
  const currentAverage = current.finance.transactions > 0 ? current.finance.netCents / current.finance.transactions : null;
  const previousAverage = previous.finance.transactions > 0 ? previous.finance.netCents / previous.finance.transactions : null;
  return {
    ...result, ready: true,
    netCents: previous.finance.netCents, transactions: previous.finance.transactions,
    averageSaleCents: previousAverage,
    netDeltaCents: current.finance.netCents - previous.finance.netCents,
    netDeltaPct: percentChange(current.finance.netCents, previous.finance.netCents),
    averageSaleDeltaPct: percentChange(currentAverage, previousAverage),
  };
}

function financialRangeCoverage({ current, coverage, range, now }) {
  const requested = displayRangeBounds(range, now);
  const from = coverage?.fromAt ? new Date(coverage.fromAt) : null;
  const through = coverage?.throughAt ? new Date(coverage.throughAt) : null;
  // Today's last published value is a snapshot through `throughAt`, not a
  // promise that observations arriving after it have already been collected.
  const ready = Boolean(current?.ready && current.generation && from && through
    && from <= requested.startAt && through >= requested.endDay);
  return { ready, fresh: ready && coverage?.fresh === true,
    fromAt: from?.toISOString() || null, throughAt: through?.toISOString() || null };
}

async function readCreatorFinancialReadState({ db, creatorId, range, now, current }) {
  const previous = previousDisplayRange(range, now);
  const [published, coverage] = await Promise.all([
    readPublishedFinancialSummary({ db, creatorId, from: previous.startAt, to: previous.endAt }),
    readLiveEarningsCoverage(db, creatorId, now),
  ]);
  return {
    comparison: financeComparison({ current, previous: published, coverage, range, now }),
    financialRange: financialRangeCoverage({ current, coverage, range, now }),
  };
}

async function readCreatorFinancialComparison(input) { return (await readCreatorFinancialReadState(input)).comparison; }

module.exports = { readCreatorFinancialComparison, readCreatorFinancialReadState, financeComparison, financialRangeCoverage };
