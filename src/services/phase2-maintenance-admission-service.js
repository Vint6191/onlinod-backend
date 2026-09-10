"use strict";

function bounded(value, fallback, max) {
  const n = Math.floor(Number(value) || fallback);
  return Math.max(1, Math.min(max, n));
}

function selectPhase2MaintenanceLanes({ laneNames, now = new Date(), intervalMs = 5_000, lanesPerTick = 5 } = {}) {
  const names = Array.from(new Set((Array.isArray(laneNames) ? laneNames : []).map((v) => String(v || "").trim()).filter(Boolean)));
  if (!names.length) return { generation: "phase2_fair_admission_v1", round: 0, startIndex: 0, lanesPerTick: 0, totalLanes: 0, selected: [] };
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error("PHASE2_MAINTENANCE_ADMISSION_TIME_REQUIRED");
  const interval = bounded(intervalMs, 5_000, 60 * 60 * 1000);
  const quantum = bounded(lanesPerTick, Math.min(5, names.length), names.length);
  const round = Math.floor(at.getTime() / interval);
  // Advance by the admitted quantum, not by one slot.  Under sustained load a
  // ten-lane/five-slot pump therefore admits every lane within two ticks rather
  // than making adjacent five-lane windows overlap for nine ticks.
  const startIndex = ((((round * quantum) % names.length) + names.length) % names.length);
  const selected = [];
  for (let offset = 0; offset < quantum; offset += 1) selected.push(names[(startIndex + offset) % names.length]);
  return { generation: "phase2_fair_admission_v1", round, startIndex, lanesPerTick: quantum, totalLanes: names.length, selected };
}

module.exports = { selectPhase2MaintenanceLanes };
