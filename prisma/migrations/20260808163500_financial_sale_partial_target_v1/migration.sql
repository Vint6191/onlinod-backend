-- Financial payout transactions can prove that a sale was a MESSAGE or POST
-- without exposing the target messageId/postId. Keep the typed sale while
-- preserving target consistency: the opposite target must stay NULL, and a
-- target-less MESSAGE/POST must be anchored by an external transaction id.
--
-- Do not edit the older audited notification migration: it may already be
-- applied in production. Replace the constraint in a forward-only migration.

ALTER TABLE "CreatorSale"
  DROP CONSTRAINT IF EXISTS "CreatorSale_target_consistency_check";

ALTER TABLE "CreatorSale"
  ADD CONSTRAINT "CreatorSale_target_consistency_check" CHECK (
    (
      "saleType" = 'MESSAGE'
      AND "postId" IS NULL
      AND ("messageId" IS NOT NULL OR "externalTransactionId" IS NOT NULL)
    ) OR
    (
      "saleType" = 'POST'
      AND "messageId" IS NULL
      AND ("postId" IS NOT NULL OR "externalTransactionId" IS NOT NULL)
    ) OR
    (
      "saleType" IN ('STREAM', 'OTHER')
      AND NOT ("messageId" IS NOT NULL AND "postId" IS NOT NULL)
    )
  );
