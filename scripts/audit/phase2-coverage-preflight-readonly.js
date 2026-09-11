"use strict";

/*
 * Actual53 Phase2 coverage-manifest migration preflight (M53-01).
 *
 * READ ONLY. It never seeds, mutates, activates, or repairs coverage.
 *
 * Required:
 *   ONLINOD_PHASE2_COVERAGE_PREFLIGHT=1
 *
 * Optional:
 *   ONLINOD_PHASE2_COVERAGE_PREFLIGHT_AGENCY_ID=<one agency>
 *   ONLINOD_PHASE2_COVERAGE_PREFLIGHT_SAMPLE_LIMIT=50
 */

const {
  COVERAGE_MANIFEST_VERSION,
  COVERAGE_SEED_LANE_KEY,
  COVERAGE_SEED_GENERATION,
  COVERAGE_MANIFEST,
  coverageManifestFingerprint,
} = require("../../src/services/phase2-coverage-manifest");

const LEGACY_SEED_IDENTITIES = Object.freeze([
  Object.freeze({ key: "phase2_coverage_seed_v2", generation: "phase2_coverage_seed_v2" }),
]);

function envFlag(name, env = process.env) {
  return String(env?.[name] || "").trim() === "1";
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function positiveInt(value, fallback, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function identityKey(agencyId, family, generation) {
  return `${agencyId}\u001f${family}\u001f${generation}`;
}

function coveragePreflightPasses({ currentSeedComplete = false, manifestSeeded = false, convergenceComplete = false } = {}) {
  return currentSeedComplete === true && manifestSeeded === true && convergenceComplete === true;
}

async function readLane(prisma, key) {
  if (!prisma?.maintenanceLaneState?.findUnique) return null;
  return prisma.maintenanceLaneState.findUnique({
    where: { key },
    select: {
      key: true,
      generation: true,
      activeGeneration: true,
      completedAt: true,
      ownerToken: true,
      leaseUntil: true,
      cursor: true,
      progress: true,
      lastOutcome: true,
      lastError: true,
      updatedAt: true,
    },
  });
}

async function inspectAgencies(prisma, requestedAgencyId, sampleLimit) {
  const missing = [];
  const incomplete = [];
  let scannedAgencies = 0;
  let manifestRowsObserved = 0;
  let missingCount = 0;
  let incompleteCount = 0;
  let afterId = null;

  for (;;) {
    const agencies = await prisma.agency.findMany({
      where: {
        deletedAt: null,
        ...(requestedAgencyId ? { id: requestedAgencyId } : {}),
        ...(!requestedAgencyId && afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: requestedAgencyId ? 1 : 100,
    });
    if (!agencies.length) break;

    const agencyIds = agencies.map((row) => String(row.id));
    const rows = await prisma.phase2WorkCoverage.findMany({
      where: {
        agencyId: { in: agencyIds },
        OR: COVERAGE_MANIFEST.map(([family, generation]) => ({ family, generation })),
      },
      select: {
        agencyId: true,
        family: true,
        generation: true,
        active: true,
        enumerationState: true,
        enumeratedThrough: true,
        projectedThrough: true,
        unresolvedCount: true,
        completedAt: true,
        updatedAt: true,
      },
    });
    manifestRowsObserved += rows.length;
    const observed = new Map(rows.map((row) => [identityKey(row.agencyId, row.family, row.generation), row]));

    for (const agencyId of agencyIds) {
      scannedAgencies += 1;
      for (const [family, generation] of COVERAGE_MANIFEST) {
        const key = identityKey(agencyId, family, generation);
        const row = observed.get(key);
        if (!row) {
          missingCount += 1;
          if (missing.length < sampleLimit) missing.push({ agencyId, family, generation });
          continue;
        }
        const complete = row.active === true
          && String(row.enumerationState || "") === "COMPLETE"
          && row.completedAt != null;
        if (!complete) {
          incompleteCount += 1;
          if (incomplete.length < sampleLimit) {
            incomplete.push({
              agencyId, family, generation,
              active: row.active === true,
              enumerationState: String(row.enumerationState || "UNKNOWN"),
              unresolvedCount: Number(row.unresolvedCount || 0),
              completedAt: row.completedAt || null,
            });
          }
        }
      }
    }

    if (requestedAgencyId || agencies.length < 100) break;
    afterId = agencyIds[agencyIds.length - 1];
  }

  return {
    scannedAgencies,
    expectedManifestRows: scannedAgencies * COVERAGE_MANIFEST.length,
    manifestRowsObserved,
    missingCount,
    incompleteCount,
    missingSample: missing,
    incompleteSample: incomplete,
    samplesTruncated: missing.length >= sampleLimit || incomplete.length >= sampleLimit,
  };
}

async function runCoveragePreflight({ prisma = null, env = process.env, stdout = process.stdout } = {}) {
  if (!envFlag("ONLINOD_PHASE2_COVERAGE_PREFLIGHT", env)) {
    throw new Error("ONLINOD_PHASE2_COVERAGE_PREFLIGHT=1_REQUIRED");
  }

  const ownsPrisma = !prisma;
  const db = prisma || require("../../src/prisma");
  const requestedAgencyId = clean(env?.ONLINOD_PHASE2_COVERAGE_PREFLIGHT_AGENCY_ID);
  const sampleLimit = positiveInt(env?.ONLINOD_PHASE2_COVERAGE_PREFLIGHT_SAMPLE_LIMIT, 50);

  try {
    if (requestedAgencyId) {
      const agency = await db.agency.findUnique({
        where: { id: requestedAgencyId },
        select: { id: true, deletedAt: true },
      });
      if (!agency || agency.deletedAt) throw new Error("ONLINOD_PHASE2_COVERAGE_PREFLIGHT_AGENCY_NOT_FOUND");
    }

    const currentLane = await readLane(db, COVERAGE_SEED_LANE_KEY);
    const legacyLanes = [];
    for (const identity of LEGACY_SEED_IDENTITIES) {
      legacyLanes.push({ ...identity, row: await readLane(db, identity.key) });
    }

    const coverage = await inspectAgencies(db, requestedAgencyId, sampleLimit);
    const legacyCompleted = legacyLanes.some(({ row }) => row?.completedAt != null);
    const expectedManifestFingerprint = coverageManifestFingerprint();
    const currentProgress = currentLane?.progress && typeof currentLane.progress === "object" && !Array.isArray(currentLane.progress)
      ? currentLane.progress
      : {};
    const currentManifestIdentityMatches = String(currentProgress.manifestVersion || "") === COVERAGE_MANIFEST_VERSION
      && String(currentProgress.manifestFingerprint || "") === expectedManifestFingerprint;
    const currentSeedComplete = currentLane?.completedAt != null
      && String(currentLane?.generation || "") === COVERAGE_SEED_GENERATION
      && String(currentLane?.activeGeneration || currentLane?.generation || "") === COVERAGE_SEED_GENERATION
      && currentManifestIdentityMatches;

    const missingCount = coverage.missingCount;
    const manifestSeeded = missingCount === 0
      && coverage.manifestRowsObserved === coverage.expectedManifestRows;
    const convergenceComplete = coverage.incompleteCount === 0 && manifestSeeded;

    const reasons = [];
    if (legacyCompleted && !currentSeedComplete) reasons.push("LEGACY_SEED_COMPLETE_REQUIRES_CURRENT_MANIFEST_RESEED");
    if (currentLane?.completedAt != null && !currentManifestIdentityMatches) reasons.push("CURRENT_SEED_MANIFEST_IDENTITY_MISMATCH");
    if (!currentSeedComplete) reasons.push("CURRENT_MANIFEST_SEED_NOT_COMPLETE");
    if (!manifestSeeded) reasons.push("CURRENT_MANIFEST_ROWS_MISSING");
    if (!convergenceComplete) reasons.push("CURRENT_MANIFEST_COVERAGE_NOT_CONVERGED");

    const report = {
      ok: coveragePreflightPasses({ currentSeedComplete, manifestSeeded, convergenceComplete }),
      mode: "READ_ONLY_MIGRATION_PREFLIGHT",
      manifest: {
        version: COVERAGE_MANIFEST_VERSION,
        fingerprint: expectedManifestFingerprint,
        seedLaneKey: COVERAGE_SEED_LANE_KEY,
        seedGeneration: COVERAGE_SEED_GENERATION,
        families: COVERAGE_MANIFEST.map(([family, generation]) => ({ family, generation })),
      },
      requestedAgencyId,
      currentSeedLane: currentLane,
      currentManifestIdentityMatches,
      legacySeedLanes: legacyLanes,
      legacyCompleted,
      coverage: {
        ...coverage,
        missingCount,
        manifestSeeded,
        convergenceComplete,
      },
      reasons,
      generatedAt: new Date().toISOString(),
    };

    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 2;
    return report;
  } finally {
    if (ownsPrisma && typeof db.$disconnect === "function") await db.$disconnect();
  }
}

async function main() {
  return runCoveragePreflight();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[phase2-coverage-preflight-readonly]", error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { coveragePreflightPasses, runCoveragePreflight };
