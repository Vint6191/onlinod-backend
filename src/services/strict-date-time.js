"use strict";

const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function utcWallClockMs(year, month, day, hour, minute, second, millisecond) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, millisecond);
  return value.getTime();
}

function parseStrictIsoDateTime(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value !== "string") return null;
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] || "").padEnd(3, "0").slice(0, 3) || 0);

  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const localWallClockMs = utcWallClockMs(year, month, day, hour, minute, second, millisecond);
  const local = new Date(localWallClockMs);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) return null;

  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offsetHours = Number(match[10]);
    const offsetRemainderMinutes = Number(match[11]);
    if (offsetHours > 14 || offsetRemainderMinutes > 59 || (offsetHours === 14 && offsetRemainderMinutes !== 0)) return null;
    offsetMinutes = offsetHours * 60 + offsetRemainderMinutes;
    if (match[9] === "-") offsetMinutes *= -1;
  }

  const instant = new Date(localWallClockMs - offsetMinutes * 60_000);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

module.exports = { ISO_DATE_TIME_PATTERN, parseStrictIsoDateTime };
