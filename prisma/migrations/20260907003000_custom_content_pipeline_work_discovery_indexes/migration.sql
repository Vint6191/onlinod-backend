-- Custom Content Pipeline work-discovery performance closure.
-- The runtime now cursor-scans correctness candidates in durable fairness order
-- before applying executable LIMIT. Keep that production-safe at large backlog
-- without changing any business/execution authority semantics.
CREATE INDEX "CCS_pipeline_fairness_idx"
  ON "CustomContentSubmission"(
    "agencyId",
    "pipelineDisposition",
    "pipelineLastAttemptAt" ASC NULLS FIRST,
    "receivedAt",
    "createdAt",
    "id"
  );

CREATE INDEX "CCS_source_pipeline_fairness_idx"
  ON "CustomContentSubmission"(
    "agencyId",
    "telegramSourceAccountId",
    "pipelineDisposition",
    "pipelineLastAttemptAt" ASC NULLS FIRST,
    "receivedAt",
    "createdAt",
    "id"
  );
