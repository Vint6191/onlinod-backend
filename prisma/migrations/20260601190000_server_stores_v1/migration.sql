-- Server Stores V1
-- Server source-of-truth tables for content, CRM, fan lists, campaign drafts,
-- automation state, hidden/follow-back pools, and vault sales metadata.
-- No local import/migration is included by design.

CREATE TABLE "ContentCollection" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'message_library',
  "title" TEXT NOT NULL,
  "description" TEXT,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'active',
  "clientId" TEXT,
  "createdByUserId" TEXT,
  "updatedByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentCollection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContentBlock" (
  "id" TEXT NOT NULL,
  "collectionId" TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  "role" TEXT NOT NULL DEFAULT 'message',
  "title" TEXT,
  "text" TEXT NOT NULL DEFAULT '',
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "lockedText" BOOLEAN NOT NULL DEFAULT false,
  "media" JSONB NOT NULL DEFAULT '[]',
  "note" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "clientId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentBlock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContentUsageEvent" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "collectionId" TEXT,
  "blockId" TEXT,
  "creatorId" TEXT,
  "fanId" TEXT,
  "dialogId" TEXT,
  "eventType" TEXT NOT NULL DEFAULT 'used',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrmProfile" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT NOT NULL DEFAULT '',
  "username" TEXT,
  "name" TEXT,
  "preferredName" TEXT,
  "age" TEXT,
  "location" TEXT,
  "country" TEXT,
  "city" TEXT,
  "timezone" TEXT,
  "nativeLanguage" TEXT,
  "chatLanguage" TEXT,
  "profession" TEXT,
  "spenderTier" TEXT,
  "stage" TEXT,
  "fanRole" TEXT,
  "controlPreference" TEXT,
  "creatorRole" TEXT,
  "tone" TEXT,
  "dynamicSummary" TEXT,
  "aiSummary" TEXT,
  "info" JSONB NOT NULL DEFAULT '{}',
  "ppvStats" JSONB NOT NULL DEFAULT '{}',
  "messageStats" JSONB NOT NULL DEFAULT '{}',
  "source" TEXT NOT NULL DEFAULT 'electron',
  "analyzedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrmProfileTag" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "tagKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'fetish',
  "category" TEXT,
  "facets" JSONB NOT NULL DEFAULT '[]',
  "intensity" TEXT,
  "nicheLevel" TEXT,
  "broadcastPolicy" TEXT,
  "confidence" DOUBLE PRECISION,
  "source" TEXT NOT NULL DEFAULT 'ai',
  "negative" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CrmProfileTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrmProfileRawTag" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "rawLabel" TEXT NOT NULL,
  "mappedKey" TEXT,
  "kind" TEXT,
  "status" TEXT NOT NULL DEFAULT 'needs_review',
  "confidence" DOUBLE PRECISION,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmProfileRawTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrmNote" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'auto',
  "text" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "CrmNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrmAnalysisRun" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "profileId" TEXT,
  "dialogId" TEXT,
  "fanId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'done',
  "model" TEXT,
  "promptVersion" TEXT,
  "analysis" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmAnalysisRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FanList" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT NOT NULL DEFAULT 'manual',
  "filters" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FanList_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FanListMember" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "listId" TEXT NOT NULL,
  "creatorId" TEXT,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT,
  "username" TEXT,
  "name" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "matchedReasons" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FanListMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavedSegment" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "safety" JSONB NOT NULL DEFAULT '{}',
  "preview" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedSegment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CampaignDraft" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "segmentId" TEXT,
  "contentCollectionId" TEXT,
  "title" TEXT,
  "text" TEXT NOT NULL DEFAULT '',
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "lockedText" BOOLEAN NOT NULL DEFAULT false,
  "media" JSONB NOT NULL DEFAULT '[]',
  "previews" JSONB NOT NULL DEFAULT '[]',
  "filters" JSONB NOT NULL DEFAULT '{}',
  "manualUserIds" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdByUserId" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CampaignQueueStatus" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "draftId" TEXT,
  "ofQueueId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "audienceCount" INTEGER NOT NULL DEFAULT 0,
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "mediaCount" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "lastOfResponse" JSONB NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignQueueStatus_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationDelivery" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "ruleId" TEXT,
  "contentCollectionId" TEXT,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT,
  "trigger" TEXT,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "scheduledAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "messageId" TEXT,
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "media" JSONB NOT NULL DEFAULT '[]',
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HiddenOnlineUser" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT,
  "username" TEXT,
  "name" TEXT,
  "totalSpentCents" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "signals" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "lastSignalAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HiddenOnlineUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FollowBackTask" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT NOT NULL,
  "dialogId" TEXT,
  "username" TEXT,
  "name" TEXT,
  "action" TEXT NOT NULL DEFAULT 'follow_back',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastResultAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowBackTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VaultPurchaseMessage" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "fanId" TEXT,
  "dialogId" TEXT,
  "messageId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "purchasedAt" TIMESTAMP(3),
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "resolvedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VaultPurchaseMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VaultMediaSale" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "fanId" TEXT,
  "dialogId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'sold',
  "allocatedAmountCents" INTEGER NOT NULL DEFAULT 0,
  "packagePriceCents" INTEGER NOT NULL DEFAULT 0,
  "packSize" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT,
  "purchasedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VaultMediaSale_pkey" PRIMARY KEY ("id")
);

