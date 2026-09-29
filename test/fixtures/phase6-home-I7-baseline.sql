-- Offline fixture: unchanged table/type/index definitions from I7 Prisma SQL.
-- Excludes unrelated tables, foreign keys, historical triggers and full migration chain.


CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'OPERATOR');

CREATE TYPE "CreatorStatus" AS ENUM ('DRAFT', 'READY', 'NOT_CREATOR', 'AUTH_FAILED', 'DISABLED');

CREATE TYPE "CreatorConnectionState" AS ENUM ('ENROLLMENT_REQUIRED', 'CONNECTING', 'CONNECTED', 'RECONNECT_REQUIRED', 'RECONNECTING');

CREATE TYPE "CreatorSessionStateStatus" AS ENUM ('ACTIVE', 'REVOKED', 'REINITIALIZING');

CREATE TYPE "AgencyProxyType" AS ENUM ('HTTP', 'HTTPS', 'SOCKS4', 'SOCKS4A', 'SOCKS5');

CREATE TYPE "CreatorNetworkMode" AS ENUM ('DIRECT', 'PROXY');

CREATE TYPE "CustomOrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'MISSED', 'CANCELLED');

CREATE TYPE "CustomOrderType" AS ENUM ('CONTENT', 'CALL', 'PHYSICAL');

CREATE TYPE "CustomOrderContentKind" AS ENUM ('PHOTO', 'VIDEO', 'BOTH');

CREATE TYPE "CustomOrderPhysicalStatus" AS ENUM ('WAITING', 'READY', 'SHIPPED', 'COMPLETED');

CREATE TYPE "CustomContentReviewStatus" AS ENUM ('WAITING_REVIEW', 'REVISION_REQUESTED', 'APPROVED');

CREATE TYPE "AnalyticsDataType" AS ENUM ('EARNINGS', 'NOTIFICATIONS', 'NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS', 'NOTIFICATION_LIKES', 'NOTIFICATION_COMMENTS', 'CAMPAIGNS', 'SALES', 'FINANCIAL_TRANSACTIONS', 'PAID_SUBSCRIPTIONS', 'MESSAGES_DAILY');

CREATE TYPE "AnalyticsCoverageStatus" AS ENUM ('MISSING', 'QUEUED', 'SCANNING', 'PARTIAL', 'COMPLETE', 'FAILED', 'UNAVAILABLE');

CREATE TYPE "AnalyticsIngestStatus" AS ENUM ('RECEIVED', 'COMMITTED', 'PARTIAL', 'REJECTED', 'FAILED');

CREATE TYPE "CreatorNotificationScanOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'IGNORED');

CREATE TYPE "CreatorNotificationScanFactType" AS ENUM ('PURCHASE', 'TIP', 'SUBSCRIPTION', 'LIKE', 'COMMENT');

CREATE TYPE "CreatorFinancialTransactionFactType" AS ENUM ('SALE', 'TIP', 'PAID_SUBSCRIPTION', 'OTHER');

CREATE TYPE "CreatorFinancialTransactionProjectionStatus" AS ENUM ('PROJECTED', 'STORED_ONLY');

CREATE TYPE "CreatorEarningsCategory" AS ENUM ('TOTAL', 'SUBSCRIPTIONS', 'MESSAGES', 'TIPS', 'POSTS', 'STREAMS');

CREATE TYPE "CreatorSaleType" AS ENUM ('MESSAGE', 'POST', 'STREAM', 'OTHER');

CREATE TYPE "CreatorSubscriptionEventType" AS ENUM ('SUBSCRIBED_FREE', 'SUBSCRIBED_PAID', 'SUBSCRIBED_UNKNOWN', 'RENEWED', 'RESUBSCRIBED', 'EXPIRED', 'AUTO_RENEW_ENABLED', 'AUTO_RENEW_DISABLED', 'REFUNDED');

CREATE TYPE "CreatorFactSource" AS ENUM ('NOTIFICATION', 'LOCAL_MESSAGE_LEDGER', 'ONLYFANS_API', 'RECONCILIATION');

CREATE TYPE "CreatorPaidSubscriptionPaymentType" AS ENUM ('INITIAL', 'RENEWAL', 'RESUBSCRIPTION');

CREATE TYPE "CreatorSubscriptionStateStatus" AS ENUM ('UNKNOWN', 'ACTIVE', 'EXPIRED');

CREATE TYPE "CreatorCampaignAttributionSource" AS ENUM ('ONLYFANS_TRACKING', 'NOTIFICATION', 'SUBSCRIPTION_RECORD', 'MANUAL', 'INFERRED');

