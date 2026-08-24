-- V20.19: bind each proxy endpoint permanently to its creator encryption domain.
ALTER TABLE "AgencyProxyEndpoint"
  ADD COLUMN "ownerCreatorId" TEXT;

-- Existing V20.18 endpoints inherit ownership from the creator that currently uses them.
UPDATE "AgencyProxyEndpoint" AS proxy
SET "ownerCreatorId" = profile."creatorId"
FROM "CreatorNetworkProfile" AS profile
WHERE profile."agencyId" = proxy."agencyId"
  AND profile."proxyEndpointId" = proxy."id"
  AND profile."mode" = 'PROXY';

CREATE UNIQUE INDEX "AgencyProxyEndpoint_agencyId_ownerCreatorId_key"
  ON "AgencyProxyEndpoint"("agencyId", "ownerCreatorId");

ALTER TABLE "AgencyProxyEndpoint"
ADD CONSTRAINT "AgencyProxyEndpoint_agencyId_ownerCreatorId_fkey"
FOREIGN KEY ("agencyId", "ownerCreatorId") REFERENCES "CreatorAccount"("agencyId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
