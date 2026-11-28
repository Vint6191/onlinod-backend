BEGIN;

-- An old source version may replay an acknowledged immutable sequence after a
-- long offline period. Retain its semantic repair receipts; compact ordinary
-- completed recovery history through its own bounded index.
CREATE INDEX "CreatorRecoveryIntent_ordinary_completed_retention_idx"
  ON "CreatorRecoveryIntent" ("completedAt", id)
  WHERE status = 'COMPLETE'
    AND reason <> 'NOTIFICATION_NORMALIZER_UPGRADE'
    AND left(id, 13) <> 'notifupgrade_';

COMMIT;