CREATE TYPE "CreatorCampaignAttributionConfidence" AS ENUM ('CONFIRMED', 'PROBABLE', 'WEAK');

CREATE TYPE "CreatorCampaignFrontierKind" AS ENUM ('CANONICAL', 'STAGED');

CREATE TYPE "CreatorLocalCoverageStatus" AS ENUM ('MISSING', 'PARTIAL', 'COMPLETE', 'FAILED');

CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

CREATE TYPE "CryptoIdentityStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

CREATE TYPE "CryptoRootStatus" AS ENUM ('ACTIVE', 'RECOVERY_ONLY', 'DISABLED');

CREATE TYPE "SecretEncryptionMode" AS ENUM ('CLIENT_E2E_V1');

CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'LOCKED');

CREATE TYPE "BillingMode" AS ENUM ('MANUAL', 'STRIPE', 'CRYPTO', 'FREE_INTERNAL');

CREATE TYPE "CreatorBillingTier" AS ENUM ('STARTER', 'GROWTH', 'PRO', 'ELITE', 'CUSTOM');

CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'THREE_MONTHS', 'SIX_MONTHS');

CREATE TYPE "BillingProvider" AS ENUM ('NOWPAYMENTS');

CREATE TYPE "BillingEntitlementSource" AS ENUM ('PAYMENT', 'ADMIN', 'LEGACY', 'WALLET');

CREATE TYPE "BillingOrderPurpose" AS ENUM ('SUBSCRIPTION', 'WALLET_TOP_UP');

CREATE TYPE "BillingWalletTransactionType" AS ENUM ('TOP_UP', 'SUBSCRIPTION_DEBIT', 'TOP_UP_REFUND', 'ADMIN_ADJUSTMENT');

CREATE TYPE "CreatorBillingPeriodStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'LEGACY');

