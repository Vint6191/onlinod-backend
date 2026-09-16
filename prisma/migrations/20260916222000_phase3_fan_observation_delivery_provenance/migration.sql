-- Phase 3 INT5.3A: action-scoped USER_PROFILE provenance must reference
-- AutomationDelivery, not overload sourceJobId (which is FK -> JobInstance).
ALTER TABLE "CreatorFanRelationshipCurrent" ADD COLUMN "sourceDeliveryId" TEXT;
ALTER TABLE "CreatorFanValueCurrent" ADD COLUMN "sourceDeliveryId" TEXT;

ALTER TABLE "CreatorFanRelationshipCurrent"
  ADD CONSTRAINT "CreatorFanRelationshipCurrent_sourceDeliveryId_fkey"
  FOREIGN KEY ("sourceDeliveryId") REFERENCES "AutomationDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorFanValueCurrent"
  ADD CONSTRAINT "CreatorFanValueCurrent_sourceDeliveryId_fkey"
  FOREIGN KEY ("sourceDeliveryId") REFERENCES "AutomationDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CreatorFanRelationshipCurrent_sourceDeliveryId_idx" ON "CreatorFanRelationshipCurrent"("sourceDeliveryId");
CREATE INDEX "CreatorFanValueCurrent_sourceDeliveryId_idx" ON "CreatorFanValueCurrent"("sourceDeliveryId");
