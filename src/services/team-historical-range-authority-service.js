"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function retainedDetailFrom({ authorityNow, detailDays }) {
  const now = asDate(authorityNow);
  if (!now) throw new Error("TEAM_HISTORY_AUTHORITY_TIME_REQUIRED");
  const days = Math.max(1, Number(detailDays) || 180);
  return new Date(now.getTime() - days * DAY_MS);
}

function latestAvailableFrom(...values) {
  const dates = values.map(asDate).filter(Boolean);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((value) => value.getTime())));
}

function clampRangeToAvailableFrom(range, availableFrom) {
  const from = asDate(availableFrom);
  if (!from) return null;
  const endAt = asDate(range?.endAt) || new Date();
  if (endAt.getTime() < from.getTime()) return null;
  const requestedStart = asDate(range?.startAt);
  const startAt = requestedStart && requestedStart.getTime() > from.getTime() ? requestedStart : from;
  if (startAt.getTime() > endAt.getTime()) return null;
  return { ...range, startAt, endAt };
}

function coverageState(range, availableFrom) {
  const from = asDate(availableFrom);
  if (!from) return { status: "UNAVAILABLE", availableFrom: null };
  const start = asDate(range?.startAt);
  const end = asDate(range?.endAt);
  if (end && end.getTime() < from.getTime()) return { status: "UNAVAILABLE", availableFrom: from.toISOString() };
  if (!start) return { status: "AVAILABLE_FROM", availableFrom: from.toISOString() };
  if (start.getTime() >= from.getTime()) return { status: "FULL", availableFrom: from.toISOString() };
  return { status: "PARTIAL", availableFrom: from.toISOString() };
}

function buildProjectionDetailAuthority({ range, authorityNow, detailDays, responseCoverageFrom, dialogCoverageFrom }) {
  const detailRetainedFrom = retainedDetailFrom({ authorityNow, detailDays });
  const responseAvailableFrom = latestAvailableFrom(responseCoverageFrom, detailRetainedFrom);
  const dialogAvailableFrom = latestAvailableFrom(dialogCoverageFrom, detailRetainedFrom);
  return {
    detailRetainedFrom,
    responseAvailableFrom,
    dialogAvailableFrom,
    responseRange: clampRangeToAvailableFrom(range, responseAvailableFrom),
    dialogRange: clampRangeToAvailableFrom(range, dialogAvailableFrom),
    responseCoverage: coverageState(range, responseAvailableFrom),
    dialogCoverage: coverageState(range, dialogAvailableFrom),
  };
}

module.exports = {
  DAY_MS,
  asDate,
  retainedDetailFrom,
  latestAvailableFrom,
  clampRangeToAvailableFrom,
  coverageState,
  buildProjectionDetailAuthority,
};
