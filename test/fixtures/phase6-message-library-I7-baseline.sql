-- Offline D1 fixture: I7 table/index definitions only, without historical triggers or foreign keys.

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

CREATE TABLE "ContentCollection" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'message_library',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "clientId" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),
    "trashedByUserId" TEXT,
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
    "status" TEXT NOT NULL DEFAULT 'active',
    "deletedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),
    "trashedByUserId" TEXT,
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

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
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

CREATE INDEX "AuditLog_agencyId_idx" ON "AuditLog"("agencyId");

CREATE INDEX "AuditLog_agencyId_createdAt_idx" ON "AuditLog"("agencyId", "createdAt");

CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

CREATE INDEX "AgencySubscription_agency_created_id_idx" ON "AgencySubscription"("agencyId", "createdAt", "id");

CREATE INDEX "AgencySubscription_agencyId_idx" ON "AgencySubscription"("agencyId");

CREATE INDEX "AgencySubscription_status_idx" ON "AgencySubscription"("status");

CREATE INDEX "AgencySubscription_currentPeriodEnd_idx" ON "AgencySubscription"("currentPeriodEnd");

CREATE UNIQUE INDEX "CreatorBillingEntitlement_creatorId_key" ON "CreatorBillingEntitlement"("creatorId");

CREATE INDEX "CreatorBillingEntitlement_agencyId_coreValidUntil_idx" ON "CreatorBillingEntitlement"("agencyId", "coreValidUntil");

CREATE INDEX "CreatorBillingEntitlement_coreValidUntil_idx" ON "CreatorBillingEntitlement"("coreValidUntil");

CREATE INDEX "CreatorBillingEntitlement_aiChatterValidUntil_idx" ON "CreatorBillingEntitlement"("aiChatterValidUntil");

CREATE INDEX "CreatorBillingEntitlement_outreachValidUntil_idx" ON "CreatorBillingEntitlement"("outreachValidUntil");

CREATE INDEX "ContentCollection_agencyId_kind_status_idx" ON "ContentCollection"("agencyId", "kind", "status");

CREATE INDEX "ContentCollection_creatorId_kind_status_idx" ON "ContentCollection"("creatorId", "kind", "status");

CREATE INDEX "ContentCollection_updatedAt_idx" ON "ContentCollection"("updatedAt");

CREATE INDEX "ContentCollection_deletedAt_idx" ON "ContentCollection"("deletedAt");

CREATE INDEX "ContentCollection_purgeAfter_idx" ON "ContentCollection"("purgeAfter");

CREATE UNIQUE INDEX "ContentCollection_agencyId_clientId_key" ON "ContentCollection"("agencyId", "clientId");

CREATE INDEX "ContentBlock_collectionId_order_idx" ON "ContentBlock"("collectionId", "order");

CREATE INDEX "ContentBlock_status_purgeAfter_idx" ON "ContentBlock"("status", "purgeAfter");

CREATE UNIQUE INDEX "ContentBlock_collectionId_clientId_key" ON "ContentBlock"("collectionId", "clientId");

CREATE INDEX "ContentUsageEvent_agencyId_createdAt_idx" ON "ContentUsageEvent"("agencyId", "createdAt");

CREATE INDEX "ContentUsageEvent_collectionId_idx" ON "ContentUsageEvent"("collectionId");

CREATE INDEX "ContentUsageEvent_creatorId_fanId_idx" ON "ContentUsageEvent"("creatorId", "fanId");
