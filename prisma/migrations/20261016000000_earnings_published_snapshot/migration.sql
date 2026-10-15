BEGIN;
SET LOCAL lock_timeout = '15s';
-- Additive snapshot: pending scanner rows never replace published money.
CREATE TABLE "CreatorEarningsPublishedDay" (
 "id" TEXT NOT NULL,
 "agencyId" TEXT NOT NULL,
 "creatorId" TEXT NOT NULL,
 "date" DATE NOT NULL,
 "sourceTimezone" TEXT NOT NULL DEFAULT 'UTC'::text,
 "subscriptionsCents" INTEGER,
 "messagesCents" INTEGER,
 "tipsCents" INTEGER,
 "postsCents" INTEGER,
 "streamsCents" INTEGER,
 "referralsCents" INTEGER,
 "totalCents" INTEGER NOT NULL,
 "currency" TEXT NOT NULL DEFAULT 'USD'::text,
 "sourceUpdatedAt" TIMESTAMP(3),
 "sourceScanRunId" TEXT,
 "sourceScanRequestedAt" TIMESTAMP(3),
 "scanProofId" TEXT NOT NULL,
 "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 "coverageStatus" TEXT NOT NULL CHECK ("coverageStatus" IN ('COMPLETE','PARTIAL')),
 "lastVerifiedAt" TIMESTAMP(3), "hourlyPoints" JSONB,
 CONSTRAINT "CreatorEarningsPublishedDay_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "CreatorEarningsPublishedDay_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId","creatorId") REFERENCES "CreatorAccount"("agencyId","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CreatorEarningsPublishedDay_scanProofId_fkey" FOREIGN KEY ("scanProofId") REFERENCES "AnalyticsScanProof"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT "CreatorEarningsPublishedDay_hourly_size_check" CHECK ("hourlyPoints" IS NULL OR (jsonb_typeof("hourlyPoints")='array' AND jsonb_array_length("hourlyPoints")<=24)),
 CONSTRAINT "CreatorEarningsPublishedDay_money_check" CHECK ("totalCents">=0 AND "sourceTimezone"='UTC')
);
CREATE UNIQUE INDEX "CreatorEarningsPublishedDay_creatorId_date_sourceTimezone_key" ON "CreatorEarningsPublishedDay"("creatorId","date","sourceTimezone");
CREATE INDEX "CreatorEarningsPublishedDay_agencyId_creatorId_date_idx" ON "CreatorEarningsPublishedDay"("agencyId","creatorId","date");
CREATE INDEX "CreatorEarningsPublishedDay_creatorId_date_idx" ON "CreatorEarningsPublishedDay"("creatorId","date");
CREATE INDEX "CreatorEarningsPublishedDay_creatorId_sourceScanRunId_idx" ON "CreatorEarningsPublishedDay"("creatorId","sourceScanRunId");
CREATE INDEX "CreatorEarningsPublishedDay_scanProofId_idx" ON "CreatorEarningsPublishedDay"("scanProofId");
-- Seed only rows backed by the current durable money proof. A partial/failed
-- scan is not a substitute for lost historical evidence and is recollected.
INSERT INTO "CreatorEarningsPublishedDay" ("id","agencyId","creatorId","date","sourceTimezone","subscriptionsCents","messagesCents","tipsCents","postsCents","streamsCents","referralsCents","totalCents","currency","sourceUpdatedAt","sourceScanRunId","sourceScanRequestedAt","scanProofId","collectedAt","createdAt","updatedAt","coverageStatus","lastVerifiedAt")
 SELECT d."id",d."agencyId",d."creatorId",d."date",d."sourceTimezone",d."subscriptionsCents",d."messagesCents",d."tipsCents",d."postsCents",d."streamsCents",d."referralsCents",d."totalCents",d."currency",d."sourceUpdatedAt",d."sourceScanRunId",d."sourceScanRequestedAt",d."scanProofId",d."collectedAt",d."createdAt",d."updatedAt",v."status"::text,LEAST(v."lastVerifiedAt",COALESCE(p."observationStartedAt",p."requestedAt"))
 FROM "CreatorEarningsDaily" d JOIN "AnalyticsCoverage" v ON v."creatorId"=d."creatorId" AND v."agencyId"=d."agencyId"
  AND v."coverageDate"=d."date" AND v."sourceTimezone"='UTC' AND v."dataType"='EARNINGS' AND v."scanProofId"=d."scanProofId"
 JOIN "AnalyticsScanProof" p ON p."id"=d."scanProofId" AND p."agencyId"=d."agencyId" AND p."creatorId"=d."creatorId"
  AND p."dataType"='EARNINGS' AND p."sourceTimezone"='UTC' AND p."status"='COMMITTED' AND p."proofVersion"=2
  AND p."committedAt" IS NOT NULL AND p."scanRunId"=d."sourceScanRunId" AND d."date" BETWEEN p."scanFrom" AND p."scanTo"
 WHERE d."sourceTimezone"='UTC' AND v."status" IN ('COMPLETE','PARTIAL');
COMMIT;