-- Unique constraints and indexes
CREATE UNIQUE INDEX "ContentCollection_agencyId_clientId_key" ON "ContentCollection"("agencyId", "clientId");
CREATE INDEX "ContentCollection_agencyId_kind_status_idx" ON "ContentCollection"("agencyId", "kind", "status");
CREATE INDEX "ContentCollection_creatorId_kind_status_idx" ON "ContentCollection"("creatorId", "kind", "status");
CREATE INDEX "ContentCollection_updatedAt_idx" ON "ContentCollection"("updatedAt");
CREATE INDEX "ContentCollection_deletedAt_idx" ON "ContentCollection"("deletedAt");
CREATE UNIQUE INDEX "ContentBlock_collectionId_clientId_key" ON "ContentBlock"("collectionId", "clientId");
CREATE INDEX "ContentBlock_collectionId_order_idx" ON "ContentBlock"("collectionId", "order");
CREATE INDEX "ContentUsageEvent_agencyId_createdAt_idx" ON "ContentUsageEvent"("agencyId", "createdAt");
CREATE INDEX "ContentUsageEvent_collectionId_idx" ON "ContentUsageEvent"("collectionId");
CREATE INDEX "ContentUsageEvent_creatorId_fanId_idx" ON "ContentUsageEvent"("creatorId", "fanId");

CREATE UNIQUE INDEX "CrmProfile_creatorId_fanId_key" ON "CrmProfile"("creatorId", "fanId");
CREATE INDEX "CrmProfile_agencyId_idx" ON "CrmProfile"("agencyId");
CREATE INDEX "CrmProfile_creatorId_idx" ON "CrmProfile"("creatorId");
CREATE INDEX "CrmProfile_creatorId_dialogId_idx" ON "CrmProfile"("creatorId", "dialogId");
CREATE INDEX "CrmProfile_country_idx" ON "CrmProfile"("country");
CREATE INDEX "CrmProfile_city_idx" ON "CrmProfile"("city");
CREATE INDEX "CrmProfile_nativeLanguage_idx" ON "CrmProfile"("nativeLanguage");
CREATE INDEX "CrmProfile_chatLanguage_idx" ON "CrmProfile"("chatLanguage");
CREATE INDEX "CrmProfile_fanRole_idx" ON "CrmProfile"("fanRole");
CREATE INDEX "CrmProfile_updatedAt_idx" ON "CrmProfile"("updatedAt");
CREATE UNIQUE INDEX "CrmProfileTag_profileId_tagKey_kind_source_key" ON "CrmProfileTag"("profileId", "tagKey", "kind", "source");
CREATE INDEX "CrmProfileTag_agencyId_tagKey_idx" ON "CrmProfileTag"("agencyId", "tagKey");
CREATE INDEX "CrmProfileTag_agencyId_category_idx" ON "CrmProfileTag"("agencyId", "category");
CREATE INDEX "CrmProfileTag_agencyId_kind_idx" ON "CrmProfileTag"("agencyId", "kind");
CREATE INDEX "CrmProfileTag_broadcastPolicy_idx" ON "CrmProfileTag"("broadcastPolicy");
CREATE INDEX "CrmProfileTag_nicheLevel_idx" ON "CrmProfileTag"("nicheLevel");
CREATE INDEX "CrmProfileRawTag_agencyId_status_idx" ON "CrmProfileRawTag"("agencyId", "status");
CREATE INDEX "CrmProfileRawTag_profileId_idx" ON "CrmProfileRawTag"("profileId");
CREATE INDEX "CrmProfileRawTag_mappedKey_idx" ON "CrmProfileRawTag"("mappedKey");
CREATE INDEX "CrmNote_agencyId_creatorId_idx" ON "CrmNote"("agencyId", "creatorId");
CREATE INDEX "CrmNote_profileId_kind_idx" ON "CrmNote"("profileId", "kind");
CREATE INDEX "CrmNote_deletedAt_idx" ON "CrmNote"("deletedAt");
CREATE INDEX "CrmAnalysisRun_agencyId_creatorId_createdAt_idx" ON "CrmAnalysisRun"("agencyId", "creatorId", "createdAt");
CREATE INDEX "CrmAnalysisRun_profileId_idx" ON "CrmAnalysisRun"("profileId");
CREATE INDEX "CrmAnalysisRun_status_idx" ON "CrmAnalysisRun"("status");

