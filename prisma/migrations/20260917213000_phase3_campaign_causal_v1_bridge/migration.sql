-- Phase 3 rolling bridge. This migration intentionally does NOT activate the
-- protocol. It creates a durable row that both tokenless Campaign ingests and
-- the later operator activation transaction can lock, so the activation commit
-- is a real causal barrier rather than a process-local feature flag.
INSERT INTO "SystemSetting" ("id", "key", "value", "createdAt", "updatedAt")
VALUES (
  'phase3-campaign-causal-v1',
  'phase3.campaignCausalObservationV1',
  '{"active":false,"epoch":0}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
