ALTER TABLE "VaultUnsortedItem" ADD COLUMN "pendingScanToken" TEXT;
CREATE INDEX "VaultUnsortedItem_pendingScanToken_idx" ON "VaultUnsortedItem"("pendingScanToken");
