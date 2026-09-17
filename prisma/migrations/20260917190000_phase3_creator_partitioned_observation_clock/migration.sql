-- Phase 3 / INT5.6A-1
-- Creator-partitioned durable observation chronology.
--
-- This is deliberately additive for rolling-deploy safety: the previous
-- FanObservationClock singleton remains available to an old binary during the
-- deployment overlap, while current code writes only the per-creator table.
-- A later cleanup migration may remove the legacy singleton after the cutover
-- has been observed in a full deployed actual.

CREATE TABLE IF NOT EXISTS "FanObservationCreatorClock" (
  "creatorId" TEXT PRIMARY KEY,
  "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
