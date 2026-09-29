-- Extracted verbatim from Prisma 5.22.0 empty -> supplied I7 schema diff.
-- Offline projection fixture only: no FK/business triggers, no external database.
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

CREATE TABLE "CreatorCampaignCollectionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "activeGeneration" TEXT,
    "activeRequestedAt" TIMESTAMP(3),
    "baselineVerifiedAt" TIMESTAMP(3),
    "baselineGeneration" TEXT,
    "lastCatchupCompletedAt" TIMESTAMP(3),
    "lastCatchupGeneration" TEXT,
    "lastCompleteScanRunId" TEXT,
    "campaignProofScanRunId" VARCHAR(120),
    "campaignProofCollectorVersion" VARCHAR(80),
    "campaignProofCampaignBatches" INTEGER NOT NULL DEFAULT 0,
    "campaignProofClaimerBatches" INTEGER NOT NULL DEFAULT 0,
    "campaignProofRejectedBatches" INTEGER NOT NULL DEFAULT 0,
    "campaignProofRejectedRows" INTEGER NOT NULL DEFAULT 0,
    "membershipCoverageStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "membershipCoverageCompletedAt" TIMESTAMP(3),
    "fanValueCoverageScanRunId" VARCHAR(120),
    "fanValueCoverageDelegated" BOOLEAN NOT NULL DEFAULT false,
    "fanValueCoverageOwnerKind" VARCHAR(32),
    "fanValueCoverageCollectorVersion" VARCHAR(80),
    "fanValueCoverageSourceJobId" TEXT,
    "fanValueFreshnessCutoffAt" TIMESTAMP(3),
    "fanValueFreshnessStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "fanValueExpected" INTEGER NOT NULL DEFAULT 0,
    "fanValueAlreadyFresh" INTEGER NOT NULL DEFAULT 0,
    "fanValueQueued" INTEGER NOT NULL DEFAULT 0,
    "fanValueSucceeded" INTEGER NOT NULL DEFAULT 0,
    "fanValueUnavailable" INTEGER NOT NULL DEFAULT 0,
    "fanValueFailed" INTEGER NOT NULL DEFAULT 0,
    "fanValueOutstanding" INTEGER NOT NULL DEFAULT 0,
    "fanValueCoverageUpdatedAt" TIMESTAMP(3),
    "campaignFrontierPlanRunId" VARCHAR(120),
    "campaignFrontierFreshnessStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "campaignFrontierDueCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierTargetCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierCompletedCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierDeferredCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierOldestDueAt" TIMESTAMP(3),
    "campaignFrontierNextDueAt" TIMESTAMP(3),
    "campaignFrontierUpdatedAt" TIMESTAMP(3),
    "campaignDirectoryGeneration" VARCHAR(120),
    "campaignDirectoryRequestedAt" TIMESTAMP(3),
    "campaignDirectoryVerifiedAt" TIMESTAMP(3),
    "campaignDirectoryRevision" INTEGER NOT NULL DEFAULT 0,
    "campaignDirectoryCampaignCount" INTEGER NOT NULL DEFAULT 0,
    "campaignDirectoryDiscoveryDueAt" TIMESTAMP(3),
    "campaignDirectoryDiscoveryRequestedAt" TIMESTAMP(3),
    "campaignDirectoryDiscoveryRequestedRevision" INTEGER NOT NULL DEFAULT 0,
    "campaignDirectoryDiscoveryCompletedRevision" INTEGER NOT NULL DEFAULT 0,
    "retryAfterAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCampaignCollectionState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorFanRefreshDemand" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "onlyFansUserId" VARCHAR(180) NOT NULL,
    "requestedFreshnessCutoffAt" TIMESTAMP(3) NOT NULL,
    "requestedRevision" INTEGER NOT NULL DEFAULT 1,
    "satisfiedRevision" INTEGER NOT NULL DEFAULT 0,
    "activeRefreshJobId" TEXT,
    "activeRefreshRevision" INTEGER,
    "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    "lastRequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastObservedAt" TIMESTAMP(3),
    "lastOutcome" VARCHAR(32),
    "lastCompletedAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "retryAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastRetryAt" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3),
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFanRefreshDemand_pkey" PRIMARY KEY ("id")
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

