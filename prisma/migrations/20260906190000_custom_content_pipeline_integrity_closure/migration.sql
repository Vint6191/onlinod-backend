BEGIN;

-- Custom Content Pipeline integrity closure.
-- Runtime treats unknown execution disposition fail-closed; enforce the same
-- authority at the database boundary so a typo/manual write/future incompatible
-- value can never be interpreted as ACTIVE work by a rolling process.
ALTER TABLE "CustomContentSubmission"
  ADD CONSTRAINT "CustomContentSubmission_pipelineDisposition_check"
  CHECK ("pipelineDisposition" IN ('ACTIVE', 'SALVAGE', 'ARCHIVED', 'ABANDONED'));

-- A cancellation waiver is one control-plane fact. Half-written waiver metadata
-- would make debt scanners and repair projectors disagree about whether a real
-- Telegram cancellation is still owed.
ALTER TABLE "CustomOrder"
  ADD CONSTRAINT "CustomOrder_telegramCancellationWaiver_pair_check"
  CHECK (
    ("telegramCancellationWaivedAt" IS NULL AND "telegramCancellationWaiverReason" IS NULL)
    OR
    ("telegramCancellationWaivedAt" IS NOT NULL AND NULLIF(BTRIM("telegramCancellationWaiverReason"), '') IS NOT NULL)
  );

-- Telegram work/projection states are durable scheduling authority. Unknown text
-- must fail migration/write at the database boundary instead of silently falling
-- out of every discovery query and becoming invisible durable work.
ALTER TABLE "TelegramDeliveryIntent"
  ADD CONSTRAINT "TelegramDeliveryIntent_kind_check"
  CHECK ("kind" IN ('TASK', 'REFERENCE', 'MANUAL_REMINDER', 'AUTO_REMINDER', 'CANCELLATION')),
  ADD CONSTRAINT "TelegramDeliveryIntent_state_check"
  CHECK ("state" IN ('PLANNED', 'CLAIMED', 'COMMITTING', 'CONFIRMED', 'RECONCILE_REQUIRED', 'CANCELLED', 'FAILED_PRECOMMIT'));

ALTER TABLE "TelegramInboundEvent"
  ADD CONSTRAINT "TelegramInboundEvent_projectionState_check"
  CHECK ("projectionState" IN ('PENDING', 'APPLIED', 'SKIPPED', 'REVIEW_REQUIRED', 'FAILED_RETRYABLE'));

-- TASK and CANCELLATION are singleton logical effects per CustomOrder. The
-- application logicalKey already encodes identity=one, but correctness must not
-- depend on a string convention: historical/manual corruption must block the
-- migration instead of allowing an arbitrary confirmed TASK to win a backfill.
CREATE UNIQUE INDEX "TelegramDeliveryIntent_one_task_per_order_key"
  ON "TelegramDeliveryIntent"("customOrderId")
  WHERE "kind" = 'TASK';

CREATE UNIQUE INDEX "TelegramDeliveryIntent_one_cancellation_per_order_key"
  ON "TelegramDeliveryIntent"("customOrderId")
  WHERE "kind" = 'CANCELLATION';

COMMIT;