CREATE INDEX "FanList_agencyId_type_status_idx" ON "FanList"("agencyId", "type", "status");
CREATE INDEX "FanList_creatorId_idx" ON "FanList"("creatorId");
CREATE INDEX "FanList_deletedAt_idx" ON "FanList"("deletedAt");
CREATE UNIQUE INDEX "FanListMember_listId_fanId_key" ON "FanListMember"("listId", "fanId");
CREATE INDEX "FanListMember_agencyId_fanId_idx" ON "FanListMember"("agencyId", "fanId");
CREATE INDEX "FanListMember_creatorId_fanId_idx" ON "FanListMember"("creatorId", "fanId");
CREATE INDEX "SavedSegment_agencyId_status_idx" ON "SavedSegment"("agencyId", "status");
CREATE INDEX "SavedSegment_creatorId_idx" ON "SavedSegment"("creatorId");
CREATE INDEX "SavedSegment_deletedAt_idx" ON "SavedSegment"("deletedAt");

CREATE INDEX "CampaignDraft_agencyId_status_idx" ON "CampaignDraft"("agencyId", "status");
CREATE INDEX "CampaignDraft_creatorId_status_idx" ON "CampaignDraft"("creatorId", "status");
CREATE INDEX "CampaignDraft_segmentId_idx" ON "CampaignDraft"("segmentId");
CREATE INDEX "CampaignDraft_deletedAt_idx" ON "CampaignDraft"("deletedAt");
CREATE UNIQUE INDEX "CampaignQueueStatus_creatorId_ofQueueId_key" ON "CampaignQueueStatus"("creatorId", "ofQueueId");
CREATE INDEX "CampaignQueueStatus_agencyId_status_idx" ON "CampaignQueueStatus"("agencyId", "status");
CREATE INDEX "CampaignQueueStatus_creatorId_status_idx" ON "CampaignQueueStatus"("creatorId", "status");

CREATE INDEX "AutomationDelivery_agencyId_status_idx" ON "AutomationDelivery"("agencyId", "status");
CREATE INDEX "AutomationDelivery_creatorId_fanId_idx" ON "AutomationDelivery"("creatorId", "fanId");
CREATE INDEX "AutomationDelivery_ruleId_idx" ON "AutomationDelivery"("ruleId");
CREATE INDEX "AutomationDelivery_sentAt_idx" ON "AutomationDelivery"("sentAt");
CREATE UNIQUE INDEX "HiddenOnlineUser_creatorId_fanId_key" ON "HiddenOnlineUser"("creatorId", "fanId");
CREATE INDEX "HiddenOnlineUser_agencyId_status_idx" ON "HiddenOnlineUser"("agencyId", "status");
CREATE INDEX "HiddenOnlineUser_creatorId_status_idx" ON "HiddenOnlineUser"("creatorId", "status");
CREATE INDEX "HiddenOnlineUser_lastSignalAt_idx" ON "HiddenOnlineUser"("lastSignalAt");
CREATE UNIQUE INDEX "FollowBackTask_creatorId_fanId_action_key" ON "FollowBackTask"("creatorId", "fanId", "action");
CREATE INDEX "FollowBackTask_agencyId_status_idx" ON "FollowBackTask"("agencyId", "status");
CREATE INDEX "FollowBackTask_creatorId_status_idx" ON "FollowBackTask"("creatorId", "status");