CREATE TABLE "OfProviderRequestGateState" (
    "id" TEXT NOT NULL,
    "activePermitId" TEXT,
    "activeOwnerInstanceId" TEXT,
    "activeAgencyId" TEXT,
    "activeCreatorId" TEXT,
    "activeDeviceId" TEXT,
    "activeCapability" TEXT,
    "activePriority" TEXT,
    "activeCategory" TEXT,
    "activeIntervalMs" INTEGER,
    "activeGrantedAt" TIMESTAMP(3),
    "activeExpiresAt" TIMESTAMP(3),
    "nextAllowedAt" TIMESTAMP(3),
    "revision" BIGINT NOT NULL DEFAULT 0,
    "lastStartedAt" TIMESTAMP(3),
    "lastStartedCreatorId" TEXT,
    "lastStartedDeviceId" TEXT,
    "priorityCursor" INTEGER NOT NULL DEFAULT 0,
    "backgroundCategoryCursor" INTEGER NOT NULL DEFAULT 0,
    "fairnessGeneration" TEXT NOT NULL DEFAULT 'phase3_provider_gate_fairness_v2_a14',
    "fairnessActivationState" TEXT NOT NULL DEFAULT 'DRAINING',
    "fairnessDrainStartedAt" TIMESTAMP(3),
    "fairnessActivatedAt" TIMESTAMP(3),
    "fairnessActivationConfirmedAt" TIMESTAMP(3),
    "legacyPermitLastSeenAt" TIMESTAMP(3),
    "legacyPermitCount" BIGINT NOT NULL DEFAULT 0,
    "usageWindowStartedAt" TIMESTAMP(3),
    "usageTotalStarts" BIGINT NOT NULL DEFAULT 0,
    "usageCriticalWriteStarts" BIGINT NOT NULL DEFAULT 0,
    "usageInteractiveStarts" BIGINT NOT NULL DEFAULT 0,
    "usageRealtimeStarts" BIGINT NOT NULL DEFAULT 0,
    "usageNormalStarts" BIGINT NOT NULL DEFAULT 0,
    "usageCampaignDirectoryStarts" BIGINT NOT NULL DEFAULT 0,
    "usageCampaignFrontierStarts" BIGINT NOT NULL DEFAULT 0,
    "usageFanDataStarts" BIGINT NOT NULL DEFAULT 0,
    "usageBackgroundOtherStarts" BIGINT NOT NULL DEFAULT 0,
    "usageUnclassifiedStarts" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfProviderRequestGateState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderCapacityDebtState" (
    "id" TEXT NOT NULL,
    "sourceVersion" VARCHAR(120) NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "status" VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
    "overloadReason" VARCHAR(500),
    "physicalStartsPerHour" DOUBLE PRECISION NOT NULL,
    "backgroundGuaranteedStartsPerHour" DOUBLE PRECISION NOT NULL,
    "campaignDirectoryGuaranteedStartsPerHour" DOUBLE PRECISION NOT NULL,
    "fanDataGuaranteedStartsPerHour" DOUBLE PRECISION NOT NULL,
    "campaignDirectoryDueCreators" INTEGER NOT NULL DEFAULT 0,
    "campaignDirectoryOverdueCreators" INTEGER NOT NULL DEFAULT 0,
    "campaignDirectoryRequiredCalls" BIGINT NOT NULL DEFAULT 0,
    "campaignDirectoryCapacityDebtCalls" BIGINT NOT NULL DEFAULT 0,
    "campaignDirectoryOldestDueAt" TIMESTAMP(3),
    "campaignDirectoryGuaranteedClearHours" DOUBLE PRECISION NOT NULL,
    "campaignDirectoryTargetHours" DOUBLE PRECISION NOT NULL,
    "fanDataUnsatisfiedDemands" BIGINT NOT NULL DEFAULT 0,
    "fanDataPendingJobs" INTEGER NOT NULL DEFAULT 0,
    "fanDataCapacityDebtCalls" BIGINT NOT NULL DEFAULT 0,
    "fanDataOldestRequestedAt" TIMESTAMP(3),
    "fanDataGuaranteedClearHours" DOUBLE PRECISION NOT NULL,
    "fanDataTargetHours" DOUBLE PRECISION NOT NULL,
    "providerLowerBoundRequiredCalls" BIGINT NOT NULL DEFAULT 0,
    "providerExclusiveClearHours" DOUBLE PRECISION NOT NULL,
    "actualUsageWindowStartedAt" TIMESTAMP(3),
    "actualUsageTotalStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageCriticalWriteStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageInteractiveStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageRealtimeStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageNormalStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageCampaignDirectoryStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageCampaignFrontierStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageFanDataStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageBackgroundOtherStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageUnclassifiedStarts" BIGINT NOT NULL DEFAULT 0,
    "actualUsageAccountingComplete" BOOLEAN NOT NULL DEFAULT true,
    "backgroundOtherPendingJobs" INTEGER NOT NULL DEFAULT 0,
    "backgroundOtherOldestScheduledAt" TIMESTAMP(3),
    "backgroundOtherPendingJobClasses" INTEGER NOT NULL DEFAULT 0,
    "backgroundOtherCallCardinalityKnown" BOOLEAN NOT NULL DEFAULT true,
    "futureDebtCoverageStatus" VARCHAR(40) NOT NULL DEFAULT 'COMPLETE_AT_SAMPLE',
    "futureDebtCoverageReason" VARCHAR(500),
    "topologyVersion" VARCHAR(120) NOT NULL DEFAULT 'phase3_provider_capacity_topology_v1_a16',
    "topologyId" VARCHAR(120) NOT NULL DEFAULT 'of-global',
    "topologyScope" VARCHAR(40) NOT NULL DEFAULT 'FLEET_GLOBAL',
    "topologyShardCount" INTEGER NOT NULL DEFAULT 1,
    "topologyShardingAllowed" BOOLEAN NOT NULL DEFAULT false,
    "controlMode" VARCHAR(40) NOT NULL DEFAULT 'CONSERVATIVE',
    "controlReason" VARCHAR(500),
    "operatorActionRequired" BOOLEAN NOT NULL DEFAULT false,
    "campaignDirectoryAdmissionBudgetCalls" INTEGER NOT NULL DEFAULT 1,
    "campaignDirectoryGuaranteedCallsPerSweep" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCapacityDebtState_pkey" PRIMARY KEY ("id")
);