CREATE TYPE "BillingOrderStatus" AS ENUM ('CREATED', 'CHECKOUT_CREATED', 'PROCESSING', 'PARTIALLY_PAID', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELLED');

CREATE TYPE "CreatorMediaAssetSource" AS ENUM ('GENERAL', 'CUSTOM');

CREATE TABLE "Agency" (
    "billingPolicyRevision" INTEGER NOT NULL DEFAULT 1,
    "billingSupportHold" BOOLEAN NOT NULL DEFAULT false,
    "billingSupportHoldReason" TEXT,
    "billingSupportHoldAt" TIMESTAMP(3),
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "status" TEXT NOT NULL DEFAULT 'TRIAL',
    "trialGrantedAt" TIMESTAMP(3),
    "trialGrantedDays" INTEGER,
    "trialPolicyRevision" INTEGER,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgencyMember" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "permissions" JSONB,
    "accessEpoch" INTEGER NOT NULL DEFAULT 1,
    "roleKey" TEXT,
    "displayName" TEXT,
    "initials" TEXT,
    "tone" TEXT,
    "commission" JSONB,
    "assignedCreators" JSONB,
    "statusBadge" JSONB,
    "lastSeenLabel" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "sessionsRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorAccount" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "username" TEXT,
    "enrollmentExpectedUsername" TEXT,
    "platformUsername" TEXT,
    "platformDisplayName" TEXT,
    "platformAvatarUrl" TEXT,
    "platformProfileObservedAt" TIMESTAMP(3),
    "platformProfileSourceDeviceId" TEXT,
    "platformProfileConnectionGeneration" INTEGER,
    "avatarUrl" TEXT,
    "remoteId" TEXT,
    "status" "CreatorStatus" NOT NULL DEFAULT 'DRAFT',
    "connectionState" "CreatorConnectionState" NOT NULL DEFAULT 'ENROLLMENT_REQUIRED',
    "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
    "connectionStartedAt" TIMESTAMP(3),
    "connectedSessionRevision" INTEGER,
    "notes" TEXT,
    "telegramContact" TEXT,
    "telegramUserId" TEXT,
    "telegramAccountId" TEXT,
    "customsVaultFolderId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DomainWorkClaimTopologyState" (
    "id" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "activationState" TEXT NOT NULL DEFAULT 'BUILDING',
    "cursorAgencyId" TEXT,
    "cursorWorkClass" TEXT,
    "cursorPartitionKey" TEXT,
    "cursorActiveGeneration" TEXT,
    "cursorWorkId" TEXT,
    "backfilledPartitions" BIGINT NOT NULL DEFAULT 0,
    "partitionsBackfilledAt" TIMESTAMP(3),
    "cursorMemberId" TEXT,
    "backfilledMembers" BIGINT NOT NULL DEFAULT 0,
    "membersBackfilledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainWorkClaimTopologyState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgencyMemberCreatorAccessCurrent" (
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "accessEpoch" INTEGER NOT NULL,
    "claimShard" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyMemberCreatorAccessCurrent_identity_key" PRIMARY KEY ("memberId","creatorId")
);

CREATE TABLE "AgencySubscription" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "billingMode" "BillingMode" NOT NULL DEFAULT 'MANUAL',
    "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "corePricePerCreatorCents" INTEGER NOT NULL DEFAULT 2000,
    "trialEndsAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencySubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorBillingEntitlement" (
    "entitlementRevision" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "tier" "CreatorBillingTier" NOT NULL DEFAULT 'STARTER',
    "coreSource" "BillingEntitlementSource" NOT NULL DEFAULT 'LEGACY',
    "corePriceCents" INTEGER NOT NULL DEFAULT 0,
    "coreValidFrom" TIMESTAMP(3),
    "coreValidUntil" TIMESTAMP(3),
    "aiChatterSource" "BillingEntitlementSource" NOT NULL DEFAULT 'LEGACY',
    "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 0,
    "aiChatterValidUntil" TIMESTAMP(3),
    "outreachSource" "BillingEntitlementSource" NOT NULL DEFAULT 'LEGACY',
    "outreachPriceCents" INTEGER NOT NULL DEFAULT 0,
    "outreachValidUntil" TIMESTAMP(3),
    "coreLastOrderId" TEXT,
    "aiLastOrderId" TEXT,
    "outreachLastOrderId" TEXT,
    "lastPaidAt" TIMESTAMP(3),
    "subscriptionStartedAt" TIMESTAMP(3),
    "currentPeriodStartedAt" TIMESTAMP(3),
    "currentPeriodEndsAt" TIMESTAMP(3),
    "nextRenewalAt" TIMESTAMP(3),
    "billingAnchorDay" INTEGER,
    "tierAtPeriodStart" "CreatorBillingTier",
    "amountChargedForPeriodCents" INTEGER NOT NULL DEFAULT 0,
    "autoRenewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRenewalAttemptAt" TIMESTAMP(3),
    "lastRenewalErrorCode" TEXT,
    "lastRevenue30dCents" INTEGER,
    "lastRevenueCapturedAt" TIMESTAMP(3),
    "walletTestMode" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorBillingEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsCoverage" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "ingestBatchId" TEXT,
    "scanProofId" TEXT,
    "dataType" "AnalyticsDataType" NOT NULL,
    "coverageDate" DATE NOT NULL,
    "sourceTimezone" TEXT NOT NULL,
    "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "coveredFromAt" TIMESTAMP(3),
    "coveredToAt" TIMESTAMP(3),
    "sourceCursorStart" TEXT,
    "sourceCursorEnd" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "retryAfterAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsCoverage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsScanProof" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dataType" "AnalyticsDataType" NOT NULL,
    "scanRunId" TEXT NOT NULL,
    "sourceTimezone" TEXT NOT NULL,
    "scanFrom" DATE NOT NULL,
    "scanTo" DATE NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "clientObservedAt" TIMESTAMP(3),
    "serverReceivedAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "status" "AnalyticsIngestStatus" NOT NULL,
    "collectorVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "scanGeneration" TEXT NOT NULL,
    "collectionReason" TEXT NOT NULL,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,
    "payloadChecksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsScanProof_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorEarningsDaily" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sourceTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "subscriptionsCents" INTEGER,
    "messagesCents" INTEGER,
    "tipsCents" INTEGER,
    "postsCents" INTEGER,
    "streamsCents" INTEGER,
    "referralsCents" INTEGER,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sourceUpdatedAt" TIMESTAMP(3),
    "sourceScanRunId" TEXT,
    "sourceScanRequestedAt" TIMESTAMP(3),
    "scanProofId" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorEarningsDaily_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsCollectionDemand" (
    "key" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "rangeKey" TEXT NOT NULL,
    "coverageFrom" DATE NOT NULL,
    "coverageTo" DATE NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "reason" TEXT NOT NULL,
    "creatorIds" JSONB,
    "requestedByMemberId" TEXT NOT NULL,
    "requestedAccessEpoch" INTEGER NOT NULL,
    "requestRevision" INTEGER NOT NULL DEFAULT 1,
    "completedRevision" INTEGER NOT NULL DEFAULT 0,
    "claimedRevision" INTEGER,
    "claimToken" TEXT,
    "claimUntil" TIMESTAMP(3),
    "cursorCreatorId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorClass" TEXT,
    "lastError" TEXT,
    "quarantinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsCollectionDemand_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "JobInstance" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "creatorId" TEXT,
    "agencyId" TEXT,
    "idempotencyKey" TEXT,
    "params" JSONB,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedByDeviceId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "leaseTokenHash" TEXT,
    "leaseRevision" INTEGER NOT NULL DEFAULT 0,
    "leaseMemberId" TEXT,
    "leaseAccessEpoch" INTEGER,
    "workId" TEXT,
    "continuation" JSONB,
    "progress" JSONB,
    "lastProgressAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobInstance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE INDEX "User_disabledAt_idx" ON "User"("disabledAt");

CREATE INDEX "Agency_deletedAt_idx" ON "Agency"("deletedAt");

CREATE INDEX "AgencyMember_agencyId_idx" ON "AgencyMember"("agencyId");

CREATE INDEX "AgencyMember_userId_idx" ON "AgencyMember"("userId");

CREATE INDEX "AgencyMember_roleKey_idx" ON "AgencyMember"("roleKey");

CREATE INDEX "AgencyMember_deletedAt_idx" ON "AgencyMember"("deletedAt");

CREATE INDEX "AgencyMember_deactivatedAt_idx" ON "AgencyMember"("deactivatedAt");

CREATE UNIQUE INDEX "AgencyMember_agencyId_userId_key" ON "AgencyMember"("agencyId", "userId");

CREATE INDEX "CreatorAccount_agencyId_idx" ON "CreatorAccount"("agencyId");

CREATE INDEX "CreatorAccount_agencyId_telegramUserId_idx" ON "CreatorAccount"("agencyId", "telegramUserId");

CREATE INDEX "CreatorAccount_agencyId_telegramAccountId_idx" ON "CreatorAccount"("agencyId", "telegramAccountId");

CREATE INDEX "CreatorAccount_status_idx" ON "CreatorAccount"("status");

CREATE INDEX "CreatorAccount_deletedAt_idx" ON "CreatorAccount"("deletedAt");

CREATE INDEX "CreatorAccount_status_deleted_id_idx" ON "CreatorAccount"("status", "deletedAt", "id");

CREATE UNIQUE INDEX "CreatorAccount_agencyId_id_key" ON "CreatorAccount"("agencyId", "id");

CREATE INDEX "AgencySubscription_agency_created_id_idx" ON "AgencySubscription"("agencyId", "createdAt", "id");

CREATE INDEX "AgencySubscription_agencyId_idx" ON "AgencySubscription"("agencyId");

CREATE INDEX "AgencySubscription_status_idx" ON "AgencySubscription"("status");

CREATE INDEX "AgencySubscription_currentPeriodEnd_idx" ON "AgencySubscription"("currentPeriodEnd");

CREATE UNIQUE INDEX "CreatorBillingEntitlement_creatorId_key" ON "CreatorBillingEntitlement"("creatorId");

CREATE INDEX "CreatorBillingEntitlement_agencyId_coreValidUntil_idx" ON "CreatorBillingEntitlement"("agencyId", "coreValidUntil");

CREATE INDEX "CreatorBillingEntitlement_coreValidUntil_idx" ON "CreatorBillingEntitlement"("coreValidUntil");

CREATE INDEX "CreatorBillingEntitlement_aiChatterValidUntil_idx" ON "CreatorBillingEntitlement"("aiChatterValidUntil");

CREATE INDEX "CreatorBillingEntitlement_outreachValidUntil_idx" ON "CreatorBillingEntitlement"("outreachValidUntil");

CREATE INDEX "AnalyticsCoverage_agency_creator_type_day_idx" ON "AnalyticsCoverage"("agencyId", "creatorId", "dataType", "coverageDate");

CREATE INDEX "AnalyticsCoverage_creator_type_status_day_idx" ON "AnalyticsCoverage"("creatorId", "dataType", "status", "coverageDate");

CREATE INDEX "AnalyticsCoverage_ingestBatchId_idx" ON "AnalyticsCoverage"("ingestBatchId");

CREATE INDEX "AnalyticsCoverage_scanProofId_idx" ON "AnalyticsCoverage"("scanProofId");

CREATE UNIQUE INDEX "AnalyticsCoverage_creator_day_key" ON "AnalyticsCoverage"("creatorId", "dataType", "coverageDate", "sourceTimezone");

CREATE INDEX "AnalyticsScanProof_agency_creator_type_commit_idx" ON "AnalyticsScanProof"("agencyId", "creatorId", "dataType", "committedAt");

CREATE INDEX "AnalyticsScanProof_creator_type_window_idx" ON "AnalyticsScanProof"("creatorId", "dataType", "scanFrom", "scanTo");

CREATE INDEX "AnalyticsScanProof_sourceJobId_idx" ON "AnalyticsScanProof"("sourceJobId");

CREATE INDEX "AnalyticsScanProof_createdAt_id_idx" ON "AnalyticsScanProof"("createdAt", "id");

CREATE UNIQUE INDEX "AnalyticsScanProof_creator_type_run_key" ON "AnalyticsScanProof"("creatorId", "dataType", "scanRunId");

CREATE INDEX "AgencyMemberCreatorAccessCurrent_claim_idx" ON "AgencyMemberCreatorAccessCurrent"("memberId", "accessEpoch", "claimShard", "creatorId");

CREATE INDEX "AgencyMemberCreatorAccessCurrent_creator_idx" ON "AgencyMemberCreatorAccessCurrent"("agencyId", "creatorId", "memberId");

CREATE INDEX "AnalyticsCollectionDemand_due_v2_idx" ON "AnalyticsCollectionDemand"("completedAt", "quarantinedAt", "nextAttemptAt", "claimUntil", "requestedAt");

CREATE INDEX "AnalyticsCollectionDemand_agency_requested_idx" ON "AnalyticsCollectionDemand"("agencyId", "requestedAt");

CREATE INDEX "CreatorEarningsDaily_agencyId_creatorId_date_idx" ON "CreatorEarningsDaily"("agencyId", "creatorId", "date");

CREATE INDEX "CreatorEarningsDaily_creatorId_date_idx" ON "CreatorEarningsDaily"("creatorId", "date");

CREATE INDEX "CreatorEarningsDaily_creatorId_sourceScanRunId_idx" ON "CreatorEarningsDaily"("creatorId", "sourceScanRunId");

CREATE INDEX "CreatorEarningsDaily_sourceJobId_idx" ON "CreatorEarningsDaily"("sourceJobId");

CREATE INDEX "CreatorEarningsDaily_scanProofId_idx" ON "CreatorEarningsDaily"("scanProofId");

CREATE UNIQUE INDEX "CreatorEarningsDaily_creatorId_date_sourceTimezone_key" ON "CreatorEarningsDaily"("creatorId", "date", "sourceTimezone");

CREATE UNIQUE INDEX "JobInstance_idempotencyKey_key" ON "JobInstance"("idempotencyKey");

CREATE INDEX "JobInstance_status_nextRunAt_idx" ON "JobInstance"("status", "nextRunAt");

CREATE INDEX "JobInstance_creatorId_idx" ON "JobInstance"("creatorId");

CREATE INDEX "JobInstance_agencyId_idx" ON "JobInstance"("agencyId");

CREATE INDEX "JobInstance_jobKey_idx" ON "JobInstance"("jobKey");

CREATE INDEX "JobInstance_agencyId_idempotencyKey_idx" ON "JobInstance"("agencyId", "idempotencyKey");

CREATE INDEX "JobInstance_claimedByDeviceId_idx" ON "JobInstance"("claimedByDeviceId");

CREATE INDEX "JobInstance_leaseUntil_idx" ON "JobInstance"("leaseUntil");

CREATE INDEX "JobInstance_analytics_retention_idx" ON "JobInstance"("jobKey", "status", "completedAt", "id");

CREATE INDEX "JobInstance_analytics_terminal_updated_retention_idx" ON "JobInstance"("jobKey", "status", "updatedAt", "id");

CREATE OR REPLACE FUNCTION "phase3_member_has_broad_creator_access"(
  p_role TEXT,p_role_key TEXT,p_scope JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF UPPER(COALESCE(p_role,''))='OWNER' OR LOWER(COALESCE(p_role_key,''))='owner' THEN
    RETURN TRUE;
  END IF;
  IF p_scope IS NULL OR jsonb_typeof(p_scope)='null' OR p_scope='"all"'::jsonb THEN
    RETURN TRUE;
  END IF;
  IF jsonb_typeof(p_scope)='object' THEN
    IF LOWER(COALESCE(p_scope->>'mode',''))='all' THEN RETURN TRUE; END IF;
    BEGIN
      IF COALESCE((p_scope->>'all')::BOOLEAN,FALSE) THEN RETURN TRUE; END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN FALSE;
    END;
  END IF;
  RETURN FALSE;
END;
$$;