CREATE UNIQUE INDEX "VaultPurchaseMessage_creatorId_messageId_key" ON "VaultPurchaseMessage"("creatorId", "messageId");
CREATE INDEX "VaultPurchaseMessage_agencyId_idx" ON "VaultPurchaseMessage"("agencyId");
CREATE INDEX "VaultPurchaseMessage_creatorId_fanId_idx" ON "VaultPurchaseMessage"("creatorId", "fanId");
CREATE INDEX "VaultPurchaseMessage_purchasedAt_idx" ON "VaultPurchaseMessage"("purchasedAt");
CREATE UNIQUE INDEX "VaultMediaSale_creatorId_messageId_mediaId_key" ON "VaultMediaSale"("creatorId", "messageId", "mediaId");
CREATE INDEX "VaultMediaSale_agencyId_idx" ON "VaultMediaSale"("agencyId");
CREATE INDEX "VaultMediaSale_creatorId_mediaId_idx" ON "VaultMediaSale"("creatorId", "mediaId");
CREATE INDEX "VaultMediaSale_creatorId_status_idx" ON "VaultMediaSale"("creatorId", "status");

-- Foreign keys
ALTER TABLE "ContentCollection" ADD CONSTRAINT "ContentCollection_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentCollection" ADD CONSTRAINT "ContentCollection_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContentBlock" ADD CONSTRAINT "ContentBlock_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ContentCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProfile" ADD CONSTRAINT "CrmProfile_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProfile" ADD CONSTRAINT "CrmProfile_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProfileTag" ADD CONSTRAINT "CrmProfileTag_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProfileTag" ADD CONSTRAINT "CrmProfileTag_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CrmProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProfileRawTag" ADD CONSTRAINT "CrmProfileRawTag_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProfileRawTag" ADD CONSTRAINT "CrmProfileRawTag_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CrmProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmNote" ADD CONSTRAINT "CrmNote_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CrmProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmAnalysisRun" ADD CONSTRAINT "CrmAnalysisRun_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmAnalysisRun" ADD CONSTRAINT "CrmAnalysisRun_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmAnalysisRun" ADD CONSTRAINT "CrmAnalysisRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CrmProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FanList" ADD CONSTRAINT "FanList_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FanList" ADD CONSTRAINT "FanList_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FanListMember" ADD CONSTRAINT "FanListMember_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FanListMember" ADD CONSTRAINT "FanListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "FanList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FanListMember" ADD CONSTRAINT "FanListMember_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SavedSegment" ADD CONSTRAINT "SavedSegment_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedSegment" ADD CONSTRAINT "SavedSegment_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CampaignDraft" ADD CONSTRAINT "CampaignDraft_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignDraft" ADD CONSTRAINT "CampaignDraft_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignDraft" ADD CONSTRAINT "CampaignDraft_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "SavedSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CampaignQueueStatus" ADD CONSTRAINT "CampaignQueueStatus_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignQueueStatus" ADD CONSTRAINT "CampaignQueueStatus_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationDelivery" ADD CONSTRAINT "AutomationDelivery_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationDelivery" ADD CONSTRAINT "AutomationDelivery_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HiddenOnlineUser" ADD CONSTRAINT "HiddenOnlineUser_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HiddenOnlineUser" ADD CONSTRAINT "HiddenOnlineUser_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowBackTask" ADD CONSTRAINT "FollowBackTask_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowBackTask" ADD CONSTRAINT "FollowBackTask_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseMessage" ADD CONSTRAINT "VaultPurchaseMessage_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultPurchaseMessage" ADD CONSTRAINT "VaultPurchaseMessage_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultMediaSale" ADD CONSTRAINT "VaultMediaSale_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultMediaSale" ADD CONSTRAINT "VaultMediaSale_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
