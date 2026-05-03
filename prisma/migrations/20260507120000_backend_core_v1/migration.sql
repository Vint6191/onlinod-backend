-- Backend Core v1: telemetry/events, home/team analytics foundation, module skeletons.

CREATE TABLE IF NOT EXISTS "DeviceCreatorBinding" (
  "id" TEXT PRIMARY KEY,
  "deviceId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "remoteId" TEXT,
  "username" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceCreatorBinding_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DeviceCreatorBinding_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DeviceCreatorBinding_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeviceCreatorBinding_deviceId_creatorId_key" ON "DeviceCreatorBinding"("deviceId", "creatorId");
CREATE INDEX IF NOT EXISTS "DeviceCreatorBinding_agencyId_idx" ON "DeviceCreatorBinding"("agencyId");
CREATE INDEX IF NOT EXISTS "DeviceCreatorBinding_creatorId_idx" ON "DeviceCreatorBinding"("creatorId");
CREATE INDEX IF NOT EXISTS "DeviceCreatorBinding_lastSeenAt_idx" ON "DeviceCreatorBinding"("lastSeenAt");

CREATE TABLE IF NOT EXISTS "TeamActivityEvent" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "deviceId" TEXT,
  "userId" TEXT,
  "memberId" TEXT,
  "accountId" TEXT,
  "creatorId" TEXT,
  "creatorRef" TEXT,
  "fanId" TEXT,
  "type" TEXT NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL,
  "localId" TEXT,
  "extra" JSONB,
  "source" TEXT NOT NULL DEFAULT 'electron',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamActivityEvent_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "TeamActivityEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "TeamActivityEvent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_deviceId_localId_key" ON "TeamActivityEvent"("agencyId", "deviceId", "localId");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_ts_idx" ON "TeamActivityEvent"("agencyId", "ts");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_memberId_ts_idx" ON "TeamActivityEvent"("agencyId", "memberId", "ts");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_creatorId_ts_idx" ON "TeamActivityEvent"("agencyId", "creatorId", "ts");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_accountId_ts_idx" ON "TeamActivityEvent"("agencyId", "accountId", "ts");
CREATE INDEX IF NOT EXISTS "TeamActivityEvent_agencyId_type_ts_idx" ON "TeamActivityEvent"("agencyId", "type", "ts");

CREATE TABLE IF NOT EXISTS "AnalyticsSnapshot" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "rangeKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AnalyticsSnapshot_agencyId_scope_rangeKey_key" ON "AnalyticsSnapshot"("agencyId", "scope", "rangeKey");
CREATE INDEX IF NOT EXISTS "AnalyticsSnapshot_agencyId_scope_idx" ON "AnalyticsSnapshot"("agencyId", "scope");
CREATE INDEX IF NOT EXISTS "AnalyticsSnapshot_capturedAt_idx" ON "AnalyticsSnapshot"("capturedAt");

CREATE TABLE IF NOT EXISTS "WorkspaceSetting" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceSetting_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceSetting_agencyId_key_key" ON "WorkspaceSetting"("agencyId", "key");
CREATE INDEX IF NOT EXISTS "WorkspaceSetting_agencyId_idx" ON "WorkspaceSetting"("agencyId");

CREATE TABLE IF NOT EXISTS "ModuleSetting" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "moduleKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'partial',
  "config" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModuleSetting_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ModuleSetting_agencyId_moduleKey_key" ON "ModuleSetting"("agencyId", "moduleKey");
CREATE INDEX IF NOT EXISTS "ModuleSetting_agencyId_idx" ON "ModuleSetting"("agencyId");
CREATE INDEX IF NOT EXISTS "ModuleSetting_moduleKey_idx" ON "ModuleSetting"("moduleKey");

CREATE TABLE IF NOT EXISTS "MessageTemplateGroup" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageTemplateGroup_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "MessageTemplateGroup_agencyId_idx" ON "MessageTemplateGroup"("agencyId");

CREATE TABLE IF NOT EXISTS "MessageTemplate" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "groupId" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "priceCents" INTEGER,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "creatorScope" JSONB,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "MessageTemplate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MessageTemplate_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MessageTemplateGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "MessageTemplate_agencyId_idx" ON "MessageTemplate"("agencyId");
CREATE INDEX IF NOT EXISTS "MessageTemplate_groupId_idx" ON "MessageTemplate"("groupId");
CREATE INDEX IF NOT EXISTS "MessageTemplate_status_idx" ON "MessageTemplate"("status");
CREATE INDEX IF NOT EXISTS "MessageTemplate_deletedAt_idx" ON "MessageTemplate"("deletedAt");

CREATE TABLE IF NOT EXISTS "MessageTemplateUsageEvent" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "userId" TEXT,
  "memberId" TEXT,
  "creatorId" TEXT,
  "fanId" TEXT,
  "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "MessageTemplateUsageEvent_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MessageTemplateUsageEvent_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MessageTemplateUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "MessageTemplateUsageEvent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "MessageTemplateUsageEvent_agencyId_usedAt_idx" ON "MessageTemplateUsageEvent"("agencyId", "usedAt");
CREATE INDEX IF NOT EXISTS "MessageTemplateUsageEvent_templateId_idx" ON "MessageTemplateUsageEvent"("templateId");
CREATE INDEX IF NOT EXISTS "MessageTemplateUsageEvent_memberId_idx" ON "MessageTemplateUsageEvent"("memberId");

CREATE TABLE IF NOT EXISTS "AutomationRule" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "trigger" JSONB NOT NULL DEFAULT '{}',
  "action" JSONB NOT NULL DEFAULT '{}',
  "creatorScope" JSONB,
  "safety" JSONB,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "AutomationRule_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AutomationRule_agencyId_idx" ON "AutomationRule"("agencyId");
CREATE INDEX IF NOT EXISTS "AutomationRule_enabled_idx" ON "AutomationRule"("enabled");
CREATE INDEX IF NOT EXISTS "AutomationRule_deletedAt_idx" ON "AutomationRule"("deletedAt");

CREATE TABLE IF NOT EXISTS "AutomationRun" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "ruleId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "result" JSONB,
  "error" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationRun_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AutomationRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AutomationRun_agencyId_status_idx" ON "AutomationRun"("agencyId", "status");
CREATE INDEX IF NOT EXISTS "AutomationRun_ruleId_idx" ON "AutomationRun"("ruleId");
CREATE INDEX IF NOT EXISTS "AutomationRun_createdAt_idx" ON "AutomationRun"("createdAt");

CREATE TABLE IF NOT EXISTS "AutomationLog" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "runId" TEXT,
  "level" TEXT NOT NULL DEFAULT 'info',
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomationLog_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AutomationLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AutomationLog_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AutomationLog_agencyId_createdAt_idx" ON "AutomationLog"("agencyId", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomationLog_runId_idx" ON "AutomationLog"("runId");

CREATE TABLE IF NOT EXISTS "VaultUnsortedSnapshot" (
  "id" TEXT PRIMARY KEY,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "itemsCount" INTEGER NOT NULL DEFAULT 0,
  "unsortedCount" INTEGER NOT NULL DEFAULT 0,
  "sortedCount" INTEGER NOT NULL DEFAULT 0,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VaultUnsortedSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VaultUnsortedSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "VaultUnsortedSnapshot_agencyId_creatorId_key" ON "VaultUnsortedSnapshot"("agencyId", "creatorId");
CREATE INDEX IF NOT EXISTS "VaultUnsortedSnapshot_agencyId_idx" ON "VaultUnsortedSnapshot"("agencyId");
CREATE INDEX IF NOT EXISTS "VaultUnsortedSnapshot_creatorId_idx" ON "VaultUnsortedSnapshot"("creatorId");
CREATE INDEX IF NOT EXISTS "VaultUnsortedSnapshot_capturedAt_idx" ON "VaultUnsortedSnapshot"("capturedAt");
