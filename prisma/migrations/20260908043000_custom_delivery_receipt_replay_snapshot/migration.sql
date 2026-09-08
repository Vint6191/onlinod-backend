ALTER TABLE "CustomDeliveryReceipt"
  ADD COLUMN "deliveredMediaIdsAfter" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
