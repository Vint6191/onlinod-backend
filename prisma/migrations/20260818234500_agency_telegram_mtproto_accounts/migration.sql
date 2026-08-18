-- Store agency-owned Telegram MTProto credentials without exposing secrets to clients.
CREATE TABLE "AgencyTelegramMtprotoAccount" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "apiId" INTEGER NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AgencyTelegramMtprotoAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgencyTelegramMtprotoAccount_agencyId_idx" ON "AgencyTelegramMtprotoAccount"("agencyId");

ALTER TABLE "AgencyTelegramMtprotoAccount" ADD CONSTRAINT "AgencyTelegramMtprotoAccount_agencyId_fkey"
FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
