-- Customs payment foundation.
-- Existing orders remain equivalent to the old contract: paid = 0.
-- The multi-step form is intentionally repair-safe if a previous manual attempt
-- created the column without the final default/not-null constraints.
ALTER TABLE "CustomOrder"
  ADD COLUMN IF NOT EXISTS "paidAmountCents" INTEGER;

ALTER TABLE "CustomOrder"
  ALTER COLUMN "paidAmountCents" SET DEFAULT 0;

UPDATE "CustomOrder"
SET "paidAmountCents" = 0
WHERE "paidAmountCents" IS NULL OR "paidAmountCents" < 0;

ALTER TABLE "CustomOrder"
  ALTER COLUMN "paidAmountCents" SET NOT NULL;
