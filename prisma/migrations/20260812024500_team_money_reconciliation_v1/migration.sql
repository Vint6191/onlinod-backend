-- Team Analytics v13: bind PPV attribution to the canonical Creator Analytics
-- sale/financial ledgers without rewriting historical Alpha rows.
ALTER TABLE "TeamPpvPurchaseLedger"
  ADD COLUMN "creatorSaleId" TEXT,
  ADD COLUMN "financialTransactionId" TEXT,
  ADD COLUMN "financialStatus" TEXT,
  ADD COLUMN "attributionBasis" TEXT;

CREATE UNIQUE INDEX "TeamPpvPurchaseLedger_creatorSaleId_key"
  ON "TeamPpvPurchaseLedger"("creatorSaleId");
CREATE UNIQUE INDEX "TeamPpvPurchaseLedger_financialTransactionId_key"
  ON "TeamPpvPurchaseLedger"("financialTransactionId");
CREATE INDEX "TeamPpvPurchaseLedger_agencyId_creatorSaleId_idx"
  ON "TeamPpvPurchaseLedger"("agencyId", "creatorSaleId");
CREATE INDEX "TeamPpvPurchaseLedger_agencyId_financialTransactionId_idx"
  ON "TeamPpvPurchaseLedger"("agencyId", "financialTransactionId");
CREATE INDEX "TeamPpvPurchaseLedger_agencyId_financialStatus_purchasedAt_idx"
  ON "TeamPpvPurchaseLedger"("agencyId", "financialStatus", "purchasedAt");

ALTER TABLE "TeamPpvPurchaseLedger"
  ADD CONSTRAINT "TeamPpvPurchaseLedger_creatorSaleId_fkey"
  FOREIGN KEY ("creatorSaleId") REFERENCES "CreatorSale"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TeamPpvPurchaseLedger"
  ADD CONSTRAINT "TeamPpvPurchaseLedger_financialTransactionId_fkey"
  FOREIGN KEY ("financialTransactionId") REFERENCES "CreatorFinancialTransaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Canonical tip attribution uses the same Creator Analytics fact ledger.
ALTER TABLE "TeamTipLedger"
  ADD COLUMN "creatorTipId" TEXT,
  ADD COLUMN "financialStatus" TEXT,
  ADD COLUMN "attributionBasis" TEXT;

CREATE UNIQUE INDEX "TeamTipLedger_creatorTipId_key"
  ON "TeamTipLedger"("creatorTipId");
CREATE INDEX "TeamTipLedger_agencyId_creatorTipId_idx"
  ON "TeamTipLedger"("agencyId", "creatorTipId");
CREATE INDEX "TeamTipLedger_agencyId_financialStatus_receivedAt_idx"
  ON "TeamTipLedger"("agencyId", "financialStatus", "receivedAt");

ALTER TABLE "TeamTipLedger"
  ADD CONSTRAINT "TeamTipLedger_creatorTipId_fkey"
  FOREIGN KEY ("creatorTipId") REFERENCES "CreatorTip"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
