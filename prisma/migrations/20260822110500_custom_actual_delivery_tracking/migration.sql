-- V20.7: keep Telegram task delivery (deliveredAt) separate from actual fan delivery.
ALTER TABLE "CustomOrder"
  ADD COLUMN "fanDeliveredAt" TIMESTAMP(3),
  ADD COLUMN "deliverySentMediaIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "deliveryMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "deliveryOfferedCents" INTEGER NOT NULL DEFAULT 0;

-- Defensive normalization for future/manual imports.
UPDATE "CustomOrder"
SET "deliveryOfferedCents" = 0
WHERE "deliveryOfferedCents" < 0;
