BEGIN;

-- Quarantined legacy notification deliveries create a bounded FULL reproof.
-- Keep the existing financial causes and restrict the new cause to its stream.
ALTER TABLE "CreatorRecoveryIntent" DROP CONSTRAINT "CreatorRecoveryIntent_reason_check";
ALTER TABLE "CreatorRecoveryIntent" ADD CONSTRAINT "CreatorRecoveryIntent_reason_check"
  CHECK (
    reason IN ('OFFLINE_GAP', 'CAPTURE_LOSS')
    OR (stream = 'financial' AND reason IN (
      'FINANCIAL_PROOF_ADOPTION', 'FINANCIAL_PROOF_ADOPTION_FULL', 'FINANCIAL_DELIVERY_GAP'
    ))
    OR (stream = 'notifications' AND reason = 'NOTIFICATION_NORMALIZER_UPGRADE')
  );

COMMIT;
