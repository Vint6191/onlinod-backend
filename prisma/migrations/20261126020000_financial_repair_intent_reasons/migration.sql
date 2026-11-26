BEGIN;

-- Existing intents retain their original vocabulary. The new recovery causes
-- belong only to the financial stream and do not widen other stream policies.
ALTER TABLE "CreatorRecoveryIntent" DROP CONSTRAINT "CreatorRecoveryIntent_reason_check";
ALTER TABLE "CreatorRecoveryIntent" ADD CONSTRAINT "CreatorRecoveryIntent_reason_check"
  CHECK (
    reason IN ('OFFLINE_GAP', 'CAPTURE_LOSS')
    OR (stream = 'financial' AND reason IN (
      'FINANCIAL_PROOF_ADOPTION', 'FINANCIAL_PROOF_ADOPTION_FULL', 'FINANCIAL_DELIVERY_GAP'
    ))
  );

COMMIT;
