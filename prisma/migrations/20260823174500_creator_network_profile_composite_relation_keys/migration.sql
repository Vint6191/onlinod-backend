-- V20.18.1: align Prisma one-to-one relation keys with the actual tenant-scoped
-- foreign keys used by CreatorNetworkProfile. Keep migration history immutable:
-- the original V20.18 migration may already exist in a database.

CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_creatorId_key"
ON "CreatorNetworkProfile"("agencyId", "creatorId");

CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_proxyEndpointId_key"
ON "CreatorNetworkProfile"("agencyId", "proxyEndpointId");

-- The composite indexes above are now the canonical one-to-one constraints.
-- Drop the redundant global unique indexes created by the original V20.18
-- migration. PostgreSQL unique indexes allow multiple NULL values, so DIRECT
-- profiles (proxyEndpointId = NULL) continue to coexist normally.
DROP INDEX "CreatorNetworkProfile_creatorId_key";
DROP INDEX "CreatorNetworkProfile_proxyEndpointId_key";
