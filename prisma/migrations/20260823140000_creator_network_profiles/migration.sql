CREATE TYPE "AgencyProxyType" AS ENUM ('HTTP', 'HTTPS', 'SOCKS4', 'SOCKS4A', 'SOCKS5');
CREATE TYPE "CreatorNetworkMode" AS ENUM ('DIRECT', 'PROXY');

CREATE TABLE "AgencyProxyEndpoint" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" "AgencyProxyType" NOT NULL,
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "encryptedPayload" TEXT,
  "iv" TEXT,
  "tag" TEXT,
  "algorithm" TEXT,
  "payloadVersion" INTEGER NOT NULL DEFAULT 1,
  "hasCredentials" BOOLEAN NOT NULL DEFAULT false,
  "usernameHint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgencyProxyEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorNetworkProfile" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "mode" "CreatorNetworkMode" NOT NULL DEFAULT 'DIRECT',
  "proxyEndpointId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorNetworkProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorNetworkProfile_creatorId_key" ON "CreatorNetworkProfile"("creatorId");
CREATE UNIQUE INDEX "AgencyProxyEndpoint_agencyId_id_key" ON "AgencyProxyEndpoint"("agencyId", "id");
CREATE INDEX "AgencyProxyEndpoint_agencyId_updatedAt_idx" ON "AgencyProxyEndpoint"("agencyId", "updatedAt");
CREATE INDEX "AgencyProxyEndpoint_agencyId_enabled_idx" ON "AgencyProxyEndpoint"("agencyId", "enabled");
CREATE INDEX "CreatorNetworkProfile_agencyId_idx" ON "CreatorNetworkProfile"("agencyId");
CREATE INDEX "CreatorNetworkProfile_agencyId_mode_idx" ON "CreatorNetworkProfile"("agencyId", "mode");
CREATE UNIQUE INDEX "CreatorNetworkProfile_proxyEndpointId_key" ON "CreatorNetworkProfile"("proxyEndpointId");

ALTER TABLE "AgencyProxyEndpoint"
ADD CONSTRAINT "AgencyProxyEndpoint_agencyId_fkey"
FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorNetworkProfile"
ADD CONSTRAINT "CreatorNetworkProfile_agencyId_fkey"
FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorNetworkProfile"
ADD CONSTRAINT "CreatorNetworkProfile_agencyId_creatorId_fkey"
FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorNetworkProfile"
ADD CONSTRAINT "CreatorNetworkProfile_proxyEndpointId_fkey"
FOREIGN KEY ("agencyId", "proxyEndpointId") REFERENCES "AgencyProxyEndpoint"("agencyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
