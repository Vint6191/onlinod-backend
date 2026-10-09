-- ONLINOD current schema: clean installation only.
-- Tables, business SQL, queues and initial controls are one atomic baseline.
-- No prior migration chain, archive, drain or fleet activation is required.
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL check_function_bodies = false;


-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "CreatorStatus" AS ENUM ('DRAFT', 'READY', 'NOT_CREATOR', 'AUTH_FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "CreatorConnectionState" AS ENUM ('ENROLLMENT_REQUIRED', 'CONNECTING', 'CONNECTED', 'RECONNECT_REQUIRED', 'RECONNECTING');

-- CreateEnum
CREATE TYPE "CreatorSessionStateStatus" AS ENUM ('ACTIVE', 'REVOKED', 'REINITIALIZING');

-- CreateEnum
CREATE TYPE "AgencyProxyType" AS ENUM ('HTTP', 'HTTPS', 'SOCKS4', 'SOCKS4A', 'SOCKS5');

-- CreateEnum
CREATE TYPE "CreatorNetworkMode" AS ENUM ('DIRECT', 'PROXY');

-- CreateEnum
CREATE TYPE "CustomOrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomOrderType" AS ENUM ('CONTENT', 'CALL', 'PHYSICAL');

-- CreateEnum
CREATE TYPE "CustomOrderContentKind" AS ENUM ('PHOTO', 'VIDEO', 'BOTH');

-- CreateEnum
CREATE TYPE "CustomOrderPhysicalStatus" AS ENUM ('WAITING', 'READY', 'SHIPPED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CustomContentReviewStatus" AS ENUM ('WAITING_REVIEW', 'REVISION_REQUESTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "AnalyticsDataType" AS ENUM ('EARNINGS', 'NOTIFICATIONS', 'NOTIFICATION_PURCHASES', 'NOTIFICATION_TIPS', 'NOTIFICATION_SUBSCRIPTIONS', 'NOTIFICATION_LIKES', 'NOTIFICATION_COMMENTS', 'CAMPAIGNS', 'SALES', 'FINANCIAL_TRANSACTIONS', 'PAID_SUBSCRIPTIONS', 'MESSAGES_DAILY');

-- CreateEnum
CREATE TYPE "AnalyticsCoverageStatus" AS ENUM ('MISSING', 'QUEUED', 'SCANNING', 'PARTIAL', 'COMPLETE', 'FAILED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AnalyticsIngestStatus" AS ENUM ('RECEIVED', 'COMMITTED', 'PARTIAL', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreatorNotificationScanOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'IGNORED');

-- CreateEnum
CREATE TYPE "CreatorNotificationScanFactType" AS ENUM ('PURCHASE', 'TIP', 'SUBSCRIPTION', 'LIKE', 'COMMENT');

-- CreateEnum
CREATE TYPE "CreatorFinancialTransactionFactType" AS ENUM ('SALE', 'TIP', 'PAID_SUBSCRIPTION', 'OTHER');

-- CreateEnum
CREATE TYPE "CreatorFinancialTransactionProjectionStatus" AS ENUM ('PROJECTED', 'STORED_ONLY');

-- CreateEnum
CREATE TYPE "CreatorEarningsCategory" AS ENUM ('TOTAL', 'SUBSCRIPTIONS', 'MESSAGES', 'TIPS', 'POSTS', 'STREAMS');

-- CreateEnum
CREATE TYPE "CreatorSaleType" AS ENUM ('MESSAGE', 'POST', 'STREAM', 'OTHER');

-- CreateEnum
CREATE TYPE "CreatorSubscriptionEventType" AS ENUM ('SUBSCRIBED_FREE', 'SUBSCRIBED_PAID', 'SUBSCRIBED_UNKNOWN', 'RENEWED', 'RESUBSCRIBED', 'EXPIRED', 'AUTO_RENEW_ENABLED', 'AUTO_RENEW_DISABLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CreatorFactSource" AS ENUM ('NOTIFICATION', 'LOCAL_MESSAGE_LEDGER', 'ONLYFANS_API', 'RECONCILIATION');

-- CreateEnum
CREATE TYPE "CreatorPaidSubscriptionPaymentType" AS ENUM ('INITIAL', 'RENEWAL', 'RESUBSCRIPTION');

-- CreateEnum
CREATE TYPE "CreatorSubscriptionStateStatus" AS ENUM ('UNKNOWN', 'ACTIVE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CreatorCampaignAttributionSource" AS ENUM ('ONLYFANS_TRACKING', 'NOTIFICATION', 'SUBSCRIPTION_RECORD', 'MANUAL', 'INFERRED');

-- CreateEnum
CREATE TYPE "CreatorCampaignAttributionConfidence" AS ENUM ('CONFIRMED', 'PROBABLE', 'WEAK');

-- CreateEnum
CREATE TYPE "CreatorCampaignFrontierKind" AS ENUM ('CANONICAL', 'STAGED');

-- CreateEnum
CREATE TYPE "CreatorLocalCoverageStatus" AS ENUM ('MISSING', 'PARTIAL', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "CryptoIdentityStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "CryptoRootStatus" AS ENUM ('ACTIVE', 'RECOVERY_ONLY', 'DISABLED');

-- CreateEnum
CREATE TYPE "SecretEncryptionMode" AS ENUM ('CLIENT_E2E_V1');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('MANUAL', 'STRIPE', 'CRYPTO', 'FREE_INTERNAL');

-- CreateEnum
CREATE TYPE "CreatorBillingTier" AS ENUM ('STARTER', 'GROWTH', 'PRO', 'ELITE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'THREE_MONTHS', 'SIX_MONTHS');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('NOWPAYMENTS');

-- CreateEnum
CREATE TYPE "BillingEntitlementSource" AS ENUM ('PAYMENT', 'ADMIN', 'LEGACY', 'WALLET');

-- CreateEnum
CREATE TYPE "BillingOrderPurpose" AS ENUM ('SUBSCRIPTION', 'WALLET_TOP_UP');

-- CreateEnum
CREATE TYPE "BillingWalletTransactionType" AS ENUM ('TOP_UP', 'SUBSCRIPTION_DEBIT', 'TOP_UP_REFUND', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CreatorBillingPeriodStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'LEGACY');

-- CreateEnum
CREATE TYPE "BillingOrderStatus" AS ENUM ('CREATED', 'CHECKOUT_CREATED', 'PROCESSING', 'PARTIALLY_PAID', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CreatorMediaAssetSource" AS ENUM ('GENERAL', 'CUSTOM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "avatarRevision" INTEGER NOT NULL DEFAULT 0,
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "AgencyCreatorCatalogState" (
    "agencyId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyCreatorCatalogState_pkey" PRIMARY KEY ("agencyId")
);

-- CreateTable
CREATE TABLE "AgencyTelegramMtprotoAccount" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "apiId" INTEGER NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "runtimeClaimedByDeviceId" TEXT,
    "runtimeClaimToken" TEXT,
    "runtimeClaimUntil" TIMESTAMP(3),
    "runtimeLeaseUserId" TEXT,
    "runtimeLeaseMemberId" TEXT,
    "runtimeLeaseAccessEpoch" INTEGER,
    "runtimeLeaseCreatorId" TEXT,
    "runtimeClaimGeneration" INTEGER NOT NULL DEFAULT 0,
    "runtimeDrainedGeneration" INTEGER NOT NULL DEFAULT 0,
    "runtimeClaimInboundEligible" BOOLEAN NOT NULL DEFAULT false,
    "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE',
    "retirementRequestedAt" TIMESTAMP(3),
    "retirementDrainCompletedAt" TIMESTAMP(3),

    CONSTRAINT "AgencyTelegramMtprotoAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "AgencyMemberAccessEpochBoundary" (
    "memberId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessEpoch" INTEGER NOT NULL,
    "nextAccessEpoch" INTEGER NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyMemberAccessEpochBoundary_pkey" PRIMARY KEY ("memberId","accessEpoch")
);

-- CreateTable
CREATE TABLE "TeamMemberFunction" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "functionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMemberFunction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "avatarRevision" INTEGER NOT NULL DEFAULT 0,
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
    "customsVaultRevision" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrder" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "createdByMemberId" TEXT NOT NULL,
    "clientMutationId" TEXT,
    "clientMutationFingerprint" TEXT,
    "scenario" TEXT NOT NULL,
    "internalNote" TEXT,
    "type" "CustomOrderType" NOT NULL DEFAULT 'CONTENT',
    "contentKind" "CustomOrderContentKind",
    "status" "CustomOrderStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "physicalStatus" "CustomOrderPhysicalStatus",
    "physicalStatusChangedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "fanDeliveredAt" TIMESTAMP(3),
    "deliverySentMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliveryMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliveryOfferedCents" INTEGER NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "telegramCancellationWaivedAt" TIMESTAMP(3),
    "telegramCancellationWaiverReason" TEXT,
    "mediaIds" TEXT NOT NULL DEFAULT '',
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "paidAmountCents" INTEGER NOT NULL DEFAULT 0,
    "telegramTaskMessageId" INTEGER,
    "contentBoundAt" TIMESTAMP(3),
    "telegramReferenceMessageIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "telegramLastModelMessageId" INTEGER,
    "telegramLastModelMessageAt" TIMESTAMP(3),
    "reminderConfig" JSONB,
    "nextReminderAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "lastReminderKey" TEXT,
    "reminderClaimToken" TEXT,
    "reminderClaimUntil" TIMESTAMP(3),
    "reminderClaimedByDeviceId" TEXT,
    "reminderLeaseUserId" TEXT,
    "reminderLeaseMemberId" TEXT,
    "reminderLeaseAccessEpoch" INTEGER,
    "providerOperationalDirty" BOOLEAN NOT NULL DEFAULT true,
    "providerOperationalProjectedAt" TIMESTAMP(3),
    "providerOperationalProjectionVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderOperationalDebt" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "creatorId" TEXT,
    "debtClass" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "customOrderId" TEXT,
    "customSubmissionId" TEXT,
    "intentId" TEXT,
    "reason" TEXT,
    "sourceVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderOperationalDebt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomContentSubmission" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "customOrderId" TEXT,
    "bindingRevision" INTEGER NOT NULL DEFAULT 1,
    "reviewDecisionRevision" INTEGER NOT NULL DEFAULT 0,
    "telegramMessageIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "telegramInboundEventIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "telegramSourceKey" TEXT,
    "telegramSourceAccountId" TEXT,
    "telegramSourceUserId" TEXT,
    "sourceAuthority" TEXT NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
    "sourceThreadIntentId" TEXT,
    "sourceResolutionEventId" TEXT,
    "ofMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comment" TEXT,
    "executionVaultFolderId" TEXT,
    "executionRelayRecipient" TEXT,
    "executionProfileRevision" INTEGER NOT NULL DEFAULT 0,
    "executionPinnedAt" TIMESTAMP(3),
    "vaultSettlementFolderId" TEXT,
    "vaultSettlementProfileRevision" INTEGER,
    "vaultSettlementMediaFingerprint" TEXT,
    "vaultSettlementConfirmedAt" TIMESTAMP(3),
    "vaultSettlementConfirmedByDeviceId" TEXT,
    "pipelineDisposition" TEXT NOT NULL DEFAULT 'ACTIVE',
    "pipelineDispositionReason" TEXT,
    "pipelineDispositionChangedAt" TIMESTAMP(3),
    "pipelineBlockedCode" TEXT,
    "pipelineBlockedAt" TIMESTAMP(3),
    "pipelineLastAttemptAt" TIMESTAMP(3),
    "pipelineNextAttemptAt" TIMESTAMP(3),
    "reviewStatus" "CustomContentReviewStatus" NOT NULL DEFAULT 'WAITING_REVIEW',
    "reviewComment" TEXT,
    "reviewedByMemberId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomContentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomContentReviewDecision" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "customOrderId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "decisionRevision" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "actorMemberId" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "supersedesDecisionRevision" INTEGER,
    "supersessionReason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANAGER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomContentReviewDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomDeliveryReceipt" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "customOrderId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "writeId" TEXT,
    "writeCommitRevision" INTEGER,
    "idempotencyKey" TEXT,
    "dialogId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "actorMemberId" TEXT,
    "actorUserId" TEXT,
    "sentMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvedMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchedMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "newlyDeliveredMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliveredMediaIdsAfter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "duplicateMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedPriceCents" INTEGER NOT NULL DEFAULT 0,
    "actualPriceCents" INTEGER NOT NULL DEFAULT 0,
    "totalPriceCents" INTEGER NOT NULL DEFAULT 0,
    "paidAmountCents" INTEGER NOT NULL DEFAULT 0,
    "remainingAmountCents" INTEGER NOT NULL DEFAULT 0,
    "previousDeliveryOfferedCents" INTEGER NOT NULL DEFAULT 0,
    "deliveryOfferedCents" INTEGER NOT NULL DEFAULT 0,
    "paymentStatus" TEXT,
    "paymentMismatch" TEXT,
    "overrideReason" TEXT,
    "duplicateOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "priceMismatchOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "receiptFingerprint" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomDeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramDeliveryIntent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "customOrderId" TEXT NOT NULL,
    "customSubmissionId" TEXT,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "logicalKey" TEXT NOT NULL,
    "clientIntentId" TEXT,
    "referenceOrdinal" INTEGER,
    "payloadFingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "state" TEXT NOT NULL DEFAULT 'PLANNED',
    "deviceId" TEXT,
    "userId" TEXT,
    "memberId" TEXT,
    "accessEpoch" INTEGER,
    "claimTokenHash" TEXT,
    "claimRevision" INTEGER NOT NULL DEFAULT 0,
    "claimUntil" TIMESTAMP(3),
    "commitStartedAt" TIMESTAMP(3),
    "remoteMessageId" INTEGER,
    "remoteRecipientTelegramUserId" TEXT,
    "remoteSentAt" TIMESTAMP(3),
    "outcomeReason" TEXT,
    "providerBindingRepairAttempts" INTEGER NOT NULL DEFAULT 0,
    "providerBindingRetryAt" TIMESTAMP(3),
    "confirmationAuthority" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "projectionBlockedCode" TEXT,
    "projectionBlockedAt" TIMESTAMP(3),
    "projectionLastAttemptAt" TIMESTAMP(3),
    "projectionAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramDeliveryIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramInboundEvent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "creatorId" TEXT,
    "customOrderId" TEXT,
    "submissionId" TEXT,
    "senderTelegramUserId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "replyToMessageId" INTEGER,
    "groupedId" TEXT,
    "hasMedia" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectionState" TEXT NOT NULL DEFAULT 'PENDING',
    "projectionReason" TEXT,
    "projectionAttempts" INTEGER NOT NULL DEFAULT 0,
    "projectedAt" TIMESTAMP(3),
    "intakeAuthority" TEXT NOT NULL DEFAULT 'PROVIDER_OBSERVATION',
    "threadResolutionType" TEXT,
    "threadAnchorIntentId" TEXT,
    "resolutionAuthority" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvatarAsset" (
    "id" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvatarAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthMailOutbox" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authTokenId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "providerId" TEXT,
    "lastCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthMailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "codeHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "deviceId" TEXT,
    "client" TEXT,
    "rememberDevice" BOOLEAN NOT NULL DEFAULT false,
    "impersonatedByAdminId" TEXT,
    "authorizationSessionId" TEXT,

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorizationSessionBoundary" (
    "authorizationSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "deviceId" TEXT,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthorizationSessionBoundary_pkey" PRIMARY KEY ("authorizationSessionId")
);

-- CreateTable
CREATE TABLE "AgencyCreatorCatalogGenerationBoundary" (
    "agencyId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "nextGeneration" INTEGER NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyCreatorCatalogGenerationBoundary_pkey" PRIMARY KEY ("agencyId","generation")
);

-- CreateTable
CREATE TABLE "CreatorSessionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "CreatorSessionStateStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "portableReady" BOOLEAN NOT NULL DEFAULT false,
    "encryptionMode" "SecretEncryptionMode" NOT NULL DEFAULT 'CLIENT_E2E_V1',
    "keyVersion" INTEGER,
    "encryptedPayload" TEXT,
    "iv" TEXT,
    "tag" TEXT,
    "algorithm" TEXT,
    "platformUserId" TEXT,
    "credentialHash" TEXT,
    "coherenceHash" TEXT,
    "capturedAt" TIMESTAMP(3),
    "capturedByUserId" TEXT,
    "capturedByDeviceId" TEXT,
    "sourceRequestId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSessionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyProxyEndpoint" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "ownerCreatorId" TEXT,
    "label" TEXT NOT NULL,
    "type" "AgencyProxyType" NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "encryptedPayload" TEXT,
    "iv" TEXT,
    "tag" TEXT,
    "algorithm" TEXT,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "encryptionMode" "SecretEncryptionMode" NOT NULL DEFAULT 'CLIENT_E2E_V1',
    "keyVersion" INTEGER,
    "hasCredentials" BOOLEAN NOT NULL DEFAULT false,
    "usernameHint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyProxyEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorNetworkProfile" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "mode" "CreatorNetworkMode" NOT NULL DEFAULT 'DIRECT',
    "proxyEndpointId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorNetworkProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCryptoIdentity" (
    "deviceId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'x25519-spki-der-v1',
    "fingerprint" TEXT NOT NULL,
    "status" "CryptoIdentityStatus" NOT NULL DEFAULT 'PENDING',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCryptoIdentity_pkey" PRIMARY KEY ("agencyId","deviceId")
);

-- CreateTable
CREATE TABLE "AgencyCryptoRoot" (
    "agencyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "CryptoRootStatus" NOT NULL DEFAULT 'ACTIVE',
    "recoveryCiphertext" TEXT NOT NULL,
    "recoveryIv" TEXT NOT NULL,
    "recoveryTag" TEXT NOT NULL,
    "recoveryAlgorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm-recovery-v1',
    "recoveryFormatVersion" INTEGER NOT NULL DEFAULT 1,
    "recoveryProofHash" TEXT,
    "initializedByDeviceId" TEXT,
    "initializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyCryptoRoot_pkey" PRIMARY KEY ("agencyId")
);

-- CreateTable
CREATE TABLE "AgencyCryptoOwnerKeyWrap" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "rootVersion" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ephemeralPublicKey" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'x25519-hkdf-sha256-aes-256-gcm-v1',
    "createdByDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AgencyCryptoOwnerKeyWrap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyCryptoRootBridge" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm-root-bridge-v1',
    "createdByDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "AgencyCryptoRootBridge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorCryptoKeyState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "activeVersion" INTEGER NOT NULL DEFAULT 1,
    "rootVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorCryptoKeyState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorDeviceKeyWrap" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ephemeralPublicKey" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'x25519-hkdf-sha256-aes-256-gcm-v1',
    "createdByDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CreatorDeviceKeyWrap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerDevice" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "AdminUser" (
    "accessEpoch" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "issuedAccessEpoch" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingReconciliationCursor" (
    "id" TEXT NOT NULL,
    "lastAgencyId" TEXT,
    "ownerToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "cycle" INTEGER NOT NULL DEFAULT 0,
    "lastCompletedAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAgencyId" TEXT,
    "lastErrorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingReconciliationCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "CreatorBillingProfile" (
    "corePriceOverrideCents" INTEGER,
    "aiChatterPriceOverrideCents" INTEGER,
    "outreachPriceOverrideCents" INTEGER,
    "pricingRevision" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "tier" "CreatorBillingTier" NOT NULL DEFAULT 'STARTER',
    "tierMode" TEXT NOT NULL DEFAULT 'AUTO',
    "corePriceCents" INTEGER NOT NULL DEFAULT 2000,
    "revenue30dCents" INTEGER NOT NULL DEFAULT 0,
    "aiChatterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 10000,
    "outreachEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outreachPriceCents" INTEGER NOT NULL DEFAULT 2900,
    "billingExcluded" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorBillingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOrder" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "provider" "BillingProvider" NOT NULL DEFAULT 'NOWPAYMENTS',
    "purpose" "BillingOrderPurpose" NOT NULL DEFAULT 'SUBSCRIPTION',
    "status" "BillingOrderStatus" NOT NULL DEFAULT 'CREATED',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingPeriod" "BillingPeriod" NOT NULL,
    "periodMonths" INTEGER NOT NULL,
    "billedCreators" INTEGER NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "requestHash" TEXT,
    "providerInvoiceId" TEXT,
    "providerInvoiceUrl" TEXT,
    "providerStatus" TEXT,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "checkoutKey" TEXT,
    "paidAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "creatorName" TEXT NOT NULL,
    "creatorUsername" TEXT,
    "tier" "CreatorBillingTier" NOT NULL,
    "corePriceCents" INTEGER NOT NULL,
    "aiChatterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 0,
    "outreachEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outreachPriceCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyCents" INTEGER NOT NULL,
    "periodMonths" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,
    "previousTier" "CreatorBillingTier",
    "corePreviousSource" "BillingEntitlementSource",
    "corePreviousPriceCents" INTEGER,
    "corePreviousValidUntil" TIMESTAMP(3),
    "coreGrantedUntil" TIMESTAMP(3),
    "aiPreviousSource" "BillingEntitlementSource",
    "aiPreviousPriceCents" INTEGER,
    "aiPreviousValidUntil" TIMESTAMP(3),
    "aiGrantedUntil" TIMESTAMP(3),
    "outreachPreviousSource" "BillingEntitlementSource",
    "outreachPreviousPriceCents" INTEGER,
    "outreachPreviousValidUntil" TIMESTAMP(3),
    "outreachGrantedUntil" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "AgencyBillingWallet" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "balanceCents" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyBillingWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingWalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT,
    "orderId" TEXT,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "periodId" TEXT,
    "type" "BillingWalletTransactionType" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "balanceAfterCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingWalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorBillingPeriod" (
    "commercialPolicyRevision" INTEGER,
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "tier" "CreatorBillingTier" NOT NULL,
    "revenue30dCents" INTEGER NOT NULL,
    "revenueCapturedAt" TIMESTAMP(3),
    "pricingSource" TEXT NOT NULL DEFAULT 'AUTO_30D',
    "corePriceCents" INTEGER NOT NULL,
    "aiChatterEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiChatterPriceCents" INTEGER NOT NULL DEFAULT 0,
    "outreachEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outreachPriceCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "CreatorBillingPeriodStatus" NOT NULL DEFAULT 'ACTIVE',
    "renewalKey" TEXT NOT NULL,
    "walletTransactionId" TEXT,
    "sourceOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorBillingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPaymentAttempt" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'NOWPAYMENTS',
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "providerPaymentId" TEXT NOT NULL,
    "providerStatus" TEXT,
    "payAddress" TEXT,
    "payinExtraId" TEXT,
    "purchaseId" TEXT,
    "priceAmount" DECIMAL(30,12),
    "priceCurrency" TEXT,
    "payAmount" DECIMAL(30,12),
    "payCurrency" TEXT,
    "actuallyPaid" DECIMAL(30,12),
    "outcomeAmount" DECIMAL(30,12),
    "outcomeCurrency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'NOWPAYMENTS',
    "eventKey" TEXT NOT NULL,
    "orderId" TEXT,
    "paymentAttemptId" TEXT,
    "providerStatus" TEXT,
    "signature" TEXT,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,

    CONSTRAINT "BillingProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminActionLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "agencyId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyCustomRole" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tone" TEXT,
    "description" TEXT,
    "access" JSONB NOT NULL DEFAULT '{}',
    "basedOn" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyCustomRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyRoleOverride" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "access" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyRoleOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencySubPermissionOverride" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "subPermKey" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencySubPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyInvitation" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT,
    "roleKey" TEXT NOT NULL,
    "displayName" TEXT,
    "assignedCreators" JSONB,
    "commission" JSONB,
    "functions" JSONB,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedByUserId" TEXT,
    "claimedMemberId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorFan" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "onlyFansUserId" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "headerUrl" TEXT,
    "identityObservedAt" TIMESTAMP(3),
    "identitySource" TEXT,
    "identityCompleteness" TEXT,
    "identityAuthorityVersion" TEXT,
    "usernameAuthorityVersion" TEXT,
    "displayNameAuthorityVersion" TEXT,
    "avatarAuthorityVersion" TEXT,
    "headerAuthorityVersion" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorFanRelationshipCurrent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanRecordId" TEXT NOT NULL,
    "onlyFansUserId" TEXT NOT NULL,
    "fanSubscribesToCreator" BOOLEAN,
    "fanSubscriptionActive" BOOLEAN,
    "fanSubscriptionType" TEXT,
    "fanSubscriptionExpiresAt" TIMESTAMP(3),
    "creatorFollowsFan" BOOLEAN,
    "creatorFollowExpiresAt" TIMESTAMP(3),
    "canReceiveChatMessage" BOOLEAN,
    "blocked" BOOLEAN,
    "restricted" BOOLEAN,
    "performer" BOOLEAN,
    "lastSeenAt" TIMESTAMP(3),
    "subscribePriceCents" INTEGER,
    "relationshipAuthorityVersion" TEXT,
    "fanSubscribesToCreatorAuthorityVersion" TEXT,
    "fanSubscriptionActiveAuthorityVersion" TEXT,
    "fanSubscriptionTypeAuthorityVersion" TEXT,
    "fanSubscriptionExpiresAtAuthorityVersion" TEXT,
    "creatorFollowsFanAuthorityVersion" TEXT,
    "creatorFollowExpiresAtAuthorityVersion" TEXT,
    "canReceiveChatMessageAuthorityVersion" TEXT,
    "blockedAuthorityVersion" TEXT,
    "restrictedAuthorityVersion" TEXT,
    "performerAuthorityVersion" TEXT,
    "lastSeenAtAuthorityVersion" TEXT,
    "subscribePriceCentsAuthorityVersion" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "sourceDeliveryId" TEXT,
    "scanRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFanRelationshipCurrent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorFanValueCurrent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "totalNetCents" BIGINT,
    "messagesNetCents" BIGINT,
    "subscriptionsNetCents" BIGINT,
    "tipsNetCents" BIGINT,
    "postsNetCents" BIGINT,
    "streamsNetCents" BIGINT,
    "lastActivityAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "source" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "valueAuthorityVersion" TEXT,
    "availabilityAuthorityVersion" TEXT,
    "platformReportedTotalSpendCentsAuthorityVersion" TEXT,
    "messagesSpentCentsAuthorityVersion" TEXT,
    "subscriptionsSpentCentsAuthorityVersion" TEXT,
    "tipsSpentCentsAuthorityVersion" TEXT,
    "postsSpentCentsAuthorityVersion" TEXT,
    "streamsSpentCentsAuthorityVersion" TEXT,
    "lastActivityAtAuthorityVersion" TEXT,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "sourceDeliveryId" TEXT,
    "scanRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFanValueCurrent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorNotificationSyncState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "scanRunId" TEXT,
    "activeGeneration" TEXT,
    "activeRequestedAt" TIMESTAMP(3),
    "retryAfterAt" TIMESTAMP(3),
    "nextCursor" TEXT,
    "headNotificationId" TEXT,
    "tailNotificationId" TEXT,
    "oldestOccurredAt" TIMESTAMP(3),
    "newestOccurredAt" TIMESTAMP(3),
    "pagesScanned" INTEGER NOT NULL DEFAULT 0,
    "eventsAccepted" INTEGER NOT NULL DEFAULT 0,
    "eventsRejected" INTEGER NOT NULL DEFAULT 0,
    "ignoredEvents" INTEGER NOT NULL DEFAULT 0,
    "fullBackfillCompletedAt" TIMESTAMP(3),
    "fullBackfillVerifiedAt" TIMESTAMP(3),
    "fullBackfillObservedAt" TIMESTAMP(3),
    "lastCatchupCompletedAt" TIMESTAMP(3),
    "lastCatchupVerifiedAt" TIMESTAMP(3),
    "lastCatchupObservedAt" TIMESTAMP(3),
    "lastSocketEventAt" TIMESTAMP(3),
    "knownNotificationIds" JSONB NOT NULL DEFAULT '[]',
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorNotificationSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorFinancialCollectionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "activeGeneration" TEXT,
    "activeRequestedAt" TIMESTAMP(3),
    "baselineVerifiedAt" TIMESTAMP(3),
    "baselineObservedAt" TIMESTAMP(3),
    "baselineGeneration" TEXT,
    "baselineRangeFrom" TIMESTAMP(3),
    "baselineRangeTo" TIMESTAMP(3),
    "lastCatchupCompletedAt" TIMESTAMP(3),
    "lastCatchupObservedAt" TIMESTAMP(3),
    "lastCatchupGeneration" TEXT,
    "lastBoundary" TEXT,
    "retryAfterAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "receiptCoverageVersion" INTEGER NOT NULL DEFAULT 0,
    "coverageThrough" TIMESTAMP(3),
    "recentRangeFrom" TIMESTAMP(3),
    "recentRangeTo" TIMESTAMP(3),
    "historyAuditCursor" TIMESTAMP(3),
    "historyAuditCycleStartedAt" TIMESTAMP(3),
    "historyAuditObservedAt" TIMESTAMP(3),
    "historyAuditCompletedAt" TIMESTAMP(3),

    CONSTRAINT "CreatorFinancialCollectionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignFanRefreshPromotionSignal" (
    "healAfterId" VARCHAR(180) NOT NULL DEFAULT '',
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(64) NOT NULL DEFAULT 'QUEUED_DEBT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimToken" VARCHAR(120),
    "claimUntil" TIMESTAMP(3),
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignFanRefreshPromotionSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "CreatorCampaignFanRefreshWork" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "scanRunId" VARCHAR(120) NOT NULL,
    "scanStartedAt" TIMESTAMP(3) NOT NULL,
    "onlyFansUserId" VARCHAR(180) NOT NULL,
    "campaignJobId" TEXT NOT NULL,
    "refreshJobId" TEXT,
    "demandId" TEXT,
    "requestedRevision" INTEGER NOT NULL DEFAULT 1,
    "freshnessCutoffAt" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    "outcome" VARCHAR(32),
    "observedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" VARCHAR(1000),
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCampaignFanRefreshWork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorCampaignCollectionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "activeGeneration" TEXT,
    "activeRequestedAt" TIMESTAMP(3),
    "baselineVerifiedAt" TIMESTAMP(3),
    "baselineObservedAt" TIMESTAMP(3),
    "baselineGeneration" TEXT,
    "lastCatchupCompletedAt" TIMESTAMP(3),
    "lastCatchupObservedAt" TIMESTAMP(3),
    "lastCatchupGeneration" TEXT,
    "lastCompleteScanRunId" TEXT,
    "campaignProofScanRunId" VARCHAR(120),
    "campaignProofCollectorVersion" VARCHAR(80),
    "campaignProofCampaignBatches" INTEGER NOT NULL DEFAULT 0,
    "campaignProofClaimerBatches" INTEGER NOT NULL DEFAULT 0,
    "campaignProofRejectedBatches" INTEGER NOT NULL DEFAULT 0,
    "campaignProofRejectedRows" INTEGER NOT NULL DEFAULT 0,
    "membershipBaselineVerifiedAt" TIMESTAMP(3),
    "membershipBaselineObservedAt" TIMESTAMP(3),
    "membershipBaselineGeneration" TEXT,
    "membershipCatchupVerifiedAt" TIMESTAMP(3),
    "membershipCatchupObservedAt" TIMESTAMP(3),
    "membershipCatchupGeneration" TEXT,
    "membershipCoverageStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "membershipCoverageCompletedAt" TIMESTAMP(3),
    "membershipObservedAt" TIMESTAMP(3),
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
    "campaignFrontierObservationVersion" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierSelection" JSONB NOT NULL DEFAULT '{}',
    "campaignDirectoryFactsRevision" BIGINT NOT NULL DEFAULT 0,
    "campaignDirectoryCountRevision" BIGINT,
    "campaignFrontierFreshnessStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "campaignFrontierDueCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierTargetCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierCompletedCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierDeferredCount" INTEGER NOT NULL DEFAULT 0,
    "campaignFrontierOldestDueAt" TIMESTAMP(3),
    "campaignFrontierNextEligibleAt" TIMESTAMP(3),
    "campaignFrontierScheduleVersion" INTEGER NOT NULL DEFAULT 0,
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

-- CreateTable
CREATE TABLE "CreatorNotificationScanItem" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sourceJobId" TEXT NOT NULL,
    "scanRunId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "notificationId" TEXT,
    "sourceType" TEXT,
    "sourceSubType" TEXT,
    "factType" "CreatorNotificationScanFactType",
    "occurredAt" TIMESTAMP(3),
    "fanOnlyFansUserId" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "postId" TEXT,
    "commentId" TEXT,
    "messageId" TEXT,
    "amountCents" INTEGER,
    "currency" TEXT,
    "outcome" "CreatorNotificationScanOutcome" NOT NULL,
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorNotificationScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsIngestBatch" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "dataType" "AnalyticsDataType" NOT NULL,
    "status" "AnalyticsIngestStatus" NOT NULL DEFAULT 'RECEIVED',
    "rangeFrom" TIMESTAMP(3) NOT NULL,
    "rangeTo" TIMESTAMP(3) NOT NULL,
    "sourceTimezone" TEXT NOT NULL,
    "collectorVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "payloadChecksum" TEXT NOT NULL,
    "receivedRows" INTEGER NOT NULL DEFAULT 0,
    "insertedRows" INTEGER NOT NULL DEFAULT 0,
    "updatedRows" INTEGER NOT NULL DEFAULT 0,
    "unchangedRows" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsIngestBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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
    "observationStartedAt" TIMESTAMP(3),
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
    "proofVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AnalyticsScanProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLaneState" (
    "key" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "activeGeneration" TEXT,
    "ownerToken" TEXT,
    "claimFence" BIGINT NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cursor" JSONB,
    "progress" JSONB,
    "lastRunAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceLaneState_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DomainWorkItem" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "parentObjectId" TEXT,
    "partitionKey" TEXT NOT NULL,
    "creatorId" TEXT,
    "accountId" TEXT,
    "requestedRevision" BIGINT NOT NULL DEFAULT 1,
    "completedRevision" BIGINT NOT NULL DEFAULT 0,
    "activeGeneration" TEXT NOT NULL DEFAULT 'phase2_domain_work_v3_actual55',
    "projectionVersion" TEXT NOT NULL DEFAULT 'phase2_domain_work_v3_actual55',
    "state" TEXT NOT NULL DEFAULT 'READY',
    "isOutstanding" BOOLEAN NOT NULL DEFAULT true,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3),
    "ownerToken" TEXT,
    "claimFence" BIGINT NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "claimedRevision" BIGINT NOT NULL DEFAULT 0,
    "claimExecutionGeneration" TEXT,
    "progressCursor" JSONB,
    "dependencyKind" TEXT,
    "dependencyKey" TEXT,
    "dependencyRevision" BIGINT NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureRevision" BIGINT NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3),
    "lastRepair" JSONB,
    "errorClass" TEXT,
    "lastError" TEXT,
    "terminalCause" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Phase2WorkGenerationAuthority" (
    "workClass" TEXT NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "projectionVersion" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "previousGeneration" TEXT,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phase2WorkGenerationAuthority_pkey" PRIMARY KEY ("workClass")
);

-- CreateTable
CREATE TABLE "Phase2WorkFamilyState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "outstandingCount" INTEGER NOT NULL DEFAULT 0,
    "requestedSequence" BIGINT NOT NULL DEFAULT 0,
    "convergedSequence" BIGINT NOT NULL DEFAULT 0,
    "lastRequestedAt" TIMESTAMP(3),
    "lastBroadClaimedAt" TIMESTAMP(3),
    "lastConvergedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phase2WorkFamilyState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Phase2WorkBroadClaimPartitionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "partitionKey" TEXT NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "outstandingCount" INTEGER NOT NULL DEFAULT 0,
    "claimShard" INTEGER NOT NULL DEFAULT 0,
    "nextClaimableAt" TIMESTAMP(3),
    "lastClaimedAt" TIMESTAMP(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phase2WorkBroadClaimPartitionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainWorkClaimAgencyState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "nextDispatchAt" TIMESTAMP(3) NOT NULL,
    "lastSelectedAt" TIMESTAMP(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainWorkClaimAgencyState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainWorkClaimShardState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "claimShard" INTEGER NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "nextDispatchAt" TIMESTAMP(3) NOT NULL,
    "lastSelectedAt" TIMESTAMP(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainWorkClaimShardState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "DomainWorkMemberScopeShardState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "accessEpoch" INTEGER NOT NULL,
    "claimShard" INTEGER NOT NULL,
    "cursorCreatorId" TEXT,
    "lastSelectedAt" TIMESTAMP(3),
    "revision" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainWorkMemberScopeShardState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE UNLOGGED TABLE "DomainWorkClaimLocatorMutationBatch" (
    "txId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainWorkClaimLocatorMutationBatch_pkey" PRIMARY KEY ("txId")
);

-- CreateTable
CREATE UNLOGGED TABLE "DomainWorkClaimLocatorMutationIntent" (
    "txId" BIGINT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "partitionKey" TEXT NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainWorkClaimLocatorMutationIntent_identity_key" PRIMARY KEY ("txId","agencyId","workClass","partitionKey")
);

-- CreateTable
CREATE TABLE "DomainWorkReadyPartition" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "partitionKey" TEXT NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "headWorkId" TEXT NOT NULL,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainWorkReadyPartition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainWorkReadyAgency" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "workClass" TEXT NOT NULL,
    "activeGeneration" TEXT NOT NULL,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainWorkReadyAgency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Phase2WorkCoverage" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "enumerationState" TEXT NOT NULL DEFAULT 'PENDING',
    "enumeratedThrough" TEXT,
    "projectedThrough" TEXT,
    "unresolvedCount" INTEGER NOT NULL DEFAULT 0,
    "retainedFrom" TIMESTAMP(3),
    "sourceWatermark" TEXT,
    "activatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phase2WorkCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Phase2DependencyState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "dependencyKind" TEXT NOT NULL,
    "dependencyKey" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Phase2DependencyState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionSweepLease" (
    "key" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionSweepLease_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AnalyticsCollectionLease" (
    "key" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "cycleNow" TIMESTAMP(3) NOT NULL,
    "cursorCreatorId" TEXT,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsCollectionLease_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AnalyticsPlanningBudget" (
    "id" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "reservedCalls" INTEGER NOT NULL,
    "reservedJobs" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsPlanningBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsCollectionDemand" (
    "scopeMode" TEXT NOT NULL DEFAULT 'LEGACY',
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

-- CreateTable
CREATE TABLE "CreatorFinancialTransaction" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT,
    "fanOnlyFansUserId" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "externalTransactionId" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "factType" "CreatorFinancialTransactionFactType" NOT NULL DEFAULT 'OTHER',
    "projectionStatus" "CreatorFinancialTransactionProjectionStatus" NOT NULL DEFAULT 'STORED_ONLY',
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER,
    "netCents" INTEGER,
    "taxCents" INTEGER,
    "vatCents" INTEGER,
    "mediaTaxCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "transactionStatus" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "scanRunId" TEXT,
    "page" INTEGER,
    "ordinal" INTEGER,
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFinancialTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorEarningsTotal" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "category" "CreatorEarningsCategory" NOT NULL,
    "rangeFrom" TIMESTAMP(3) NOT NULL,
    "rangeTo" TIMESTAMP(3) NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "netCents" INTEGER NOT NULL,
    "transactionsCount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "scanRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorEarningsTotal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorSale" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT,
    "fanOnlyFansUserIdAtEvent" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "eventFingerprint" TEXT NOT NULL,
    "externalNotificationId" TEXT,
    "externalTransactionId" TEXT,
    "saleType" "CreatorSaleType" NOT NULL DEFAULT 'MESSAGE',
    "messageId" TEXT,
    "postId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER,
    "netCents" INTEGER,
    "taxCents" INTEGER,
    "vatCents" INTEGER,
    "mediaTaxCents" INTEGER,
    "transactionStatus" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
    "sourceUpdatedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorTip" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT,
    "fanOnlyFansUserIdAtEvent" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "eventFingerprint" TEXT NOT NULL,
    "externalNotificationId" TEXT,
    "externalTransactionId" TEXT,
    "messageId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER,
    "netCents" INTEGER,
    "taxCents" INTEGER,
    "vatCents" INTEGER,
    "mediaTaxCents" INTEGER,
    "transactionStatus" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "tippedAt" TIMESTAMP(3) NOT NULL,
    "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
    "sourceUpdatedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorSubscriptionEvent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT,
    "fanOnlyFansUserIdAtEvent" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "eventFingerprint" TEXT NOT NULL,
    "externalNotificationId" TEXT,
    "externalTransactionId" TEXT,
    "eventType" "CreatorSubscriptionEventType" NOT NULL,
    "observedPriceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
    "sourceUpdatedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorSubscriptionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "status" "CreatorSubscriptionStateStatus" NOT NULL DEFAULT 'UNKNOWN',
    "currentPriceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastRenewedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "autoRenewEnabled" BOOLEAN,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "updatedFromEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSubscriptionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPaidSubscription" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT,
    "fanOnlyFansUserIdAtEvent" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "eventFingerprint" TEXT NOT NULL,
    "externalTransactionId" TEXT,
    "subscriptionEventId" TEXT,
    "paymentType" "CreatorPaidSubscriptionPaymentType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER,
    "netCents" INTEGER,
    "taxCents" INTEGER,
    "vatCents" INTEGER,
    "mediaTaxCents" INTEGER,
    "transactionStatus" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "source" "CreatorFactSource" NOT NULL DEFAULT 'NOTIFICATION',
    "sourceUpdatedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPaidSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPostLike" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT,
    "fanOnlyFansUserIdAtEvent" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "eventFingerprint" TEXT NOT NULL,
    "externalNotificationId" TEXT,
    "onlyFansLikeId" TEXT,
    "onlyFansPostId" TEXT NOT NULL,
    "likedAt" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPostLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPostComment" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT,
    "fanOnlyFansUserIdAtEvent" TEXT,
    "fanUsernameAtEvent" TEXT,
    "fanDisplayNameAtEvent" TEXT,
    "fanAvatarUrlAtEvent" TEXT,
    "eventFingerprint" TEXT NOT NULL,
    "externalNotificationId" TEXT,
    "onlyFansCommentId" TEXT,
    "onlyFansPostId" TEXT NOT NULL,
    "commentedAt" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPostComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "CreatorCampaign" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "externalCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaignType" TEXT,
    "trackingCode" TEXT,
    "trackingUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "claimersCount" INTEGER,
    "clicksCount" INTEGER,
    "catchupFrontierHash" VARCHAR(64),
    "catchupFrontierRunId" VARCHAR(120),
    "catchupFrontierStartedAt" TIMESTAMP(3),
    "stagedCatchupFrontierHash" VARCHAR(64),
    "stagedCatchupFrontierRunId" VARCHAR(120),
    "stagedCatchupFrontierStartedAt" TIMESTAMP(3),
    "claimerRevision" INTEGER NOT NULL DEFAULT 1,
    "claimerVerifiedRevision" INTEGER NOT NULL DEFAULT 0,
    "claimersVerifiedAt" TIMESTAMP(3),
    "claimersObservationVersion" INTEGER NOT NULL DEFAULT 0,
    "claimersNextDueAt" TIMESTAMP(3),
    "claimersTargetRunId" VARCHAR(120),
    "claimersLastVerifiedRunId" VARCHAR(120),
    "claimersCursorRunId" VARCHAR(120),
    "claimersCursorPage" INTEGER NOT NULL DEFAULT 0,
    "claimersCursorOffset" INTEGER NOT NULL DEFAULT 0,
    "claimersCursorPending" BOOLEAN NOT NULL DEFAULT false,
    "claimersEligibleAt" TIMESTAMP(3),
    "claimersTraversalRunId" VARCHAR(120),
    "claimersTraversalStartedAt" TIMESTAMP(3),
    "claimersTraversalRevision" INTEGER,
    "claimersTraversalRejectedRows" INTEGER NOT NULL DEFAULT 0,
    "sourceScanRunId" TEXT,
    "sourceScanStartedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorCampaignFrontierFan" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "frontierKind" "CreatorCampaignFrontierKind" NOT NULL,
    "onlyFansUserId" VARCHAR(180) NOT NULL,
    "sourceScanRunId" VARCHAR(120),
    "sourceScanStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCampaignFrontierFan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorCampaignFan" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "externalClaimerId" TEXT,
    "claimerUsernameAtEvent" TEXT,
    "claimerDisplayNameAtEvent" TEXT,
    "claimerAvatarUrlAtEvent" TEXT,
    "attributedAt" TIMESTAMP(3),
    "attributionSource" "CreatorCampaignAttributionSource" NOT NULL DEFAULT 'ONLYFANS_TRACKING',
    "attributionConfidence" "CreatorCampaignAttributionConfidence" NOT NULL DEFAULT 'CONFIRMED',
    "subscriptionEventId" TEXT,
    "sourceScanRunId" TEXT,
    "sourceScanStartedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCampaignFan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorMessagesDaily" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sourceTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "incomingMessages" INTEGER NOT NULL DEFAULT 0,
    "outgoingMessages" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "uniqueDialogs" INTEGER NOT NULL DEFAULT 0,
    "uniqueIncomingFans" INTEGER NOT NULL DEFAULT 0,
    "uniqueOutgoingFans" INTEGER NOT NULL DEFAULT 0,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorMessagesDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorDailyMetrics" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sourceTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "incomingMessages" INTEGER NOT NULL DEFAULT 0,
    "outgoingMessages" INTEGER NOT NULL DEFAULT 0,
    "uniqueDialogs" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "uniqueLikingFans" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "uniqueCommentingFans" INTEGER NOT NULL DEFAULT 0,
    "newSubscribers" INTEGER NOT NULL DEFAULT 0,
    "renewals" INTEGER NOT NULL DEFAULT 0,
    "expiredSubscribers" INTEGER NOT NULL DEFAULT 0,
    "autoRenewDisabled" INTEGER NOT NULL DEFAULT 0,
    "messageSales" INTEGER NOT NULL DEFAULT 0,
    "postSales" INTEGER NOT NULL DEFAULT 0,
    "uniqueBuyers" INTEGER NOT NULL DEFAULT 0,
    "tipsCount" INTEGER NOT NULL DEFAULT 0,
    "tipsCents" INTEGER NOT NULL DEFAULT 0,
    "paidSubscriptions" INTEGER NOT NULL DEFAULT 0,
    "paidSubscriptionsCents" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL DEFAULT 0,
    "totalObservedRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorDailyMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorLocalMessageCoverage" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "oldestMessageAt" TIMESTAMP(3),
    "newestMessageAt" TIMESTAMP(3),
    "dialogsCovered" INTEGER NOT NULL DEFAULT 0,
    "messagesIndexed" INTEGER NOT NULL DEFAULT 0,
    "coverageStatus" "CreatorLocalCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorLocalMessageCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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
    "fairnessActivationState" TEXT NOT NULL DEFAULT 'ACTIVE',
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

-- CreateTable
CREATE TABLE "OfProviderRequestGateWaiter" (
    "ticket" BIGSERIAL NOT NULL,
    "waiterId" TEXT NOT NULL,
    "ownerInstanceId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "source" TEXT,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfProviderRequestGateWaiter_pkey" PRIMARY KEY ("ticket")
);

-- CreateTable
CREATE TABLE "ProviderCapacityDebtState" (
    "id" TEXT NOT NULL,
    "projectionRevision" BIGINT NOT NULL DEFAULT 0,
    "projectionCoverageStatus" TEXT NOT NULL DEFAULT 'PARTIAL',
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

-- CreateTable
CREATE TABLE "FanObservationCreatorClock" (
    "creatorId" TEXT NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FanObservationCreatorClock_pkey" PRIMARY KEY ("creatorId")
);

-- CreateTable
CREATE TABLE "FanObservationToken" (
    "id" BIGSERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "jobId" TEXT,
    "deliveryId" TEXT,
    "agencyId" TEXT,
    "creatorId" TEXT,
    "deviceId" TEXT NOT NULL,
    "leaseRevision" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FanObservationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FanObservationReadLease" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT,
    "token" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "jobId" TEXT,
    "deliveryId" TEXT,
    "deviceId" TEXT NOT NULL,
    "leaseRevision" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FanObservationReadLease_pkey" PRIMARY KEY ("creatorId")
);

-- CreateTable
CREATE TABLE "CreatorTaskActivity" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "mode" TEXT,
    "stage" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTaskActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "payload" JSONB,
    "issuedByAdmin" TEXT,
    "issuedByUser" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "result" JSONB,

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCreatorBinding" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "remoteId" TEXT,
    "username" TEXT,
    "accessEpoch" INTEGER,
    "sessionReadReady" BOOLEAN NOT NULL DEFAULT false,
    "sessionWriteReady" BOOLEAN NOT NULL DEFAULT false,
    "realtimeReady" BOOLEAN NOT NULL DEFAULT false,
    "pageLocalReady" BOOLEAN NOT NULL DEFAULT false,
    "browserMaterialized" BOOLEAN NOT NULL DEFAULT false,
    "browserPresentable" BOOLEAN NOT NULL DEFAULT false,
    "sessionProofEpoch" INTEGER,
    "canonicalRevision" INTEGER,
    "networkRevision" INTEGER,
    "lastCapabilityAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCreatorBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamActivityEvent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "deviceId" TEXT,
    "userId" TEXT,
    "memberId" TEXT,
    "accountId" TEXT,
    "creatorId" TEXT,
    "creatorRef" TEXT,
    "fanId" TEXT,
    "type" TEXT NOT NULL,
    "eventKind" TEXT,
    "actionSource" TEXT,
    "lifecycle" TEXT,
    "dialogId" TEXT,
    "messageId" TEXT,
    "contentId" TEXT,
    "correlationId" TEXT,
    "coverageId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "automationDeliveryId" TEXT,
    "broadcastDispatchId" TEXT,
    "priceCents" INTEGER,
    "currency" TEXT,
    "isPpv" BOOLEAN NOT NULL DEFAULT false,
    "mediaCount" INTEGER NOT NULL DEFAULT 0,
    "ts" TIMESTAMP(3) NOT NULL,
    "localId" TEXT,
    "extra" JSONB,
    "pendingProjectionVersion" TEXT,
    "pendingProjectedAt" TIMESTAMP(3),
    "dialogProjectionVersion" TEXT,
    "dialogProjectedAt" TIMESTAMP(3),
    "historicalProjectionVersion" TEXT,
    "historicalProjectedAt" TIMESTAMP(3),
    "semanticEventKey" TEXT,
    "source" TEXT NOT NULL DEFAULT 'electron',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamShift" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "note" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamShiftCreator" (
    "shiftId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "creatorRefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamShiftCreator_pkey" PRIMARY KEY ("shiftId","creatorId")
);

-- CreateTable
CREATE TABLE "WorkspaceSetting" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleSetting" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'partial',
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationTask" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT,
    "clientId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled automation',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "config" JSONB NOT NULL DEFAULT '{}',
    "triggers" JSONB NOT NULL DEFAULT '{}',
    "rules" JSONB NOT NULL DEFAULT '{}',
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationEvent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "taskId" TEXT,
    "jobId" TEXT,
    "creatorId" TEXT,
    "accountId" TEXT,
    "fanId" TEXT,
    "dialogId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'info',
    "messageId" TEXT,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultUnsortedSnapshot" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "itemsCount" INTEGER NOT NULL DEFAULT 0,
    "unsortedCount" INTEGER NOT NULL DEFAULT 0,
    "sortedCount" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultUnsortedSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneyAttribution" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creatorId" TEXT,
    "accountId" TEXT,
    "fanId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'auto',
    "attributedToMemberId" TEXT,
    "attributedToUserId" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "history" JSONB NOT NULL DEFAULT '[]',
    "autoAttributedToMemberId" TEXT,
    "autoAttributedToUserId" TEXT,
    "autoReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoneyAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorMediaAsset" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "source" "CreatorMediaAssetSource" NOT NULL DEFAULT 'GENERAL',
    "customOrderId" TEXT,
    "customSubmissionId" TEXT,
    "customFullPriceCents" INTEGER,
    "catalogActive" BOOLEAN NOT NULL DEFAULT false,
    "sortingStatus" TEXT NOT NULL DEFAULT 'UNSORTED',
    "mediaType" TEXT NOT NULL DEFAULT 'unknown',
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "thumbUrl" TEXT,
    "previewUrl" TEXT,
    "fullUrl" TEXT,
    "folderIds" JSONB NOT NULL DEFAULT '[]',
    "description" TEXT,
    "manualTags" JSONB NOT NULL DEFAULT '[]',
    "visibleBodyParts" JSONB NOT NULL DEFAULT '[]',
    "accessType" TEXT NOT NULL DEFAULT 'paid',
    "minPriceCents" INTEGER NOT NULL DEFAULT 0,
    "idealPriceCents" INTEGER NOT NULL DEFAULT 0,
    "storylineName" TEXT,
    "storylineOrder" INTEGER,
    "storylineRole" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "metadataUpdatedAt" TIMESTAMP(3),
    "metadataUpdatedByUserId" TEXT,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "notOpenedCount" INTEGER NOT NULL DEFAULT 0,
    "freeCount" INTEGER NOT NULL DEFAULT 0,
    "revenueCents" INTEGER NOT NULL DEFAULT 0,
    "averagePriceCents" INTEGER NOT NULL DEFAULT 0,
    "uniqueBuyers" INTEGER NOT NULL DEFAULT 0,
    "lastSoldAt" TIMESTAMP(3),
    "usageUpdatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorMediaUsageContribution" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceRevision" TEXT NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "soldCount" INTEGER NOT NULL DEFAULT 0,
    "notOpenedCount" INTEGER NOT NULL DEFAULT 0,
    "freeCount" INTEGER NOT NULL DEFAULT 0,
    "revenueCents" INTEGER NOT NULL DEFAULT 0,
    "uniqueBuyers" INTEGER NOT NULL DEFAULT 0,
    "lastSoldAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorMediaUsageContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorMediaUsageSourceState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceRevision" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorMediaUsageSourceState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaLibraryScanItem" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "sortingStatus" TEXT NOT NULL DEFAULT 'UNSORTED',
    "mediaType" TEXT NOT NULL DEFAULT 'unknown',
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "thumbUrl" TEXT,
    "previewUrl" TEXT,
    "fullUrl" TEXT,
    "folderIds" JSONB NOT NULL DEFAULT '[]',
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaLibraryScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "AutomationDelivery" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL DEFAULT 'bumps',
    "actionType" TEXT NOT NULL DEFAULT 'SEND_MESSAGE',
    "targetId" TEXT,
    "idempotencyKey" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "ruleId" TEXT,
    "contentCollectionId" TEXT,
    "fanId" TEXT,
    "dialogId" TEXT,
    "trigger" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduledAt" TIMESTAMP(3),
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "cancelAt" TIMESTAMP(3),
    "claimedByDeviceId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimUntil" TIMESTAMP(3),
    "leaseTokenHash" TEXT,
    "leaseRevision" INTEGER NOT NULL DEFAULT 0,
    "leaseMemberId" TEXT,
    "leaseAccessEpoch" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "failureCode" TEXT,
    "failureCategory" TEXT,
    "reportedFailureCategory" TEXT,
    "originKind" TEXT NOT NULL DEFAULT 'AUTOMATION',
    "sourceDeviceId" TEXT,
    "payloadFingerprint" TEXT,
    "executionKind" TEXT,
    "reconciliationKind" TEXT,
    "writeCommitRevision" INTEGER NOT NULL DEFAULT 0,
    "writeCommitAt" TIMESTAMP(3),
    "lastError" TEXT,
    "messageId" TEXT,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "media" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB NOT NULL DEFAULT '{}',
    "intentAcknowledgedAt" TIMESTAMP(3),
    "remoteLifecycleState" TEXT,
    "remoteTargetId" TEXT,
    "remoteLifecycleObservedAt" TIMESTAMP(3),
    "remoteSettledAt" TIMESTAMP(3),
    "error" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationMonthlyAggregate" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "canceled" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "replied" INTEGER NOT NULL DEFAULT 0,
    "followed" INTEGER NOT NULL DEFAULT 0,
    "unfollowed" INTEGER NOT NULL DEFAULT 0,
    "liked" INTEGER NOT NULL DEFAULT 0,
    "commented" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3),
    "lastAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationMonthlyAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationControlState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "creatorId" TEXT,
    "moduleKey" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationControlState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowBackCandidate" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "dialogId" TEXT,
    "username" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "subscriptionType" TEXT,
    "isActive" BOOLEAN,
    "canReceiveChatMessage" BOOLEAN,
    "subscribedByCreator" BOOLEAN,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "eligibilityReason" TEXT,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "cooldownUntil" TIMESTAMP(3),
    "snapshotRunId" TEXT,
    "latestDeliveryId" TEXT,
    "latestActionType" TEXT,
    "latestStatus" TEXT,
    "latestError" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowBackCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowAutomationCandidate" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "dialogId" TEXT,
    "username" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "subscriptionType" TEXT,
    "isActive" BOOLEAN,
    "subscribedByCreator" BOOLEAN,
    "subscribedOn" BOOLEAN,
    "subscribePriceCents" INTEGER NOT NULL DEFAULT 0,
    "ofBlocked" BOOLEAN NOT NULL DEFAULT false,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "performer" BOOLEAN NOT NULL DEFAULT false,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "eligibilityReason" TEXT,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "phase" TEXT NOT NULL DEFAULT 'IDLE',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "nudgeCount" INTEGER NOT NULL DEFAULT 0,
    "cooldownUntil" TIMESTAMP(3),
    "waitReturnUntil" TIMESTAMP(3),
    "snapshotRunId" TEXT,
    "latestDeliveryId" TEXT,
    "latestActionType" TEXT,
    "latestStatus" TEXT,
    "latestError" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowAutomationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SfsTargetCandidate" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "subscribePriceCents" INTEGER,
    "isWantComments" BOOLEAN,
    "creatorFollowing" BOOLEAN,
    "sourcePostIds" JSONB NOT NULL DEFAULT '[]',
    "state" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "phase" TEXT NOT NULL DEFAULT 'DISCOVERY',
    "eligibilityReason" TEXT,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "usedForever" BOOLEAN NOT NULL DEFAULT false,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "cooldownUntil" TIMESTAMP(3),
    "latestDeliveryId" TEXT,
    "latestActionType" TEXT,
    "latestStatus" TEXT,
    "latestError" TEXT,
    "scanJobId" TEXT,
    "safetyUnfollowDeliveryId" TEXT,
    "commentsPlanned" INTEGER NOT NULL DEFAULT 0,
    "likesPlanned" INTEGER NOT NULL DEFAULT 0,
    "unfollowAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discoveryObservedAt" TIMESTAMP(3),
    "discoverySourceJobId" TEXT,
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SfsTargetCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationBumpFanState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "dialogId" TEXT,
    "lastTemplateId" TEXT,
    "lastStatus" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "lastAnySentAt" TIMESTAMP(3),
    "lastAnyRepliedAt" TIMESTAMP(3),
    "lastBumpSentAt" TIMESTAMP(3),
    "lastTemplateSentAt" TIMESTAMP(3),
    "lastFinalizedAt" TIMESTAMP(3),
    "lastMessageId" TEXT,
    "lastReplyMessageId" TEXT,
    "pendingMessageId" TEXT,
    "pendingDeliveryId" TEXT,
    "pendingCancelAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "templateCooldownUntil" TIMESTAMP(3),
    "lastOnlineAt" TIMESTAMP(3),
    "sendGeneration" INTEGER NOT NULL DEFAULT 0,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "templateIds" JSONB NOT NULL DEFAULT '[]',
    "counters" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationBumpFanState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationContentCandidate" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "ownerFanId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'post',
    "username" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'subscriber_directory',
    "publishedAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canToggleFavorite" BOOLEAN,
    "canViewMedia" BOOLEAN,
    "isFavorite" BOOLEAN,
    "state" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "eligibilityReason" TEXT,
    "skipReason" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "cooldownUntil" TIMESTAMP(3),
    "snapshotRunId" TEXT,
    "latestDeliveryId" TEXT,
    "latestActionType" TEXT,
    "latestStatus" TEXT,
    "latestError" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationContentCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationContentDiscoveryState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "ownerFanId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL DEFAULT 'fan_posts',
    "snapshotRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "contentCount" INTEGER NOT NULL DEFAULT 0,
    "sourceErrors" JSONB NOT NULL DEFAULT '[]',
    "lastScannedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationContentDiscoveryState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberScanRun" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "jobId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'full',
    "sourceType" TEXT NOT NULL DEFAULT 'all',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "pageLimit" INTEGER NOT NULL DEFAULT 100,
    "nextOffset" INTEGER NOT NULL DEFAULT 0,
    "scannedCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenCount" INTEGER NOT NULL DEFAULT 0,
    "hasMore" BOOLEAN,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "fanProjectionStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "fanProjectionCursorOffset" INTEGER NOT NULL DEFAULT 0,
    "fanProjectionCount" INTEGER NOT NULL DEFAULT 0,
    "fanProjectionCompletedAt" TIMESTAMP(3),
    "fanProjectionLastError" VARCHAR(1000),
    "publicationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "publicationGeneration" INTEGER NOT NULL DEFAULT 0,
    "publicationCursorId" VARCHAR(180),
    "publicationPreviousRunId" TEXT,
    "publicationAddedCount" INTEGER NOT NULL DEFAULT 0,
    "publicationChangedCount" INTEGER NOT NULL DEFAULT 0,
    "publicationDisappearedCount" INTEGER NOT NULL DEFAULT 0,
    "publicationStartedAt" TIMESTAMP(3),
    "publicationCompletedAt" TIMESTAMP(3),
    "publicationJobReconciledAt" TIMESTAMP(3),
    "publicationLastError" VARCHAR(1000),
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriberScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberScanPage" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "offset" INTEGER NOT NULL,
    "nextOffset" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenCount" INTEGER NOT NULL DEFAULT 0,
    "hasMore" BOOLEAN NOT NULL,
    "contentHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberScanPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FanConsumerCursor" (
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "consumerKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "afterKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FanConsumerCursor_pkey" PRIMARY KEY ("creatorId","consumerKey")
);

-- CreateTable
CREATE TABLE "SubscriberScanItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "pageOffset" INTEGER,
    "dialogId" TEXT,
    "username" TEXT,
    "name" TEXT,
    "avatarUrl" TEXT,
    "totalSpentCents" INTEGER,
    "messagesSpentCents" INTEGER,
    "tipsSpentCents" INTEGER,
    "subscriptionsSpentCents" INTEGER,
    "postsSpentCents" INTEGER,
    "streamsSpentCents" INTEGER,
    "valueAvailability" TEXT NOT NULL DEFAULT 'NOT_FETCHED',
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIsNull" BOOLEAN NOT NULL DEFAULT false,
    "canReceiveChatMessage" BOOLEAN,
    "isActive" BOOLEAN,
    "subscribedOn" BOOLEAN,
    "subscribedBy" BOOLEAN,
    "subscriptionType" TEXT,
    "fanSubscribesToCreator" BOOLEAN,
    "fanSubscriptionActive" BOOLEAN,
    "fanSubscriptionExpiresAt" TIMESTAMP(3),
    "creatorFollowsFan" BOOLEAN,
    "creatorFollowExpiresAt" TIMESTAMP(3),
    "blocked" BOOLEAN,
    "restricted" BOOLEAN,
    "performer" BOOLEAN,
    "subscribePriceCents" INTEGER,
    "contentHash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriberScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberDirectoryState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "currentRunId" TEXT,
    "previousRunId" TEXT,
    "lastJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EMPTY',
    "scanEveryDays" INTEGER NOT NULL DEFAULT 7,
    "nextScanAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenCount" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "disappearedCount" INTEGER NOT NULL DEFAULT 0,
    "publicationGeneration" INTEGER NOT NULL DEFAULT 0,
    "publishedGeneration" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriberDirectoryState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriberDirectoryMaintenanceSignal" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(64) NOT NULL DEFAULT 'PUBLICATION_DEBT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimToken" VARCHAR(120),
    "claimUntil" TIMESTAMP(3),
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriberDirectoryMaintenanceSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HiddenOnlineUser" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "dialogId" TEXT,
    "username" TEXT,
    "name" TEXT,
    "totalSpentCents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "signals" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "lastSignalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HiddenOnlineUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogScanState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "fanId" TEXT,
    "initialScanComplete" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "scanMode" TEXT NOT NULL DEFAULT 'initial',
    "newestMessageId" TEXT,
    "newestMessageAt" TIMESTAMP(3),
    "oldestMessageId" TEXT,
    "oldestMessageAt" TIMESTAMP(3),
    "forwardCursor" TEXT,
    "backwardCursor" TEXT,
    "confirmedWatermarkMessageId" TEXT,
    "confirmedWatermarkAt" TIMESTAMP(3),
    "incrementalGapOpen" BOOLEAN NOT NULL DEFAULT false,
    "lastFullScanAt" TIMESTAMP(3),
    "lastIncrementalScanAt" TIMESTAMP(3),
    "lastWsEventAt" TIMESTAMP(3),
    "lastCatchupAt" TIMESTAMP(3),
    "lastError" TEXT,
    "activeRunId" TEXT,
    "activeJobId" TEXT,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "messagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "mediaProcessed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DialogScanState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogReconciliationTarget" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fanId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'targeted_reconciliation',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 120,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DialogReconciliationTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogScanRun" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "fanId" TEXT,
    "jobId" TEXT,
    "mode" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "continuation" JSONB,
    "progress" JSONB,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "messagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "mediaProcessed" INTEGER NOT NULL DEFAULT 0,
    "purchaseSignals" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdByDeviceId" TEXT,
    "lastWorkerDeviceId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DialogScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogScanChunkCommit" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "chunkKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "cursorIn" TEXT,
    "cursorOut" TEXT,
    "page" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "mediaCount" INTEGER NOT NULL DEFAULT 0,
    "hasMore" BOOLEAN NOT NULL DEFAULT false,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "DialogScanChunkCommit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BumpDeliveryStat" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL DEFAULT '',
    "day" TEXT NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "replied" INTEGER NOT NULL DEFAULT 0,
    "canceled" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BumpDeliveryStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSentMessageLedger" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'unknown',
    "creatorId" TEXT,
    "creatorRef" TEXT,
    "memberId" TEXT,
    "userId" TEXT,
    "deviceId" TEXT,
    "shiftKey" TEXT,
    "dialogId" TEXT,
    "fanId" TEXT,
    "messageId" TEXT,
    "localSeed" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "messageKind" TEXT NOT NULL DEFAULT 'text',
    "isPpv" BOOLEAN NOT NULL DEFAULT false,
    "priceCents" INTEGER,
    "currency" TEXT,
    "mediaCount" INTEGER NOT NULL DEFAULT 0,
    "mediaIds" JSONB,
    "campaignId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual_chat',
    "telemetryEventId" TEXT,
    "compactedAt" TIMESTAMP(3),
    "rootVersion" TEXT NOT NULL DEFAULT 'team_sent_root_v2',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamSentMessageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamCoverageSession" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "coverageId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "startReason" TEXT,
    "endReason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'team_v13',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamCoverageSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamDialogSession" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "dialogId" TEXT NOT NULL,
    "fanId" TEXT,
    "sessionId" TEXT NOT NULL,
    "coverageId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "wallSeconds" INTEGER NOT NULL DEFAULT 0,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "seenAt" TIMESTAMP(3),
    "activityEvents" INTEGER NOT NULL DEFAULT 0,
    "endReason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'team_v13',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamDialogSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamResponseCaseCurrent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "fanId" TEXT,
    "replyMessageId" TEXT NOT NULL,
    "firstIncomingMessageId" TEXT,
    "incomingCount" INTEGER NOT NULL DEFAULT 1,
    "incomingAt" TIMESTAMP(3) NOT NULL,
    "lastIncomingAt" TIMESTAMP(3) NOT NULL,
    "replyAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3),
    "coverageId" TEXT,
    "coverageStartedAt" TIMESTAMP(3),
    "handoffFromMemberId" TEXT,
    "classification" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "wallClockSeconds" INTEGER NOT NULL DEFAULT 0,
    "coverageResponseSeconds" INTEGER,
    "seenResponseSeconds" INTEGER,
    "slaEligible" BOOLEAN NOT NULL DEFAULT false,
    "sla5Pass" BOOLEAN,
    "sla15Pass" BOOLEAN,
    "derivationVersion" TEXT NOT NULL DEFAULT 'team_response_v2',
    "projectionRevision" BIGINT NOT NULL DEFAULT 0,
    "projectionState" TEXT NOT NULL DEFAULT 'FULL',
    "repairReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamResponseCaseCurrent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamProjectionCoverage" (
    "agencyId" TEXT NOT NULL,
    "responseCoverageFrom" TIMESTAMP(3) NOT NULL,
    "dialogCoverageFrom" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'audit15_cutover',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamProjectionCoverage_pkey" PRIMARY KEY ("agencyId")
);

-- CreateTable
CREATE TABLE "TeamHistoricalAnalyticsCoverage" (
    "agencyId" TEXT NOT NULL,
    "activityCoverageFrom" TIMESTAMP(3) NOT NULL,
    "moneyCoverageFrom" TIMESTAMP(3) NOT NULL,
    "activityProjectionVersion" TEXT NOT NULL DEFAULT 'team_activity_daily_v1',
    "moneyProjectionVersion" TEXT NOT NULL DEFAULT 'team_money_fact_v2',
    "activityContributionVersion" TEXT NOT NULL DEFAULT 'team_activity_contribution_v2',
    "activityContributionCutoverAt" TIMESTAMP(3),
    "retentionVectorVersion" TEXT NOT NULL DEFAULT 'team_retention_vector_v2',
    "source" TEXT NOT NULL DEFAULT 'phase2_historical_authority',
    "backfilledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamHistoricalAnalyticsCoverage_pkey" PRIMARY KEY ("agencyId")
);

-- CreateTable
CREATE TABLE "TeamActivityContribution" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "semanticKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'APPLIED',
    "memberId" TEXT,
    "creatorKey" TEXT NOT NULL DEFAULT '__none__',
    "creatorId" TEXT,
    "day" TIMESTAMP(3) NOT NULL,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "ppvSentMessages" INTEGER NOT NULL DEFAULT 0,
    "broadcastDispatches" INTEGER NOT NULL DEFAULT 0,
    "postsCreated" INTEGER NOT NULL DEFAULT 0,
    "storiesCreated" INTEGER NOT NULL DEFAULT 0,
    "contentActions" INTEGER NOT NULL DEFAULT 0,
    "contentMediaItemsPublished" INTEGER NOT NULL DEFAULT 0,
    "sourceEventAt" TIMESTAMP(3) NOT NULL,
    "projectionVersion" TEXT NOT NULL DEFAULT 'team_activity_contribution_v2',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamActivityContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMemberActivityDaily" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "creatorKey" TEXT NOT NULL DEFAULT '__none__',
    "creatorId" TEXT,
    "day" TIMESTAMP(3) NOT NULL,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "ppvSentMessages" INTEGER NOT NULL DEFAULT 0,
    "broadcastDispatches" INTEGER NOT NULL DEFAULT 0,
    "postsCreated" INTEGER NOT NULL DEFAULT 0,
    "storiesCreated" INTEGER NOT NULL DEFAULT 0,
    "contentActions" INTEGER NOT NULL DEFAULT 0,
    "contentMediaItemsPublished" INTEGER NOT NULL DEFAULT 0,
    "sourceEventCount" INTEGER NOT NULL DEFAULT 0,
    "firstEventAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastContentActivityAt" TIMESTAMP(3),
    "projectionVersion" TEXT NOT NULL DEFAULT 'team_activity_daily_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMemberActivityDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMoneyAttributionFact" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceRowId" TEXT NOT NULL,
    "externalId" TEXT,
    "creatorId" TEXT,
    "memberId" TEXT,
    "userId" TEXT,
    "fanId" TEXT,
    "dialogId" TEXT,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "businessStatus" TEXT NOT NULL,
    "financialStatus" TEXT,
    "attributionActive" BOOLEAN NOT NULL DEFAULT false,
    "canonicalMoneyId" TEXT,
    "creatorSaleId" TEXT,
    "financialTransactionId" TEXT,
    "creatorTipId" TEXT,
    "attributionBasis" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "rootId" TEXT,
    "rootVersion" TEXT NOT NULL DEFAULT 'team_money_root_v2',
    "canonicalBusinessKey" TEXT,
    "classificationState" TEXT NOT NULL DEFAULT 'PENDING',
    "classificationReason" TEXT,
    "classificationVersion" TEXT NOT NULL DEFAULT 'team_money_root_classification_v1',
    "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_fact_v2',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMoneyAttributionFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMoneyDailyRollup" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "creatorKey" TEXT NOT NULL DEFAULT '__none__',
    "creatorId" TEXT,
    "sourceType" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "amountCents" BIGINT NOT NULL DEFAULT 0,
    "factCount" INTEGER NOT NULL DEFAULT 0,
    "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_rollup_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMoneyDailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMoneyLifetimeRollup" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "creatorKey" TEXT NOT NULL DEFAULT '__none__',
    "creatorId" TEXT,
    "sourceType" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL DEFAULT 0,
    "factCount" INTEGER NOT NULL DEFAULT 0,
    "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_rollup_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMoneyLifetimeRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMoneyRollupContribution" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "sourceFactId" TEXT NOT NULL,
    "factFingerprint" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "memberId" TEXT,
    "creatorKey" TEXT NOT NULL DEFAULT '__none__',
    "creatorId" TEXT,
    "sourceType" TEXT,
    "currency" TEXT,
    "day" DATE,
    "amountCents" BIGINT NOT NULL DEFAULT 0,
    "projectionVersion" TEXT NOT NULL DEFAULT 'team_money_rollup_v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMoneyRollupContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamPendingDialogStateCurrent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "dialogId" TEXT NOT NULL,
    "fanId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CLEAR',
    "episodeKey" TEXT,
    "firstIncomingEventId" TEXT,
    "lastIncomingEventId" TEXT,
    "firstIncomingMessageId" TEXT,
    "lastIncomingMessageId" TEXT,
    "firstIncomingAt" TIMESTAMP(3),
    "lastIncomingAt" TIMESTAMP(3),
    "incomingCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3),
    "firstSeenMemberId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenMemberId" TEXT,
    "ownerMemberId" TEXT,
    "ownerAssignedAt" TIMESTAMP(3),
    "ownerReason" TEXT,
    "replyAt" TIMESTAMP(3),
    "replyMessageId" TEXT,
    "repliedByMemberId" TEXT,
    "derivationVersion" TEXT NOT NULL DEFAULT 'team_pending_v2',
    "projectionRevision" BIGINT NOT NULL DEFAULT 0,
    "projectionState" TEXT NOT NULL DEFAULT 'FULL',
    "lastProjectionSourceId" TEXT,
    "lastAppliedEventAt" TIMESTAMP(3),
    "lastAppliedEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamPendingDialogStateCurrent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamObservationState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'unknown',
    "creatorRef" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastRealtimeEventAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "lastPurchaseScanTo" TIMESTAMP(3),
    "lastTipScanTo" TIMESTAMP(3),
    "lastSuccessfulScanAt" TIMESTAMP(3),
    "currentScanStatus" TEXT NOT NULL DEFAULT 'idle',
    "currentScanFrom" TIMESTAMP(3),
    "currentScanTo" TIMESTAMP(3),
    "currentScanTypes" JSONB,
    "lockedByDeviceId" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "lastScanSummary" JSONB,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamObservationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficSource" (
    "canonicalCampaignId" TEXT,
    "projectionMetrics" JSONB NOT NULL DEFAULT '{}',
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'unknown',
    "sourceType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "url" TEXT,
    "status" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastScannedAt" TIMESTAMP(3),
    "costRevision" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "stats" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrafficSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficSourceMember" (
    "projectionMetrics" JSONB NOT NULL DEFAULT '{}',
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "lastUserInfoFetchedAt" TIMESTAMP(3),
    "lastValueFetchedAt" TIMESTAMP(3),
    "lastRevenueAt" TIMESTAMP(3),
    "needsValueRefresh" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrafficSourceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorSubscriptionLedger" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'unknown',
    "fanId" TEXT NOT NULL,
    "sourceId" TEXT,
    "eventType" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "externalEventId" TEXT,
    "eventHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'realtime',
    "metadata" JSONB,
    "attributionAttempts" INTEGER NOT NULL DEFAULT 0,
    "organicConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSubscriptionLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamPpvPurchaseLedger" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'unknown',
    "creatorId" TEXT,
    "creatorRef" TEXT,
    "purchaseId" TEXT NOT NULL,
    "messageId" TEXT,
    "dialogId" TEXT,
    "fanId" TEXT,
    "buyerFanId" TEXT,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unresolved',
    "attributedMemberId" TEXT,
    "attributedUserId" TEXT,
    "attributedShiftKey" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByDeviceId" TEXT,
    "resolvedSource" TEXT,
    "creatorSaleId" TEXT,
    "financialTransactionId" TEXT,
    "financialStatus" TEXT,
    "attributionBasis" TEXT,
    "historicalFactVersion" TEXT,
    "historicalFactProjectedAt" TIMESTAMP(3),
    "rootVersion" TEXT NOT NULL DEFAULT 'team_money_root_v2',
    "compactedAt" TIMESTAMP(3),
    "migrationBaselineProtected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamPpvPurchaseLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamTipLedger" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'unknown',
    "creatorId" TEXT,
    "creatorRef" TEXT,
    "eventHash" TEXT NOT NULL,
    "tipId" TEXT NOT NULL,
    "messageId" TEXT,
    "dialogId" TEXT,
    "fanId" TEXT,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creator_revenue',
    "attributedMemberId" TEXT,
    "attributedUserId" TEXT,
    "attributedShiftKey" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByMemberId" TEXT,
    "resolvedSource" TEXT,
    "creatorTipId" TEXT,
    "financialStatus" TEXT,
    "attributionBasis" TEXT,
    "historicalFactVersion" TEXT,
    "historicalFactProjectedAt" TIMESTAMP(3),
    "rootVersion" TEXT NOT NULL DEFAULT 'team_money_root_v2',
    "compactedAt" TIMESTAMP(3),
    "migrationBaselineProtected" BOOLEAN NOT NULL DEFAULT false,
    "candidates" JSONB,
    "weakCandidates" JSONB,
    "result" JSONB,
    "history" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'claims_ingest',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamTipLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamPpvClaimAudit" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "jobId" TEXT,
    "purchaseId" TEXT NOT NULL,
    "messageId" TEXT,
    "action" TEXT NOT NULL,
    "actorMemberId" TEXT NOT NULL,
    "selectedMemberId" TEXT,
    "reason" TEXT,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamPpvClaimAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamPpvResolveJob" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'unknown',
    "creatorId" TEXT,
    "creatorRef" TEXT,
    "purchaseId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "purchasedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByMemberId" TEXT,
    "resolvedByDeviceId" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamPpvResolveJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "revision" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminCommand" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "actorAccessEpoch" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "executionPayload" JSONB,
    "executionProgress" JSONB,
    "reason" TEXT NOT NULL,
    "scopeAgencyId" TEXT,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AdminCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminCommandAudit" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "scopeAgencyId" TEXT,
    "event" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminCommandAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSupportGrant" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "actorAccessEpoch" INTEGER NOT NULL,
    "agencyId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text),

    CONSTRAINT "AdminSupportGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCapacityProjectionState" (
    "jobKeys" TEXT[],
    "id" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "directoryCursor" TEXT,
    "directoryComplete" BOOLEAN NOT NULL DEFAULT false,
    "fanCursor" TEXT,
    "fanComplete" BOOLEAN NOT NULL DEFAULT false,
    "jobCursor" TEXT,
    "jobComplete" BOOLEAN NOT NULL DEFAULT false,
    "sampledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCapacityProjectionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCapacityDirty" (
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "touchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCapacityDirty_pkey" PRIMARY KEY ("kind","sourceId")
);

-- CreateTable
CREATE TABLE "ProviderCapacityContribution" (
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "itemCount" BIGINT NOT NULL DEFAULT 0,
    "overdueCount" BIGINT NOT NULL DEFAULT 0,
    "requiredCalls" BIGINT NOT NULL DEFAULT 0,
    "oldestAt" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3),

    CONSTRAINT "ProviderCapacityContribution_pkey" PRIMARY KEY ("kind","sourceId")
);

-- CreateTable
CREATE TABLE "ProviderCapacityBucket" (
    "bucket" TEXT NOT NULL,
    "itemCount" BIGINT NOT NULL DEFAULT 0,
    "overdueCount" BIGINT NOT NULL DEFAULT 0,
    "requiredCalls" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderCapacityBucket_pkey" PRIMARY KEY ("bucket")
);

-- CreateTable
CREATE TABLE "MaintenanceAdmissionClassState" (
    "generation" VARCHAR(80) NOT NULL,
    "laneName" VARCHAR(120) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "turnCount" BIGINT NOT NULL DEFAULT 0,
    "lastAdmittedAt" TIMESTAMP(3),

    CONSTRAINT "MaintenanceAdmissionClassState_pkey" PRIMARY KEY ("generation","laneName")
);

-- CreateTable
CREATE TABLE "TeamMutationReceipt" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "authorizationScope" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMutationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageLibraryCommandReceipt" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageLibraryCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagementCommandReceipt" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reference" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagementCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalControlState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "lastOperation" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalControlState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialogControlResumeDemand" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "moduleUpdatedAt" TIMESTAMP(3) NOT NULL,
    "creatorControlRevision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DialogControlResumeDemand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsPublication" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "leaseRevision" INTEGER NOT NULL,
    "leaseTokenHash" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "stage" TEXT NOT NULL,
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "proof" JSONB NOT NULL DEFAULT '{}',
    "inputRevision" BIGINT NOT NULL DEFAULT 0,
    "response" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsPublicationInputClock" (
    "jobId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "AnalyticsPublicationInputClock_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "TrafficMetric" (
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objectId" TEXT NOT NULL DEFAULT '',
    "period" TEXT NOT NULL DEFAULT '*',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrafficMetric_pkey" PRIMARY KEY ("creatorId","kind","objectId","period")
);

-- CreateTable
CREATE TABLE "TrafficFanProjection" (
    "lastRevenueAt" TIMESTAMP(3),
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrafficFanProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficReceiptProjection" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fact" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "TrafficReceiptProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficProjectionBackfillData" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'RETIRE',
    "cursor" TEXT NOT NULL DEFAULT '',
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrafficProjectionBackfillData_pkey" PRIMARY KEY ("creatorId")
);

-- CreateTable
CREATE TABLE "TrafficFanSignal" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "lastRevenueAt" TIMESTAMP(3),

    CONSTRAINT "TrafficFanSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficProjectionSeed" (
    "id" TEXT NOT NULL,
    "cursor" TEXT NOT NULL DEFAULT '',
    "complete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TrafficProjectionSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignReadStateData" (
    "generation" INTEGER NOT NULL DEFAULT 0,
    "valueFreshnessMs" INTEGER,
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'DIRECTORY',
    "cursor" TEXT NOT NULL DEFAULT '',
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignReadStateData_pkey" PRIMARY KEY ("creatorId")
);

-- CreateTable
CREATE TABLE "CampaignReadSeed" (
    "generation" INTEGER NOT NULL DEFAULT 0,
    "valueFreshnessMs" INTEGER,
    "id" TEXT NOT NULL,
    "cursor" TEXT NOT NULL DEFAULT '',
    "complete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CampaignReadSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignReadChange" (
    "id" BIGSERIAL NOT NULL,
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,

    CONSTRAINT "CampaignReadChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignReadReceipt" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contributions" JSONB NOT NULL DEFAULT '[]',
    "nextDueAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignReadReceipt_pkey" PRIMARY KEY ("creatorId","kind","sourceId")
);

-- CreateTable
CREATE TABLE "CampaignReadMetric" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL DEFAULT '',
    "rangeKey" TEXT NOT NULL,
    "fanId" TEXT NOT NULL DEFAULT '',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "paying" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignReadMetric_pkey" PRIMARY KEY ("creatorId","campaignId","rangeKey","fanId")
);

-- CreateTable
CREATE TABLE "CampaignReadRepair" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "fromAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignReadRepair_pkey" PRIMARY KEY ("creatorId","fanId")
);

-- CreateTable
CREATE TABLE "CampaignProjectionPolicy" (
    "id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "valueFreshnessMs" INTEGER NOT NULL,

    CONSTRAINT "CampaignProjectionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignReadRepairInterval" (
    "id" BIGSERIAL NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "fromAt" TIMESTAMP(3) NOT NULL,
    "untilAt" TIMESTAMP(3),
    "cursorAt" TIMESTAMP(3),
    "cursorId" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CampaignReadRepairInterval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorAnalyticsFactPublication" (
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "factId" TEXT NOT NULL,
    "currentValue" JSONB,
    "publishedValue" JSONB,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "dirty" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorAnalyticsFactPublication_pkey" PRIMARY KEY ("creatorId","kind","factId")
);

-- CreateTable
CREATE TABLE "CreatorAnalyticsPublicationState" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "initialized" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorAnalyticsPublicationState_pkey" PRIMARY KEY ("creatorId")
);

-- CreateTable
CREATE TABLE "CreatorAnalyticsDay" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorAnalyticsDay_pkey" PRIMARY KEY ("creatorId","date")
);

-- CreateTable
CREATE TABLE "CreatorAnalyticsDayMember" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "metric" VARCHAR(40) NOT NULL,
    "memberId" TEXT NOT NULL,
    "refs" INTEGER NOT NULL,

    CONSTRAINT "CreatorAnalyticsDayMember_pkey" PRIMARY KEY ("creatorId","date","metric","memberId")
);

-- CreateTable
CREATE TABLE "NotificationFactReceipt" (
    "jobId" TEXT NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "factId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "historical" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationFactReceipt_pkey" PRIMARY KEY ("jobId","kind","factId")
);

-- CreateTable
CREATE TABLE "FinancialReceiptRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "windows" JSONB NOT NULL,
    "cursor" JSONB NOT NULL,
    "proof" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "compactedAt" TIMESTAMP(3),
    "detailsRetiredAt" TIMESTAMP(3),

    CONSTRAINT "FinancialReceiptRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialPageReceipt" (
    "runId" TEXT NOT NULL,
    "windowIndex" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "markerStart" VARCHAR(220) NOT NULL,
    "markerEnd" VARCHAR(220),
    "sourceHasMore" BOOLEAN NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "received" INTEGER NOT NULL,
    "rejected" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialPageReceipt_pkey" PRIMARY KEY ("runId","windowIndex","page")
);

-- CreateTable
CREATE TABLE "FinancialObservedFact" (
    "runId" TEXT NOT NULL,
    "windowIndex" INTEGER NOT NULL,
    "externalId" VARCHAR(220) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "FinancialObservedFact_pkey" PRIMARY KEY ("runId","windowIndex","externalId")
);

-- CreateTable
CREATE TABLE "MassCreatorDeliveryState" (
    "creatorId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "sourceRevision" BIGINT NOT NULL DEFAULT 0,
    "observationSequence" BIGINT NOT NULL DEFAULT 0,
    "activeSequence" BIGINT NOT NULL DEFAULT 0,
    "activeObservationId" TEXT,
    "retirementId" TEXT,
    "retirementStartedAt" TIMESTAMP(3),
    "retirementProofId" TEXT,
    "retirementProofRevision" BIGINT,
    "retirementProofObservedAt" TIMESTAMP(3),
    "retirementProviderId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MassCreatorDeliveryState_pkey" PRIMARY KEY ("creatorId")
);

-- CreateTable
CREATE TABLE "MassQueueObservation" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "accessEpoch" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "sourceRevision" BIGINT NOT NULL,
    "retirementId" TEXT,
    "providerId" TEXT,
    "fenceAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "itemCount" INTEGER,
    "receivedCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "lastQueueId" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'PRESENT',
    "cursor" TEXT,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "settled" INTEGER NOT NULL DEFAULT 0,
    "cancelSettled" INTEGER NOT NULL DEFAULT 0,
    "response" JSONB,

    CONSTRAINT "MassQueueObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MassQueueObservationPage" (
    "observationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,

    CONSTRAINT "MassQueueObservationPage_pkey" PRIMARY KEY ("observationId","ordinal")
);

-- CreateTable
CREATE TABLE "MassQueueObservationItem" (
    "observationId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,

    CONSTRAINT "MassQueueObservationItem_pkey" PRIMARY KEY ("observationId","queueId")
);

-- CreateTable
CREATE TABLE "LoginAdmissionBucket" (
    "id" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL,

    CONSTRAINT "LoginAdmissionBucket_pkey" PRIMARY KEY ("id")
);


ALTER TABLE "CustomContentSubmission" ALTER COLUMN "telegramMessageIds" SET NOT NULL;

ALTER TABLE "CustomContentSubmission" ALTER COLUMN "ofMediaIds" SET NOT NULL;

ALTER TABLE "CustomContentSubmission" ALTER COLUMN "telegramInboundEventIds" SET NOT NULL;

ALTER TABLE "CustomDeliveryReceipt" ALTER COLUMN "deliveredMediaIdsAfter" SET NOT NULL;

ALTER TABLE "CustomOrder" ALTER COLUMN "telegramReferenceMessageIds" SET NOT NULL;

ALTER TABLE "CustomOrder" ALTER COLUMN "deliverySentMediaIds" SET NOT NULL;

ALTER TABLE "CustomOrder" ALTER COLUMN "deliveryMessageIds" SET NOT NULL;

ALTER TABLE "ProviderCapacityProjectionState" ALTER COLUMN "jobKeys" SET NOT NULL;

ALTER TABLE "AgencyCreatorCatalogState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AgencyCustomRole" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AgencyMemberCreatorAccessCurrent" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AgencyRoleOverride" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AgencySubPermissionOverride" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AnalyticsCoverage" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AnalyticsIngestBatch" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AutomationBumpFanState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "AutomationTask" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "BumpDeliveryStat" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CampaignFanRefreshPromotionSignal" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CampaignReadChange" ALTER COLUMN "id" SET DEFAULT nextval('"CampaignReadChange_id_seq"'::regclass);

ALTER TABLE "CampaignReadRepairInterval" ALTER COLUMN "id" SET DEFAULT nextval('"CampaignReadRepairInterval_id_seq"'::regclass);

ALTER TABLE "CreatorCampaignFanRefreshWork" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorCampaignFrontierFan" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorEarningsTotal" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorFan" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorFanRefreshDemand" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorFinancialTransaction" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorMediaUsageContribution" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorMediaUsageSourceState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "CreatorTaskActivity" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DeviceCreatorBinding" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DialogControlResumeDemand" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkClaimAgencyState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkClaimShardState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkClaimTopologyState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkItem" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkMemberScopeShardState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkReadyAgency" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkReadyPartition" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "FanObservationCreatorClock" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "FanObservationReadLease" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "FanObservationToken" ALTER COLUMN "id" SET DEFAULT nextval('"FanObservationToken_id_seq"'::regclass);

ALTER TABLE "JobInstance" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MaintenanceLaneState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MediaLibraryScanItem" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ModuleSetting" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MoneyAttribution" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "OfProviderRequestGateState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "OfProviderRequestGateWaiter" ALTER COLUMN "ticket" SET DEFAULT nextval('"OfProviderRequestGateWaiter_ticket_seq"'::regclass);

ALTER TABLE "OfProviderRequestGateWaiter" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "OperationalControlState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Phase2DependencyState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Phase2WorkBroadClaimPartitionState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Phase2WorkCoverage" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Phase2WorkFamilyState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Phase2WorkGenerationAuthority" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ProviderCapacityDebtState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ProviderOperationalDebt" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "SubscriberDirectoryMaintenanceSignal" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "SystemSetting" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamActivityContribution" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamHistoricalAnalyticsCoverage" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamMemberActivityDaily" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamMoneyAttributionFact" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamMoneyDailyRollup" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamMoneyLifetimeRollup" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamMoneyRollupContribution" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamObservationState" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamPpvPurchaseLedger" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamPpvResolveJob" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamProjectionCoverage" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "TeamSentMessageLedger" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "VaultUnsortedSnapshot" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "WorkspaceSetting" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MassCreatorDeliveryState" ALTER COLUMN "updatedAt" SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC');
ALTER TABLE "FanObservationToken" ALTER COLUMN "observedAt" DROP DEFAULT;



-- Current database functions


CREATE FUNCTION public.actual60_require_auth_history_publisher_generation() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF current_setting('onlinod.actual60_auth_history_generation',true) IS DISTINCT FROM 'actual60_auth_history_publisher_v1' THEN
    RAISE EXCEPTION 'ACTUAL60_INCOMPATIBLE_AUTH_HISTORY_PUBLISHER' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.analytics_capture_fact_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 PERFORM "analytics_stage_fact_v1"(TG_TABLE_NAME,CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,TG_OP='DELETE',FALSE);
 RETURN COALESCE(NEW,OLD);
END $function$;

CREATE OR REPLACE FUNCTION public.analytics_fact_publication_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND (NEW."creatorId",NEW."agencyId",NEW."kind",NEW."factId") IS DISTINCT FROM (OLD."creatorId",OLD."agencyId",OLD."kind",OLD."factId") THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_SCOPE_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND (NEW."publishedValue" IS DISTINCT FROM OLD."publishedValue" OR (OLD.dirty AND NOT NEW.dirty))
   AND current_setting('onlinod.analytics_publication_writer',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_WRITER_REQUIRED'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.analytics_new_creator_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 INSERT INTO "CreatorAnalyticsPublicationState"("agencyId","creatorId","initialized") VALUES(NEW."agencyId",NEW."id",TRUE) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.analytics_publication_value_v1(kind text, row_data jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT CASE WHEN row_data IS NULL THEN NULL ELSE
 jsonb_strip_nulls((SELECT jsonb_object_agg(key,value) FROM jsonb_each(row_data) WHERE key=ANY(
 CASE kind
 WHEN 'CreatorSale' THEN ARRAY['purchasedAt','saleType','amountCents','fanId']
 WHEN 'CreatorTip' THEN ARRAY['tippedAt','amountCents']
 WHEN 'CreatorSubscriptionEvent' THEN ARRAY['occurredAt','eventType','observedPriceCents']
 WHEN 'CreatorPaidSubscription' THEN ARRAY['paidAt','amountCents']
 WHEN 'CreatorPostLike' THEN ARRAY['likedAt','fanId']
 WHEN 'CreatorPostComment' THEN ARRAY['commentedAt','fanId']
 WHEN 'CreatorFinancialTransaction' THEN ARRAY['occurredAt','transactionType','transactionStatus','amountCents','netCents']
 WHEN 'CreatorMessagesDaily' THEN ARRAY['date','incomingMessages','outgoingMessages','uniqueDialogs','sourceTimezone']
 ELSE ARRAY[]::text[] END))) END $function$;

CREATE OR REPLACE FUNCTION public.analytics_published_writer_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF current_setting('onlinod.analytics_publication_writer',true) IS DISTINCT FROM '1' THEN
   RAISE EXCEPTION 'ANALYTICS_PUBLICATION_WRITER_REQUIRED';
 END IF;
 RETURN COALESCE(NEW,OLD);
END $function$;

CREATE OR REPLACE FUNCTION public.analytics_stage_fact_v1(source_kind text, row_data jsonb, is_deleted boolean DEFAULT false, is_adoption boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE value JSONB; changed INTEGER;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=row_data->>'creatorId' AND "agencyId"=row_data->>'agencyId') THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM "DomainWorkItem" d WHERE d."agencyId"=row_data->>'agencyId' AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
   AND d."objectType"='Phase2CreatorDestructiveCleanup' AND d."objectId"=row_data->>'creatorId')
 OR EXISTS(SELECT 1 FROM "DomainWorkItem" d WHERE d."agencyId"=row_data->>'agencyId' AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
   AND d."objectType"='Phase2AgencyDestructiveCleanup' AND d."objectId"=row_data->>'agencyId') THEN RETURN; END IF;
 value:=CASE WHEN is_deleted THEN NULL ELSE "analytics_publication_value_v1"(source_kind,row_data) END;
 INSERT INTO "CreatorAnalyticsFactPublication"("agencyId","creatorId","kind","factId","currentValue")
 VALUES(row_data->>'agencyId',row_data->>'creatorId',source_kind,row_data->>'id',value)
 ON CONFLICT("creatorId","kind","factId") DO UPDATE SET
   "currentValue"=EXCLUDED."currentValue","dirty"=TRUE,
   "revision"="CreatorAnalyticsFactPublication"."revision"+1,"updatedAt"=clock_timestamp()
 WHERE NOT is_adoption AND "CreatorAnalyticsFactPublication"."currentValue" IS DISTINCT FROM EXCLUDED."currentValue";
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
   INSERT INTO "CreatorAnalyticsPublicationState"("agencyId","creatorId") VALUES(row_data->>'agencyId',row_data->>'creatorId') ON CONFLICT DO NOTHING;
   PERFORM "phase2_publish_domain_work"(row_data->>'agencyId','ANALYTICS_FACT_PUBLICATION','CreatorAccount',row_data->>'creatorId',row_data->>'creatorId',row_data->>'creatorId',NULL,NULL,NULL,0,clock_timestamp());
 END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_bounded_claim_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."jobKey" = 'fetch_campaigns' AND NEW."status" = 'CLAIMED'
    AND NEW."params"->>'campaignBoundedTraversalVersion' = '1'
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."leaseRevision" IS DISTINCT FROM NEW."leaseRevision"
      OR OLD."claimedByDeviceId" IS DISTINCT FROM NEW."claimedByDeviceId"
      OR OLD."continuation" IS DISTINCT FROM NEW."continuation")
    AND current_setting('onlinod.campaign_bounded_traversal_version', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'CAMPAIGN_BOUNDED_TRAVERSAL_CLAIM_REQUIRED';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_directory_count_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('onlinod.campaign_directory_count_version', true) IS DISTINCT FROM '1'
    AND (TG_OP = 'INSERT' OR
      (OLD."campaignDirectoryGeneration", OLD."campaignDirectoryRequestedAt", OLD."campaignDirectoryRevision", OLD."campaignDirectoryCampaignCount")
      IS DISTINCT FROM
      (NEW."campaignDirectoryGeneration", NEW."campaignDirectoryRequestedAt", NEW."campaignDirectoryRevision", NEW."campaignDirectoryCampaignCount")) THEN
    NEW."campaignDirectoryCountRevision" := NULL;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_directory_facts_clock_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE previous_creator TEXT; next_creator TEXT; target_creator TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND
    (OLD."creatorId", OLD."externalCampaignId", OLD."sourceScanRunId", OLD."sourceScanStartedAt")
    IS NOT DISTINCT FROM
    (NEW."creatorId", NEW."externalCampaignId", NEW."sourceScanRunId", NEW."sourceScanStartedAt") THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN previous_creator := OLD."creatorId"; END IF;
  IF TG_OP <> 'DELETE' THEN next_creator := NEW."creatorId"; END IF;
  FOR target_creator IN SELECT DISTINCT c FROM unnest(ARRAY[previous_creator,next_creator]) c
    WHERE c IS NOT NULL ORDER BY c LOOP
    UPDATE "CreatorCampaignCollectionState"
      SET "campaignDirectoryFactsRevision" = "campaignDirectoryFactsRevision" + 1
      WHERE "creatorId" = target_creator;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_fair_cursor_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE changed boolean;
BEGIN
  changed := (NEW."claimersCursorRunId",NEW."claimersCursorPage",NEW."claimersCursorOffset",NEW."claimersCursorPending")
    IS DISTINCT FROM (OLD."claimersCursorRunId",COALESCE(OLD."claimersCursorPage",0),COALESCE(OLD."claimersCursorOffset",0),COALESCE(OLD."claimersCursorPending",false));
  IF changed THEN
    IF current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1'
      OR current_setting('onlinod.campaign_refresh_creator',true) IS DISTINCT FROM NEW."creatorId"
      OR NOT EXISTS(SELECT 1 FROM "CreatorCampaignCollectionState" s JOIN "JobInstance" j ON j.id=s."sourceJobId"
        WHERE s."creatorId"=NEW."creatorId" AND s."agencyId"=NEW."agencyId" AND s."activeGeneration"=NEW."claimersCursorRunId"
          AND j."creatorId"=s."creatorId" AND j."agencyId"=s."agencyId" AND j."status"='CLAIMED'
          AND j."params"->>'campaignFairPagesVersion'='1' AND j."params"->>'collectionGeneration'=s."activeGeneration")
      THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_CURSOR_WRITER_REQUIRED'; END IF;
    IF NEW."claimersCursorRunId" IS DISTINCT FROM OLD."claimersCursorRunId" THEN
      IF NEW."claimersCursorRunId" IS NULL OR NEW."claimersCursorPage"<>0 OR NEW."claimersCursorOffset"<>0 OR NOT NEW."claimersCursorPending"
        THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_CURSOR_INITIAL_INVALID'; END IF;
    ELSIF NOT OLD."claimersCursorPending" OR NEW."claimersCursorPage"<>OLD."claimersCursorPage"+1
      OR NEW."claimersCursorOffset"<OLD."claimersCursorOffset" OR NEW."claimersCursorOffset">OLD."claimersCursorOffset"+50
      THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_CURSOR_TRANSITION_INVALID'; END IF;
  END IF;
  -- Metadata or old binaries cannot retain a now-unjustified retry deadline.
  IF current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1' AND
    (NEW."claimersNextDueAt",NEW."claimerRevision",NEW."claimersObservationVersion") IS DISTINCT FROM
    (OLD."claimersNextDueAt",OLD."claimerRevision",OLD."claimersObservationVersion") THEN NEW."claimersEligibleAt":=NULL; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_fair_ingest_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."dataType"='CAMPAIGNS' AND current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1'
    AND EXISTS(SELECT 1 FROM "JobInstance" j WHERE j.id=NEW."sourceJobId" AND j.params->>'campaignFairPagesVersion'='1')
    THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_INGEST_REQUIRED'; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_fair_job_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."jobKey"<>'fetch_campaigns' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."params"->>'campaignFairPagesVersion'='1' AND NEW."params"->>'campaignFairPagesVersion' IS DISTINCT FROM '1'
    THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_PROTOCOL_DOWNGRADE'; END IF;
  IF NEW."params"->>'campaignFairPagesVersion'='1'
    AND (NEW.status IN ('CLAIMED','PUBLISHING','DONE') OR NEW.params IS DISTINCT FROM OLD.params OR NEW.continuation IS DISTINCT FROM OLD.continuation) AND
    (TG_OP='INSERT' OR (NEW.status,NEW."leaseRevision",NEW."claimedByDeviceId",NEW.params,NEW.continuation)
      IS DISTINCT FROM (OLD.status,OLD."leaseRevision",OLD."claimedByDeviceId",OLD.params,OLD.continuation))
    AND current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1'
    THEN RAISE EXCEPTION 'CAMPAIGN_FAIR_EXECUTOR_REQUIRED'; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_fair_schedule_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('onlinod.campaign_fair_pages_version',true) IS DISTINCT FROM '1' THEN
    NEW."campaignFrontierScheduleVersion":=0; NEW."campaignFrontierNextEligibleAt":=NULL;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_frontier_observation_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('onlinod.campaign_observation_version', true) IS DISTINCT FROM '1' THEN
    NEW."claimersObservationVersion" := 0;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.campaign_plan_observation_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('onlinod.campaign_observation_version', true) IS DISTINCT FROM '1' THEN
    NEW."campaignFrontierObservationVersion" := 0;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.campaign_traversal_ingest_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."dataType" = 'CAMPAIGNS' AND NEW."sourceJobId" IS NOT NULL
    AND current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1'
    AND EXISTS (SELECT 1 FROM "JobInstance" j WHERE j."id"=NEW."sourceJobId"
      AND j."params"->>'campaignTraversalAuthorityVersion'='1') THEN
    RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_INGEST_REQUIRED';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_traversal_job_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."jobKey" <> 'fetch_campaigns' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."params"->>'campaignTraversalAuthorityVersion' = '1'
    AND NEW."params"->>'campaignTraversalAuthorityVersion' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_PROTOCOL_DOWNGRADE';
  END IF;
  IF NEW."params"->>'campaignTraversalAuthorityVersion' = '1'
    AND NEW."status" IN ('CLAIMED','PUBLISHING','DONE')
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."leaseRevision" IS DISTINCT FROM NEW."leaseRevision"
      OR OLD."claimedByDeviceId" IS DISTINCT FROM NEW."claimedByDeviceId"
      OR OLD."params" IS DISTINCT FROM NEW."params"
      OR OLD."continuation" IS DISTINCT FROM NEW."continuation")
    AND current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_AUTHORITY_REQUIRED';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.campaign_traversal_origin_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."claimersTraversalRejectedRows" IS DISTINCT FROM OLD."claimersTraversalRejectedRows" THEN
    IF current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_ORIGIN_WRITER_REQUIRED';
    END IF;
    IF NEW."claimersTraversalRejectedRows" < 0 OR
      (NEW."claimersTraversalRunId" IS NOT DISTINCT FROM OLD."claimersTraversalRunId"
        AND NEW."claimersTraversalRejectedRows" < OLD."claimersTraversalRejectedRows") THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_REJECTIONS_CANNOT_REWIND';
    END IF;
  END IF;
  IF (NEW."claimersTraversalRunId",NEW."claimersTraversalStartedAt",NEW."claimersTraversalRevision")
    IS DISTINCT FROM (OLD."claimersTraversalRunId",OLD."claimersTraversalStartedAt",OLD."claimersTraversalRevision") THEN
    IF current_setting('onlinod.campaign_traversal_authority_version',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_ORIGIN_WRITER_REQUIRED';
    END IF;
    IF OLD."claimersTraversalRunId" IS NOT NULL AND NEW."claimersTraversalRunId" = OLD."claimersTraversalRunId"
      AND OLD."claimersTraversalStartedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'CAMPAIGN_TRAVERSAL_ORIGIN_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.capture_agency_member_access_epoch_boundary()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."accessEpoch" IS DISTINCT FROM OLD."accessEpoch" THEN
    INSERT INTO "AgencyMemberAccessEpochBoundary" (
      "memberId", "agencyId", "userId", "accessEpoch", "nextAccessEpoch", "endedAt"
    ) VALUES (
      OLD."id", OLD."agencyId", OLD."userId", OLD."accessEpoch", NEW."accessEpoch", clock_timestamp()
    )
    ON CONFLICT ("memberId", "accessEpoch") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_authorization_session_boundary()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."revokedAt" IS NULL
     AND NEW."revokedAt" IS NOT NULL
     AND NEW."authorizationSessionId" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "RefreshSession" r
        WHERE r."authorizationSessionId" = NEW."authorizationSessionId"
          AND r."id" <> NEW."id"
          AND r."revokedAt" IS NULL
          AND r."expiresAt" > clock_timestamp()
     ) THEN
    INSERT INTO "AuthorizationSessionBoundary" (
      "authorizationSessionId", "userId", "agencyId", "deviceId", "endedAt"
    ) VALUES (
      NEW."authorizationSessionId", NEW."userId", NEW."agencyId", NEW."deviceId", clock_timestamp()
    )
    ON CONFLICT ("authorizationSessionId") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_creator_catalog_generation_boundary()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."generation" IS DISTINCT FROM OLD."generation" THEN
    INSERT INTO "AgencyCreatorCatalogGenerationBoundary" (
      "agencyId", "generation", "nextGeneration", "endedAt"
    ) VALUES (
      OLD."agencyId", OLD."generation", NEW."generation", clock_timestamp()
    )
    ON CONFLICT ("agencyId", "generation") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.financial_receipt_coverage_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF NEW.status='COMPLETE' AND (TG_OP='INSERT' OR (NEW.status,NEW."baselineVerifiedAt",NEW."lastCatchupCompletedAt",NEW."activeGeneration") IS DISTINCT FROM (OLD.status,OLD."baselineVerifiedAt",OLD."lastCatchupCompletedAt",OLD."activeGeneration")) THEN
   IF current_setting('onlinod.financial_receipts_v1',true) IS DISTINCT FROM '1' OR NEW."receiptCoverageVersion"<>1
     OR NOT EXISTS(SELECT 1 FROM "FinancialReceiptRun" r WHERE r."jobId"=NEW."sourceJobId" AND r.generation=NEW."activeGeneration" AND r."agencyId"=NEW."agencyId" AND r."creatorId"=NEW."creatorId" AND r.cursor->>'phase'='done' AND r.proof->>'complete'='true')
   THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_COVERAGE_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.financial_receipt_job_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF NEW."jobKey"<>'financial_transactions_scan' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.params->>'financialReceiptVersion'='1' AND NEW.params->>'financialReceiptVersion' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_PROTOCOL_DOWNGRADE'; END IF;
 IF NEW.params->>'financialReceiptVersion'='1' AND NEW.status IN ('CLAIMED','PUBLISHING','DONE')
   AND (TG_OP='INSERT' OR (NEW.status,NEW."leaseRevision",NEW.params,NEW.continuation) IS DISTINCT FROM (OLD.status,OLD."leaseRevision",OLD.params,OLD.continuation))
   AND current_setting('onlinod.financial_receipts_v1',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_EXECUTOR_REQUIRED'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.financial_receipt_writer_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF current_setting('onlinod.financial_receipts_v1',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FINANCIAL_RECEIPT_WRITER_REQUIRED'; END IF;
 IF TG_TABLE_NAME='FinancialPageReceipt' AND TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'FINANCIAL_PAGE_RECEIPT_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='FinancialReceiptRun' AND TG_OP='UPDATE' THEN
   IF (NEW.id,NEW."jobId",NEW."agencyId",NEW."creatorId",NEW.generation,NEW.windows) IS DISTINCT FROM (OLD.id,OLD."jobId",OLD."agencyId",OLD."creatorId",OLD.generation,OLD.windows) THEN RAISE EXCEPTION 'FINANCIAL_RUN_SCOPE_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notification_fact_receipt_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'NOTIFICATION_FACT_RECEIPT_IMMUTABLE'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_admin_access_epoch_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."passwordHash", NEW."role", NEW."active") IS DISTINCT FROM
     ROW(OLD."passwordHash", OLD."role", OLD."active") THEN
    NEW."accessEpoch" := OLD."accessEpoch" + 1;
  ELSE
    NEW."accessEpoch" := OLD."accessEpoch";
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_admin_bulk_work_deleted_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE command_row "AdminCommand"%ROWTYPE;
BEGIN
 IF OLD."workClass"='ADMIN_BILLING_PRICING' AND OLD."objectType"='AdminCommand' THEN
  UPDATE "AdminCommand" SET "status"='STOPPED_TARGET',"completedAt"=clock_timestamp(),
   "executionProgress"=COALESCE("executionProgress",'{}'::jsonb)||jsonb_build_object('stoppedCode','ADMIN_WORK_REMOVED')
   WHERE "id"=OLD."objectId" AND "scopeAgencyId"=OLD."agencyId" AND "action"='billing.pricing.bulk' AND "status" IN ('QUEUED','RUNNING')
   RETURNING * INTO command_row;
  IF FOUND THEN
   INSERT INTO "AdminCommandAudit"("id","commandId","sequence","actorId","action","targetId","scopeAgencyId","event","reason","detail","createdAt")
   VALUES('admin-work-removed-'||md5(command_row."id"),command_row."id",2147483647,command_row."actorId",command_row."action",command_row."targetId",command_row."scopeAgencyId",'STOPPED_TARGET',command_row."reason",jsonb_build_object('code','ADMIN_WORK_REMOVED','progress',command_row."executionProgress"),clock_timestamp());
  END IF;
 END IF;
 RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_agency_billing_policy_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF ROW(NEW."plan",NEW."trialEndsAt",NEW."billingSupportHold",NEW."billingSupportHoldReason") IS DISTINCT FROM
    ROW(OLD."plan",OLD."trialEndsAt",OLD."billingSupportHold",OLD."billingSupportHoldReason") THEN
   NEW."billingPolicyRevision" := GREATEST(NEW."billingPolicyRevision",OLD."billingPolicyRevision"+1);
 ELSE
   NEW."billingPolicyRevision" := GREATEST(NEW."billingPolicyRevision",OLD."billingPolicyRevision");
 END IF;
 IF NEW."billingSupportHold" OR NEW."deletedAt" IS NOT NULL THEN NEW."status" := 'LOCKED'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_analytics_collector_publication_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE changed BOOLEAN;
BEGIN
  changed:=NEW."baselineVerifiedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."baselineVerifiedAt" IS DISTINCT FROM NEW."baselineVerifiedAt")
    OR NEW."lastCatchupCompletedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."lastCatchupCompletedAt" IS DISTINCT FROM NEW."lastCatchupCompletedAt");
  IF TG_TABLE_NAME='CreatorCampaignCollectionState' THEN
    changed:=changed OR NEW."membershipCoverageCompletedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."membershipCoverageCompletedAt" IS DISTINCT FROM NEW."membershipCoverageCompletedAt");
  END IF;
  IF changed AND NOT EXISTS(
    SELECT 1 FROM "AnalyticsPublication" p JOIN "JobInstance" j ON j."id"=p."jobId"
    WHERE p."jobId"=NEW."sourceJobId" AND p."agencyId"=NEW."agencyId" AND p."creatorId"=NEW."creatorId"
      AND p."payload"->>'scanRunId'=NEW."activeGeneration"
      AND ((p."state"='PENDING' AND p."stage"='FINALIZE' AND j."status"='PUBLISHING')
        OR (TG_TABLE_NAME='CreatorCampaignCollectionState' AND p."state"='COMMITTED' AND j."status"='DONE'))
  ) THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_AUTHORITY_REQUIRED'; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_analytics_projection_restore_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "phase2_bump_dependency"(NEW."id",'ANALYTICS_PROJECTION_LIFECYCLE',NEW."id");
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_analytics_proof_publication_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'COMMITTED' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."payloadChecksum" IS DISTINCT FROM NEW."payloadChecksum") THEN
    IF NEW."proofVersion" <> 2 OR NOT EXISTS (
      SELECT 1 FROM "JobInstance" j JOIN "AnalyticsPublication" p ON p."jobId"=j."id"
      WHERE j."id"=NEW."sourceJobId" AND j."status"='PUBLISHING' AND p."state"='PENDING'
        AND p."stage"='FINALIZE' AND p."creatorId"=NEW."creatorId" AND p."agencyId"=NEW."agencyId"
    ) THEN RAISE EXCEPTION 'ANALYTICS_PUBLICATION_AUTHORITY_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_analytics_publication_immutable_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF (NEW."jobId",NEW."agencyId",NEW."creatorId",NEW."userId",NEW."deviceId",NEW."leaseRevision",NEW."leaseTokenHash",NEW."payloadHash",NEW."payload")
   IS DISTINCT FROM (OLD."jobId",OLD."agencyId",OLD."creatorId",OLD."userId",OLD."deviceId",OLD."leaseRevision",OLD."leaseTokenHash",OLD."payloadHash",OLD."payload") THEN
   RAISE EXCEPTION 'ANALYTICS_PUBLICATION_IMMUTABLE';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_analytics_publication_input_clock_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE previous_job TEXT; next_job TEXT; target_job TEXT;
BEGIN
  IF TG_TABLE_NAME = 'CreatorEarningsDaily' THEN
    IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'scanProofId' - 'updatedAt') = (to_jsonb(NEW) - 'scanProofId' - 'updatedAt') THEN RETURN NEW; END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" AND OLD."receivedRows" = NEW."receivedRows"
      AND OLD."rejectedRows" = NEW."rejectedRows" AND OLD."payloadChecksum" = NEW."payloadChecksum" THEN RETURN NEW; END IF;
    IF TG_OP <> 'DELETE' AND (NEW."dataType" <> 'EARNINGS' OR NEW."idempotencyKey" NOT LIKE '%:daily:%') THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' AND (OLD."dataType" <> 'EARNINGS' OR OLD."idempotencyKey" NOT LIKE '%:daily:%') THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN previous_job := OLD."sourceJobId"; END IF;
  IF TG_OP <> 'DELETE' THEN next_job := NEW."sourceJobId"; END IF;
  FOR target_job IN SELECT DISTINCT j FROM unnest(ARRAY[previous_job,next_job]) j WHERE j IS NOT NULL ORDER BY j LOOP
    UPDATE "AnalyticsPublicationInputClock" SET "revision"="revision"+1 WHERE "jobId"=target_job;
    IF NOT FOUND THEN
      INSERT INTO "AnalyticsPublicationInputClock"("jobId","revision")
        SELECT target_job,1 WHERE EXISTS (SELECT 1 FROM "JobInstance" WHERE "id"=target_job)
        ON CONFLICT ("jobId") DO UPDATE SET "revision"="AnalyticsPublicationInputClock"."revision"+1;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_analytics_publishing_job_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF OLD."status"='PUBLISHING' AND NEW."status"<>'CANCELLED'
   AND EXISTS(SELECT 1 FROM "AnalyticsPublication" WHERE "jobId"=OLD."id" AND "state"='PENDING') AND (NEW."params" IS DISTINCT FROM OLD."params"
   OR NEW."leaseRevision" IS DISTINCT FROM OLD."leaseRevision" OR NEW."status" NOT IN ('PUBLISHING','DONE','FAILED','CANCELLED')) THEN
   RAISE EXCEPTION 'ANALYTICS_ACCEPTED_JOB_IMMUTABLE';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_membership_proof_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE b boolean; c boolean;
BEGIN
  IF TG_OP='UPDATE' AND (NEW."agencyId",NEW."creatorId") IS DISTINCT FROM (OLD."agencyId",OLD."creatorId")
    AND (OLD."membershipBaselineVerifiedAt" IS NOT NULL OR OLD."membershipCatchupVerifiedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'CAMPAIGN_MEMBERSHIP_SCOPE_IMMUTABLE';
  END IF;
  b := (NEW."membershipBaselineVerifiedAt",NEW."membershipBaselineObservedAt",NEW."membershipBaselineGeneration")
    IS DISTINCT FROM (OLD."membershipBaselineVerifiedAt",OLD."membershipBaselineObservedAt",OLD."membershipBaselineGeneration");
  c := (NEW."membershipCatchupVerifiedAt",NEW."membershipCatchupObservedAt",NEW."membershipCatchupGeneration")
    IS DISTINCT FROM (OLD."membershipCatchupVerifiedAt",OLD."membershipCatchupObservedAt",OLD."membershipCatchupGeneration");
  IF NOT b AND NOT c THEN RETURN NEW; END IF;
  IF NEW."membershipCoverageStatus" <> 'COMPLETE' OR NEW."membershipCoverageCompletedAt" IS NULL
    OR NEW."activeGeneration" IS NULL OR NEW."sourceJobId" IS NULL
    OR (b AND (NEW."mode" <> 'full'
      OR NEW."membershipBaselineVerifiedAt" IS DISTINCT FROM NEW."membershipCoverageCompletedAt"
      OR NEW."membershipBaselineObservedAt" IS DISTINCT FROM NEW."membershipObservedAt"
      OR NEW."membershipBaselineGeneration" IS DISTINCT FROM NEW."activeGeneration"))
    OR (c AND (NEW."mode" <> 'catchup'
      OR NEW."membershipCatchupVerifiedAt" IS DISTINCT FROM NEW."membershipCoverageCompletedAt"
      OR NEW."membershipCatchupObservedAt" IS DISTINCT FROM NEW."membershipObservedAt"
      OR NEW."membershipCatchupGeneration" IS DISTINCT FROM NEW."activeGeneration"))
    OR NOT EXISTS (
      SELECT 1 FROM "AnalyticsPublication" p JOIN "JobInstance" j ON j."id"=p."jobId"
      WHERE p."jobId"=NEW."sourceJobId" AND p."agencyId"=NEW."agencyId" AND p."creatorId"=NEW."creatorId"
        AND j."agencyId"=NEW."agencyId" AND j."creatorId"=NEW."creatorId" AND j."jobKey"='fetch_campaigns'
        AND p."payload"->>'scanRunId'=NEW."activeGeneration"
        AND ((p."state"='PENDING' AND p."stage"='FINALIZE' AND j."status"='PUBLISHING')
          OR (p."state"='COMMITTED' AND j."status"='DONE'))
    ) THEN RAISE EXCEPTION 'CAMPAIGN_MEMBERSHIP_PUBLICATION_REQUIRED'; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_projection_ack_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ((NEW."state"='CLAIMED' AND (OLD."state"<>'CLAIMED' OR NEW."claimFence"<>OLD."claimFence" OR NEW."leaseUntil">OLD."leaseUntil"))
      OR (OLD."state"='CLAIMED' AND NEW."state"<>'CLAIMED'))
    AND current_setting('onlinod.campaign_projection_writer',true) IS DISTINCT FROM 'campaign_projection_v2' THEN
    RAISE EXCEPTION 'CAMPAIGN_PROJECTION_WRITER_RETIRED_OR_POLICY_CHANGED';
  END IF;
  IF NEW."completedRevision">OLD."completedRevision" AND NEW."workClass" IN
    ('CAMPAIGN_FACT','CAMPAIGN_VALUE','CAMPAIGN_ATTRIBUTION','CAMPAIGN_CLOCK','CAMPAIGN_BACKFILL')
    AND EXISTS(SELECT 1 FROM "CreatorAccount" c JOIN "Agency" a ON a."id"=c."agencyId"
      WHERE c."id"=NEW."creatorId" AND c."deletedAt" IS NULL AND a."deletedAt" IS NULL) THEN
    PERFORM "onlinod_campaign_projection_assert_v2"();
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_projection_assert_v2()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('onlinod.campaign_projection_writer',true) IS DISTINCT FROM 'campaign_projection_v2'
    OR current_setting('onlinod.campaign_value_refresh_version',true) IS DISTINCT FROM '1'
    OR NOT EXISTS(SELECT 1 FROM "CampaignProjectionPolicy" WHERE "id"='active'
      AND "generation"::text=current_setting('onlinod.campaign_projection_generation',true)) THEN
    RAISE EXCEPTION 'CAMPAIGN_PROJECTION_WRITER_RETIRED_OR_POLICY_CHANGED';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_projection_guard_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE r JSONB;
BEGIN
  IF TG_OP='DELETE' THEN
    r:=to_jsonb(OLD);
    IF r->>'creatorId' IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM "CreatorAccount" c JOIN "Agency" a ON a."id"=c."agencyId"
      WHERE c."id"=r->>'creatorId' AND c."deletedAt" IS NULL AND a."deletedAt" IS NULL
    ) THEN RETURN OLD; END IF;
  END IF;
  PERFORM "onlinod_campaign_projection_assert_v2"();
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_projection_policy_v2(expected integer, ttl integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE p "CampaignProjectionPolicy";
BEGIN
  SELECT * INTO p FROM "CampaignProjectionPolicy" WHERE "id"='active' FOR UPDATE;
  IF p."generation"<>expected THEN RAISE EXCEPTION 'CAMPAIGN_POLICY_GENERATION_CONFLICT'; END IF;
  IF ttl<60000 THEN RAISE EXCEPTION 'CAMPAIGN_POLICY_TTL_INVALID'; END IF;
  IF p."valueFreshnessMs"=ttl THEN RETURN p."generation"; END IF;
  UPDATE "CampaignProjectionPolicy" SET "generation"="generation"+1,"valueFreshnessMs"=ttl WHERE "id"='active' RETURNING * INTO p;
  PERFORM set_config('onlinod.campaign_projection_writer','campaign_projection_v2',true);
  PERFORM set_config('onlinod.campaign_projection_generation',p."generation"::text,true);
  PERFORM set_config('onlinod.campaign_value_refresh_version','1',true);
  UPDATE "CampaignReadSeed" SET "generation"=p."generation","valueFreshnessMs"=ttl,"cursor"='',"complete"=false WHERE "id"='v1';
  RETURN p."generation";
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_read_add_v1(a text, c text, p text, w text, f text, d jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE before_value JSONB; after_value JSONB; delta JSONB; k TEXT; n NUMERIC; members NUMERIC; payers NUMERIC;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(d) e WHERE e.value::numeric<>0) THEN RETURN; END IF;
  INSERT INTO "CampaignReadMetric"("agencyId","creatorId","campaignId","rangeKey","fanId") VALUES(a,c,p,w,f) ON CONFLICT DO NOTHING;
  SELECT "metrics" INTO before_value FROM "CampaignReadMetric"
    WHERE "creatorId"=c AND "campaignId"=p AND "rangeKey"=w AND "fanId"=f FOR UPDATE;
  after_value:=before_value;
  FOR k,n IN SELECT e.key,e.value::numeric FROM jsonb_each_text(d) e LOOP
    n:=COALESCE((after_value->>k)::numeric,0)+n;
    IF n<0 AND (k NOT LIKE '%Cents') THEN RAISE EXCEPTION 'CAMPAIGN_READ_COUNTER_UNDERFLOW:%',k; END IF;
    after_value:=jsonb_set(after_value,ARRAY[k],to_jsonb(n::text));
  END LOOP;
  UPDATE "CampaignReadMetric" SET "metrics"=after_value,"paying"=COALESCE((after_value->>'transactionsCount')::numeric,0)>0,"updatedAt"=CURRENT_TIMESTAMP
    WHERE "creatorId"=c AND "campaignId"=p AND "rangeKey"=w AND "fanId"=f;
  IF f<>'' THEN
    members:=(CASE WHEN COALESCE((after_value->>'memberships')::numeric,0)>0 THEN 1 ELSE 0 END)
      -(CASE WHEN COALESCE((before_value->>'memberships')::numeric,0)>0 THEN 1 ELSE 0 END);
    payers:=(CASE WHEN COALESCE((after_value->>'transactionsCount')::numeric,0)>0 THEN 1 ELSE 0 END)
      -(CASE WHEN COALESCE((before_value->>'transactionsCount')::numeric,0)>0 THEN 1 ELSE 0 END);
    delta:=d || jsonb_build_object('uniqueFans',members::text,'payingFans',payers::text);
    PERFORM "onlinod_campaign_read_add_v1"(a,c,p,w,'',delta);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(after_value) e WHERE e.value::numeric<>0) THEN
    DELETE FROM "CampaignReadMetric" WHERE "creatorId"=c AND "campaignId"=p AND "rangeKey"=w AND "fanId"=f;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_read_attribution_v3(a text, c text, f text, t timestamp without time zone)
 RETURNS text
 LANGUAGE plpgsql
 SET enable_sort TO 'off'
AS $function$
DECLARE campaign TEXT; scope_agency TEXT;
BEGIN
  IF f IS NULL OR t IS NULL THEN RETURN NULL; END IF;
  SELECT "agencyId" INTO scope_agency FROM "CreatorAccount" WHERE "id"=c;
  IF scope_agency IS DISTINCT FROM a OR scope_agency IS NULL THEN RETURN NULL; END IF;
  SELECT m."campaignId" INTO campaign FROM "CreatorCampaignFan" m
    WHERE m."creatorId"=c AND m."agencyId"=a AND m."fanId"=f AND m."attributedAt"<=t
    ORDER BY m."attributedAt" DESC,m."id" DESC LIMIT 1;
  RETURN campaign;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_read_capture_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE r JSONB; prior JSONB; a TEXT; c TEXT; f TEXT; kind TEXT;
BEGIN
  r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='CreatorAccount' THEN
    -- A creator without campaigns has a virtual empty read model; no bootstrap debt.
    RETURN NEW;
  END IF;
  a:=r->>'agencyId'; c:=r->>'creatorId'; f:=r->>'fanId';
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL)
     OR NOT EXISTS(SELECT 1 FROM "Agency" WHERE "id"=a AND "deletedAt" IS NULL) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    prior:=to_jsonb(OLD);
    IF (prior->>'id',prior->>'creatorId',prior->>'agencyId') IS DISTINCT FROM (r->>'id',c,a) THEN
      RAISE EXCEPTION 'CAMPAIGN_READ_SOURCE_IDENTITY_IMMUTABLE';
    END IF;
    IF TG_TABLE_NAME='CreatorCampaign' AND (prior->>'isActive') IS NOT DISTINCT FROM (r->>'isActive') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='CreatorCampaignFan' AND
      (prior->>'fanId',prior->>'campaignId',prior->>'attributedAt') IS NOT DISTINCT FROM (f,r->>'campaignId',r->>'attributedAt') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='CreatorFinancialTransaction' AND
      (prior->>'fanId',prior->>'occurredAt',prior->>'amountCents',prior->>'netCents',prior->>'transactionStatus',prior->>'transactionType') IS NOT DISTINCT FROM
      (f,r->>'occurredAt',r->>'amountCents',r->>'netCents',r->>'transactionStatus',r->>'transactionType') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='CreatorFanValueCurrent' AND (prior-'updatedAt')=(r-'updatedAt') THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "CampaignReadStateData" WHERE "creatorId"=c)
     AND NOT EXISTS(SELECT 1 FROM "CreatorCampaign" WHERE "creatorId"=c) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  PERFORM "onlinod_campaign_read_enroll_v1"(a,c);
  IF TG_TABLE_NAME='CreatorFanValueCurrent' THEN
    PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',f,c,c);
    IF prior->>'fanId' IS NOT NULL AND prior->>'fanId'<>f THEN
      PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',prior->>'fanId',c,c);
    END IF;
  ELSE
    kind:=CASE TG_TABLE_NAME WHEN 'CreatorCampaign' THEN 'DIRECTORY' WHEN 'CreatorCampaignFan' THEN 'MEMBER' ELSE 'FINANCIAL' END;
    -- No projection locks or aggregate mutations in a canonical transaction.
    -- Append-only outbox: workers never contend with a producer updating an
    -- already selected signal. Uncommitted sequence gaps are not cursor gaps.
    INSERT INTO "CampaignReadChange"("agencyId","creatorId","kind","sourceId") VALUES(a,c,kind,r->>'id');
    PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_FACT','CampaignReadChange',c,c,c);
    IF kind='MEMBER' THEN
      PERFORM "onlinod_campaign_read_repair_v2"(a,c,f,r->>'id',(r->>'attributedAt')::timestamp);
      PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',f,c,c);
      IF TG_OP='UPDATE' THEN
        PERFORM "onlinod_campaign_read_repair_v2"(a,c,prior->>'fanId',prior->>'id',(prior->>'attributedAt')::timestamp);
        IF prior->>'fanId'<>f THEN PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_VALUE','CampaignFan',prior->>'fanId',c,c); END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_read_enroll_v1(a text, c text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "CampaignReadStateData"("agencyId","creatorId") VALUES(a,c) ON CONFLICT DO NOTHING;
  IF FOUND THEN PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_BACKFILL','CampaignReadState',c,c,c); END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_read_repair_v1(a text, c text, f text, t timestamp without time zone)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF f IS NULL OR t IS NULL THEN RETURN; END IF;
  INSERT INTO "CampaignReadRepair"("agencyId","creatorId","fanId","fromAt") VALUES(a,c,f,t)
    ON CONFLICT("creatorId","fanId") DO UPDATE SET "fromAt"=LEAST("CampaignReadRepair"."fromAt",EXCLUDED."fromAt");
  PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_ATTRIBUTION','CampaignFan',f,c,c);
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_read_repair_v2(a text, c text, f text, source_id text, t timestamp without time zone)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE successor TIMESTAMP(3);
BEGIN
  IF f IS NULL OR t IS NULL THEN RETURN; END IF;
  successor:="onlinod_campaign_read_successor_v3"(a,c,f,source_id,t);
  IF successor=t THEN RETURN; END IF;
  INSERT INTO "CampaignReadRepairInterval"("agencyId","creatorId","fanId","fromAt","untilAt") VALUES(a,c,f,t,successor);
  PERFORM "phase2_publish_domain_work"(a,'CAMPAIGN_ATTRIBUTION','CampaignFan',f,c,c);
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_read_successor_v3(a text, c text, f text, source_id text, t timestamp without time zone)
 RETURNS timestamp without time zone
 LANGUAGE plpgsql
 SET enable_sort TO 'off'
AS $function$
DECLARE successor TIMESTAMP(3); scope_agency TEXT;
BEGIN
  IF f IS NULL OR t IS NULL OR source_id IS NULL THEN RETURN NULL; END IF;
  -- Reject a mismatched scope with one PK lookup, before visiting memberships.
  SELECT "agencyId" INTO scope_agency FROM "CreatorAccount" WHERE "id"=c;
  IF scope_agency IS DISTINCT FROM a OR scope_agency IS NULL THEN RETURN NULL; END IF;
  SELECT m."attributedAt" INTO successor FROM "CreatorCampaignFan" m
    WHERE m."creatorId"=c AND m."agencyId"=a AND m."fanId"=f AND m."id"<>source_id
      AND (m."attributedAt",m."id")>(t,source_id)
    ORDER BY m."attributedAt",m."id" LIMIT 1;
  RETURN successor;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_refresh_work_scope_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF pg_trigger_depth()>1 THEN RETURN NEW; END IF;
  IF current_setting('onlinod.campaign_refresh_creator',true) IS DISTINCT FROM NEW."creatorId" THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_CREATOR_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' AND
    ROW(NEW."id",NEW."agencyId",NEW."creatorId",NEW."scanRunId",NEW."scanStartedAt",NEW."onlyFansUserId",
      NEW."campaignJobId",NEW."demandId",NEW."requestedRevision",NEW."freshnessCutoffAt") IS DISTINCT FROM
    ROW(OLD."id",OLD."agencyId",OLD."creatorId",OLD."scanRunId",OLD."scanStartedAt",OLD."onlyFansUserId",
      OLD."campaignJobId",OLD."demandId",OLD."requestedRevision",OLD."freshnessCutoffAt") THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "CreatorCampaignCollectionState" s
    WHERE s."agencyId"=NEW."agencyId" AND s."creatorId"=NEW."creatorId"
      AND s."fanValueCoverageScanRunId"=NEW."scanRunId") THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_GENERATION_SUPERSEDED';
  END IF;
  IF NEW."demandId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "CreatorFanRefreshDemand" d
    WHERE d."id"=NEW."demandId" AND d."agencyId"=NEW."agencyId"
      AND d."creatorId"=NEW."creatorId" AND d."onlyFansUserId"=NEW."onlyFansUserId") THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_DEMAND_SCOPE_INVALID';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "JobInstance" j WHERE j."id"=NEW."campaignJobId"
    AND j."agencyId"=NEW."agencyId" AND j."creatorId"=NEW."creatorId")
    OR (NEW."refreshJobId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "JobInstance" j
      WHERE j."id"=NEW."refreshJobId" AND j."agencyId"=NEW."agencyId" AND j."creatorId"=NEW."creatorId")) THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_JOB_SCOPE_INVALID';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_campaign_refresh_work_writer_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Referential actions may clear a Job/Demand FK during lifecycle cleanup.
  IF pg_trigger_depth()>1 THEN RETURN NULL; END IF;
  IF current_setting('onlinod.campaign_refresh_work_version',true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'CAMPAIGN_REFRESH_WORK_EXECUTOR_REQUIRED';
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_capacity_mark_dirty()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Preserve first enqueue time: a hot source must not move to the end forever.
  INSERT INTO "ProviderCapacityDirty" ("kind","sourceId","touchedAt")
  VALUES (TG_ARGV[0], CASE WHEN TG_OP='DELETE' THEN OLD."id" ELSE NEW."id" END, clock_timestamp())
  ON CONFLICT ("kind","sourceId") DO UPDATE SET "sourceId"=EXCLUDED."sourceId";
  -- An id rewrite is rare but must retract the former contribution too.
  IF TG_OP='UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
    INSERT INTO "ProviderCapacityDirty" ("kind","sourceId","touchedAt")
    VALUES (TG_ARGV[0], OLD."id", clock_timestamp()) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_capacity_publication_fence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Legacy binaries can finish work but cannot publish over the new authority.
  IF NEW."sourceVersion" <> 'phase6_provider_capacity_debt_v1' THEN RETURN NULL; END IF;
  IF current_setting('onlinod.capacity_projection_revision',true) IS DISTINCT FROM NEW."projectionRevision"::text
    OR NOT EXISTS (SELECT 1 FROM "ProviderCapacityProjectionState" WHERE "id"=NEW."id"
      AND "generation"='phase6_capacity_observation_v2' AND "revision"=NEW."projectionRevision") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_OWNER_REQUIRED';
  END IF;
  IF TG_OP='UPDATE' AND (NEW."projectionRevision" <= OLD."projectionRevision" OR NEW."sampledAt" < OLD."sampledAt") THEN
    RAISE EXCEPTION 'CAPACITY_PUBLICATION_STALE';
  END IF;
  RETURN NEW;
END $function$;

CREATE FUNCTION public.onlinod_enforce_provider_gate_waiter_registration() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."activePermitId" IS NOT NULL AND NEW."activePermitId" IS DISTINCT FROM OLD."activePermitId" AND NOT EXISTS (
    SELECT 1 FROM "OfProviderRequestGateWaiter" w WHERE w."waiterId"=NEW."activePermitId"
      AND w."agencyId"=NEW."activeAgencyId" AND w."creatorId"=NEW."activeCreatorId"
      AND w."deviceId"=NEW."activeDeviceId" AND w."capability"=NEW."activeCapability"
      AND w."leaseUntil">clock_timestamp()
  ) THEN RAISE EXCEPTION 'ONLINOD_PROVIDER_GATE_WAITER_REQUIRED' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_entitlement_revision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE ignored TEXT[] := ARRAY['entitlementRevision','updatedAt','lastRenewalAttemptAt','lastRenewalErrorCode','lastRevenue30dCents','lastRevenueCapturedAt'];
BEGIN
 IF (to_jsonb(NEW)-ignored) IS DISTINCT FROM (to_jsonb(OLD)-ignored) THEN
   NEW."entitlementRevision" := OLD."entitlementRevision"+1;
 ELSE NEW."entitlementRevision" := OLD."entitlementRevision";
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_mass_agency_retirement_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE retiring BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' THEN
    retiring := OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL;
    IF NOT retiring THEN RETURN NEW; END IF;
  ELSE retiring := OLD."deletedAt" IS NULL; END IF;
  IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "agencyId"=OLD."id" AND ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) ) THEN
    RAISE EXCEPTION 'AGENCY_HAS_ACTIVE_MASS' USING ERRCODE='23514';
  END IF;
  IF retiring AND EXISTS(SELECT 1 FROM "CreatorAccount" c LEFT JOIN "MassCreatorDeliveryState" s ON s."creatorId"=c."id" AND s."agencyId"=c."agencyId"
    WHERE c."agencyId"=OLD."id" AND c."deletedAt" IS NULL AND NULLIF(btrim(c."remoteId"),'') IS NOT NULL
      AND (s."retirementId" IS NULL OR s."retirementProofId" IS NULL OR s."retirementProofRevision" IS DISTINCT FROM s."sourceRevision"
        OR s."retirementProviderId" IS DISTINCT FROM c."remoteId")) THEN
    RAISE EXCEPTION 'AGENCY_MASS_PROVIDER_SNAPSHOT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_mass_creator_retirement_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE retiring BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."remoteId" IS DISTINCT FROM OLD."remoteId" THEN
      UPDATE "MassCreatorDeliveryState" SET "sourceRevision"="sourceRevision"+1,"retirementProofId"=NULL,
        "retirementProofRevision"=NULL,"retirementProofObservedAt"=NULL WHERE "creatorId"=OLD."id";
    END IF;
    retiring := OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL;
    IF NOT retiring THEN RETURN NEW; END IF;
  ELSE retiring := OLD."deletedAt" IS NULL; END IF;
  IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "creatorId"=OLD."id" AND "agencyId"=OLD."agencyId" AND ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) ) THEN
    RAISE EXCEPTION 'CREATOR_HAS_ACTIVE_MASS' USING ERRCODE='23514';
  END IF;
  IF retiring AND NULLIF(btrim(OLD."remoteId"),'') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM "MassCreatorDeliveryState" s WHERE s."creatorId"=OLD."id" AND s."agencyId"=OLD."agencyId"
      AND s."retirementId" IS NOT NULL AND s."retirementProofId" IS NOT NULL AND s."retirementProofRevision"=s."sourceRevision"
      AND s."retirementProviderId" IS NOT DISTINCT FROM OLD."remoteId") THEN
    RAISE EXCEPTION 'CREATOR_MASS_PROVIDER_SNAPSHOT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_mass_delivery_delete_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."actionType" NOT IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') THEN RETURN OLD; END IF;
  -- Parent cascade is permitted only after the parent's own retirement guard.
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=OLD."creatorId") THEN RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "id"=OLD."id" AND ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) ) THEN
    RAISE EXCEPTION 'MASS_CURRENT_DEBT_NOT_DELETABLE' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_mass_delivery_mutation_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE s "MassCreatorDeliveryState"%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD."actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL')
     AND ROW(OLD."agencyId",OLD."creatorId",OLD."actionType") IS DISTINCT FROM ROW(NEW."agencyId",NEW."creatorId",NEW."actionType") THEN
    RAISE EXCEPTION 'MASS_DELIVERY_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NEW."actionType" NOT IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(OLD."agencyId",OLD."creatorId",OLD."actionType") IS DISTINCT FROM ROW(NEW."agencyId",NEW."creatorId",NEW."actionType") THEN
      RAISE EXCEPTION 'MASS_DELIVERY_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    IF ROW(OLD."status",OLD."targetId",OLD."writeCommitAt",OLD."writeCommitRevision",OLD."remoteLifecycleState",OLD."remoteTargetId",OLD."remoteLifecycleObservedAt",OLD."failureCode")
       IS NOT DISTINCT FROM ROW(NEW."status",NEW."targetId",NEW."writeCommitAt",NEW."writeCommitRevision",NEW."remoteLifecycleState",NEW."remoteTargetId",NEW."remoteLifecycleObservedAt",NEW."failureCode") THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=NEW."creatorId" AND "agencyId"=NEW."agencyId") THEN
    RAISE EXCEPTION 'MASS_DELIVERY_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;
  INSERT INTO "MassCreatorDeliveryState"("creatorId","agencyId") VALUES (NEW."creatorId",NEW."agencyId") ON CONFLICT ("creatorId") DO NOTHING;
  SELECT * INTO s FROM "MassCreatorDeliveryState" WHERE "creatorId"=NEW."creatorId" FOR UPDATE;
  IF s."agencyId" IS DISTINCT FROM NEW."agencyId" THEN RAISE EXCEPTION 'MASS_DELIVERY_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF s."retirementId" IS NOT NULL AND NEW."actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE') THEN
    IF TG_OP='INSERT' OR (NEW."status"='COMMITTING' AND (OLD."status" IS DISTINCT FROM 'COMMITTING' OR NEW."writeCommitAt" IS DISTINCT FROM OLD."writeCommitAt" OR NEW."writeCommitRevision" IS DISTINCT FROM OLD."writeCommitRevision")) THEN
      RAISE EXCEPTION 'MASS_CREATOR_RETIREMENT_IN_PROGRESS' USING ERRCODE='23514';
    END IF;
  END IF;
  UPDATE "MassCreatorDeliveryState" SET "sourceRevision"="sourceRevision"+1,
    "retirementProofId"=NULL,"retirementProofRevision"=NULL,"retirementProofObservedAt"=NULL,
    "updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "creatorId"=NEW."creatorId";
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_pricing_revision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['pricingRevision','updatedAt','revenue30dCents']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['pricingRevision','updatedAt','revenue30dCents']) THEN
  NEW."pricingRevision" := OLD."pricingRevision"+1;
 ELSE NEW."pricingRevision" := OLD."pricingRevision"; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_project_team_activity_contribution_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_day TIMESTAMP(3);
  v_creator_key TEXT;
  v_messages INTEGER := 0;
  v_ppv_sent INTEGER := 0;
  v_broadcast INTEGER := 0;
  v_posts INTEGER := 0;
  v_stories INTEGER := 0;
  v_content INTEGER := 0;
  v_media INTEGER := 0;
  v_content_at TIMESTAMP(3) := NULL;
  v_contributes BOOLEAN := FALSE;
  v_semantic_key TEXT;
  v_cutover TIMESTAMP(3);
  v_inserted INTEGER := 0;
BEGIN
  IF NEW."source" <> 'electron_team_v13' OR NEW."eventKind" IS NULL OR NEW."memberId" IS NULL THEN
    RETURN NEW;
  END IF;

  v_day := date_trunc('day', NEW."ts");
  v_creator_key := COALESCE(NEW."creatorId", NEW."accountId", '__none__');
  v_semantic_key := NULLIF(NEW."semanticEventKey", '');
  -- Rolling-deploy compatibility: old binaries do not yet populate semanticEventKey.
  -- Derive the same stable business identity from canonical columns, never localId.
  IF v_semantic_key IS NULL THEN
    IF NEW."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND NEW."messageId" IS NOT NULL THEN
      v_semantic_key := v_creator_key || ':message:' || NEW."messageId";
    ELSIF NEW."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED' AND NEW."broadcastDispatchId" IS NOT NULL THEN
      v_semantic_key := v_creator_key || ':broadcast:' || NEW."broadcastDispatchId";
    ELSIF NEW."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED','CONTENT_STORY_PUBLISHED_CONFIRMED') AND NEW."contentId" IS NOT NULL THEN
      v_semantic_key := v_creator_key || ':content:' || NEW."contentId";
    END IF;
  END IF;
  NEW."semanticEventKey" := v_semantic_key;

  IF NEW."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_messages := 1;
    IF NEW."isPpv" = TRUE OR COALESCE(NEW."priceCents", 0) > 0 THEN v_ppv_sent := 1; END IF;
  ELSIF NEW."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_broadcast := 1;
  ELSIF NEW."eventKind" = 'CONTENT_POST_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_posts := 1; v_content := 1;
    v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  ELSIF NEW."eventKind" = 'CONTENT_STORY_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE; v_stories := 1; v_content := 1;
    v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  END IF;

  IF NOT v_contributes THEN
    NEW."historicalProjectionVersion" := 'team_activity_zero_v2';
    NEW."historicalProjectedAt" := clock_timestamp();
    RETURN NEW;
  END IF;

  -- A contributing event without a stable semantic identity fails closed: keep raw
  -- evidence and do not create a new aggregate contribution from transport identity.
  IF v_semantic_key IS NULL THEN
    NEW."historicalProjectionVersion" := 'team_activity_unkeyed_v2';
    NEW."historicalProjectedAt" := NULL;
    RETURN NEW;
  END IF;

  SELECT c."activityContributionCutoverAt" INTO v_cutover
    FROM "TeamHistoricalAnalyticsCoverage" c
   WHERE c."agencyId" = NEW."agencyId";

  -- Coverage can be absent only for an agency created after this migration. New
  -- agencies have no sealed legacy daily baseline, so historical provider events are admissible.
  IF v_cutover IS NULL THEN
    INSERT INTO "TeamHistoricalAnalyticsCoverage"(
      "agencyId", "activityCoverageFrom", "moneyCoverageFrom",
      "activityProjectionVersion", "moneyProjectionVersion", "activityContributionVersion",
      "activityContributionCutoverAt", "retentionVectorVersion", "source", "backfilledAt", "createdAt", "updatedAt"
    ) VALUES (
      NEW."agencyId", NEW."ts", NEW."ts", 'team_activity_daily_v1', 'team_money_fact_v2',
      'team_activity_contribution_v2', TIMESTAMP '1970-01-01 00:00:00', 'team_retention_vector_v2',
      'phase2_retention_roots_v2_new_agency', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ) ON CONFLICT ("agencyId") DO NOTHING;
    v_cutover := TIMESTAMP '1970-01-01 00:00:00';
  END IF;

  -- Existing pre-cutover history with no compact identity is ambiguous: daily v1 may
  -- already include it. Seal the key without adding another contribution.
  IF NEW."ts" < v_cutover THEN
    INSERT INTO "TeamActivityContribution"(
      "id","agencyId","eventKind","semanticKey","state","memberId","creatorKey","creatorId","day",
      "sourceEventAt","projectionVersion","createdAt","updatedAt"
    ) VALUES (
      'tac_' || md5(NEW."agencyId" || ':' || NEW."eventKind" || ':' || v_semantic_key),
      NEW."agencyId", NEW."eventKind", v_semantic_key, 'SEALED_LEGACY', NEW."memberId", v_creator_key,
      NEW."creatorId", v_day, NEW."ts", 'team_activity_contribution_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    ) ON CONFLICT ("agencyId","eventKind","semanticKey") DO NOTHING;
    NEW."historicalProjectionVersion" := 'team_activity_legacy_sealed_v2';
    NEW."historicalProjectedAt" := clock_timestamp();
    RETURN NEW;
  END IF;

  INSERT INTO "TeamActivityContribution"(
    "id","agencyId","eventKind","semanticKey","state","memberId","creatorKey","creatorId","day",
    "messagesSent","ppvSentMessages","broadcastDispatches","postsCreated","storiesCreated",
    "contentActions","contentMediaItemsPublished","sourceEventAt","projectionVersion","createdAt","updatedAt"
  ) VALUES (
    'tac_' || md5(NEW."agencyId" || ':' || NEW."eventKind" || ':' || v_semantic_key),
    NEW."agencyId", NEW."eventKind", v_semantic_key, 'APPLIED', NEW."memberId", v_creator_key, NEW."creatorId", v_day,
    v_messages, v_ppv_sent, v_broadcast, v_posts, v_stories, v_content, v_media, NEW."ts",
    'team_activity_contribution_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ) ON CONFLICT ("agencyId","eventKind","semanticKey") DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    INSERT INTO "TeamMemberActivityDaily" (
      "id", "agencyId", "memberId", "creatorKey", "creatorId", "day",
      "messagesSent", "ppvSentMessages", "broadcastDispatches", "postsCreated", "storiesCreated",
      "contentActions", "contentMediaItemsPublished", "sourceEventCount", "firstEventAt", "lastEventAt",
      "lastContentActivityAt", "projectionVersion", "createdAt", "updatedAt"
    ) VALUES (
      'tad_' || md5(NEW."agencyId" || ':' || NEW."memberId" || ':' || v_creator_key || ':' || v_day::text),
      NEW."agencyId", NEW."memberId", v_creator_key, NEW."creatorId", v_day,
      v_messages, v_ppv_sent, v_broadcast, v_posts, v_stories, v_content, v_media,
      1, NEW."ts", NEW."ts", v_content_at, 'team_activity_daily_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agencyId", "memberId", "creatorKey", "day") DO UPDATE SET
      "messagesSent" = "TeamMemberActivityDaily"."messagesSent" + EXCLUDED."messagesSent",
      "ppvSentMessages" = "TeamMemberActivityDaily"."ppvSentMessages" + EXCLUDED."ppvSentMessages",
      "broadcastDispatches" = "TeamMemberActivityDaily"."broadcastDispatches" + EXCLUDED."broadcastDispatches",
      "postsCreated" = "TeamMemberActivityDaily"."postsCreated" + EXCLUDED."postsCreated",
      "storiesCreated" = "TeamMemberActivityDaily"."storiesCreated" + EXCLUDED."storiesCreated",
      "contentActions" = "TeamMemberActivityDaily"."contentActions" + EXCLUDED."contentActions",
      "contentMediaItemsPublished" = "TeamMemberActivityDaily"."contentMediaItemsPublished" + EXCLUDED."contentMediaItemsPublished",
      "sourceEventCount" = "TeamMemberActivityDaily"."sourceEventCount" + 1,
      "firstEventAt" = LEAST("TeamMemberActivityDaily"."firstEventAt", EXCLUDED."firstEventAt"),
      "lastEventAt" = GREATEST("TeamMemberActivityDaily"."lastEventAt", EXCLUDED."lastEventAt"),
      "lastContentActivityAt" = CASE
        WHEN EXCLUDED."lastContentActivityAt" IS NULL THEN "TeamMemberActivityDaily"."lastContentActivityAt"
        WHEN "TeamMemberActivityDaily"."lastContentActivityAt" IS NULL THEN EXCLUDED."lastContentActivityAt"
        ELSE GREATEST("TeamMemberActivityDaily"."lastContentActivityAt", EXCLUDED."lastContentActivityAt")
      END,
      "updatedAt" = CURRENT_TIMESTAMP;
  END IF;

  NEW."historicalProjectionVersion" := 'team_activity_contribution_v2';
  NEW."historicalProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_project_team_activity_daily_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_day TIMESTAMP(3);
  v_creator_key TEXT;
  v_messages INTEGER := 0;
  v_ppv_sent INTEGER := 0;
  v_broadcast INTEGER := 0;
  v_posts INTEGER := 0;
  v_stories INTEGER := 0;
  v_content INTEGER := 0;
  v_media INTEGER := 0;
  v_content_at TIMESTAMP(3) := NULL;
  v_contributes BOOLEAN := FALSE;
BEGIN
  IF NEW."source" <> 'electron_team_v13' OR NEW."eventKind" IS NULL OR NEW."memberId" IS NULL THEN
    RETURN NEW;
  END IF;

  v_day := date_trunc('day', NEW."ts");
  v_creator_key := COALESCE(NEW."creatorId", NEW."accountId", '__none__');

  IF NEW."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_messages := 1;
    IF NEW."isPpv" = TRUE OR COALESCE(NEW."priceCents", 0) > 0 THEN v_ppv_sent := 1; END IF;
  END IF;
  IF NEW."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_broadcast := 1;
  END IF;
  IF NEW."eventKind" = 'CONTENT_POST_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_posts := 1; v_content := 1; v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  END IF;
  IF NEW."eventKind" = 'CONTENT_STORY_PUBLISHED_CONFIRMED' AND NEW."actionSource" = 'MANUAL' AND NEW."lifecycle" = 'CONFIRMED' THEN
    v_contributes := TRUE;
    v_stories := 1; v_content := 1; v_media := GREATEST(COALESCE(NEW."mediaCount", 0), 0); v_content_at := NEW."ts";
  END IF;

  -- High-volume incoming/seen/coverage telemetry contributes zero to this compact
  -- activity family. Mark the zero contribution as projected without hammering a
  -- shared member/creator/day row on every inbound event.
  IF NOT v_contributes THEN
    NEW."historicalProjectionVersion" := 'team_activity_daily_v1';
    NEW."historicalProjectedAt" := clock_timestamp();
    RETURN NEW;
  END IF;

  INSERT INTO "TeamMemberActivityDaily" (
    "id", "agencyId", "memberId", "creatorKey", "creatorId", "day",
    "messagesSent", "ppvSentMessages", "broadcastDispatches", "postsCreated", "storiesCreated",
    "contentActions", "contentMediaItemsPublished", "sourceEventCount", "firstEventAt", "lastEventAt",
    "lastContentActivityAt", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'tad_' || md5(NEW."agencyId" || ':' || NEW."memberId" || ':' || v_creator_key || ':' || v_day::text),
    NEW."agencyId", NEW."memberId", v_creator_key, NEW."creatorId", v_day,
    v_messages, v_ppv_sent, v_broadcast, v_posts, v_stories, v_content, v_media,
    1, NEW."ts", NEW."ts", v_content_at, 'team_activity_daily_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "memberId", "creatorKey", "day") DO UPDATE SET
    "messagesSent" = "TeamMemberActivityDaily"."messagesSent" + EXCLUDED."messagesSent",
    "ppvSentMessages" = "TeamMemberActivityDaily"."ppvSentMessages" + EXCLUDED."ppvSentMessages",
    "broadcastDispatches" = "TeamMemberActivityDaily"."broadcastDispatches" + EXCLUDED."broadcastDispatches",
    "postsCreated" = "TeamMemberActivityDaily"."postsCreated" + EXCLUDED."postsCreated",
    "storiesCreated" = "TeamMemberActivityDaily"."storiesCreated" + EXCLUDED."storiesCreated",
    "contentActions" = "TeamMemberActivityDaily"."contentActions" + EXCLUDED."contentActions",
    "contentMediaItemsPublished" = "TeamMemberActivityDaily"."contentMediaItemsPublished" + EXCLUDED."contentMediaItemsPublished",
    "sourceEventCount" = "TeamMemberActivityDaily"."sourceEventCount" + 1,
    "firstEventAt" = LEAST("TeamMemberActivityDaily"."firstEventAt", EXCLUDED."firstEventAt"),
    "lastEventAt" = GREATEST("TeamMemberActivityDaily"."lastEventAt", EXCLUDED."lastEventAt"),
    "lastContentActivityAt" = CASE
      WHEN EXCLUDED."lastContentActivityAt" IS NULL THEN "TeamMemberActivityDaily"."lastContentActivityAt"
      WHEN "TeamMemberActivityDaily"."lastContentActivityAt" IS NULL THEN EXCLUDED."lastContentActivityAt"
      ELSE GREATEST("TeamMemberActivityDaily"."lastContentActivityAt", EXCLUDED."lastContentActivityAt")
    END,
    "updatedAt" = CURRENT_TIMESTAMP;

  NEW."historicalProjectionVersion" := 'team_activity_daily_v1';
  NEW."historicalProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_project_team_ppv_fact_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "projectionVersion",
    "createdAt", "updatedAt"
  ) VALUES (
    'ppv_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'PPV', NEW."id", NEW."purchaseId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", COALESCE(NEW."fanId", NEW."buyerFanId"), NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."purchasedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    COALESCE(NEW."financialTransactionId", NEW."creatorSaleId"), NEW."creatorSaleId", NEW."financialTransactionId", NULL,
    NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    'team_money_fact_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId" = EXCLUDED."externalId", "creatorId" = EXCLUDED."creatorId", "memberId" = EXCLUDED."memberId",
    "userId" = EXCLUDED."userId", "fanId" = EXCLUDED."fanId", "dialogId" = EXCLUDED."dialogId",
    "amountCents" = EXCLUDED."amountCents", "currency" = EXCLUDED."currency", "occurredAt" = EXCLUDED."occurredAt",
    "businessStatus" = EXCLUDED."businessStatus", "financialStatus" = EXCLUDED."financialStatus",
    "attributionActive" = EXCLUDED."attributionActive", "canonicalMoneyId" = EXCLUDED."canonicalMoneyId",
    "creatorSaleId" = EXCLUDED."creatorSaleId", "financialTransactionId" = EXCLUDED."financialTransactionId",
    "creatorTipId" = EXCLUDED."creatorTipId", "attributionBasis" = EXCLUDED."attributionBasis",
    "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
    "projectionVersion" = 'team_money_fact_v1', "updatedAt" = CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v1';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_project_team_ppv_fact_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  business_key TEXT;
  previous_business_key TEXT;
  first_lock_key TEXT;
  second_lock_key TEXT;
BEGIN
  business_key := CASE
    WHEN NEW."creatorSaleId" IS NOT NULL THEN 'sale:' || NEW."creatorSaleId"
    WHEN NEW."financialTransactionId" IS NOT NULL THEN 'financial:' || NEW."financialTransactionId"
    ELSE NULL
  END;

  SELECT "canonicalBusinessKey" INTO previous_business_key
  FROM "TeamMoneyAttributionFact"
  WHERE "agencyId" = NEW."agencyId" AND "sourceType" = 'PPV' AND "sourceRowId" = NEW."id";

  -- Lock both the former and current peer-set identities in deterministic
  -- lexical order. Concurrent duplicate generations therefore cannot each see
  -- themselves as the sole canonical peer and commit two CANONICAL facts.
  IF previous_business_key IS NOT NULL AND business_key IS NOT NULL AND previous_business_key <> business_key THEN
    first_lock_key := LEAST(previous_business_key, business_key);
    second_lock_key := GREATEST(previous_business_key, business_key);
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || first_lock_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || second_lock_key, 0));
  ELSIF COALESCE(business_key, previous_business_key) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':PPV:' || COALESCE(business_key, previous_business_key), 0));
  END IF;

  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'ppv_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'PPV', NEW."id", NEW."purchaseId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", COALESCE(NEW."fanId", NEW."buyerFanId"), NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."purchasedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    COALESCE(NEW."financialTransactionId", NEW."creatorSaleId"), NEW."creatorSaleId", NEW."financialTransactionId", NULL,
    NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP), NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'PENDING' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE 'PEER_SET_RECLASSIFICATION_PENDING' END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey",
    "classificationState"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'INCOMPLETE'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationState"
    END,
    "classificationReason"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PEER_SET_RECLASSIFICATION_PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationReason"
    END,
    "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'PPV', business_key);
  IF previous_business_key IS NOT NULL AND previous_business_key IS DISTINCT FROM business_key THEN
    PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'PPV', previous_business_key);
  END IF;

  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_project_team_tip_fact_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "projectionVersion",
    "createdAt", "updatedAt"
  ) VALUES (
    'tip_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'TIP', NEW."id", NEW."tipId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", NEW."fanId", NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."receivedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'claimed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    NEW."creatorTipId", NULL, NULL, NEW."creatorTipId", NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    'team_money_fact_v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId" = EXCLUDED."externalId", "creatorId" = EXCLUDED."creatorId", "memberId" = EXCLUDED."memberId",
    "userId" = EXCLUDED."userId", "fanId" = EXCLUDED."fanId", "dialogId" = EXCLUDED."dialogId",
    "amountCents" = EXCLUDED."amountCents", "currency" = EXCLUDED."currency", "occurredAt" = EXCLUDED."occurredAt",
    "businessStatus" = EXCLUDED."businessStatus", "financialStatus" = EXCLUDED."financialStatus",
    "attributionActive" = EXCLUDED."attributionActive", "canonicalMoneyId" = EXCLUDED."canonicalMoneyId",
    "creatorSaleId" = EXCLUDED."creatorSaleId", "financialTransactionId" = EXCLUDED."financialTransactionId",
    "creatorTipId" = EXCLUDED."creatorTipId", "attributionBasis" = EXCLUDED."attributionBasis",
    "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
    "projectionVersion" = 'team_money_fact_v1', "updatedAt" = CURRENT_TIMESTAMP;
  NEW."historicalFactVersion" := 'team_money_fact_v1';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_project_team_tip_fact_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  business_key TEXT;
  previous_business_key TEXT;
  first_lock_key TEXT;
  second_lock_key TEXT;
BEGIN
  business_key := CASE WHEN NEW."creatorTipId" IS NOT NULL THEN 'tip:' || NEW."creatorTipId" ELSE NULL END;

  SELECT "canonicalBusinessKey" INTO previous_business_key
  FROM "TeamMoneyAttributionFact"
  WHERE "agencyId" = NEW."agencyId" AND "sourceType" = 'TIP' AND "sourceRowId" = NEW."id";

  IF previous_business_key IS NOT NULL AND business_key IS NOT NULL AND previous_business_key <> business_key THEN
    first_lock_key := LEAST(previous_business_key, business_key);
    second_lock_key := GREATEST(previous_business_key, business_key);
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || first_lock_key, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || second_lock_key, 0));
  ELSIF COALESCE(business_key, previous_business_key) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('team_money_peer:' || NEW."agencyId" || ':TIP:' || COALESCE(business_key, previous_business_key), 0));
  END IF;

  INSERT INTO "TeamMoneyAttributionFact" (
    "id", "agencyId", "sourceType", "sourceRowId", "externalId", "creatorId", "memberId", "userId",
    "fanId", "dialogId", "amountCents", "currency", "occurredAt", "businessStatus", "financialStatus",
    "attributionActive", "canonicalMoneyId", "creatorSaleId", "financialTransactionId", "creatorTipId",
    "attributionBasis", "sourceUpdatedAt", "rootId", "rootVersion", "canonicalBusinessKey",
    "classificationState", "classificationReason", "classificationVersion", "projectionVersion", "createdAt", "updatedAt"
  ) VALUES (
    'tip_' || md5(NEW."agencyId" || ':' || NEW."id"), NEW."agencyId", 'TIP', NEW."id", NEW."tipId", NEW."creatorId",
    NEW."attributedMemberId", NEW."attributedUserId", NEW."fanId", NEW."dialogId",
    GREATEST(COALESCE(NEW."amountCents", 0), 0), UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')), NEW."receivedAt",
    NEW."status", NEW."financialStatus",
    (NEW."status" IN ('attributed', 'claimed', 'resolved') AND NEW."attributedMemberId" IS NOT NULL AND COALESCE(lower(NEW."financialStatus"), '') <> 'undo'),
    NEW."creatorTipId", NULL, NULL, NEW."creatorTipId", NEW."attributionBasis", COALESCE(NEW."updatedAt", CURRENT_TIMESTAMP),
    NEW."id", 'team_money_root_v2', business_key,
    CASE WHEN business_key IS NULL THEN 'INCOMPLETE' ELSE 'PENDING' END,
    CASE WHEN business_key IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING' ELSE 'PEER_SET_RECLASSIFICATION_PENDING' END,
    'team_money_root_classification_v1', 'team_money_fact_v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId", "sourceType", "sourceRowId") DO UPDATE SET
    "externalId"=EXCLUDED."externalId", "creatorId"=EXCLUDED."creatorId", "memberId"=EXCLUDED."memberId",
    "userId"=EXCLUDED."userId", "fanId"=EXCLUDED."fanId", "dialogId"=EXCLUDED."dialogId",
    "amountCents"=EXCLUDED."amountCents", "currency"=EXCLUDED."currency", "occurredAt"=EXCLUDED."occurredAt",
    "businessStatus"=EXCLUDED."businessStatus", "financialStatus"=EXCLUDED."financialStatus",
    "attributionActive"=EXCLUDED."attributionActive", "canonicalMoneyId"=EXCLUDED."canonicalMoneyId",
    "creatorSaleId"=EXCLUDED."creatorSaleId", "financialTransactionId"=EXCLUDED."financialTransactionId",
    "creatorTipId"=EXCLUDED."creatorTipId", "attributionBasis"=EXCLUDED."attributionBasis",
    "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt", "rootId"=EXCLUDED."rootId", "rootVersion"='team_money_root_v2',
    "canonicalBusinessKey"=EXCLUDED."canonicalBusinessKey",
    "classificationState"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'INCOMPLETE'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationState"
    END,
    "classificationReason"=CASE
      WHEN EXCLUDED."canonicalBusinessKey" IS NULL THEN 'LIVE_ROOT_CANONICAL_BUSINESS_KEY_MISSING'
      WHEN "TeamMoneyAttributionFact"."canonicalBusinessKey" IS DISTINCT FROM EXCLUDED."canonicalBusinessKey" THEN 'PEER_SET_RECLASSIFICATION_PENDING'
      ELSE "TeamMoneyAttributionFact"."classificationReason"
    END,
    "classificationVersion"='team_money_root_classification_v1',
    "projectionVersion"='team_money_fact_v2', "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'TIP', business_key);
  IF previous_business_key IS NOT NULL AND previous_business_key IS DISTINCT FROM business_key THEN
    PERFORM "phase2_reclassify_team_money_peer_set"(NEW."agencyId", 'TIP', previous_business_key);
  END IF;

  NEW."historicalFactVersion" := 'team_money_fact_v2';
  NEW."historicalFactProjectedAt" := clock_timestamp();
  NEW."rootVersion" := 'team_money_root_v2';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_refresh_team_fact_from_creator_sale_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "TeamMoneyAttributionFact" f
  SET "amountCents" = GREATEST(COALESCE(NEW."amountCents", 0), 0),
      "currency" = UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')),
      "occurredAt" = NEW."purchasedAt",
      "financialStatus" = CASE WHEN f."financialTransactionId" IS NULL THEN NEW."transactionStatus" ELSE f."financialStatus" END,
      "attributionActive" = (
        f."businessStatus" IN ('attributed', 'resolved')
        AND f."memberId" IS NOT NULL
        AND COALESCE(lower(CASE WHEN f."financialTransactionId" IS NULL THEN NEW."transactionStatus" ELSE f."financialStatus" END), '') <> 'undo'
      ),
      "sourceUpdatedAt" = COALESCE(NEW."sourceUpdatedAt", NEW."updatedAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE f."sourceType" = 'PPV' AND f."creatorSaleId" = NEW."id";
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_refresh_team_fact_from_creator_tip_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "TeamMoneyAttributionFact" f
  SET "amountCents" = GREATEST(COALESCE(NEW."amountCents", 0), 0),
      "currency" = UPPER(COALESCE(NULLIF(NEW."currency", ''), 'USD')),
      "occurredAt" = NEW."tippedAt",
      "financialStatus" = NEW."transactionStatus",
      "attributionActive" = (
        f."businessStatus" IN ('attributed', 'claimed', 'resolved')
        AND f."memberId" IS NOT NULL
        AND COALESCE(lower(NEW."transactionStatus"), '') <> 'undo'
      ),
      "sourceUpdatedAt" = COALESCE(NEW."sourceUpdatedAt", NEW."updatedAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE f."sourceType" = 'TIP' AND f."creatorTipId" = NEW."id";
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_refresh_team_fact_from_financial_tx_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "TeamMoneyAttributionFact" f
  SET "financialStatus" = NEW."transactionStatus",
      "attributionActive" = (
        f."businessStatus" IN ('attributed', 'resolved')
        AND f."memberId" IS NOT NULL
        AND COALESCE(lower(NEW."transactionStatus"), '') <> 'undo'
      ),
      "sourceUpdatedAt" = COALESCE(NEW."sourceUpdatedAt", NEW."updatedAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE f."sourceType" = 'PPV' AND f."financialTransactionId" = NEW."id";
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_subscription_policy_revision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
   UPDATE "Agency" SET "billingPolicyRevision"="billingPolicyRevision"+1 WHERE "id"=NEW."agencyId";
 ELSIF TG_OP='DELETE' THEN
   UPDATE "Agency" SET "billingPolicyRevision"="billingPolicyRevision"+1 WHERE "id"=OLD."agencyId";
 ELSIF ROW(NEW."billingMode",NEW."billingPeriod",NEW."corePricePerCreatorCents",NEW."trialEndsAt",NEW."notes") IS DISTINCT FROM
       ROW(OLD."billingMode",OLD."billingPeriod",OLD."corePricePerCreatorCents",OLD."trialEndsAt",OLD."notes") THEN
   UPDATE "Agency" SET "billingPolicyRevision"="billingPolicyRevision"+1 WHERE "id"=NEW."agencyId";
 END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_sync_creator_task_activity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."creatorId" IS NULL OR NEW."agencyId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."status" NOT IN ('CLAIMED', 'SCHEDULED', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  -- A future SCHEDULED job is not activity yet. If a previously-started job is
  -- requeued, startedAt/claimedAt remains populated and the same activity row
  -- is updated instead of disappearing from the 30-day history.
  IF NEW."status" = 'SCHEDULED' AND NEW."startedAt" IS NULL AND NEW."claimedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "CreatorTaskActivity" (
    "id", "agencyId", "creatorId", "jobId", "jobKey", "mode", "stage", "status",
    "detail", "lastError", "startedAt", "completedAt", "createdAt", "updatedAt"
  ) VALUES (
    NEW."id" || ':activity',
    NEW."agencyId",
    NEW."creatorId",
    NEW."id",
    NEW."jobKey",
    COALESCE(NEW."params"->>'analyticsSyncKind', NEW."params"->>'financialMode', NEW."params"->>'campaignMode', NEW."params"->>'notificationMode'),
    NEW."params"->>'analyticsSyncStage',
    NEW."status",
    LEFT(COALESCE(NEW."progress"->>'message', ''), 500),
    LEFT(COALESCE(NEW."lastError", ''), 2000),
    COALESCE(NEW."startedAt", NEW."claimedAt"),
    NEW."completedAt",
    COALESCE(NEW."createdAt", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("jobId") DO UPDATE SET
    "jobKey" = EXCLUDED."jobKey",
    "mode" = EXCLUDED."mode",
    "stage" = EXCLUDED."stage",
    "status" = EXCLUDED."status",
    "detail" = NULLIF(EXCLUDED."detail", ''),
    "lastError" = NULLIF(EXCLUDED."lastError", ''),
    "startedAt" = COALESCE("CreatorTaskActivity"."startedAt", EXCLUDED."startedAt"),
    "completedAt" = EXCLUDED."completedAt",
    "updatedAt" = CURRENT_TIMESTAMP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_telegram_new_send_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE lifecycle TEXT;
BEGIN
  IF NEW."state"<>'COMMITTING' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."state"='COMMITTING' AND NEW."commitStartedAt" IS NOT DISTINCT FROM OLD."commitStartedAt"
     AND ROW(NEW."claimRevision",NEW."agencyId",NEW."creatorId",NEW."accountId",NEW."kind",NEW."logicalKey",NEW."payloadFingerprint",NEW."deviceId")
       IS NOT DISTINCT FROM ROW(OLD."claimRevision",OLD."agencyId",OLD."creatorId",OLD."accountId",OLD."kind",OLD."logicalKey",OLD."payloadFingerprint",OLD."deviceId") THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."commitStartedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TELEGRAM_SEND_REPLAY_NOT_ALLOWED' USING ERRCODE='23514';
  END IF;
  IF current_setting('onlinod.telegram_send_generation',true) IS DISTINCT FROM 'external_delivery_v2' THEN
    RAISE EXCEPTION 'TELEGRAM_SEND_RUNTIME_UPGRADE_REQUIRED' USING ERRCODE='23514';
  END IF;
  SELECT "lifecycleState" INTO lifecycle FROM "AgencyTelegramMtprotoAccount" WHERE "id"=NEW."accountId" AND "agencyId"=NEW."agencyId" FOR SHARE;
  IF lifecycle IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'TELEGRAM_EXECUTION_NEW_SEND_FORBIDDEN' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_add_v2(a text, c text, k text, o text, p text, d jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE previous JSONB; updated JSONB; key TEXT; amount NUMERIC;
BEGIN
  IF d='{}'::jsonb OR NOT EXISTS(SELECT 1 FROM jsonb_each_text(d) e WHERE e.value::numeric<>0) THEN RETURN; END IF;
  INSERT INTO "TrafficMetric"("agencyId","creatorId","kind","objectId","period") VALUES(a,c,k,o,p)
    ON CONFLICT DO NOTHING;
  SELECT "metrics" INTO previous FROM "TrafficMetric" WHERE "creatorId"=c AND "kind"=k AND "objectId"=o AND "period"=p FOR UPDATE;
  updated:=previous;
  FOR key,amount IN SELECT e.key,e.value::numeric FROM jsonb_each_text(d) e LOOP
    updated:=jsonb_set(updated,ARRAY[key],to_jsonb(COALESCE((updated->>key)::numeric,0)+amount));
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_each_text(updated) e WHERE e.value::numeric<0) THEN RAISE EXCEPTION 'TRAFFIC_METRIC_UNDERFLOW:%:%',k,o; END IF;
  UPDATE "TrafficMetric" SET "metrics"=updated,"updatedAt"=CURRENT_TIMESTAMP
    WHERE "creatorId"=c AND "kind"=k AND "objectId"=o AND "period"=p;
  -- Exact all-time distinct paid-fan counts, with replay-safe zero crossings.
  IF k LIKE 'receiptFan:%' AND p='*' THEN
    amount:=(CASE WHEN COALESCE((updated->>'paidSubscriptions')::numeric,0)>0 THEN 1 ELSE 0 END)
      -(CASE WHEN COALESCE((previous->>'paidSubscriptions')::numeric,0)>0 THEN 1 ELSE 0 END);
    IF amount<>0 THEN PERFORM "onlinod_traffic_add_v2"(a,c,'source',substring(k from 12),'*',jsonb_build_object('paidFans',amount)); END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(updated) e WHERE e.value::numeric<>0) THEN
    DELETE FROM "TrafficMetric" WHERE "creatorId"=c AND "kind"=k AND "objectId"=o AND "period"=p;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_canonical_capture_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME='CreatorCampaign' THEN
    IF TG_OP='INSERT' OR (OLD."name",OLD."trackingUrl",OLD."isActive",OLD."startedAt",OLD."endedAt",OLD."claimersCount",OLD."clicksCount",OLD."collectedAt")
      IS DISTINCT FROM (NEW."name",NEW."trackingUrl",NEW."isActive",NEW."startedAt",NEW."endedAt",NEW."claimersCount",NEW."clicksCount",NEW."collectedAt") THEN
      PERFORM "onlinod_traffic_publish_fact_v3"(NEW."agencyId",NEW."creatorId",TG_TABLE_NAME,NEW."id");
    END IF;
  ELSE
    IF TG_OP='INSERT' OR (OLD."attributedAt",OLD."collectedAt",OLD."claimerUsernameAtEvent",OLD."claimerDisplayNameAtEvent",OLD."claimerAvatarUrlAtEvent")
      IS DISTINCT FROM (NEW."attributedAt",NEW."collectedAt",NEW."claimerUsernameAtEvent",NEW."claimerDisplayNameAtEvent",NEW."claimerAvatarUrlAtEvent") THEN
      PERFORM "onlinod_traffic_publish_fact_v3"(NEW."agencyId",NEW."creatorId",TG_TABLE_NAME,NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_creator_enroll_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."deletedAt" IS NULL THEN PERFORM "onlinod_traffic_ensure_backfill_v2"(NEW."agencyId",NEW."id"); END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_delete_guard_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=OLD."creatorId" AND "deletedAt" IS NULL)
    AND EXISTS(SELECT 1 FROM "Agency" WHERE "id"=OLD."agencyId" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'TRAFFIC_HISTORY_REQUIRES_CREATOR_RETIREMENT';
  END IF;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_delta_v2(old_value jsonb, new_value jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT COALESCE(jsonb_object_agg(k,to_jsonb(COALESCE((new_value->>k)::numeric,0)-COALESCE((old_value->>k)::numeric,0))),'{}'::jsonb)
  FROM (SELECT jsonb_object_keys(COALESCE(old_value,'{}')||COALESCE(new_value,'{}')) k) keys
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_dirty_fan_v2(a text, c text, f text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE identity TEXT:=md5(jsonb_build_array(c,f)::text);
BEGIN
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  IF current_setting('onlinod.traffic_executor_version',true)='3'
    AND current_setting('onlinod.traffic_projection_creator_v3',true)=c THEN
    INSERT INTO "TrafficFanProjection"("id","agencyId","creatorId","fanId") VALUES(identity,a,c,f) ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO "TrafficFanSignal"("id","agencyId","creatorId","fanId") VALUES(identity,a,c,f) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_FAN','TrafficFanProjection',identity,c,c);
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_ensure_backfill_v2(a text, c text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "TrafficProjectionBackfillData"("agencyId","creatorId") VALUES(a,c) ON CONFLICT DO NOTHING;
  IF FOUND THEN PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_BACKFILL','TrafficProjectionBackfill',c,c,c); END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_enter_v3(c text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "onlinod_traffic_executor_assert_v3"();
  IF c IS NULL OR c='' THEN RAISE EXCEPTION 'TRAFFIC_PROJECTION_SCOPE_REQUIRED'; END IF;
  PERFORM "onlinod_traffic_lock_v2"(c);
  PERFORM set_config('onlinod.traffic_projection_creator_v3',c,true);
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_executor_assert_v3()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('onlinod.traffic_executor_version',true) IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'TRAFFIC_PROJECTION_EXECUTOR_RETIRED';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_job_retired_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF NEW."jobKey"='traffic_sources_scan' AND NEW."status" IN ('SCHEDULED','CLAIMED','PAUSED') THEN
  RAISE EXCEPTION 'TRAFFIC_SOURCE_JOB_RETIRED'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_lock_v2(c text)
 RETURNS void
 LANGUAGE sql
AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended('traffic-projection-v2:'||c,0))
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_member_dirty_capture_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE a TEXT; c TEXT; f TEXT;
BEGIN
  IF TG_TABLE_NAME='CreatorFanValueCurrent' THEN
    IF TG_OP='DELETE' THEN a:=OLD."agencyId";c:=OLD."creatorId";f:=OLD."fanId"; ELSE a:=NEW."agencyId";c:=NEW."creatorId";f:=NEW."fanId"; END IF;
    SELECT "onlyFansUserId" INTO f FROM "CreatorFan" WHERE "id"=f AND "creatorId"=c;
    IF NOT EXISTS(SELECT 1 FROM "TrafficSourceMember" WHERE "creatorId"=c AND "fanId"=f)
      AND NOT EXISTS(SELECT 1 FROM "TrafficFanProjection" WHERE "creatorId"=c AND "fanId"=f) THEN
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='CreatorFan' THEN
    a:=OLD."agencyId";c:=OLD."creatorId";f:=OLD."onlyFansUserId";
    IF NOT EXISTS(SELECT 1 FROM "TrafficFanProjection" WHERE "creatorId"=c AND "fanId"=f) THEN RETURN OLD; END IF;
  ELSE
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['projectionMetrics','updatedAt'])=(to_jsonb(OLD)-ARRAY['projectionMetrics','updatedAt']) THEN RETURN NEW; END IF;
    IF TG_OP='DELETE' THEN a:=OLD."agencyId";c:=OLD."creatorId";f:=OLD."fanId"; ELSE a:=NEW."agencyId";c:=NEW."creatorId";f:=NEW."fanId"; END IF;
  END IF;
  PERFORM "onlinod_traffic_dirty_fan_v2"(a,c,f);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_member_metrics_v2(member_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE m "TrafficSourceMember"%ROWTYPE; v "CreatorFanValueCurrent"%ROWTYPE; desired JSONB; d JSONB; t TEXT; available BOOLEAN; revenue_at TIMESTAMP(3);
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO m FROM "TrafficSourceMember" WHERE "id"=member_id;
  IF NOT FOUND THEN RETURN '{}'; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(m."creatorId");
  SELECT v0.* INTO v FROM "CreatorFan" f JOIN "CreatorFanValueCurrent" v0 ON v0."creatorId"=f."creatorId" AND v0."fanId"=f."id"
    WHERE f."creatorId"=m."creatorId" AND f."agencyId"=m."agencyId" AND f."onlyFansUserId"=m."fanId";
  SELECT GREATEST(m."lastRevenueAt",p."lastRevenueAt",signal."lastRevenueAt") INTO revenue_at
    FROM "TrafficFanProjection" p LEFT JOIN "TrafficFanSignal" signal ON signal."id"=p."id" AND signal."creatorId"=p."creatorId" AND signal."agencyId"=p."agencyId"
    WHERE p."creatorId"=m."creatorId" AND p."fanId"=m."fanId";
  available:=COALESCE(v."availability"='AVAILABLE',false);
  desired:=jsonb_build_object('sourceMembers',1,'valueSnapshotMembers',CASE WHEN available THEN 1 ELSE 0 END,
    'valuePendingMembers',CASE WHEN NOT available OR COALESCE(revenue_at,m."lastRevenueAt")>v."fetchedAt" THEN 1 ELSE 0 END,
    'valuePayingFans',CASE WHEN available AND v."totalNetCents">0 THEN 1 ELSE 0 END,
    'fanValueCents',CASE WHEN available THEN COALESCE(v."totalNetCents",0) ELSE 0 END,
    'valueMessagesCents',CASE WHEN available THEN COALESCE(v."messagesNetCents",0) ELSE 0 END,
    'valueTipsCents',CASE WHEN available THEN COALESCE(v."tipsNetCents",0) ELSE 0 END,
    'valueSubscribesCents',CASE WHEN available THEN COALESCE(v."subscriptionsNetCents",0) ELSE 0 END,
    'valuePostsCents',CASE WHEN available THEN COALESCE(v."postsNetCents",0) ELSE 0 END,
    'valueStreamsCents',CASE WHEN available THEN COALESCE(v."streamsNetCents",0) ELSE 0 END);
  d:="onlinod_traffic_delta_v2"(m."projectionMetrics",desired);
  SELECT "sourceType" INTO t FROM "TrafficSource" WHERE "id"=m."sourceId";
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'source',m."sourceId",'*',d);
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'type',t,'*',d);
  PERFORM "onlinod_traffic_add_v2"(m."agencyId",m."creatorId",'total','','*',jsonb_build_object('sourceMembers',d->'sourceMembers'));
  UPDATE "TrafficSourceMember" SET "projectionMetrics"=desired WHERE "id"=m."id" AND "projectionMetrics" IS DISTINCT FROM desired;
  RETURN desired-'sourceMembers';
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_observe_revenue_v3(a text, c text, f text, observed_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE identity TEXT:=md5(jsonb_build_array(c,f)::text);
BEGIN
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  INSERT INTO "TrafficFanSignal"("id","agencyId","creatorId","fanId","lastRevenueAt") VALUES(identity,a,c,f,observed_at)
    ON CONFLICT("creatorId","fanId") DO UPDATE SET "lastRevenueAt"=GREATEST("TrafficFanSignal"."lastRevenueAt",EXCLUDED."lastRevenueAt")
    WHERE "TrafficFanSignal"."lastRevenueAt" IS NULL OR "TrafficFanSignal"."lastRevenueAt"<EXCLUDED."lastRevenueAt";
  PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_FAN','TrafficFanProjection',identity,c,c);
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_project_member_v2(membership_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE r "CreatorCampaignFan"%ROWTYPE; f "CreatorFan"%ROWTYPE; s TEXT; prior_flag TEXT;
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO r FROM "CreatorCampaignFan" WHERE "id"=membership_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(r."creatorId");
  IF NOT EXISTS(SELECT 1 FROM "CreatorCampaign" WHERE "id"=r."campaignId" AND "creatorId"=r."creatorId" AND "agencyId"=r."agencyId") THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_CAMPAIGN_SCOPE'; END IF;
  SELECT * INTO f FROM "CreatorFan" WHERE "id"=r."fanId" AND "creatorId"=r."creatorId" AND "agencyId"=r."agencyId";
  IF NOT FOUND THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_FAN_SCOPE'; END IF;
  SELECT "id" INTO s FROM "TrafficSource" WHERE "canonicalCampaignId"=r."campaignId" AND "creatorId"=r."creatorId" AND "agencyId"=r."agencyId";
  IF s IS NULL THEN s:="onlinod_traffic_project_source_v2"(r."campaignId"); END IF;
  IF s IS NULL THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_CAMPAIGN_MISSING'; END IF;
  prior_flag:=current_setting('onlinod.traffic_projection_v2',true);
  PERFORM set_config('onlinod.traffic_projection_v2','canonical',true);
  INSERT INTO "TrafficSourceMember"("id","agencyId","creatorId","sourceId","fanId","firstSeenAt","lastSeenAt","claimedAt","metadata","createdAt","updatedAt")
    VALUES('tcm_'||md5(r."id"),r."agencyId",r."creatorId",s,f."onlyFansUserId",r."collectedAt",r."collectedAt",r."attributedAt",
      jsonb_build_object('fanUsername',r."claimerUsernameAtEvent",'fanName',r."claimerDisplayNameAtEvent",'fanAvatar',r."claimerAvatarUrlAtEvent"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT("agencyId","creatorId","sourceId","fanId") DO UPDATE SET
      "lastSeenAt"=GREATEST("TrafficSourceMember"."lastSeenAt",EXCLUDED."lastSeenAt"),
      "claimedAt"=COALESCE(EXCLUDED."claimedAt","TrafficSourceMember"."claimedAt"),"metadata"=EXCLUDED."metadata","updatedAt"=CURRENT_TIMESTAMP
    WHERE ("TrafficSourceMember"."lastSeenAt","TrafficSourceMember"."claimedAt","TrafficSourceMember"."metadata") IS DISTINCT FROM
      (GREATEST("TrafficSourceMember"."lastSeenAt",EXCLUDED."lastSeenAt"),COALESCE(EXCLUDED."claimedAt","TrafficSourceMember"."claimedAt"),EXCLUDED."metadata");
  PERFORM set_config('onlinod.traffic_projection_v2',COALESCE(prior_flag,''),true);
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_project_source_v2(campaign_id text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE r "CreatorCampaign"%ROWTYPE; source_id TEXT; prior_flag TEXT;
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO r FROM "CreatorCampaign" WHERE "id"=campaign_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(r."creatorId");
  PERFORM "onlinod_traffic_ensure_backfill_v2"(r."agencyId",r."creatorId");
  prior_flag:=current_setting('onlinod.traffic_projection_v2',true);
  PERFORM set_config('onlinod.traffic_projection_v2','canonical',true);
  INSERT INTO "TrafficSource"("id","agencyId","creatorId","accountId","sourceType","externalId","canonicalCampaignId",
    "name","url","status","startedAt","endedAt","lastScannedAt","stats","createdAt","updatedAt")
  VALUES('tcs_'||md5(r."id"),r."agencyId",r."creatorId",r."creatorId",'of_campaign',r."externalCampaignId",r."id",
    r."name",r."trackingUrl",CASE WHEN r."isActive" THEN 'live' ELSE 'inactive' END,r."startedAt",r."endedAt",r."collectedAt",
    jsonb_build_object('claimers',r."claimersCount",'clicks',r."clicksCount"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT("agencyId","creatorId","sourceType","externalId") DO UPDATE SET
    "canonicalCampaignId"=EXCLUDED."canonicalCampaignId","name"=EXCLUDED."name","url"=EXCLUDED."url","status"=EXCLUDED."status",
    "startedAt"=EXCLUDED."startedAt","endedAt"=EXCLUDED."endedAt","lastScannedAt"=EXCLUDED."lastScannedAt","stats"=EXCLUDED."stats","updatedAt"=CURRENT_TIMESTAMP
  WHERE ("TrafficSource"."canonicalCampaignId","TrafficSource"."name","TrafficSource"."url","TrafficSource"."status",
    "TrafficSource"."startedAt","TrafficSource"."endedAt","TrafficSource"."lastScannedAt","TrafficSource"."stats") IS DISTINCT FROM
    (EXCLUDED."canonicalCampaignId",EXCLUDED."name",EXCLUDED."url",EXCLUDED."status",EXCLUDED."startedAt",EXCLUDED."endedAt",EXCLUDED."lastScannedAt",EXCLUDED."stats")
  RETURNING "id" INTO source_id;
  IF source_id IS NULL THEN
    SELECT "id" INTO source_id FROM "TrafficSource" WHERE "agencyId"=r."agencyId" AND "creatorId"=r."creatorId"
      AND "sourceType"='of_campaign' AND "externalId"=r."externalCampaignId";
  END IF;
  PERFORM set_config('onlinod.traffic_projection_v2',COALESCE(prior_flag,''),true);
  RETURN source_id;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_projection_assert_v3(c text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "onlinod_traffic_executor_assert_v3"();
  IF c IS NULL OR current_setting('onlinod.traffic_projection_creator_v3',true) IS DISTINCT FROM c THEN
    RAISE EXCEPTION 'TRAFFIC_PROJECTION_SCOPE_NOT_LOCKED';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_projection_guard_v3()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE r JSONB;
BEGIN
  r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP='DELETE' AND r->>'creatorId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM "CreatorAccount" c JOIN "Agency" a ON a."id"=c."agencyId"
    WHERE c."id"=r->>'creatorId' AND c."deletedAt" IS NULL AND a."deletedAt" IS NULL
  ) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='TrafficProjectionSeed' THEN PERFORM "onlinod_traffic_executor_assert_v3"();
  ELSE PERFORM "onlinod_traffic_projection_assert_v3"(r->>'creatorId'); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_provider_guard_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('onlinod.traffic_projection_v2',true)='canonical' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'TRAFFIC_CANONICAL_WRITER_REQUIRED'; END IF;
  IF TG_TABLE_NAME='TrafficSource' THEN
    IF (to_jsonb(NEW)-ARRAY['costRevision','costCents','currency','updatedAt','projectionMetrics'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['costRevision','costCents','currency','updatedAt','projectionMetrics']) THEN
      RAISE EXCEPTION 'TRAFFIC_CANONICAL_WRITER_REQUIRED'; END IF;
  ELSE
    IF (NEW."agencyId",NEW."creatorId",NEW."sourceId",NEW."fanId",NEW."firstSeenAt",NEW."lastSeenAt",NEW."claimedAt",NEW."metadata")
      IS DISTINCT FROM (OLD."agencyId",OLD."creatorId",OLD."sourceId",OLD."fanId",OLD."firstSeenAt",OLD."lastSeenAt",OLD."claimedAt",OLD."metadata") THEN
      RAISE EXCEPTION 'TRAFFIC_CANONICAL_WRITER_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_publish_fact_v3(a text, c text, t text, o text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  PERFORM "phase2_publish_domain_work"(a,'TRAFFIC_FACT',t,o,c,c);
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_receipt_capture_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' AND (OLD."sourceId",OLD."fanId",OLD."amountCents",OLD."occurredAt") IS NOT DISTINCT FROM (NEW."sourceId",NEW."fanId",NEW."amountCents",NEW."occurredAt") THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM "onlinod_traffic_publish_fact_v3"(OLD."agencyId",OLD."creatorId",TG_TABLE_NAME,OLD."id");
    RETURN OLD;
  END IF;
  PERFORM "onlinod_traffic_publish_fact_v3"(NEW."agencyId",NEW."creatorId",TG_TABLE_NAME,NEW."id");
  IF NEW."sourceId" IS NULL THEN PERFORM "onlinod_traffic_dirty_fan_v2"(NEW."agencyId",NEW."creatorId",NEW."fanId"); END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_receipt_project_v2(receipt_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE r "CreatorSubscriptionLedger"%ROWTYPE; cache "TrafficReceiptProjection"%ROWTYPE; next_fact JSONB:='{}'; fact JSONB; sign INTEGER; a TEXT; c TEXT; t TEXT; p TEXT; d JSONB;
BEGIN
  PERFORM "onlinod_traffic_projection_assert_v3"(current_setting('onlinod.traffic_projection_creator_v3',true));
  SELECT * INTO r FROM "CreatorSubscriptionLedger" WHERE "id"=receipt_id;
  SELECT * INTO cache FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  a:=COALESCE(r."agencyId",cache."agencyId");c:=COALESCE(r."creatorId",cache."creatorId");
  IF c IS NULL OR NOT EXISTS(SELECT 1 FROM "CreatorAccount" WHERE "id"=c AND "agencyId"=a AND "deletedAt" IS NULL) THEN RETURN; END IF;
  PERFORM "onlinod_traffic_projection_assert_v3"(c);
  -- Read again after the projection lock: concurrent rebuild and live writes
  -- must compare against the most recently committed cache.
  SELECT * INTO cache FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  SELECT * INTO r FROM "CreatorSubscriptionLedger" WHERE "id"=receipt_id;
  IF r."id" IS NOT NULL AND r."amountCents">0 THEN
    SELECT "sourceType" INTO t FROM "TrafficSource" WHERE "id"=r."sourceId" AND "creatorId"=c AND "agencyId"=a;
    IF r."sourceId" IS NOT NULL AND t IS NULL THEN RAISE EXCEPTION 'TRAFFIC_RECEIPT_SOURCE_SCOPE'; END IF;
    next_fact:=jsonb_build_object('source',COALESCE(r."sourceId",''),'type',COALESCE(t,'paid_unknown'),'fan',r."fanId",
      'period',to_char(r."occurredAt",'YYYY-MM-DD'),'amount',r."amountCents");
  END IF;
  IF r."id" IS NOT NULL AND r."sourceId" IS NOT NULL AND r."amountCents">0 THEN
    UPDATE "TrafficSourceMember" SET "needsValueRefresh"=true,
      "lastRevenueAt"=GREATEST("lastRevenueAt",r."occurredAt"),"convertedAt"=LEAST("convertedAt",r."occurredAt")
    WHERE "agencyId"=a AND "creatorId"=c AND "sourceId"=r."sourceId" AND "fanId"=r."fanId"
      AND (NOT "needsValueRefresh" OR "lastRevenueAt" IS NULL OR "lastRevenueAt"<r."occurredAt"
        OR "convertedAt" IS NULL OR "convertedAt">r."occurredAt");
  END IF;
  IF COALESCE(cache."fact",'{}')=next_fact THEN RETURN; END IF;
  FOR fact,sign IN SELECT COALESCE(cache."fact",'{}'),-1 UNION ALL SELECT next_fact,1 LOOP
    IF fact='{}'::jsonb THEN CONTINUE; END IF;
    d:=jsonb_build_object('paidSubscriptions',sign,'revenueCents',sign*(fact->>'amount')::numeric);
    FOREACH p IN ARRAY ARRAY['*',fact->>'period'] LOOP
      PERFORM "onlinod_traffic_add_v2"(a,c,'total','',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'type',fact->>'type',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'source',fact->>'source',p,d);
      PERFORM "onlinod_traffic_add_v2"(a,c,'receiptFan:'||(fact->>'source'),fact->>'fan',p,d);
    END LOOP;
  END LOOP;
  IF r."id" IS NULL THEN DELETE FROM "TrafficReceiptProjection" WHERE "id"=receipt_id;
  ELSE
    INSERT INTO "TrafficReceiptProjection"("id","agencyId","creatorId","fact") VALUES(receipt_id,a,c,next_fact)
      ON CONFLICT("id") DO UPDATE SET "fact"=EXCLUDED."fact";
    PERFORM "onlinod_traffic_ensure_backfill_v2"(a,c);
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_source_metrics_v2()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE previous JSONB:='{}'; desired JSONB; d JSONB;
BEGIN
  IF TG_OP='UPDATE' AND NEW."projectionMetrics" IS DISTINCT FROM OLD."projectionMetrics" AND (to_jsonb(NEW)-'projectionMetrics')=(to_jsonb(OLD)-'projectionMetrics') THEN RETURN NEW; END IF;
  PERFORM "onlinod_traffic_lock_v2"(NEW."creatorId");
  IF TG_OP='UPDATE' THEN previous:=OLD."projectionMetrics"; END IF;
  desired:=jsonb_build_object('sources',1,'costCents',NEW."costCents");
  d:="onlinod_traffic_delta_v2"(previous,desired);
  PERFORM "onlinod_traffic_add_v2"(NEW."agencyId",NEW."creatorId",'total','','*',d);
  PERFORM "onlinod_traffic_add_v2"(NEW."agencyId",NEW."creatorId",'type',NEW."sourceType",'*',d);
  UPDATE "TrafficSource" SET "projectionMetrics"=desired WHERE "id"=NEW."id" AND "projectionMetrics" IS DISTINCT FROM desired;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.onlinod_traffic_work_guard_v3()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW."state"='CLAIMED' AND (OLD."state"<>'CLAIMED' OR NEW."claimFence"<>OLD."claimFence" OR NEW."leaseUntil">OLD."leaseUntil"))
    OR (OLD."state"='CLAIMED' AND NEW."state"<>'CLAIMED')
    OR NEW."completedRevision">OLD."completedRevision"
    OR (OLD."state"='CLAIMED' AND NEW."progressCursor" IS DISTINCT FROM OLD."progressCursor") THEN
    PERFORM "onlinod_traffic_executor_assert_v3"();
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.phase2_account_topology_dependency_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency TEXT;
  v_account TEXT;
  v_auto_revision BIGINT;
  v_account_revision BIGINT;
BEGIN
  IF TG_OP='UPDATE' AND OLD."lifecycleState" IS NOT DISTINCT FROM NEW."lifecycleState" THEN
    RETURN NEW;
  END IF;

  IF TG_OP='DELETE' THEN
    v_agency := OLD."agencyId";
    v_account := OLD."id";
  ELSE
    v_agency := NEW."agencyId";
    v_account := NEW."id";
  END IF;

  v_auto_revision := "phase2_bump_dependency"(v_agency,'AUTO_PROVIDER',v_agency);
  v_account_revision := "phase2_bump_dependency"(v_agency,'ACCOUNT_LIFECYCLE',v_account);
  PERFORM "phase2_publish_domain_work"(v_agency,'DEPENDENCY_FANOUT','AgencyTelegramMtprotoAccount',v_account,v_agency,NULL,v_account,'AUTO_PROVIDER',v_agency,v_auto_revision,CURRENT_TIMESTAMP);

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_adjust_work_family_state(p_agency text, p_class text, p_generation text, p_outstanding_delta integer, p_requested_delta bigint, p_requested_at timestamp without time zone)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL THEN RETURN; END IF;
  v_id := 'p2wfs_' || md5(p_agency || E'\x1f' || p_class);
  INSERT INTO "Phase2WorkFamilyState"(
    "id","agencyId","workClass","activeGeneration","outstandingCount","requestedSequence","convergedSequence",
    "lastRequestedAt","lastConvergedAt","createdAt","updatedAt"
  ) VALUES (
    v_id,p_agency,p_class,COALESCE(p_generation,"phase2_current_domain_work_generation"(p_class)),
    GREATEST(0,COALESCE(p_outstanding_delta,0)),GREATEST(0,COALESCE(p_requested_delta,0)),
    CASE WHEN COALESCE(p_outstanding_delta,0) <= 0 THEN GREATEST(0,COALESCE(p_requested_delta,0)) ELSE 0 END,
    CASE WHEN COALESCE(p_requested_delta,0)>0 THEN COALESCE(p_requested_at,CURRENT_TIMESTAMP) ELSE NULL END,
    CASE WHEN COALESCE(p_outstanding_delta,0)<=0 THEN CURRENT_TIMESTAMP ELSE NULL END,
    CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId","workClass") DO UPDATE SET
    "activeGeneration"=COALESCE(p_generation,"Phase2WorkFamilyState"."activeGeneration"),
    "outstandingCount"=GREATEST(0,"Phase2WorkFamilyState"."outstandingCount"+COALESCE(p_outstanding_delta,0)),
    "requestedSequence"="Phase2WorkFamilyState"."requestedSequence"+GREATEST(0,COALESCE(p_requested_delta,0)),
    "convergedSequence"=CASE
      WHEN GREATEST(0,"Phase2WorkFamilyState"."outstandingCount"+COALESCE(p_outstanding_delta,0))=0
      THEN "Phase2WorkFamilyState"."requestedSequence"+GREATEST(0,COALESCE(p_requested_delta,0))
      ELSE "Phase2WorkFamilyState"."convergedSequence" END,
    "lastRequestedAt"=CASE WHEN COALESCE(p_requested_delta,0)>0 THEN COALESCE(p_requested_at,CURRENT_TIMESTAMP)
                           ELSE "Phase2WorkFamilyState"."lastRequestedAt" END,
    "lastConvergedAt"=CASE
      WHEN GREATEST(0,"Phase2WorkFamilyState"."outstandingCount"+COALESCE(p_outstanding_delta,0))=0
      THEN CURRENT_TIMESTAMP ELSE "Phase2WorkFamilyState"."lastConvergedAt" END,
    "updatedAt"=CURRENT_TIMESTAMP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_assert_agency_destructive_mutation_allowed(p_agency_id text, p_table_name text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency_id text;
  v_locked boolean;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(p_agency_id, '')), '');
  IF v_agency_id IS NULL THEN RETURN; END IF;

  IF "phase2_internal_agency_destructive_authorized"(v_agency_id) THEN
    RETURN;
  END IF;

  SELECT pg_try_advisory_xact_lock_shared(hashtext('agency-lifecycle:' || v_agency_id))
    INTO v_locked;
  IF NOT COALESCE(v_locked, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = format('PHASE2_AGENCY_LIFECYCLE_BUSY agency=%s table=%s', v_agency_id, p_table_name);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "Agency" a WHERE a."id" = v_agency_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format('PHASE2_AGENCY_IDENTITY_ABSENT agency=%s table=%s', v_agency_id, p_table_name);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId" = v_agency_id
       AND d."workClass" = 'DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType" = 'Phase2AgencyDestructiveCleanup'
       AND d."objectId" = v_agency_id
     LIMIT 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format('PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s table=%s', v_agency_id, p_table_name);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_assert_creator_dependency_row_allowed(p_agency_id text, p_dependency_kind text, p_dependency_key text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_creator_id text;
BEGIN
  IF p_dependency_kind = 'CREATOR_BINDING' THEN
    v_creator_id := NULLIF(BTRIM(p_dependency_key), '');
  ELSIF p_dependency_kind = 'REMINDER_OUTCOME' THEN
    SELECT o."creatorId" INTO v_creator_id
      FROM "CustomOrder" o
     WHERE o."agencyId" = p_agency_id
       AND o."id" = p_dependency_key
     LIMIT 1;
    IF v_creator_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = format('PHASE2_REMINDER_DEPENDENCY_PARENT_ABSENT agency=%s order=%s', p_agency_id, p_dependency_key);
    END IF;
  ELSE
    RETURN;
  END IF;
  PERFORM "phase2_assert_creator_destructive_insert_allowed"(p_agency_id, v_creator_id, 'Phase2DependencyState');
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_assert_creator_destructive_insert_allowed(p_agency_id text, p_creator_id text, p_table_name text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency_id text;
  v_creator_internal boolean;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_creator_id, '')), '') IS NULL THEN RETURN; END IF;

  BEGIN
    SELECT c."agencyId"
      INTO v_agency_id
      FROM "CreatorAccount" c
     WHERE c."id"=p_creator_id
       AND (
         NULLIF(BTRIM(COALESCE(p_agency_id, '')), '') IS NULL
         OR c."agencyId"=p_agency_id
       )
     FOR KEY SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING
      ERRCODE='55P03',
      MESSAGE=format(
        'PHASE2_CREATOR_LIFECYCLE_BUSY agency=%s creator=%s table=%s',
        COALESCE(p_agency_id,'?'),p_creator_id,p_table_name
      );
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='23503',
      MESSAGE=format(
        'PHASE2_CREATOR_IDENTITY_ABSENT agency=%s creator=%s table=%s',
        COALESCE(p_agency_id,'?'),p_creator_id,p_table_name
      );
  END IF;

  v_creator_internal := "phase2_internal_creator_destructive_authorized"(
    v_agency_id,p_creator_id
  );

  IF EXISTS (
    SELECT 1
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=v_agency_id
       AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType"='Phase2AgencyDestructiveCleanup'
       AND d."objectId"=v_agency_id
     LIMIT 1
  )
  AND NOT "phase2_internal_agency_destructive_authorized"(v_agency_id)
  AND NOT v_creator_internal THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format(
        'PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s',
        v_agency_id,p_creator_id,p_table_name
      );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=v_agency_id
       AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
       AND d."objectType"='Phase2CreatorDestructiveCleanup'
       AND d."objectId"=p_creator_id
     LIMIT 1
  )
  AND NOT v_creator_internal THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format(
        'PHASE2_CREATOR_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s',
        v_agency_id,p_creator_id,p_table_name
      );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_assert_indirect_creator_residual_row_allowed(p_table_name text, p_row jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency_id text;
  v_creator_id text;
  v_candidate text;
  v_ref text;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(p_row->>'agencyId', '')), '');
  v_creator_id := NULLIF(BTRIM(COALESCE(p_row->>'creatorId', '')), '');
  IF v_agency_id IS NULL THEN RETURN; END IF;

  IF p_table_name = 'DomainWorkItem'
     AND COALESCE(p_row->>'workClass', '') = 'DESTRUCTIVE_CREATOR_CLEANUP'
     AND COALESCE(p_row->>'objectType', '') = 'Phase2CreatorDestructiveCleanup' THEN
    RETURN;
  END IF;

  IF p_table_name IN ('ProviderOperationalDebt', 'TelegramInboundEvent') THEN
    v_ref := NULLIF(BTRIM(COALESCE(p_row->>'customOrderId', '')), '');
    IF v_ref IS NOT NULL THEN
      SELECT o."creatorId" INTO v_candidate
        FROM "CustomOrder" o
       WHERE o."agencyId" = v_agency_id AND o."id" = v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s order=%s', p_table_name, v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=%s order=%s', p_table_name, v_ref);
      END IF;
    END IF;

    v_ref := CASE WHEN p_table_name='ProviderOperationalDebt'
      THEN NULLIF(BTRIM(COALESCE(p_row->>'customSubmissionId', '')), '')
      ELSE NULLIF(BTRIM(COALESCE(p_row->>'submissionId', '')), '') END;
    IF v_ref IS NOT NULL THEN
      SELECT s."creatorId" INTO v_candidate
        FROM "CustomContentSubmission" s
       WHERE s."agencyId" = v_agency_id AND s."id" = v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s submission=%s', p_table_name, v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=%s submission=%s', p_table_name, v_ref);
      END IF;
    END IF;
  ELSIF p_table_name = 'DomainWorkItem' THEN
    IF COALESCE(p_row->>'objectType', '') = 'CreatorAccount' THEN
      v_candidate := NULLIF(BTRIM(COALESCE(p_row->>'objectId', '')), '');
      IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem objectType=CreatorAccount';
      END IF;
      v_creator_id := COALESCE(v_creator_id, v_candidate);
    END IF;
    IF COALESCE(p_row->>'dependencyKind', '') = 'CREATOR_BINDING' THEN
      v_candidate := NULLIF(BTRIM(COALESCE(p_row->>'dependencyKey', '')), '');
      IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem dependency=CREATOR_BINDING';
      END IF;
      v_creator_id := COALESCE(v_creator_id, v_candidate);
    END IF;
    IF COALESCE(p_row->>'objectType', '') = 'CustomOrder' THEN
      v_ref := NULLIF(BTRIM(COALESCE(p_row->>'objectId', '')), '');
      SELECT o."creatorId" INTO v_candidate FROM "CustomOrder" o
       WHERE o."agencyId"=v_agency_id AND o."id"=v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem order=%s', v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=DomainWorkItem order=%s', v_ref);
      END IF;
    ELSIF COALESCE(p_row->>'objectType', '') = 'CustomContentSubmission' THEN
      v_ref := NULLIF(BTRIM(COALESCE(p_row->>'objectId', '')), '');
      SELECT s."creatorId" INTO v_candidate FROM "CustomContentSubmission" s
       WHERE s."agencyId"=v_agency_id AND s."id"=v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem submission=%s', v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=DomainWorkItem submission=%s', v_ref);
      END IF;
    END IF;
  END IF;

  IF v_creator_id IS NOT NULL THEN
    PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_agency_id, v_creator_id, p_table_name);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_bump_creator_catalog_generation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency_id TEXT;
  v_old_live BOOLEAN := FALSE;
  v_new_live BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_live := OLD."deletedAt" IS NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_live := NEW."deletedAt" IS NULL;
  END IF;

  -- Ignore metadata-only updates: the catalog membership did not change.
  IF TG_OP = 'UPDATE'
     AND OLD."agencyId" IS NOT DISTINCT FROM NEW."agencyId"
     AND v_old_live = v_new_live THEN
    RETURN NEW;
  END IF;

  -- If an UPDATE moves a live Creator across Agencies, advance both catalogs.
  IF TG_OP = 'UPDATE'
     AND OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
     AND v_old_live THEN
    INSERT INTO "AgencyCreatorCatalogState" ("agencyId", "generation", "updatedAt")
    VALUES (OLD."agencyId", 1, clock_timestamp())
    ON CONFLICT ("agencyId") DO UPDATE
      SET "generation" = "AgencyCreatorCatalogState"."generation" + 1,
          "updatedAt" = clock_timestamp();
  END IF;

  IF (TG_OP = 'DELETE' AND v_old_live) OR (TG_OP = 'UPDATE' AND v_old_live AND NOT v_new_live) THEN
    v_agency_id := OLD."agencyId";
  ELSIF (TG_OP = 'INSERT' AND v_new_live) OR (TG_OP = 'UPDATE' AND v_new_live AND (NOT v_old_live OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId")) THEN
    v_agency_id := NEW."agencyId";
  ELSE
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  INSERT INTO "AgencyCreatorCatalogState" ("agencyId", "generation", "updatedAt")
  VALUES (v_agency_id, 1, clock_timestamp())
  ON CONFLICT ("agencyId") DO UPDATE
    SET "generation" = "AgencyCreatorCatalogState"."generation" + 1,
        "updatedAt" = clock_timestamp();

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_bump_dependency(p_agency text, p_kind text, p_key text)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_revision BIGINT;
  v_id TEXT;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_agency,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_kind,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_key,'')),'') IS NULL THEN
    RETURN 0;
  END IF;

  v_id := 'p2dep_' || md5(p_agency || E'\x1f' || p_kind || E'\x1f' || p_key);
  INSERT INTO "Phase2DependencyState"(
    "id","agencyId","dependencyKind","dependencyKey","revision",
    "changedAt","createdAt","updatedAt"
  ) VALUES (
    v_id,p_agency,p_kind,p_key,1,
    CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId","dependencyKind","dependencyKey") DO UPDATE SET
    "revision"="Phase2DependencyState"."revision"+1,
    "changedAt"=CURRENT_TIMESTAMP,
    "updatedAt"=CURRENT_TIMESTAMP
  RETURNING "revision" INTO v_revision;

  -- One coalescing durable identity per exact dependency.  No creator, Agency,
  -- history, or blocked-work enumeration is legal in this producer transaction.
  PERFORM "phase2_publish_domain_work"(
    p_agency,'DEPENDENCY_WAKE','DomainDependency',v_id,p_key,
    NULL,NULL,p_kind,p_key,v_revision,CURRENT_TIMESTAMP
  );
  RETURN v_revision;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_creator_binding_dependency_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_revision BIGINT;
BEGIN
  IF TG_OP='UPDATE' AND NOT (
      OLD."telegramContact" IS DISTINCT FROM NEW."telegramContact" OR
      OLD."telegramUserId" IS DISTINCT FROM NEW."telegramUserId" OR
      OLD."telegramAccountId" IS DISTINCT FROM NEW."telegramAccountId" OR
      OLD."customsVaultFolderId" IS DISTINCT FROM NEW."customsVaultFolderId" OR
      OLD."status" IS DISTINCT FROM NEW."status" OR
      OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt") THEN RETURN NEW; END IF;
  v_revision := "phase2_bump_dependency"(NEW."agencyId",'CREATOR_BINDING',NEW."id");
  PERFORM "phase2_publish_domain_work"(NEW."agencyId",'DEPENDENCY_FANOUT','CreatorAccount',NEW."id",NEW."id",NEW."id",NEW."telegramAccountId",'CREATOR_BINDING',NEW."id",v_revision,CURRENT_TIMESTAMP);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_current_domain_work_generation(p_class text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE v_generation TEXT;
BEGIN
  SELECT "activeGeneration" INTO v_generation
    FROM "Phase2WorkGenerationAuthority"
   WHERE "workClass"=p_class;
  RETURN COALESCE(v_generation,'phase2_domain_work_v3_actual55');
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_current_domain_work_projection(p_class text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE v_projection TEXT;
BEGIN
  SELECT "projectionVersion" INTO v_projection
    FROM "Phase2WorkGenerationAuthority"
   WHERE "workClass"=p_class;
  RETURN COALESCE(v_projection,'phase2_domain_work_v3_actual55');
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_custom_order_domain_work_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP='INSERT' THEN v_changed := TRUE;
  ELSE
    v_changed := OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."type" IS DISTINCT FROM NEW."type"
      OR OLD."scheduledAt" IS DISTINCT FROM NEW."scheduledAt"
      OR OLD."dueAt" IS DISTINCT FROM NEW."dueAt"
      OR OLD."physicalStatus" IS DISTINCT FROM NEW."physicalStatus"
      OR OLD."priceCents" IS DISTINCT FROM NEW."priceCents"
      OR OLD."paidAmountCents" IS DISTINCT FROM NEW."paidAmountCents"
      OR OLD."fanDeliveredAt" IS DISTINCT FROM NEW."fanDeliveredAt"
      OR OLD."telegramCancellationWaivedAt" IS DISTINCT FROM NEW."telegramCancellationWaivedAt"
      OR OLD."reminderConfig" IS DISTINCT FROM NEW."reminderConfig";
  END IF;
  IF v_changed THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."id",NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_custom_pipeline_config_dependency_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency TEXT;
  v_key TEXT;
  v_revision BIGINT;
BEGIN
  IF TG_OP='DELETE' THEN
    v_agency := OLD."agencyId";
    v_key := OLD."key";
  ELSE
    v_agency := NEW."agencyId";
    v_key := NEW."key";
    IF TG_OP='UPDATE' AND OLD."key" IS NOT DISTINCT FROM NEW."key" AND OLD."value" IS NOT DISTINCT FROM NEW."value" THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD."key" = 'vaultUploadRecipient' AND NEW."key" <> 'vaultUploadRecipient' THEN
    v_key := OLD."key";
  END IF;
  IF v_key <> 'vaultUploadRecipient' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  v_revision := "phase2_bump_dependency"(v_agency,'CUSTOM_PIPELINE_CONFIG',v_agency);
  PERFORM "phase2_publish_domain_work"(v_agency,'DEPENDENCY_FANOUT','CustomPipelineConfig',v_agency,v_agency,NULL,NULL,'CUSTOM_PIPELINE_CONFIG',v_agency,v_revision,CURRENT_TIMESTAMP);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_domain_work_family_state_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE old_out INTEGER := 0;
DECLARE new_out INTEGER := 0;
DECLARE req_delta BIGINT := 0;
BEGIN
  IF TG_OP='INSERT' THEN
    new_out := CASE WHEN NEW."isOutstanding" THEN 1 ELSE 0 END;
    req_delta := GREATEST(NEW."requestedRevision",0);
    PERFORM "phase2_adjust_work_family_state"(NEW."agencyId",NEW."workClass",NEW."activeGeneration",new_out,req_delta,NEW."updatedAt");
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    old_out := CASE WHEN OLD."isOutstanding" THEN 1 ELSE 0 END;
    IF old_out<>0 THEN
      PERFORM "phase2_adjust_work_family_state"(OLD."agencyId",OLD."workClass",OLD."activeGeneration",-old_out,0,NULL);
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."agencyId" IS DISTINCT FROM NEW."agencyId" OR OLD."workClass" IS DISTINCT FROM NEW."workClass" THEN
    old_out := CASE WHEN OLD."isOutstanding" THEN 1 ELSE 0 END;
    new_out := CASE WHEN NEW."isOutstanding" THEN 1 ELSE 0 END;
    IF old_out<>0 THEN
      PERFORM "phase2_adjust_work_family_state"(OLD."agencyId",OLD."workClass",OLD."activeGeneration",-old_out,0,NULL);
    END IF;
    PERFORM "phase2_adjust_work_family_state"(NEW."agencyId",NEW."workClass",NEW."activeGeneration",new_out,GREATEST(NEW."requestedRevision",0),NEW."updatedAt");
    RETURN NEW;
  END IF;

  old_out := CASE WHEN OLD."isOutstanding" THEN 1 ELSE 0 END;
  new_out := CASE WHEN NEW."isOutstanding" THEN 1 ELSE 0 END;
  req_delta := GREATEST(NEW."requestedRevision"-OLD."requestedRevision",0);
  IF old_out<>new_out OR req_delta>0 OR OLD."activeGeneration" IS DISTINCT FROM NEW."activeGeneration" THEN
    PERFORM "phase2_adjust_work_family_state"(
      NEW."agencyId",NEW."workClass",NEW."activeGeneration",new_out-old_out,req_delta,
      CASE WHEN req_delta>0 THEN NEW."updatedAt" ELSE NULL END
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_domain_work_id(p_agency text, p_class text, p_type text, p_object text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  RETURN 'dwi_' || md5(COALESCE(p_agency,'') || E'\\x1f' || COALESCE(p_class,'') || E'\\x1f' || COALESCE(p_type,'') || E'\\x1f' || COALESCE(p_object,''));
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_domain_work_ready_head_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE old_key TEXT;
DECLARE new_key TEXT;
BEGIN
  IF TG_OP='DELETE' THEN
    -- The agency authority must always be obtained before any partition authority.
    PERFORM "phase2_lock_domain_work_agency_head"(OLD."agencyId",OLD."workClass");
    PERFORM "phase2_refresh_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
    RETURN OLD;
  END IF;

  IF TG_OP='UPDATE'
     AND (OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
       OR OLD."workClass" IS DISTINCT FROM NEW."workClass") THEN
    RAISE EXCEPTION 'DomainWorkItem agencyId/workClass authority identity is immutable'
      USING ERRCODE='23514';
  END IF;

  -- Every normal DWI transaction is tenant-scoped.  Acquire the tenant head
  -- authority first; broad scheduler claims are split into one agency per DB
  -- transaction by claimDomainWorkBatch(), so this lock cannot participate in a
  -- cross-agency cycle.
  PERFORM "phase2_lock_domain_work_agency_head"(NEW."agencyId",NEW."workClass");

  IF TG_OP='UPDATE' AND OLD."partitionKey" IS DISTINCT FROM NEW."partitionKey" THEN
    old_key := OLD."workClass" || E'\x1f' || OLD."partitionKey";
    new_key := NEW."workClass" || E'\x1f' || NEW."partitionKey";
    IF old_key <= new_key THEN
      PERFORM "phase2_lock_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
      PERFORM "phase2_lock_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
    ELSE
      PERFORM "phase2_lock_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
      PERFORM "phase2_lock_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
    END IF;
    PERFORM "phase2_refresh_domain_work_partition_head"(OLD."agencyId",OLD."workClass",OLD."partitionKey");
    PERFORM "phase2_refresh_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
    RETURN NEW;
  END IF;

  PERFORM "phase2_refresh_domain_work_partition_head"(NEW."agencyId",NEW."workClass",NEW."partitionKey");
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_enforce_domain_work_generation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_generation TEXT;
DECLARE v_projection TEXT;
BEGIN
  v_generation := "phase2_current_domain_work_generation"(NEW."workClass");
  v_projection := "phase2_current_domain_work_projection"(NEW."workClass");

  IF TG_OP='INSERT' THEN
    NEW."activeGeneration" := v_generation;
    NEW."projectionVersion" := v_projection;
  ELSIF NEW."activeGeneration" IS DISTINCT FROM v_generation
     OR OLD."activeGeneration" IS DISTINCT FROM v_generation THEN
    NEW."activeGeneration" := v_generation;
    NEW."projectionVersion" := v_projection;
    NEW."requestedRevision" := GREATEST(NEW."requestedRevision",OLD."requestedRevision"+1);
    NEW."claimFence" := GREATEST(NEW."claimFence",OLD."claimFence"+1);
    NEW."claimedRevision" := 0;
    NEW."ownerToken" := NULL;
    NEW."leaseUntil" := NULL;
    NEW."nextAttemptAt" := NULL;
    NEW."progressCursor" := NULL;
    NEW."errorClass" := NULL;
    NEW."lastError" := NULL;
    NEW."terminalCause" := NULL;
    NEW."state" := CASE WHEN OLD."state"='BLOCKED' THEN 'BLOCKED' ELSE 'READY' END;
  END IF;

  NEW."isOutstanding" := (NEW."state" <> 'DONE' OR NEW."requestedRevision" > NEW."completedRevision");
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_agency_member_physical_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF "phase2_internal_agency_destructive_authorized"(OLD."agencyId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE='55000',
    MESSAGE=format('PHASE2_AGENCY_MEMBER_PHYSICAL_DELETE_RETIRED agency=%s member=%s',OLD."agencyId",OLD."id");
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_creator_access_scope()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_creator_id text;
  v_new_ids text[];
  v_old_ids text[];
  v_ids_to_fence text[];
BEGIN
  v_new_ids := "phase2_scope_creator_ids"(NEW."assignedCreators");

  IF TG_OP='INSERT' OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId" THEN
    SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::text[])
      INTO v_ids_to_fence
      FROM unnest(v_new_ids) AS u(x);
  ELSE
    v_old_ids := "phase2_scope_creator_ids"(OLD."assignedCreators");
    SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::text[])
      INTO v_ids_to_fence
      FROM unnest(v_new_ids) AS u(x)
     WHERE NOT (x = ANY(v_old_ids));
  END IF;

  FOREACH v_creator_id IN ARRAY v_ids_to_fence LOOP
    PERFORM 1
      FROM "CreatorAccount" c
     WHERE c."id"=v_creator_id
       AND c."agencyId"=NEW."agencyId"
       AND c."deletedAt" IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE='23503',
        MESSAGE=format('PHASE2_CREATOR_SCOPE_RETIRED creator=%s agency=%s',v_creator_id,NEW."agencyId");
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_creator_account_release_writer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency_id text;
  v_creator_id text;
BEGIN
  v_agency_id := CASE WHEN TG_OP='DELETE' THEN OLD."agencyId" ELSE NEW."agencyId" END;
  v_creator_id := CASE WHEN TG_OP='DELETE' THEN OLD."id" ELSE NEW."id" END;

  IF TG_OP='DELETE' AND (
       "phase2_internal_creator_destructive_authorized"(v_agency_id,v_creator_id)
       OR "phase2_internal_agency_destructive_authorized"(v_agency_id)
     ) THEN
    RETURN OLD;
  END IF;

  IF NOT "onlinod_write_contract_authorized"(
    'CREATOR_ACCOUNT_WRITER','onlinod.phase2_creator_writer_generation'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format('PHASE2_INCOMPATIBLE_CREATOR_WRITER agency=%s creator=%s op=%s',COALESCE(v_agency_id,'?'),COALESCE(v_creator_id,'?'),TG_OP);
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_creator_dependency_insert_during_creator_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(OLD."agencyId", OLD."dependencyKind", OLD."dependencyKey")
         IS DISTINCT FROM
         ROW(NEW."agencyId", NEW."dependencyKind", NEW."dependencyKey") THEN
    PERFORM "phase2_assert_creator_dependency_row_allowed"(OLD."agencyId", OLD."dependencyKind", OLD."dependencyKey");
  END IF;
  PERFORM "phase2_assert_creator_dependency_row_allowed"(NEW."agencyId", NEW."dependencyKind", NEW."dependencyKey");
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_direct_creator_insert_during_creator_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_old_agency_id text;
  v_old_creator_id text;
  v_new_agency_id text;
  v_new_creator_id text;
BEGIN
  v_new_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'agencyId', '')), '');
  v_new_creator_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'creatorId', '')), '');

  IF TG_TABLE_NAME = 'TeamShiftCreator'
     AND TG_OP = 'UPDATE'
     AND NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'creatorRefId', '')), '') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'creatorRefId', '')), '') IS NULL
     AND (to_jsonb(NEW) - 'creatorRefId') = (to_jsonb(OLD) - 'creatorRefId') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'agencyId', '')), '');
    v_old_creator_id := NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'creatorId', '')), '');
    IF v_old_creator_id IS NOT NULL
       AND (v_old_creator_id IS DISTINCT FROM v_new_creator_id OR v_old_agency_id IS DISTINCT FROM v_new_agency_id) THEN
      PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_old_agency_id, v_old_creator_id, TG_TABLE_NAME);
    END IF;
  END IF;

  IF v_new_creator_id IS NOT NULL THEN
    PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_new_agency_id, v_new_creator_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_domain_work_executor_acquire()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_required text;
BEGIN
  IF NEW."state"='CLAIMED'
     AND (
       OLD."state" IS DISTINCT FROM 'CLAIMED'
       OR OLD."ownerToken" IS DISTINCT FROM NEW."ownerToken"
       OR OLD."claimFence" IS DISTINCT FROM NEW."claimFence"
     ) THEN
    v_required := "onlinod_required_write_contract"('DOMAIN_WORK_EXECUTOR');
    IF v_required IS NULL
       OR NOT "onlinod_write_contract_authorized"(
         'DOMAIN_WORK_EXECUTOR','onlinod.phase2_domain_executor_generation'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',
        MESSAGE=format('PHASE2_INCOMPATIBLE_DOMAIN_EXECUTOR work=%s class=%s',NEW."id",NEW."workClass");
    END IF;
    NEW."claimExecutionGeneration" := v_required;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_indirect_creator_residual_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_old_signature jsonb;
  v_new_signature jsonb;
BEGIN
  v_new := to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    IF TG_TABLE_NAME IN ('ProviderOperationalDebt', 'TelegramInboundEvent') THEN
      v_old_signature := jsonb_build_array(v_old->>'agencyId',v_old->>'creatorId',v_old->>'customOrderId',v_old->>'customSubmissionId',v_old->>'submissionId');
      v_new_signature := jsonb_build_array(v_new->>'agencyId',v_new->>'creatorId',v_new->>'customOrderId',v_new->>'customSubmissionId',v_new->>'submissionId');
    ELSE
      v_old_signature := jsonb_build_array(v_old->>'agencyId',v_old->>'creatorId',v_old->>'workClass',v_old->>'objectType',v_old->>'objectId',v_old->>'dependencyKind',v_old->>'dependencyKey');
      v_new_signature := jsonb_build_array(v_new->>'agencyId',v_new->>'creatorId',v_new->>'workClass',v_new->>'objectType',v_new->>'objectId',v_new->>'dependencyKind',v_new->>'dependencyKey');
    END IF;
    IF v_old_signature IS DISTINCT FROM v_new_signature THEN
      PERFORM "phase2_assert_indirect_creator_residual_row_allowed"(TG_TABLE_NAME, v_old);
    END IF;
  END IF;
  PERFORM "phase2_assert_indirect_creator_residual_row_allowed"(TG_TABLE_NAME, v_new);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_fence_non_fk_tenant_insert_during_agency_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_agency_id TEXT;
  v_locked BOOLEAN;
  v_internal_agency_id TEXT;
  v_internal_work_id TEXT;
  v_internal_owner_token TEXT;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'agencyId','')),'');
  IF v_agency_id IS NULL THEN RETURN NEW; END IF;

  SELECT pg_try_advisory_xact_lock_shared(hashtext('agency-lifecycle:' || v_agency_id))
    INTO v_locked;
  IF NOT COALESCE(v_locked,FALSE) THEN
    RAISE EXCEPTION USING
      ERRCODE='55P03',
      MESSAGE=format('PHASE2_AGENCY_LIFECYCLE_BUSY agency=%s table=%s',v_agency_id,TG_TABLE_NAME);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "Agency" a WHERE a."id"=v_agency_id) THEN
    RAISE EXCEPTION USING
      ERRCODE='23503',
      MESSAGE=format('PHASE2_AGENCY_IDENTITY_ABSENT agency=%s table=%s',v_agency_id,TG_TABLE_NAME);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId"=v_agency_id
       AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType"='Phase2AgencyDestructiveCleanup'
       AND d."objectId"=v_agency_id
     LIMIT 1
  ) THEN
    v_internal_agency_id := NULLIF(
      BTRIM(COALESCE(current_setting('onlinod.phase2_destructive_agency_id',TRUE),'')),''
    );
    v_internal_work_id := NULLIF(
      BTRIM(COALESCE(current_setting('onlinod.phase2_destructive_agency_work_id',TRUE),'')),''
    );
    v_internal_owner_token := NULLIF(
      BTRIM(COALESCE(current_setting('onlinod.phase2_destructive_agency_owner_token',TRUE),'')),''
    );
    IF v_internal_agency_id IS DISTINCT FROM v_agency_id OR NOT EXISTS (
      SELECT 1 FROM "DomainWorkItem" d
       WHERE d."id"=v_internal_work_id
         AND d."agencyId"=v_agency_id
         AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
         AND d."objectType"='Phase2AgencyDestructiveCleanup'
         AND d."objectId"=v_agency_id
         AND d."state"='CLAIMED'
         AND d."ownerToken"=v_internal_owner_token
         AND d."leaseUntil">clock_timestamp()
       LIMIT 1
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',
        MESSAGE=format('PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s table=%s',v_agency_id,TG_TABLE_NAME);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_filter_live_creator_scope(p_scope jsonb, p_agency_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE v_filtered jsonb;
BEGIN
  IF p_scope IS NULL OR jsonb_typeof(p_scope)='null' OR p_scope='"all"'::jsonb THEN RETURN p_scope; END IF;
  IF jsonb_typeof(p_scope)='object' AND (COALESCE((p_scope->>'all')::boolean,FALSE) OR LOWER(COALESCE(p_scope->>'mode',''))='all') THEN RETURN p_scope; END IF;

  IF jsonb_typeof(p_scope)='array' THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord),'[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements_text(p_scope) WITH ORDINALITY e(value,ord)
     WHERE EXISTS (
       SELECT 1 FROM "CreatorAccount" c
        WHERE c."id"=BTRIM(e.value) AND c."agencyId"=p_agency_id AND c."deletedAt" IS NULL
     );
    RETURN v_filtered;
  END IF;

  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'ids')='array' THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord),'[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'ids') WITH ORDINALITY e(value,ord)
     WHERE EXISTS (
       SELECT 1 FROM "CreatorAccount" c
        WHERE c."id"=BTRIM(e.value) AND c."agencyId"=p_agency_id AND c."deletedAt" IS NULL
     );
    RETURN jsonb_set(p_scope,'{ids}',v_filtered,true);
  END IF;

  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'creatorIds')='array' THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord),'[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'creatorIds') WITH ORDINALITY e(value,ord)
     WHERE EXISTS (
       SELECT 1 FROM "CreatorAccount" c
        WHERE c."id"=BTRIM(e.value) AND c."agencyId"=p_agency_id AND c."deletedAt" IS NULL
     );
    RETURN jsonb_set(p_scope,'{creatorIds}',v_filtered,true);
  END IF;

  RETURN p_scope;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN p_scope;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_inbound_domain_work_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' OR OLD."submissionId" IS DISTINCT FROM NEW."submissionId" THEN
    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'TELEGRAM_INBOUND_PROJECTION','TelegramInboundEvent',NEW."id",
      COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_intent_domain_work_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_confirm_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF "phase2_internal_creator_destructive_authorized"(OLD."agencyId",OLD."creatorId")
       OR "phase2_internal_agency_destructive_authorized"(OLD."agencyId") THEN
      RETURN OLD;
    END IF;
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
      IF OLD."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') THEN
        PERFORM "phase2_bump_dependency"(OLD."agencyId",'REMINDER_OUTCOME',OLD."customOrderId");
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    IF NEW."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') AND
       (TG_OP='INSERT' OR OLD."state" IS DISTINCT FROM NEW."state" OR OLD."outcomeReason" IS DISTINCT FROM NEW."outcomeReason" OR OLD."remoteMessageId" IS DISTINCT FROM NEW."remoteMessageId" OR OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt") THEN
      PERFORM "phase2_bump_dependency"(NEW."agencyId",'REMINDER_OUTCOME',NEW."customOrderId");
    END IF;
  END IF;

  IF TG_OP='INSERT' THEN
    v_confirm_changed := NEW."state"='CONFIRMED' OR NEW."projectionBlockedAt" IS NOT NULL;
  ELSE
    v_confirm_changed :=
      (NEW."state"='CONFIRMED' AND (
        OLD."state" IS DISTINCT FROM NEW."state" OR
        OLD."remoteMessageId" IS DISTINCT FROM NEW."remoteMessageId" OR
        OLD."remoteRecipientTelegramUserId" IS DISTINCT FROM NEW."remoteRecipientTelegramUserId" OR
        OLD."remoteSentAt" IS DISTINCT FROM NEW."remoteSentAt" OR
        OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt" OR
        OLD."confirmationAuthority" IS DISTINCT FROM NEW."confirmationAuthority"
      )) OR
      (NEW."projectionBlockedAt" IS NOT NULL AND OLD."projectionBlockedAt" IS DISTINCT FROM NEW."projectionBlockedAt");
  END IF;

  IF v_confirm_changed THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'TELEGRAM_CONFIRMED_PROJECTION','TelegramDeliveryIntent',NEW."id",COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    IF NEW."state"='CONFIRMED' AND NEW."remoteMessageId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(NEW."agencyId",'TELEGRAM_INBOUND_PROJECTION','TelegramDeliveryReceipt',NEW."id",COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_internal_agency_destructive_authorized(p_agency_id text)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT NULLIF(BTRIM(COALESCE(p_agency_id,'')),'') IS NOT NULL
     AND current_setting('onlinod.phase2_destructive_agency_id',TRUE)=BTRIM(p_agency_id)
     AND EXISTS (
       SELECT 1
         FROM "DomainWorkItem" d
        WHERE d."id"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_agency_work_id',TRUE),''
              )), '')
          AND d."agencyId"=BTRIM(p_agency_id)
          AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
          AND d."objectType"='Phase2AgencyDestructiveCleanup'
          AND d."objectId"=BTRIM(p_agency_id)
          AND d."state"='CLAIMED'
          AND d."isOutstanding"=TRUE
          AND d."ownerToken"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_agency_owner_token',TRUE),''
              )), '')
          AND d."leaseUntil">clock_timestamp()
        LIMIT 1
     );
$function$;

CREATE OR REPLACE FUNCTION public.phase2_internal_creator_destructive_authorized(p_agency_id text, p_creator_id text)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT NULLIF(BTRIM(COALESCE(p_agency_id,'')),'') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(p_creator_id,'')),'') IS NOT NULL
     AND current_setting('onlinod.phase2_destructive_agency_id',TRUE)=BTRIM(p_agency_id)
     AND current_setting('onlinod.phase2_destructive_creator_id',TRUE)=BTRIM(p_creator_id)
     AND EXISTS (
       SELECT 1
         FROM "DomainWorkItem" d
        WHERE d."id"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_creator_work_id',TRUE),''
              )), '')
          AND d."agencyId"=BTRIM(p_agency_id)
          AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
          AND d."objectType"='Phase2CreatorDestructiveCleanup'
          AND d."objectId"=BTRIM(p_creator_id)
          AND d."state"='CLAIMED'
          AND d."isOutstanding"=TRUE
          AND d."ownerToken"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_creator_owner_token',TRUE),''
              )), '')
          AND d."leaseUntil">clock_timestamp()
        LIMIT 1
     );
$function$;

CREATE OR REPLACE FUNCTION public.phase2_lock_domain_work_agency_head(p_agency text, p_class text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_agency IS NULL OR p_class IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'phase2:dwra-scope:' || p_agency, 0
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_lock_domain_work_mutation_scope()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE'
     AND (OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
       OR OLD."workClass" IS DISTINCT FROM NEW."workClass") THEN
    RAISE EXCEPTION 'DomainWorkItem agencyId/workClass authority identity is immutable'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='DELETE' THEN
    PERFORM "phase2_lock_domain_work_agency_head"(OLD."agencyId",OLD."workClass");
    RETURN OLD;
  END IF;

  PERFORM "phase2_lock_domain_work_agency_head"(NEW."agencyId",NEW."workClass");
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_lock_domain_work_partition_head(p_agency text, p_class text, p_partition text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_partition IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'phase2:dwrp:' || p_agency || E'\\x1f' || p_class || E'\\x1f' || p_partition, 0
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_mark_provider_order_dirty(p_agency text, p_order text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_agency IS NULL OR p_order IS NULL THEN RETURN; END IF;
  UPDATE "CustomOrder"
     SET "providerOperationalDirty" = TRUE
   WHERE "agencyId" = p_agency AND "id" = p_order;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_new_agency_coverage_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "Phase2WorkCoverage"(
    "id","agencyId","family","generation","active","enumerationState",
    "unresolvedCount","sourceWatermark","activatedAt","completedAt","createdAt","updatedAt"
  ) VALUES
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'PROVIDER_OPERATIONAL' || E'\x1f' || 'phase2_provider_operational_coverage_v1'), NEW."id",'PROVIDER_OPERATIONAL','phase2_provider_operational_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'CUSTOM_EXTERNAL_PROJECTION' || E'\x1f' || 'phase2_custom_external_coverage_v1'), NEW."id",'CUSTOM_EXTERNAL_PROJECTION','phase2_custom_external_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'CUSTOM_SOURCE_PIPELINE' || E'\x1f' || 'phase2_custom_source_pipeline_coverage_v1'), NEW."id",'CUSTOM_SOURCE_PIPELINE','phase2_custom_source_pipeline_coverage_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_ACTIVITY_CONTRIBUTION' || E'\x1f' || 'phase2_team_activity_contribution_v2'), NEW."id",'TEAM_ACTIVITY_CONTRIBUTION','phase2_team_activity_contribution_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_RESPONSE_RANGE_REPAIR' || E'\x1f' || 'phase2_team_response_range_v2'), NEW."id",'TEAM_RESPONSE_RANGE_REPAIR','phase2_team_response_range_v2',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_DIALOG_PROJECTION' || E'\x1f' || 'phase2_team_dialog_projection_v1'), NEW."id",'TEAM_DIALOG_PROJECTION','phase2_team_dialog_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_MONEY_ROOT_CLASSIFICATION' || E'\x1f' || 'phase2_team_money_root_classification_v1'), NEW."id",'TEAM_MONEY_ROOT_CLASSIFICATION','phase2_team_money_root_classification_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_MONEY_RECONCILIATION' || E'\x1f' || 'phase2_team_money_reconciliation_v1'), NEW."id",'TEAM_MONEY_RECONCILIATION','phase2_team_money_reconciliation_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TEAM_READ_SUMMARY' || E'\x1f' || 'phase2_team_money_read_summary_v1'), NEW."id",'TEAM_READ_SUMMARY','phase2_team_money_read_summary_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TELEGRAM_CONFIRMED_PROJECTION' || E'\x1f' || 'phase2_telegram_confirmed_projection_v1'), NEW."id",'TELEGRAM_CONFIRMED_PROJECTION','phase2_telegram_confirmed_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
    ('p2cov_' || md5(NEW."id" || E'\x1f' || 'TELEGRAM_INBOUND_PROJECTION' || E'\x1f' || 'phase2_telegram_inbound_projection_v1'), NEW."id",'TELEGRAM_INBOUND_PROJECTION','phase2_telegram_inbound_projection_v1',TRUE,'COMPLETE',0,'NEW_AGENCY_AFTER_PHASE2_CUTOVER',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT ("agencyId","family","generation") DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_provider_account_lifecycle_dirty_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."lifecycleState" IS NOT DISTINCT FROM NEW."lifecycleState" THEN RETURN NEW; END IF;
  UPDATE "CustomOrder" co
     SET "providerOperationalDirty" = TRUE
    FROM "CreatorAccount" ca
   WHERE ca."agencyId" = NEW."agencyId"
     AND ca."telegramAccountId" = NEW."id"
     AND co."agencyId" = ca."agencyId"
     AND co."creatorId" = ca."id"
     AND co."type" = 'CONTENT'
     AND co."status" = 'PENDING'
     AND co."providerOperationalDirty" IS DISTINCT FROM TRUE;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_provider_creator_binding_dirty_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "CustomOrder"
     SET "providerOperationalDirty" = TRUE
   WHERE "agencyId" = NEW."agencyId"
     AND "creatorId" = NEW."id"
     AND "type" = 'CONTENT'
     AND "status" = 'PENDING';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_provider_intent_dirty_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM "phase2_mark_provider_order_dirty"(NEW."agencyId", NEW."customOrderId");
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_mark_provider_order_dirty"(OLD."agencyId", OLD."customOrderId");
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_provider_order_delete_cleanup_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM "ProviderOperationalDebt"
   WHERE "agencyId" = OLD."agencyId" AND "customOrderId" = OLD."id"
     AND "debtClass" IN (
       'UNKNOWN_EXTERNAL_OUTCOME','PINNED_CANCELLATION_FOLLOWUP','CURRENT_PROVIDER_THREAD_CAPABILITY',
       'CANCELLATION_FOLLOWUP_DEBT','INCOMPLETE_SOURCE_RELAY','CONFIRMED_PROJECTION_DEBT','PROVIDER_BINDING_RETRY'
     );
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_provider_order_state_dirty_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW."providerOperationalDirty" := TRUE;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_provider_submission_dirty_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM "phase2_mark_provider_order_dirty"(NEW."agencyId", NEW."customOrderId");
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_mark_provider_order_dirty"(OLD."agencyId", OLD."customOrderId");
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_publish_domain_work(p_agency text, p_class text, p_type text, p_object text, p_partition text DEFAULT NULL::text, p_creator text DEFAULT NULL::text, p_account text DEFAULT NULL::text, p_dependency_kind text DEFAULT NULL::text, p_dependency_key text DEFAULT NULL::text, p_dependency_revision bigint DEFAULT 0, p_available_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP)
 RETURNS bigint
 LANGUAGE plpgsql
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_revision BIGINT;
DECLARE v_generation TEXT;
DECLARE v_projection TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_type IS NULL OR p_object IS NULL THEN RETURN 0; END IF;
  v_generation := "phase2_current_domain_work_generation"(p_class);
  v_projection := "phase2_current_domain_work_projection"(p_class);

  INSERT INTO "DomainWorkItem"(
    "id","agencyId","workClass","objectType","objectId","partitionKey","creatorId","accountId",
    "requestedRevision","completedRevision","activeGeneration","projectionVersion","state","isOutstanding","availableAt",
    "dependencyKind","dependencyKey","dependencyRevision","createdAt","updatedAt"
  ) VALUES (
    "phase2_domain_work_id"(p_agency,p_class,p_type,p_object),p_agency,p_class,p_type,p_object,
    COALESCE(NULLIF(p_partition,''),p_agency),NULLIF(p_creator,''),NULLIF(p_account,''),
    1,0,v_generation,v_projection,'READY',TRUE,COALESCE(p_available_at,CURRENT_TIMESTAMP),
    NULLIF(p_dependency_kind,''),NULLIF(p_dependency_key,''),COALESCE(p_dependency_revision,0),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId","workClass","objectType","objectId") DO UPDATE SET
    "requestedRevision" = "DomainWorkItem"."requestedRevision" + 1,
    "partitionKey" = EXCLUDED."partitionKey",
    "creatorId" = COALESCE(EXCLUDED."creatorId","DomainWorkItem"."creatorId"),
    "accountId" = COALESCE(EXCLUDED."accountId","DomainWorkItem"."accountId"),
    "dependencyKind" = EXCLUDED."dependencyKind",
    "dependencyKey" = EXCLUDED."dependencyKey",
    "dependencyRevision" = GREATEST("DomainWorkItem"."dependencyRevision",EXCLUDED."dependencyRevision"),
    "state" = CASE WHEN "DomainWorkItem"."state"='CLAIMED' THEN 'CLAIMED' ELSE 'READY' END,
    "isOutstanding"=TRUE,
    "availableAt" = LEAST("DomainWorkItem"."availableAt",EXCLUDED."availableAt"),
    "nextAttemptAt" = NULL,
    "progressCursor" = CASE
      WHEN "DomainWorkItem"."state"='CLAIMED' THEN "DomainWorkItem"."progressCursor"
      WHEN "DomainWorkItem"."workClass"='TEAM_DIALOG_PROJECTION'
        AND ("DomainWorkItem"."progressCursor"->'pendingRepair') IS NOT NULL
        THEN "DomainWorkItem"."progressCursor"
      ELSE NULL
    END,
    "errorClass" = NULL,
    "lastError" = NULL,
    "terminalCause" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  RETURNING "requestedRevision" INTO v_revision;
  RETURN v_revision;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_reclassify_team_money_peer_set(p_agency_id text, p_source_type text, p_business_key text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  peer_count INTEGER := 0;
  next_state TEXT;
  next_reason TEXT;
BEGIN
  IF p_business_key IS NULL OR btrim(p_business_key) = '' THEN
    RETURN;
  END IF;

  -- The peer lock is acquired by the caller before the fact mutation. Counting
  -- two rows is sufficient to distinguish the only supported states while the
  -- business-key index keeps discovery bounded in the normal case.
  SELECT count(*) INTO peer_count
  FROM (
    SELECT "id"
    FROM "TeamMoneyAttributionFact"
    WHERE "agencyId" = p_agency_id
      AND "sourceType" = p_source_type
      AND "canonicalBusinessKey" = p_business_key
    ORDER BY "id" ASC
    LIMIT 2
  ) AS peers;

  IF peer_count = 1 THEN
    next_state := 'CANONICAL';
    next_reason := NULL;
  ELSIF peer_count > 1 THEN
    next_state := 'AMBIGUOUS';
    next_reason := 'MULTIPLE_FACT_GENERATIONS:' || peer_count::TEXT || '+';
  ELSE
    RETURN;
  END IF;

  UPDATE "TeamMoneyAttributionFact"
  SET "classificationState" = next_state,
      "classificationReason" = next_reason,
      "classificationVersion" = 'team_money_root_classification_v1',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "agencyId" = p_agency_id
    AND "sourceType" = p_source_type
    AND "canonicalBusinessKey" = p_business_key
    AND (
      "classificationState" IS DISTINCT FROM next_state
      OR "classificationReason" IS DISTINCT FROM next_reason
      OR "classificationVersion" IS DISTINCT FROM 'team_money_root_classification_v1'
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_refresh_custom_external_projection_debt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_submission_id TEXT;
  v_order_id TEXT;
  v_account_id TEXT;
  v_media_id TEXT;
  v_message_id TEXT;
  v_projected BOOLEAN := FALSE;
  v_has_media BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."actionType" IN ('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND') THEN
      DELETE FROM "ProviderOperationalDebt" WHERE "id"=('pod_external_' || OLD."id");
    END IF;
    RETURN OLD;
  END IF;

  -- Ordinary AutomationDelivery transitions must not pay for a Custom debt-table lookup.
  -- If a row transitioned away from a Custom kind, deterministic PK cleanup is sufficient;
  -- any already-published DomainWork will revalidate the canonical delivery and ACK obsolete.
  IF NEW."actionType" NOT IN ('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND') THEN
    IF TG_OP='UPDATE' AND OLD."actionType" IN ('CUSTOM_RELAY_SEND','CUSTOM_MANUAL_SEND') THEN
      DELETE FROM "ProviderOperationalDebt" WHERE "id"=('pod_external_' || NEW."id");
    END IF;
    RETURN NEW;
  END IF;

  DELETE FROM "ProviderOperationalDebt" WHERE "id"=('pod_external_' || NEW."id");
  IF NEW."status" <> 'COMPLETED' THEN RETURN NEW; END IF;

  IF NEW."actionType" = 'CUSTOM_RELAY_SEND' THEN
    v_submission_id := COALESCE(NULLIF(NEW."payload"->>'submissionId',''), split_part(COALESCE(NEW."targetId",''), ':', 1));
    v_media_id := NULLIF(NEW."result"->>'mediaId','');
    IF v_submission_id IS NULL OR v_submission_id = '' OR v_media_id IS NULL THEN RETURN NEW; END IF;

    SELECT COALESCE(NULLIF(NEW."payload"->>'telegramSourceAccountId',''), NULLIF(submission."telegramSourceAccountId",'')),
           (v_media_id = ANY(submission."ofMediaIds"))
      INTO v_account_id, v_projected
      FROM "CustomContentSubmission" submission
     WHERE submission."agencyId"=NEW."agencyId" AND submission."id"=v_submission_id
     LIMIT 1;
    IF v_account_id IS NULL OR COALESCE(v_projected,FALSE) THEN RETURN NEW; END IF;

    INSERT INTO "ProviderOperationalDebt"(
      "id","agencyId","accountId","creatorId","debtClass","objectType","objectId",
      "customOrderId","customSubmissionId","intentId","reason","sourceVersion","createdAt","updatedAt"
    ) VALUES (
      'pod_external_' || NEW."id", NEW."agencyId", v_account_id, NEW."creatorId",
      'CUSTOM_EXTERNAL_PROJECTION_DEBT','AutomationDelivery',NEW."id",
      NULLIF(NEW."payload"->>'customOrderId',''),v_submission_id,NULL,'CUSTOM_RELAY_SEND','provider_operational_debt_v1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO UPDATE SET
      "accountId"=EXCLUDED."accountId", "creatorId"=EXCLUDED."creatorId",
      "customOrderId"=EXCLUDED."customOrderId", "customSubmissionId"=EXCLUDED."customSubmissionId",
      "reason"=EXCLUDED."reason", "sourceVersion"=EXCLUDED."sourceVersion", "updatedAt"=CURRENT_TIMESTAMP;

    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'CUSTOM_EXTERNAL_PROJECTION','AutomationDelivery',NEW."id",
      COALESCE(NULLIF(v_account_id,''),NEW."creatorId"),NEW."creatorId",NULLIF(v_account_id,''),NULL,NULL,0,CURRENT_TIMESTAMP
    );
    RETURN NEW;
  END IF;

  v_order_id := COALESCE(NULLIF(NEW."payload"->>'customOrderId',''), NULLIF(NEW."result"->>'customOrderId',''), NULLIF(NEW."targetId",''));
  v_submission_id := COALESCE(NULLIF(NEW."payload"->>'submissionId',''), NULLIF(NEW."result"->>'submissionId',''));
  v_message_id := COALESCE(NULLIF(NEW."messageId",''), NULLIF(NEW."result"->>'messageId',''));
  IF v_order_id IS NULL OR v_message_id IS NULL THEN RETURN NEW; END IF;

  SELECT EXISTS(
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(NEW."result"->'mediaIds')='array' THEN NEW."result"->'mediaIds' ELSE '[]'::jsonb END
           ) AS media(value)
         ),
         (v_message_id = ANY(ord."deliveryMessageIds"))
         AND NOT EXISTS(
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(NEW."result"->'mediaIds')='array' THEN NEW."result"->'mediaIds' ELSE '[]'::jsonb END
           ) AS media(value)
           WHERE NOT (media.value = ANY(ord."deliverySentMediaIds"))
         )
    INTO v_has_media, v_projected
    FROM "CustomOrder" ord
   WHERE ord."agencyId"=NEW."agencyId" AND ord."id"=v_order_id
   LIMIT 1;
  IF NOT COALESCE(v_has_media,FALSE) OR COALESCE(v_projected,FALSE) THEN RETURN NEW; END IF;

  INSERT INTO "ProviderOperationalDebt"(
    "id","agencyId","accountId","creatorId","debtClass","objectType","objectId",
    "customOrderId","customSubmissionId","intentId","reason","sourceVersion","createdAt","updatedAt"
  ) VALUES (
    'pod_external_' || NEW."id", NEW."agencyId", '__CUSTOM_MANUAL__', NEW."creatorId",
    'CUSTOM_EXTERNAL_PROJECTION_DEBT','AutomationDelivery',NEW."id",
    v_order_id,v_submission_id,NULL,'CUSTOM_MANUAL_SEND','provider_operational_debt_v1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  ) ON CONFLICT ("id") DO UPDATE SET
    "creatorId"=EXCLUDED."creatorId", "customOrderId"=EXCLUDED."customOrderId",
    "customSubmissionId"=EXCLUDED."customSubmissionId", "reason"=EXCLUDED."reason",
    "sourceVersion"=EXCLUDED."sourceVersion", "updatedAt"=CURRENT_TIMESTAMP;

  PERFORM "phase2_publish_domain_work"(
    NEW."agencyId",'CUSTOM_EXTERNAL_PROJECTION','AutomationDelivery',NEW."id",
    NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_refresh_domain_work_agency_head(p_agency text, p_class text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v_generation TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL THEN RETURN; END IF;
  PERFORM "phase2_lock_domain_work_agency_head"(p_agency,p_class);
  v_generation := "phase2_current_domain_work_generation"(p_class);
  SELECT MIN(p."nextDueAt") INTO v_due
    FROM "DomainWorkReadyPartition" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_class AND p."activeGeneration"=v_generation;
  v_id := 'dwra_' || md5(p_agency || E'\\x1f' || p_class);
  IF v_due IS NULL THEN
    DELETE FROM "DomainWorkReadyAgency" WHERE "agencyId"=p_agency AND "workClass"=p_class;
  ELSE
    INSERT INTO "DomainWorkReadyAgency"("id","agencyId","workClass","activeGeneration","nextDueAt","createdAt","updatedAt")
    VALUES(v_id,p_agency,p_class,v_generation,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("agencyId","workClass") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration","nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_refresh_domain_work_partition_head(p_agency text, p_class text, p_partition text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v_generation TEXT;
DECLARE v_work TEXT;
DECLARE v_due TIMESTAMP(3);
DECLARE v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_class IS NULL OR p_partition IS NULL THEN RETURN; END IF;
  -- Global lock order for head maintenance is agency scope -> partition. The
  -- agency lock intentionally ignores workClass so a multi-class mutation inside
  -- one tenant transaction cannot create class-order cycles.
  PERFORM "phase2_lock_domain_work_agency_head"(p_agency,p_class);
  PERFORM "phase2_lock_domain_work_partition_head"(p_agency,p_class,p_partition);
  v_generation := "phase2_current_domain_work_generation"(p_class);
  SELECT d."id",
         GREATEST(
           d."availableAt",
           COALESCE(d."nextAttemptAt",d."availableAt"),
           CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
         )
    INTO v_work,v_due
    FROM "DomainWorkItem" d
   WHERE d."agencyId"=p_agency
     AND d."workClass"=p_class
     AND d."partitionKey"=p_partition
     AND d."activeGeneration"=v_generation
     AND d."isOutstanding"=TRUE
     AND d."state" IN ('READY','CLAIMED')
   ORDER BY GREATEST(
           d."availableAt",
           COALESCE(d."nextAttemptAt",d."availableAt"),
           CASE WHEN d."state"='CLAIMED' THEN COALESCE(d."leaseUntil",CURRENT_TIMESTAMP) ELSE d."availableAt" END
         ),d."id"
   LIMIT 1;

  v_id := 'dwrp_' || md5(p_agency || E'\\x1f' || p_class || E'\\x1f' || p_partition);
  IF v_work IS NULL THEN
    DELETE FROM "DomainWorkReadyPartition"
     WHERE "agencyId"=p_agency AND "workClass"=p_class AND "partitionKey"=p_partition;
  ELSE
    INSERT INTO "DomainWorkReadyPartition"(
      "id","agencyId","workClass","partitionKey","activeGeneration","headWorkId","nextDueAt","createdAt","updatedAt"
    ) VALUES(v_id,p_agency,p_class,p_partition,v_generation,v_work,v_due,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration","headWorkId"=EXCLUDED."headWorkId",
      "nextDueAt"=EXCLUDED."nextDueAt","updatedAt"=CURRENT_TIMESTAMP;
  END IF;
  PERFORM "phase2_refresh_domain_work_agency_head"(p_agency,p_class);
END;
$function$;

CREATE OR REPLACE FUNCTION public.onlinod_write_contract_authorized(p_scope text, p_setting text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_required text;
  v_actual text;
BEGIN
  v_required := "onlinod_required_write_contract"(p_scope);
  IF v_required IS NULL THEN RETURN FALSE; END IF;
  v_actual := current_setting(p_setting, true);
  RETURN v_actual = v_required;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_remove_creator_from_access_scope(p_scope jsonb, p_creator_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE v_id text := BTRIM(COALESCE(p_creator_id,''));
DECLARE v_filtered jsonb;
BEGIN
  IF v_id='' OR p_scope IS NULL THEN RETURN p_scope; END IF;
  IF jsonb_typeof(p_scope)='array' THEN
    SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb) INTO v_filtered
      FROM jsonb_array_elements_text(p_scope) WITH ORDINALITY e(value,ord) WHERE value<>v_id;
    RETURN v_filtered;
  END IF;
  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'ids')='array' THEN
    SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb) INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'ids') WITH ORDINALITY e(value,ord) WHERE value<>v_id;
    RETURN jsonb_set(p_scope,'{ids}',v_filtered,true);
  END IF;
  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'creatorIds')='array' THEN
    SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb) INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'creatorIds') WITH ORDINALITY e(value,ord) WHERE value<>v_id;
    RETURN jsonb_set(p_scope,'{creatorIds}',v_filtered,true);
  END IF;
  RETURN p_scope;
END;
$function$;

CREATE FUNCTION public.phase2_require_team_control_plane_generation() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF current_setting('onlinod.phase2_team_control_plane_generation',true) IS DISTINCT FROM 'phase2_team_control_plane_v2_durable_access' THEN
    RAISE EXCEPTION 'PHASE2_INCOMPATIBLE_TEAM_CONTROL_PLANE_WRITER' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE FUNCTION public.onlinod_required_write_contract(p_scope text) RETURNS text LANGUAGE sql IMMUTABLE AS $function$
SELECT CASE p_scope
  WHEN 'CREATOR_ACCOUNT_WRITER' THEN 'phase2_creator_writer_v2_actual56_postcut'
  WHEN 'DOMAIN_WORK_EXECUTOR' THEN 'phase3_domain_executor_v6_failure_policy'
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_scope_allows_creator(p_scope jsonb, p_creator_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE v_mode text;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_creator_id,'')),'') IS NULL THEN RETURN FALSE; END IF;
  IF p_scope IS NULL OR jsonb_typeof(p_scope)='null' THEN RETURN TRUE; END IF;
  IF p_scope = '"all"'::jsonb THEN RETURN TRUE; END IF;
  IF jsonb_typeof(p_scope)='object' THEN
    IF COALESCE((p_scope->>'all')::boolean,FALSE) THEN RETURN TRUE; END IF;
    v_mode := LOWER(COALESCE(p_scope->>'mode',''));
    IF v_mode='all' THEN RETURN TRUE; END IF;
  END IF;
  RETURN BTRIM(p_creator_id) = ANY("phase2_scope_creator_ids"(p_scope));
EXCEPTION WHEN invalid_text_representation THEN
  RETURN BTRIM(p_creator_id) = ANY("phase2_scope_creator_ids"(p_scope));
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_scope_creator_ids(p_scope jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE v_ids jsonb;
BEGIN
  IF p_scope IS NULL OR jsonb_typeof(p_scope) = 'null' THEN RETURN ARRAY[]::text[]; END IF;
  IF jsonb_typeof(p_scope) = 'array' THEN v_ids := p_scope;
  ELSIF jsonb_typeof(p_scope) = 'object' AND jsonb_typeof(p_scope->'ids')='array' THEN v_ids := p_scope->'ids';
  ELSIF jsonb_typeof(p_scope) = 'object' AND jsonb_typeof(p_scope->'creatorIds')='array' THEN v_ids := p_scope->'creatorIds';
  ELSE RETURN ARRAY[]::text[];
  END IF;
  RETURN COALESCE(ARRAY(SELECT DISTINCT BTRIM(value) FROM jsonb_array_elements_text(v_ids) value WHERE BTRIM(value)<>'' ORDER BY BTRIM(value)), ARRAY[]::text[]);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_submission_domain_work_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    IF "phase2_internal_creator_destructive_authorized"(OLD."agencyId",OLD."creatorId")
       OR "phase2_internal_agency_destructive_authorized"(OLD."agencyId") THEN
      RETURN OLD;
    END IF;
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
    RETURN OLD;
  END IF;

  PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_SOURCE_PIPELINE','CustomContentSubmission',NEW."id",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_team_dialog_domain_work_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_dialog_id TEXT;
  v_object_id TEXT;
BEGIN
  IF NEW."creatorId" IS NULL OR NEW."eventKind" IS NULL THEN RETURN NEW; END IF;
  v_dialog_id := COALESCE(NULLIF(NEW."dialogId",''),NULLIF(NEW."fanId",''));

  IF v_dialog_id IS NOT NULL AND (
       NEW."eventKind" IN ('FAN_MESSAGE_RECEIVED','DIALOG_SEEN','DIALOG_SESSION') OR
       (NEW."eventKind"='MESSAGE_SEND_CONFIRMED' AND UPPER(COALESCE(NEW."actionSource",''))='MANUAL' AND UPPER(COALESCE(NEW."lifecycle",''))='CONFIRMED')
     ) THEN
    v_object_id := json_build_array(NEW."creatorId",v_dialog_id)::text;
    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'TEAM_DIALOG_PROJECTION','CreatorDialog',v_object_id,
      NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
    );
  END IF;

  IF NEW."eventKind" IN ('COVERAGE_STARTED','COVERAGE_ENDED') THEN
    PERFORM "phase2_publish_domain_work"(
      NEW."agencyId",'TEAM_RESPONSE_RANGE_REPAIR','TeamActivityEvent',NEW."id",
      NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_team_money_read_summary_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "phase2_publish_domain_work"(
    NEW."agencyId",'TEAM_READ_SUMMARY','TeamMoneyAttributionFact',NEW."id",
    COALESCE(NULLIF(NEW."creatorId",''),NEW."agencyId"),NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_team_money_reconciliation_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "phase2_publish_domain_work"(
    NEW."agencyId",'TEAM_MONEY_RECONCILIATION',TG_TABLE_NAME,NEW."id",
    NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,CURRENT_TIMESTAMP
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase2_track_domain_work_broad_partition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."isOutstanding" IS TRUE THEN
    INSERT INTO "Phase2WorkBroadClaimPartitionState"(
      "id","agencyId","workClass","partitionKey","activeGeneration",
      "lastClaimedAt","createdAt","updatedAt"
    ) VALUES (
      'p2wbcps_' || md5(NEW."agencyId" || E'\x1f' || NEW."workClass" || E'\x1f' || NEW."partitionKey"),
      NEW."agencyId",NEW."workClass",NEW."partitionKey",NEW."activeGeneration",
      NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration",
      "lastClaimedAt"=CASE
        WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
        THEN NULL
        ELSE "Phase2WorkBroadClaimPartitionState"."lastClaimedAt"
      END,
      "updatedAt"=CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."phase3RejectRetiredLegacyFanObservationClockWrite"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SystemSetting"
    WHERE "key" = 'phase3.fanObservationCreatorClockV1'
      AND COALESCE(("value"->>'active')::boolean, false) = true
  ) THEN
    RAISE EXCEPTION 'FAN_OBSERVATION_LEGACY_CLOCK_RETIRED'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_campaign_claim_generation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  barrier_value jsonb;
  expected_generation text;
  session_generation text;
BEGIN
  -- The trigger is intentionally narrow: only a fresh transition into CLAIMED
  -- for fetch_campaigns is physically fenced. Renew/progress/release paths keep
  -- their normal lease semantics and are fenced separately by leaseRevision.
  IF NEW."jobKey" IS DISTINCT FROM 'fetch_campaigns'
     OR NEW."status" IS DISTINCT FROM 'CLAIMED'
     OR OLD."status" IS NOT DISTINCT FROM 'CLAIMED' THEN
    RETURN NEW;
  END IF;

  SELECT "value"
  INTO barrier_value
  FROM "SystemSetting"
  WHERE "key" = 'phase3.campaignCausalObservationV1'
  FOR SHARE;

  IF barrier_value IS NULL THEN
    RAISE EXCEPTION 'CAMPAIGN_CLAIM_GENERATION_BARRIER_MISSING'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE((barrier_value->>'claimGenerationActive')::boolean, false) = false THEN
    RETURN NEW;
  END IF;

  expected_generation := NULLIF(barrier_value->>'writerGeneration', '');
  session_generation := NULLIF(current_setting('onlinod.campaign_claim_generation', true), '');

  IF expected_generation IS NULL
     OR session_generation IS NULL
     OR session_generation IS DISTINCT FROM expected_generation THEN
    RAISE EXCEPTION 'CAMPAIGN_CLAIM_GENERATION_RETIRED'
      USING ERRCODE = 'P0001',
            DETAIL = format('expected generation %s, session generation %s', expected_generation, session_generation);
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_campaign_writer_generation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  barrier_value jsonb;
  expected_generation text;
  session_generation text;
  old_row jsonb := '{}'::jsonb;
  guarded_write boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
  END IF;

  -- Current and historical Actual64 Campaign chunks normally pass through the
  -- CAMPAIGNS ingest-batch ledger, but its old single/batch fan-value helpers
  -- projected FanData directly. Therefore the physical fence covers both the
  -- ingest-batch commit path and exact canonical authority-version writes whose
  -- incoming source is CAMPAIGN_CLAIMER. Non-Campaign FanData producers remain
  -- unaffected even when the stored row previously came from Campaign.
  IF TG_TABLE_NAME = 'AnalyticsIngestBatch' THEN
    guarded_write := NEW."dataType"::text = 'CAMPAIGNS';
  ELSIF TG_TABLE_NAME = 'CreatorFan' THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_each_text(to_jsonb(NEW)) AS field("key", "value")
      WHERE field."key" = ANY (ARRAY[
        'identityAuthorityVersion',
        'usernameAuthorityVersion',
        'displayNameAuthorityVersion',
        'avatarAuthorityVersion',
        'headerAuthorityVersion'
      ])
        AND field."value" LIKE '%|CAMPAIGN_CLAIMER|%'
        AND (TG_OP = 'INSERT' OR field."value" IS DISTINCT FROM old_row->>field."key")
    ) INTO guarded_write;
  ELSIF TG_TABLE_NAME = 'CreatorFanValueCurrent' THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_each_text(to_jsonb(NEW)) AS field("key", "value")
      WHERE field."key" = ANY (ARRAY[
        'valueAuthorityVersion',
        'availabilityAuthorityVersion',
        'platformReportedTotalSpendCentsAuthorityVersion',
        'messagesSpentCentsAuthorityVersion',
        'subscriptionsSpentCentsAuthorityVersion',
        'tipsSpentCentsAuthorityVersion',
        'postsSpentCentsAuthorityVersion',
        'streamsSpentCentsAuthorityVersion',
        'lastActivityAtAuthorityVersion'
      ])
        AND field."value" LIKE '%|CAMPAIGN_CLAIMER|%'
        AND (TG_OP = 'INSERT' OR field."value" IS DISTINCT FROM old_row->>field."key")
    ) INTO guarded_write;
  END IF;

  IF guarded_write = false THEN
    RETURN NEW;
  END IF;

  -- The share lock is retained to transaction end. Activation locks live
  -- Campaign JobInstance rows first, then this setting row FOR UPDATE. Thus old
  -- progress (JobInstance -> trigger/barrier) and activation use one lock order.
  SELECT "value"
    INTO barrier_value
  FROM "SystemSetting"
  WHERE "key" = 'phase3.campaignCausalObservationV1'
  FOR SHARE;

  IF barrier_value IS NULL THEN
    RAISE EXCEPTION 'CAMPAIGN_CAUSAL_V1_BARRIER_MISSING'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE((barrier_value->>'writerGenerationActive')::boolean, false) = false THEN
    RETURN NEW;
  END IF;

  expected_generation := NULLIF(barrier_value->>'writerGeneration', '');
  session_generation := NULLIF(current_setting('onlinod.campaign_writer_generation', true), '');

  IF expected_generation IS NULL OR session_generation IS DISTINCT FROM expected_generation THEN
    RAISE EXCEPTION 'CAMPAIGN_WRITER_GENERATION_RETIRED'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'expected Campaign writer generation %s, session generation %s',
              COALESCE(expected_generation, '<missing>'),
              COALESCE(session_generation, '<missing>')
            );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_domain_executor_no_downgrade()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."scope"='DOMAIN_WORK_EXECUTOR'
     AND OLD."requiredGeneration"='phase3_domain_executor_v6_failure_policy'
     AND NEW."requiredGeneration" IS DISTINCT FROM OLD."requiredGeneration" THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='PHASE3_DOMAIN_EXECUTOR_DOWNGRADE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_domain_work_claim_shard(p_partition text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT (((hashtextextended(COALESCE(p_partition,''),0) % 128) + 128) % 128)::INTEGER;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_domain_work_claimable_at(p_state text, p_available_at timestamp without time zone, p_next_attempt_at timestamp without time zone, p_lease_until timestamp without time zone)
 RETURNS timestamp without time zone
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN p_state='READY' THEN GREATEST(p_available_at,COALESCE(p_next_attempt_at,p_available_at))
    WHEN p_state='CLAIMED' THEN GREATEST(
      p_available_at,
      COALESCE(p_next_attempt_at,p_available_at),
      COALESCE(p_lease_until,p_available_at)
    )
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_fence_agency_member_access_epoch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."accessEpoch" < OLD."accessEpoch" THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AGENCY_MEMBER_ACCESS_EPOCH_REGRESSION';
  END IF;
  IF OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."role" IS DISTINCT FROM NEW."role"
     OR OLD."roleKey" IS DISTINCT FROM NEW."roleKey"
     OR OLD."permissions" IS DISTINCT FROM NEW."permissions"
     OR OLD."assignedCreators" IS DISTINCT FROM NEW."assignedCreators"
     OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt"
     OR OLD."deactivatedAt" IS DISTINCT FROM NEW."deactivatedAt" THEN
    IF NEW."accessEpoch" <= OLD."accessEpoch" THEN
      NEW."accessEpoch" := OLD."accessEpoch" + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_fence_fan_consumer_commit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."originKind"='AUTOMATION'
     AND NEW."moduleKey" IN ('follow_back','follow','bumps','likes','sfs')
     AND NEW."status"='COMMITTING'
     AND (TG_OP='INSERT' OR OLD."status" IS DISTINCT FROM NEW."status"
          OR OLD."writeCommitRevision" IS DISTINCT FROM NEW."writeCommitRevision")
     AND current_setting('onlinod.phase3_fan_consumer_generation',true)
           IS DISTINCT FROM 'phase3_fan_consumer_v1_current_bounded' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='PHASE3_INCOMPATIBLE_FAN_CONSUMER_COMMIT';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_fence_member_creator_access_during_creator_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_creator_agency_id TEXT;
BEGIN
  BEGIN
    SELECT c."agencyId" INTO v_creator_agency_id
      FROM "CreatorAccount" c
     WHERE c."id"=NEW."creatorId"
     FOR KEY SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING
      ERRCODE='55P03',
      MESSAGE=format(
        'PHASE2_CREATOR_LIFECYCLE_BUSY agency=%s creator=%s table=%s',
        NEW."agencyId",NEW."creatorId",TG_TABLE_NAME
      );
  END;

  IF v_creator_agency_id IS NOT NULL AND v_creator_agency_id IS DISTINCT FROM NEW."agencyId" THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE=format(
        'PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s agency=%s creator=%s',
        TG_TABLE_NAME,NEW."agencyId",NEW."creatorId"
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId"=NEW."agencyId"
       AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
       AND d."objectType"='Phase2CreatorDestructiveCleanup'
       AND d."objectId"=NEW."creatorId"
     LIMIT 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format(
        'PHASE2_CREATOR_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s',
        NEW."agencyId",NEW."creatorId",TG_TABLE_NAME
      );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_flush_domain_work_claim_locator_mutations()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_txid BIGINT := NEW."txId";
  v_touched_at TIMESTAMP(3) := clock_timestamp();
  v_intent RECORD;
BEGIN
  IF v_txid IS NULL OR v_txid <> txid_current() THEN
    RETURN NULL;
  END IF;

  -- Partition -> shard -> Agency is one global order for every DWI writer.
  -- The generation authority is resolved again at commit so a generation
  -- activation in the same transaction cannot leave old-generation locators.
  FOR v_intent IN
    SELECT i."agencyId",i."workClass",i."partitionKey",
           COALESCE(g."activeGeneration",i."activeGeneration") AS "activeGeneration"
      FROM "DomainWorkClaimLocatorMutationIntent" i
      LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=i."workClass"
     WHERE i."txId"=v_txid
     ORDER BY i."agencyId",i."workClass",i."partitionKey"
  LOOP
    PERFORM "phase3_reconcile_domain_work_claim_partition"(
      v_intent."agencyId",v_intent."workClass",v_intent."activeGeneration",
      v_intent."partitionKey",v_touched_at
    );
  END LOOP;

  FOR v_intent IN
    SELECT DISTINCT i."agencyId",i."workClass",
           COALESCE(g."activeGeneration",i."activeGeneration") AS "activeGeneration",
           "phase3_domain_work_claim_shard"(i."partitionKey") AS "claimShard"
      FROM "DomainWorkClaimLocatorMutationIntent" i
      LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=i."workClass"
     WHERE i."txId"=v_txid
     ORDER BY i."agencyId",i."workClass","claimShard"
  LOOP
    PERFORM "phase3_reconcile_domain_work_claim_shard"(
      v_intent."agencyId",v_intent."workClass",v_intent."activeGeneration",
      v_intent."claimShard",v_touched_at
    );
  END LOOP;

  FOR v_intent IN
    SELECT DISTINCT i."agencyId",i."workClass",
           COALESCE(g."activeGeneration",i."activeGeneration") AS "activeGeneration"
      FROM "DomainWorkClaimLocatorMutationIntent" i
      LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=i."workClass"
     WHERE i."txId"=v_txid
     ORDER BY i."agencyId",i."workClass",
              COALESCE(g."activeGeneration",i."activeGeneration")
  LOOP
    PERFORM "phase3_reconcile_domain_work_claim_agency"(
      v_intent."agencyId",v_intent."workClass",v_intent."activeGeneration",v_touched_at
    );
  END LOOP;

  DELETE FROM "DomainWorkClaimLocatorMutationBatch" b WHERE b."txId"=v_txid;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_invalidate_domain_work_claim_generation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."activeGeneration" IS DISTINCT FROM NEW."activeGeneration" THEN
    UPDATE "DomainWorkClaimTopologyState"
       SET "activationState"='BUILDING',
           "cursorAgencyId"=NULL,
           "cursorWorkClass"=NULL,
           "cursorPartitionKey"=NULL,
           "cursorActiveGeneration"=NULL,
           "cursorWorkId"=NULL,
           "backfilledPartitions"=0,
           "partitionsBackfilledAt"=NULL,
           "startedAt"=CURRENT_TIMESTAMP,
           "activatedAt"=NULL,
           "lastError"=NULL,
           "revision"="revision"+1,
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE "id"='phase3_domain_work_claim_topology_a36_v1';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_member_has_broad_creator_access(p_role text, p_role_key text, p_scope jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.phase3_project_hidden_status_to_bump()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_creator_id TEXT;
  v_fan_id TEXT;
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE "AutomationBumpFanState"
       SET "ignored"=FALSE,
           "blocked"=FALSE,
           "metadata"=COALESCE("metadata",'{}'::jsonb)
             || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE "creatorId"=OLD."creatorId" AND "fanId"=OLD."fanId";
    RETURN OLD;
  END IF;

  IF TG_OP='UPDATE' AND OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;

  IF NEW."status" IN ('ignored','blocked') THEN
    INSERT INTO "AutomationBumpFanState"(
      "id","agencyId","creatorId","fanId","dialogId","ignored","blocked",
      "templateIds","counters","metadata","createdAt","updatedAt"
    ) VALUES (
      'phase3_bump_' || md5(NEW."creatorId" || E'\x1f' || NEW."fanId"),
      NEW."agencyId",NEW."creatorId",NEW."fanId",COALESCE(NEW."dialogId",NEW."fanId"),
      NEW."status"='ignored',NEW."status"='blocked',
      '[]'::jsonb,'{}'::jsonb,
      jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("creatorId","fanId") DO UPDATE SET
      "ignored"=EXCLUDED."ignored",
      "blocked"=EXCLUDED."blocked",
      "dialogId"=COALESCE(EXCLUDED."dialogId","AutomationBumpFanState"."dialogId"),
      "metadata"=COALESCE("AutomationBumpFanState"."metadata",'{}'::jsonb)
        || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
      "updatedAt"=CURRENT_TIMESTAMP;
  ELSE
    UPDATE "AutomationBumpFanState"
       SET "ignored"=FALSE,
           "blocked"=FALSE,
           "metadata"=COALESCE("metadata",'{}'::jsonb)
             || jsonb_build_object('statusAuthority','HiddenOnlineUser','statusProjectedAt',CURRENT_TIMESTAMP),
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE "creatorId"=NEW."creatorId" AND "fanId"=NEW."fanId";
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_queue_domain_work_claim_locator_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_txid BIGINT := txid_current();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM old_rows LIMIT 1) THEN
    RETURN NULL;
  END IF;

  INSERT INTO "DomainWorkClaimLocatorMutationBatch"("txId","createdAt")
  VALUES (v_txid,CURRENT_TIMESTAMP)
  ON CONFLICT ("txId") DO NOTHING;

  INSERT INTO "DomainWorkClaimLocatorMutationIntent"(
    "txId","agencyId","workClass","partitionKey","activeGeneration","createdAt"
  )
  SELECT DISTINCT v_txid,o."agencyId",o."workClass",o."partitionKey",
         COALESCE(g."activeGeneration",o."activeGeneration"),CURRENT_TIMESTAMP
    FROM old_rows o
    LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=o."workClass"
   WHERE o."isOutstanding"=TRUE
     AND (g."activeGeneration" IS NULL OR g."activeGeneration"=o."activeGeneration")
   ORDER BY o."agencyId",o."workClass",o."partitionKey",
            COALESCE(g."activeGeneration",o."activeGeneration")
  ON CONFLICT ("txId","agencyId","workClass","partitionKey") DO UPDATE SET
    "activeGeneration"=EXCLUDED."activeGeneration";
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_queue_domain_work_claim_locator_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_txid BIGINT := txid_current();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM new_rows LIMIT 1) THEN
    RETURN NULL;
  END IF;

  INSERT INTO "DomainWorkClaimLocatorMutationBatch"("txId","createdAt")
  VALUES (v_txid,CURRENT_TIMESTAMP)
  ON CONFLICT ("txId") DO NOTHING;

  INSERT INTO "DomainWorkClaimLocatorMutationIntent"(
    "txId","agencyId","workClass","partitionKey","activeGeneration","createdAt"
  )
  SELECT DISTINCT v_txid,n."agencyId",n."workClass",n."partitionKey",
         COALESCE(g."activeGeneration",n."activeGeneration"),CURRENT_TIMESTAMP
    FROM new_rows n
    LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=n."workClass"
   WHERE n."isOutstanding"=TRUE
     AND (g."activeGeneration" IS NULL OR g."activeGeneration"=n."activeGeneration")
   ORDER BY n."agencyId",n."workClass",n."partitionKey",
            COALESCE(g."activeGeneration",n."activeGeneration")
  ON CONFLICT ("txId","agencyId","workClass","partitionKey") DO UPDATE SET
    "activeGeneration"=EXCLUDED."activeGeneration";
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_queue_domain_work_claim_locator_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_txid BIGINT := txid_current();
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n ON n."id"=o."id"
     WHERE o."id" IS NULL OR n."id" IS NULL
        OR o."agencyId" IS DISTINCT FROM n."agencyId"
        OR o."workClass" IS DISTINCT FROM n."workClass"
        OR o."partitionKey" IS DISTINCT FROM n."partitionKey"
        OR o."activeGeneration" IS DISTINCT FROM n."activeGeneration"
        OR o."isOutstanding" IS DISTINCT FROM n."isOutstanding"
        OR o."state" IS DISTINCT FROM n."state"
        OR o."availableAt" IS DISTINCT FROM n."availableAt"
        OR o."nextAttemptAt" IS DISTINCT FROM n."nextAttemptAt"
        OR o."leaseUntil" IS DISTINCT FROM n."leaseUntil"
     LIMIT 1
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO "DomainWorkClaimLocatorMutationBatch"("txId","createdAt")
  VALUES (v_txid,CURRENT_TIMESTAMP)
  ON CONFLICT ("txId") DO NOTHING;

  WITH changed AS MATERIALIZED (
    SELECT o."id" AS "oldId",n."id" AS "newId"
      FROM old_rows o
      FULL JOIN new_rows n ON n."id"=o."id"
     WHERE o."id" IS NULL OR n."id" IS NULL
        OR o."agencyId" IS DISTINCT FROM n."agencyId"
        OR o."workClass" IS DISTINCT FROM n."workClass"
        OR o."partitionKey" IS DISTINCT FROM n."partitionKey"
        OR o."activeGeneration" IS DISTINCT FROM n."activeGeneration"
        OR o."isOutstanding" IS DISTINCT FROM n."isOutstanding"
        OR o."state" IS DISTINCT FROM n."state"
        OR o."availableAt" IS DISTINCT FROM n."availableAt"
        OR o."nextAttemptAt" IS DISTINCT FROM n."nextAttemptAt"
        OR o."leaseUntil" IS DISTINCT FROM n."leaseUntil"
  ), touched AS MATERIALIZED (
    SELECT o."agencyId",o."workClass",o."partitionKey",o."activeGeneration",o."isOutstanding"
      FROM old_rows o JOIN changed c ON c."oldId"=o."id"
    UNION
    SELECT n."agencyId",n."workClass",n."partitionKey",n."activeGeneration",n."isOutstanding"
      FROM new_rows n JOIN changed c ON c."newId"=n."id"
  )
  INSERT INTO "DomainWorkClaimLocatorMutationIntent"(
    "txId","agencyId","workClass","partitionKey","activeGeneration","createdAt"
  )
  SELECT DISTINCT v_txid,t."agencyId",t."workClass",t."partitionKey",
         COALESCE(g."activeGeneration",t."activeGeneration"),CURRENT_TIMESTAMP
    FROM touched t
    LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=t."workClass"
   WHERE t."isOutstanding"=TRUE
     AND (g."activeGeneration" IS NULL OR g."activeGeneration"=t."activeGeneration")
   ORDER BY t."agencyId",t."workClass",t."partitionKey",
            COALESCE(g."activeGeneration",t."activeGeneration")
  ON CONFLICT ("txId","agencyId","workClass","partitionKey") DO UPDATE SET
    "activeGeneration"=EXCLUDED."activeGeneration";
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_reconcile_domain_work_claim_agency(p_agency text, p_work_class text, p_generation text, p_touched_at timestamp without time zone)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_revision BIGINT;
  v_last_selected TIMESTAMP(3);
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
  v_try INTEGER;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL THEN
    RETURN FALSE;
  END IF;

  v_id := 'dwcas_' || md5(p_agency || E'\x1f' || p_work_class);
  -- At most eight attempts if another transaction repeatedly deletes/recreates
  -- this identity. The caller must retry the whole transaction on serialization failure.
  FOR v_try IN 1..8 LOOP
    SELECT a."revision",CASE WHEN a."activeGeneration"=p_generation
    THEN a."lastSelectedAt" ELSE NULL END INTO v_revision,v_last_selected
    FROM "DomainWorkClaimAgencyState" a
   WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class
   FOR UPDATE;
    EXIT WHEN FOUND;
    -- No locator and no committed/own child: nothing to publish. A peer's
    -- private child is reconciled by that peer's own deferred flush.
    IF NOT EXISTS (
      SELECT 1 FROM "DomainWorkClaimShardState" s
       WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
         AND s."activeGeneration"=p_generation
       LIMIT 1
    ) THEN RETURN TRUE; END IF;
    INSERT INTO "DomainWorkClaimAgencyState"(
      "id","agencyId","workClass","activeGeneration",
      "nextDispatchAt","lastSelectedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_generation,CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      -- Our INSERT already owns this row. Avoid a redundant index lookup in
      -- large publications; competitors still retry through SELECT FOR UPDATE.
      v_revision := 1;
      v_last_selected := NULL;
      EXIT;
    END IF;
    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM "DomainWorkClaimAgencyState" a
       WHERE a."id"=v_id AND NOT (a."agencyId"=p_agency AND a."workClass"=p_work_class)
    ) THEN
      RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_CONFLICT:agency' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_RETRY' USING ERRCODE='40001';
  END IF;

  SELECT s."nextDispatchAt" INTO v_due
    FROM "DomainWorkClaimShardState" s
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
     AND s."activeGeneration"=p_generation
   ORDER BY s."nextDispatchAt",s."revision",s."claimShard"
   LIMIT 1;

  IF v_due IS NULL THEN
    DELETE FROM "DomainWorkClaimAgencyState" a
     WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class AND a."revision"=v_revision;
    RETURN FOUND;
  END IF;

  v_dispatch := GREATEST(v_due,p_touched_at,v_last_selected);

  UPDATE "DomainWorkClaimAgencyState" a
     SET "activeGeneration"=p_generation,
         "nextDispatchAt"=v_dispatch,
         "lastSelectedAt"=GREATEST(p_touched_at,v_last_selected),
         "revision"=a."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class AND a."revision"=v_revision;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_reconcile_domain_work_claim_agency(p_agency text, p_work_class text, p_generation text, p_touched_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT "phase3_reconcile_domain_work_claim_agency"(
    p_agency,
    p_work_class,
    p_generation,
    "phase3_utc_timestamp"(p_touched_at)
  );
$function$;

CREATE OR REPLACE FUNCTION public.phase3_reconcile_domain_work_claim_partition(p_agency text, p_work_class text, p_generation text, p_partition text, p_touched_at timestamp without time zone)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_revision BIGINT;
  v_last_selected TIMESTAMP(3);
  v_exists BOOLEAN;
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
  v_try INTEGER;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL OR p_partition IS NULL THEN
    RETURN FALSE;
  END IF;

  v_id := 'p2wbcps_' || md5(p_agency || E'\x1f' || p_work_class || E'\x1f' || p_partition);
  -- At most eight attempts if another transaction repeatedly deletes/recreates
  -- this identity. The caller must retry the whole transaction on serialization failure.
  FOR v_try IN 1..8 LOOP
    SELECT p."revision",CASE WHEN p."activeGeneration"=p_generation
    THEN p."lastClaimedAt" ELSE NULL END INTO v_revision,v_last_selected
    FROM "Phase2WorkBroadClaimPartitionState" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class AND p."partitionKey"=p_partition
   FOR UPDATE;
    EXIT WHEN FOUND;
    -- No locator and no committed/own child: nothing to publish. A peer's
    -- private child is reconciled by that peer's own deferred flush.
    IF NOT EXISTS (
      SELECT 1 FROM "DomainWorkItem" d
       WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
         AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
         AND d."isOutstanding"=TRUE
       LIMIT 1
    ) THEN RETURN TRUE; END IF;
    INSERT INTO "Phase2WorkBroadClaimPartitionState"(
      "id","agencyId","workClass","partitionKey","activeGeneration",
      "outstandingCount","claimShard","nextClaimableAt","lastClaimedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_partition,p_generation,1,
      "phase3_domain_work_claim_shard"(p_partition),CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      -- Our INSERT already owns this row. Avoid a redundant index lookup in
      -- large publications; competitors still retry through SELECT FOR UPDATE.
      v_revision := 1;
      v_last_selected := NULL;
      EXIT;
    END IF;
    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM "Phase2WorkBroadClaimPartitionState" p
       WHERE p."id"=v_id AND NOT (p."agencyId"=p_agency AND p."workClass"=p_work_class AND p."partitionKey"=p_partition)
    ) THEN
      RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_CONFLICT:partition' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_RETRY' USING ERRCODE='40001';
  END IF;

  -- Positive witness and indexed claimable head; no history count.
    SELECT EXISTS (
      SELECT 1 FROM "DomainWorkItem" d
       WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
         AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
         AND d."isOutstanding"=TRUE
       LIMIT 1
    ) INTO v_exists;
    IF NOT COALESCE(v_exists,FALSE) THEN
      DELETE FROM "Phase2WorkBroadClaimPartitionState" p
       WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
         AND p."partitionKey"=p_partition AND p."revision"=v_revision;
      RETURN FOUND;
    END IF;

    SELECT "phase3_domain_work_claimable_at"(
             d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
           ) INTO v_due
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
       AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
       AND d."isOutstanding"=TRUE AND d."state" IN ('READY','CLAIMED')
     ORDER BY "phase3_domain_work_claimable_at"(
                d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
              ),d."id"
     LIMIT 1;
  v_dispatch := CASE WHEN v_due IS NULL THEN NULL
    ELSE GREATEST(v_due,p_touched_at,v_last_selected) END;


  UPDATE "Phase2WorkBroadClaimPartitionState" p
     SET "activeGeneration"=p_generation,
         "claimShard"="phase3_domain_work_claim_shard"(p_partition),
         "nextClaimableAt"=v_dispatch,
         "lastClaimedAt"=GREATEST(p_touched_at,v_last_selected),
         "revision"=p."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
     AND p."partitionKey"=p_partition AND p."revision"=v_revision;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_reconcile_domain_work_claim_partition(p_agency text, p_work_class text, p_generation text, p_partition text, p_touched_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT "phase3_reconcile_domain_work_claim_partition"(
    p_agency,
    p_work_class,
    p_generation,
    p_partition,
    "phase3_utc_timestamp"(p_touched_at)
  );
$function$;

CREATE OR REPLACE FUNCTION public.phase3_reconcile_domain_work_claim_shard(p_agency text, p_work_class text, p_generation text, p_shard integer, p_touched_at timestamp without time zone)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_revision BIGINT;
  v_last_selected TIMESTAMP(3);
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
  v_try INTEGER;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL
     OR p_shard IS NULL OR p_shard < 0 OR p_shard >= 128 THEN
    RETURN FALSE;
  END IF;

  v_id := 'dwcss_' || md5(p_agency || E'\x1f' || p_work_class || E'\x1f' || p_shard::TEXT);
  -- At most eight attempts if another transaction repeatedly deletes/recreates
  -- this identity. The caller must retry the whole transaction on serialization failure.
  FOR v_try IN 1..8 LOOP
    SELECT s."revision",CASE WHEN s."activeGeneration"=p_generation
    THEN s."lastSelectedAt" ELSE NULL END INTO v_revision,v_last_selected
    FROM "DomainWorkClaimShardState" s
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class AND s."claimShard"=p_shard
   FOR UPDATE;
    EXIT WHEN FOUND;
    -- No locator and no committed/own child: nothing to publish. A peer's
    -- private child is reconciled by that peer's own deferred flush.
    IF NOT EXISTS (
      SELECT 1 FROM "Phase2WorkBroadClaimPartitionState" p
       WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
         AND p."activeGeneration"=p_generation AND p."claimShard"=p_shard
         AND p."nextClaimableAt" IS NOT NULL
       LIMIT 1
    ) THEN RETURN TRUE; END IF;
    INSERT INTO "DomainWorkClaimShardState"(
      "id","agencyId","workClass","claimShard","activeGeneration",
      "nextDispatchAt","lastSelectedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_shard,p_generation,CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      -- Our INSERT already owns this row. Avoid a redundant index lookup in
      -- large publications; competitors still retry through SELECT FOR UPDATE.
      v_revision := 1;
      v_last_selected := NULL;
      EXIT;
    END IF;
    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM "DomainWorkClaimShardState" s
       WHERE s."id"=v_id AND NOT (s."agencyId"=p_agency AND s."workClass"=p_work_class AND s."claimShard"=p_shard)
    ) THEN
      RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_CONFLICT:shard' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_RETRY' USING ERRCODE='40001';
  END IF;

  SELECT p."nextClaimableAt" INTO v_due
    FROM "Phase2WorkBroadClaimPartitionState" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
     AND p."activeGeneration"=p_generation AND p."claimShard"=p_shard
     AND p."nextClaimableAt" IS NOT NULL
   ORDER BY p."nextClaimableAt",p."revision",p."partitionKey"
   LIMIT 1;

  IF v_due IS NULL THEN
    DELETE FROM "DomainWorkClaimShardState" s
     WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
       AND s."claimShard"=p_shard AND s."revision"=v_revision;
    RETURN FOUND;
  END IF;

  v_dispatch := GREATEST(v_due,p_touched_at,v_last_selected);

  UPDATE "DomainWorkClaimShardState" s
     SET "activeGeneration"=p_generation,
         "nextDispatchAt"=v_dispatch,
         "lastSelectedAt"=GREATEST(p_touched_at,v_last_selected),
         "revision"=s."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
     AND s."claimShard"=p_shard AND s."revision"=v_revision;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_reconcile_domain_work_claim_shard(p_agency text, p_work_class text, p_generation text, p_shard integer, p_touched_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT "phase3_reconcile_domain_work_claim_shard"(
    p_agency,
    p_work_class,
    p_generation,
    p_shard,
    "phase3_utc_timestamp"(p_touched_at)
  );
$function$;

CREATE OR REPLACE FUNCTION public.phase3_reconcile_domain_work_claim_shard(p_agency text, p_work_class text, p_generation text, p_shard bigint, p_touched_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT CASE
    WHEN p_shard >= 0 AND p_shard < 128 THEN
      "phase3_reconcile_domain_work_claim_shard"(
        p_agency,
        p_work_class,
        p_generation,
        p_shard::INTEGER,
        "phase3_utc_timestamp"(p_touched_at)
      )
    ELSE FALSE
  END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_refresh_member_creator_scope(p_member_id text)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_member "AgencyMember"%ROWTYPE;
  v_count INTEGER := 0;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_member_id,'')),'') IS NULL THEN RETURN 0; END IF;

  DELETE FROM "DomainWorkMemberScopeShardState" s WHERE s."memberId"=p_member_id;
  DELETE FROM "AgencyMemberCreatorAccessCurrent" a WHERE a."memberId"=p_member_id;

  SELECT m.* INTO v_member FROM "AgencyMember" m WHERE m."id"=p_member_id;
  IF NOT FOUND OR v_member."deletedAt" IS NOT NULL OR v_member."deactivatedAt" IS NOT NULL
     OR "phase3_member_has_broad_creator_access"(
          v_member."role"::TEXT,v_member."roleKey",v_member."assignedCreators"
        ) THEN
    RETURN 0;
  END IF;

  -- Normalize the member grant itself, not a grant x current-Creator snapshot.
  -- Creator liveness is rechecked by each bounded reader.  This keeps soft
  -- delete/restore and later identity materialization from requiring an
  -- O(all members assigned to creator) fan-out rebuild.
  INSERT INTO "AgencyMemberCreatorAccessCurrent"(
    "agencyId","memberId","creatorId","accessEpoch","claimShard","createdAt","updatedAt"
  )
  SELECT v_member."agencyId",v_member."id",scope."creatorId",v_member."accessEpoch",
         "phase3_domain_work_claim_shard"(scope."creatorId"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM unnest("phase2_scope_creator_ids"(v_member."assignedCreators")) AS scope("creatorId")
   ORDER BY scope."creatorId"
  ON CONFLICT ("memberId","creatorId") DO UPDATE SET
    "agencyId"=EXCLUDED."agencyId",
    "accessEpoch"=EXCLUDED."accessEpoch",
    "claimShard"=EXCLUDED."claimShard",
    "updatedAt"=CURRENT_TIMESTAMP;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO "DomainWorkMemberScopeShardState"(
    "id","agencyId","memberId","accessEpoch","claimShard","cursorCreatorId",
    "lastSelectedAt","revision","createdAt","updatedAt"
  )
  SELECT 'dwmsss_' || md5(v_member."id" || E'\x1f' || a."claimShard"::TEXT),
         v_member."agencyId",v_member."id",v_member."accessEpoch",a."claimShard",
         NULL,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM "AgencyMemberCreatorAccessCurrent" a
   WHERE a."memberId"=v_member."id" AND a."accessEpoch"=v_member."accessEpoch"
   GROUP BY a."claimShard"
   ORDER BY a."claimShard"
  ON CONFLICT ("memberId","claimShard") DO UPDATE SET
    "agencyId"=EXCLUDED."agencyId",
    "accessEpoch"=EXCLUDED."accessEpoch",
    "cursorCreatorId"=CASE
      WHEN "DomainWorkMemberScopeShardState"."accessEpoch"=EXCLUDED."accessEpoch"
        THEN "DomainWorkMemberScopeShardState"."cursorCreatorId"
      ELSE NULL END,
    "lastSelectedAt"=CASE
      WHEN "DomainWorkMemberScopeShardState"."accessEpoch"=EXCLUDED."accessEpoch"
        THEN "DomainWorkMemberScopeShardState"."lastSelectedAt"
      ELSE NULL END,
    "revision"="DomainWorkMemberScopeShardState"."revision"+1,
    "updatedAt"=CURRENT_TIMESTAMP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_refresh_member_creator_scope_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "phase3_refresh_member_creator_scope"(
    CASE WHEN TG_OP='DELETE' THEN OLD."id" ELSE NEW."id" END
  );
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_sync_creator_recurring_work()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_old_eligible BOOLEAN := FALSE;
  v_new_eligible BOOLEAN := FALSE;
  v_same_identity BOOLEAN := FALSE;
  v_work_class CONSTANT TEXT := 'CREATOR_RECURRING_PLANNING';
  v_generation CONSTANT TEXT := 'phase2_domain_work_v3_actual55';
BEGIN
  -- DELETE must not UPDATE a creator-owned DomainWorkItem: its mandatory
  -- Phase2 owner fence resolves CreatorAccount and the identity is already absent
  -- inside an AFTER DELETE trigger. DELETE is also the correct lifecycle for this
  -- operational work root and lets the current-partition trigger conserve counts.
  IF TG_OP='DELETE' THEN
    DELETE FROM "DomainWorkItem"
     WHERE "agencyId"=OLD."agencyId"
       AND "workClass"=v_work_class
       AND "objectType"='CreatorAccount'
       AND "objectId"=OLD."id";
    RETURN OLD;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    v_old_eligible := OLD."status"='READY' AND OLD."deletedAt" IS NULL;
  END IF;
  v_new_eligible := NEW."status"='READY' AND NEW."deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM "Agency" a WHERE a."id"=NEW."agencyId" AND a."deletedAt" IS NULL);
  IF TG_OP='UPDATE' THEN
    v_same_identity := OLD."id"=NEW."id" AND OLD."agencyId"=NEW."agencyId";
  END IF;

  IF v_old_eligible AND NOT (v_new_eligible AND v_same_identity) THEN
    UPDATE "DomainWorkItem"
       SET "requestedRevision"="requestedRevision"+1,
           "completedRevision"="requestedRevision"+1,
           "state"='DONE',"isOutstanding"=FALSE,
           "ownerToken"=NULL,"leaseUntil"=CURRENT_TIMESTAMP,"nextAttemptAt"=NULL,
           "progressCursor"=NULL,"errorClass"=NULL,"lastError"=NULL,
           "terminalCause"='CREATOR_NOT_READY',"updatedAt"=CURRENT_TIMESTAMP
     WHERE "agencyId"=OLD."agencyId"
       AND "workClass"=v_work_class
       AND "objectType"='CreatorAccount'
       AND "objectId"=OLD."id";
  END IF;

  IF v_new_eligible AND NOT (v_old_eligible AND v_same_identity) THEN
    INSERT INTO "DomainWorkItem"(
      "id","agencyId","workClass","objectType","objectId","partitionKey","creatorId",
      "requestedRevision","completedRevision","activeGeneration","projectionVersion",
      "state","isOutstanding","availableAt","claimedRevision","claimFence","attempts",
      "dependencyRevision","createdAt","updatedAt"
    ) VALUES (
      'dwi_' || md5(NEW."agencyId" || E'\x1f' || v_work_class || E'\x1f' || 'CreatorAccount' || E'\x1f' || NEW."id"),
      NEW."agencyId",v_work_class,'CreatorAccount',NEW."id",NEW."id",NEW."id",
      1,0,v_generation,v_generation,'READY',TRUE,CURRENT_TIMESTAMP,0,0,0,0,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agencyId","workClass","objectType","objectId") DO UPDATE SET
      "requestedRevision"="DomainWorkItem"."requestedRevision"+1,
      "partitionKey"=EXCLUDED."partitionKey","creatorId"=EXCLUDED."creatorId",
      "activeGeneration"=EXCLUDED."activeGeneration","projectionVersion"=EXCLUDED."projectionVersion",
      "state"='READY',"isOutstanding"=TRUE,"availableAt"=CURRENT_TIMESTAMP,
      "ownerToken"=NULL,"leaseUntil"=CURRENT_TIMESTAMP,"nextAttemptAt"=NULL,
      "progressCursor"=NULL,"errorClass"=NULL,"lastError"=NULL,"terminalCause"=NULL,
      "updatedAt"=CURRENT_TIMESTAMP;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_utc_timestamp(p_value timestamp with time zone)
 RETURNS timestamp without time zone
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT (p_value AT TIME ZONE 'UTC')::TIMESTAMP(3);
$function$;

CREATE OR REPLACE FUNCTION public.phase3_wake_domain_dependency_batch(p_agency text, p_kind text, p_key text, p_revision bigint, p_limit integer DEFAULT 100)
 RETURNS TABLE(woken integer, remaining boolean)
 LANGUAGE plpgsql
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_limit INTEGER := GREATEST(1,LEAST(COALESCE(p_limit,100),500));
  v_woken INTEGER := 0;
  v_remaining BOOLEAN := FALSE;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_agency,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_kind,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_key,'')),'') IS NULL
     OR COALESCE(p_revision,0) <= 0 THEN
    RETURN QUERY SELECT 0,FALSE;
    RETURN;
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT d."id"
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency
       AND d."state"='BLOCKED'
       AND d."isOutstanding"=TRUE
       AND d."dependencyKind"=p_kind
       AND d."dependencyKey"=p_key
       AND d."dependencyRevision" < p_revision
     ORDER BY d."dependencyRevision",d."id"
     LIMIT v_limit
     FOR UPDATE OF d SKIP LOCKED
  ), updated AS (
    UPDATE "DomainWorkItem" d
       SET "state"='READY',
           "isOutstanding"=TRUE,
           "availableAt"=CURRENT_TIMESTAMP,
           "nextAttemptAt"=NULL,
           "ownerToken"=NULL,
           "leaseUntil"=CURRENT_TIMESTAMP,
           "progressCursor"=NULL,
           "errorClass"=NULL,
           "lastError"=NULL,
           "terminalCause"=NULL,
           "updatedAt"=CURRENT_TIMESTAMP
      FROM candidates c
     WHERE d."id"=c."id"
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_woken FROM updated;

  SELECT EXISTS(
    SELECT 1
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency
       AND d."state"='BLOCKED'
       AND d."isOutstanding"=TRUE
       AND d."dependencyKind"=p_kind
       AND d."dependencyKey"=p_key
       AND d."dependencyRevision" < p_revision
     LIMIT 1
  ) INTO v_remaining;

  RETURN QUERY SELECT v_woken,v_remaining;
END;
$function$;

CREATE OR REPLACE FUNCTION public.phase3_wake_domain_dependency_batch(p_agency text, p_kind text, p_key text, p_revision bigint, p_limit bigint)
 RETURNS TABLE(woken integer, remaining boolean)
 LANGUAGE sql
AS $function$
  SELECT wake_result."woken",wake_result."remaining"
    FROM "phase3_wake_domain_dependency_batch"(
      p_agency,
      p_kind,
      p_key,
      p_revision,
      GREATEST(
        1::BIGINT,
        LEAST(COALESCE(p_limit,100::BIGINT),500::BIGINT)
      )::INTEGER
    ) AS wake_result;
$function$;

CREATE OR REPLACE FUNCTION public.phase4_assert_single_owner(agency_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE owner_count INT; operational_count INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Agency" WHERE "id"=agency_id AND "deletedAt" IS NULL) THEN RETURN; END IF;
  SELECT count(*),count(*) FILTER (WHERE m."deactivatedAt" IS NULL AND u."disabledAt" IS NULL)
    INTO owner_count,operational_count FROM "AgencyMember" m JOIN "User" u ON u."id"=m."userId"
    WHERE m."agencyId"=agency_id AND m."deletedAt" IS NULL AND (m."roleKey"='owner' OR m."role"='OWNER');
  IF owner_count<>1 OR operational_count<>1 THEN
    RAISE EXCEPTION 'PHASE4_EXACTLY_ONE_OPERATIONAL_OWNER_REQUIRED agency=%',agency_id USING ERRCODE='23514';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.phase4_check_agency_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN PERFORM phase4_assert_single_owner(NEW."id"); RETURN NULL; END $function$;

CREATE OR REPLACE FUNCTION public.phase4_check_member_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP<>'INSERT' AND (OLD."roleKey"='owner' OR OLD."role"='OWNER') THEN PERFORM phase4_assert_single_owner(OLD."agencyId"); END IF;
  IF TG_OP<>'DELETE' AND (NEW."roleKey"='owner' OR NEW."role"='OWNER') THEN PERFORM phase4_assert_single_owner(NEW."agencyId"); END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.phase4_check_user_owner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE agency_id TEXT;
BEGIN
  FOR agency_id IN SELECT "agencyId" FROM "AgencyMember" WHERE "userId"=NEW."id" AND "deletedAt" IS NULL AND ("roleKey"='owner' OR "role"='OWNER')
    LOOP PERFORM phase4_assert_single_owner(agency_id); END LOOP;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.phase4_commercial_policy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE field TEXT; amount NUMERIC;
BEGIN
 IF (TG_OP <> 'INSERT' AND OLD."key" = 'billing.commercial.policy.v1') OR
    (TG_OP <> 'DELETE' AND NEW."key" = 'billing.commercial.policy.v1') THEN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."key" <> OLD."key") THEN
   RAISE EXCEPTION 'COMMERCIAL_POLICY_CANNOT_DELETE_OR_RENAME';
  END IF;
  IF current_setting('onlinod.commercial_policy_command',true) IS DISTINCT FROM 'v1' THEN
   RAISE EXCEPTION 'COMMERCIAL_POLICY_COMMAND_REQUIRED';
  END IF;
  IF jsonb_typeof(NEW."value") IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW."value")) <> 7 THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
  FOREACH field IN ARRAY ARRAY['trialDays','starterPriceCents','growthPriceCents','proPriceCents','elitePriceCents','aiChatterPriceCents','outreachPriceCents'] LOOP
   IF jsonb_typeof(NEW."value"->field) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
   amount := (NEW."value"->>field)::numeric;
   IF amount <> trunc(amount) OR amount < (CASE WHEN field IN ('aiChatterPriceCents','outreachPriceCents') THEN 0 ELSE 1 END)
      OR amount > (CASE WHEN field='trialDays' THEN 365 ELSE 1000000 END) THEN RAISE EXCEPTION 'COMMERCIAL_POLICY_INVALID'; END IF;
  END LOOP;
  IF TG_OP='UPDATE' THEN NEW."revision" := OLD."revision" + 1; ELSE NEW."revision" := 1; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.phase4_commercial_pricing_writer_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF current_setting('onlinod.commercial_pricing_writer',true) IS DISTINCT FROM 'v1' THEN
  RAISE EXCEPTION 'COMMERCIAL_PRICING_WRITER_REQUIRED';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.phase4_issue_agency_trial()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE policy RECORD; issued TIMESTAMP(3);
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW."trialGrantedAt",NEW."trialGrantedDays",NEW."trialPolicyRevision") IS DISTINCT FROM
     ROW(OLD."trialGrantedAt",OLD."trialGrantedDays",OLD."trialPolicyRevision") THEN RAISE EXCEPTION 'TRIAL_ISSUANCE_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 SELECT "value","revision" INTO STRICT policy FROM "SystemSetting" WHERE "key"='billing.commercial.policy.v1' FOR SHARE;
 issued := clock_timestamp() AT TIME ZONE 'UTC';
 -- Server-owned issuance, also for a draining binary that omitted the dates.
 NEW."trialGrantedAt" := issued;
 NEW."trialGrantedDays" := (policy."value"->>'trialDays')::integer;
 NEW."trialPolicyRevision" := policy."revision";
 NEW."trialEndsAt" := issued + make_interval(days => NEW."trialGrantedDays");
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.phase4_retention_policy_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF (TG_OP <> 'INSERT' AND OLD."key" = 'retention.policy.v1') OR (TG_OP <> 'DELETE' AND NEW."key" = 'retention.policy.v1') THEN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."key" <> OLD."key") THEN
   RAISE EXCEPTION 'RETENTION_POLICY_RESET_REQUIRES_REVISION';
  END IF;
  IF current_setting('onlinod.retention_policy_command', true) IS DISTINCT FROM 'v1' THEN
   RAISE EXCEPTION 'RETENTION_POLICY_COMMAND_REQUIRED';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW."revision" := OLD."revision" + 1;
  ELSE NEW."revision" := 1; END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.phase4_support_grant_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id",NEW."actorId",NEW."sessionId",NEW."actorAccessEpoch",NEW."agencyId",NEW."reason",NEW."createdAt",NEW."expiresAt")
     IS DISTINCT FROM ROW(OLD."id",OLD."actorId",OLD."sessionId",OLD."actorAccessEpoch",OLD."agencyId",OLD."reason",OLD."createdAt",OLD."expiresAt")
     OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.phase5_notification_fact_consequences()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE job RECORD;
BEGIN
 FOR job IN SELECT "id","params" FROM "JobInstance" WHERE "id" IN (NEW."sourceJobId",CASE WHEN TG_OP='UPDATE' THEN OLD."sourceJobId" ELSE NULL END)
   AND "agencyId"=NEW."agencyId" AND "creatorId"=NEW."creatorId" AND "jobKey"='catchup_notifications_scan'
 LOOP
   INSERT INTO "NotificationFactReceipt"("jobId","kind","factId","agencyId","creatorId","historical")
     VALUES(job.id,TG_TABLE_NAME,NEW.id,NEW."agencyId",NEW."creatorId",COALESCE(job.params->>'notificationMode','')<>'catchup') ON CONFLICT DO NOTHING;
   PERFORM "phase2_publish_domain_work"(NEW."agencyId",'NOTIFICATION_FACT_RECEIPTS','JobInstance',job.id,NEW."creatorId",NEW."creatorId",NULL,NULL,NULL,0,clock_timestamp());
 END LOOP;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.phase6_home_member_scope_claim_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."scopeMode" = 'MEMBER_CURRENT' AND NEW."claimToken" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
          OR NEW."claimedRevision" IS DISTINCT FROM OLD."claimedRevision")
     AND current_setting('onlinod.home_member_scope_version',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'HOME_MEMBER_SCOPE_WORKER_UPGRADE_REQUIRED';
  END IF;
  RETURN NEW;
END;
$function$;


-- Current constraints


ALTER TABLE "AuthMailOutbox" ADD CONSTRAINT "AuthMailOutbox_authTokenId_key" UNIQUE ("authTokenId");

ALTER TABLE "CampaignFanRefreshPromotionSignal" ADD CONSTRAINT "CampaignFanRefreshPromotionSignal_agency_creator_key" UNIQUE ("agencyId", "creatorId");

ALTER TABLE "CampaignFanRefreshPromotionSignal" ADD CONSTRAINT "CampaignFanRefreshPromotionSignal_creatorId_key" UNIQUE ("creatorId");

ALTER TABLE "FanObservationToken" ADD CONSTRAINT "FanObservationToken_token_key" UNIQUE (token);

ALTER TABLE "FinancialPageReceipt" ADD CONSTRAINT "FinancialPageReceipt_runId_windowIndex_markerStart_key" UNIQUE ("runId", "windowIndex", "markerStart");

ALTER TABLE "FinancialReceiptRun" ADD CONSTRAINT "FinancialReceiptRun_jobId_generation_key" UNIQUE ("jobId", generation);

ALTER TABLE "MaintenanceAdmissionClassState" ADD CONSTRAINT "MaintenanceAdmissionClassState_generation_ordinal_key" UNIQUE (generation, ordinal);

ALTER TABLE "OfProviderRequestGateWaiter" ADD CONSTRAINT "OfProviderRequestGateWaiter_waiterId_key" UNIQUE ("waiterId");

ALTER TABLE "OperationalControlState" ADD CONSTRAINT "OperationalControlState_agencyId_creatorId_family_key" UNIQUE ("agencyId", "creatorId", family);

ALTER TABLE "TrafficFanProjection" ADD CONSTRAINT "TrafficFanProjection_creatorId_fanId_key" UNIQUE ("creatorId", "fanId");

ALTER TABLE "TrafficFanSignal" ADD CONSTRAINT "TrafficFanSignal_creatorId_fanId_key" UNIQUE ("creatorId", "fanId");


-- Current indexes


CREATE INDEX "AdminActionLog_agencyId_idx" ON public."AdminActionLog" USING btree ("agencyId");

CREATE INDEX "AdminCommand_actorId_action_createdAt_id_idx" ON public."AdminCommand" USING btree ("actorId", action, "createdAt", id);

CREATE UNIQUE INDEX "AdminCommand_actorId_commandId_key" ON public."AdminCommand" USING btree ("actorId", "commandId");

CREATE INDEX "AdminCommand_actorId_createdAt_id_idx" ON public."AdminCommand" USING btree ("actorId", "createdAt", id);

CREATE UNIQUE INDEX "AdminCommand_one_active_retention_run" ON public."AdminCommand" USING btree (action) WHERE ((action = 'retention.run'::text) AND (status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text])) AND ("executionPayload" IS NOT NULL));

CREATE INDEX "AdminCommand_scopeAgencyId_createdAt_id_idx" ON public."AdminCommand" USING btree ("scopeAgencyId", "createdAt", id);

CREATE INDEX "AdminCommandAudit_actorId_createdAt_id_idx" ON public."AdminCommandAudit" USING btree ("actorId", "createdAt", id);

CREATE UNIQUE INDEX "AdminCommandAudit_commandId_sequence_key" ON public."AdminCommandAudit" USING btree ("commandId", sequence);

CREATE INDEX "AdminCommandAudit_scopeAgencyId_createdAt_id_idx" ON public."AdminCommandAudit" USING btree ("scopeAgencyId", "createdAt", id);

CREATE INDEX "AdminSession_adminUserId_idx" ON public."AdminSession" USING btree ("adminUserId");

CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON public."AdminSession" USING btree ("tokenHash");

CREATE INDEX "AdminSupportGrant_actorId_createdAt_id_idx" ON public."AdminSupportGrant" USING btree ("actorId", "createdAt", id);

CREATE INDEX "AdminSupportGrant_expiresAt_idx" ON public."AdminSupportGrant" USING btree ("expiresAt");

CREATE INDEX "AdminSupportGrant_sessionId_idx" ON public."AdminSupportGrant" USING btree ("sessionId");

CREATE UNIQUE INDEX "AdminUser_email_key" ON public."AdminUser" USING btree (email);

CREATE INDEX "Agency_deletedAt_idx" ON public."Agency" USING btree ("deletedAt");

CREATE UNIQUE INDEX "AgencyBillingWallet_agencyId_testMode_key" ON public."AgencyBillingWallet" USING btree ("agencyId", "testMode");

CREATE INDEX "AgencyBillingWallet_updatedAt_idx" ON public."AgencyBillingWallet" USING btree ("updatedAt");

CREATE INDEX "AgencyCreatorCatalogGenerationBoundary_agency_ended_idx" ON public."AgencyCreatorCatalogGenerationBoundary" USING btree ("agencyId", "endedAt");

CREATE UNIQUE INDEX "AgencyCryptoOwnerKeyWrap_agencyId_rootVersion_deviceId_key" ON public."AgencyCryptoOwnerKeyWrap" USING btree ("agencyId", "rootVersion", "deviceId");

CREATE INDEX "AgencyCryptoOwnerKeyWrap_deviceId_revokedAt_idx" ON public."AgencyCryptoOwnerKeyWrap" USING btree ("deviceId", "revokedAt");

CREATE INDEX "AgencyCryptoRoot_status_updatedAt_idx" ON public."AgencyCryptoRoot" USING btree (status, "updatedAt");

CREATE UNIQUE INDEX "AgencyCryptoRootBridge_agencyId_fromVersion_toVersion_key" ON public."AgencyCryptoRootBridge" USING btree ("agencyId", "fromVersion", "toVersion");

CREATE INDEX "AgencyCryptoRootBridge_agencyId_toVersion_retiredAt_idx" ON public."AgencyCryptoRootBridge" USING btree ("agencyId", "toVersion", "retiredAt");

CREATE INDEX "AgencyCustomRole_agencyId_idx" ON public."AgencyCustomRole" USING btree ("agencyId");

CREATE UNIQUE INDEX "AgencyCustomRole_agencyId_key_key" ON public."AgencyCustomRole" USING btree ("agencyId", key);

CREATE INDEX "AgencyInvitation_agencyId_idx" ON public."AgencyInvitation" USING btree ("agencyId");

CREATE INDEX "AgencyInvitation_email_idx" ON public."AgencyInvitation" USING btree (email);

CREATE INDEX "AgencyInvitation_expiresAt_idx" ON public."AgencyInvitation" USING btree ("expiresAt");

CREATE INDEX "AgencyInvitation_pending_assignedCreators_gin_idx" ON public."AgencyInvitation" USING gin ("assignedCreators" jsonb_path_ops) WHERE (("claimedAt" IS NULL) AND ("revokedAt" IS NULL));

CREATE UNIQUE INDEX "AgencyInvitation_tokenHash_key" ON public."AgencyInvitation" USING btree ("tokenHash");

CREATE INDEX "AgencyMember_agencyId_idx" ON public."AgencyMember" USING btree ("agencyId");

CREATE UNIQUE INDEX "AgencyMember_agencyId_userId_key" ON public."AgencyMember" USING btree ("agencyId", "userId");

CREATE INDEX "AgencyMember_current_activation_a36_idx" ON public."AgencyMember" USING btree (id) WHERE (("deletedAt" IS NULL) AND ("deactivatedAt" IS NULL));

CREATE INDEX "AgencyMember_deactivatedAt_idx" ON public."AgencyMember" USING btree ("deactivatedAt");

CREATE INDEX "AgencyMember_live_assignedCreators_gin_idx" ON public."AgencyMember" USING gin ("assignedCreators" jsonb_path_ops) WHERE ("deletedAt" IS NULL);

CREATE INDEX "AgencyMember_roleKey_idx" ON public."AgencyMember" USING btree ("roleKey");

CREATE UNIQUE INDEX "AgencyMember_single_owner_agency_idx" ON public."AgencyMember" USING btree ("agencyId") WHERE (("deletedAt" IS NULL) AND (("roleKey" = 'owner'::text) OR (role = 'OWNER'::"UserRole")));

CREATE INDEX "AgencyMember_userId_idx" ON public."AgencyMember" USING btree ("userId");

CREATE INDEX "AgencyMemberAccessEpochBoundary_agency_user_ended_idx" ON public."AgencyMemberAccessEpochBoundary" USING btree ("agencyId", "userId", "endedAt");

CREATE INDEX "AgencyMemberCreatorAccessCurrent_claim_idx" ON public."AgencyMemberCreatorAccessCurrent" USING btree ("memberId", "accessEpoch", "claimShard", "creatorId");

CREATE INDEX "AgencyMemberCreatorAccessCurrent_creator_idx" ON public."AgencyMemberCreatorAccessCurrent" USING btree ("agencyId", "creatorId", "memberId");

CREATE INDEX "AgencyProxyEndpoint_agencyId_enabled_idx" ON public."AgencyProxyEndpoint" USING btree ("agencyId", enabled);

CREATE UNIQUE INDEX "AgencyProxyEndpoint_agencyId_id_key" ON public."AgencyProxyEndpoint" USING btree ("agencyId", id);

CREATE UNIQUE INDEX "AgencyProxyEndpoint_agencyId_ownerCreatorId_key" ON public."AgencyProxyEndpoint" USING btree ("agencyId", "ownerCreatorId");

CREATE INDEX "AgencyProxyEndpoint_agencyId_updatedAt_idx" ON public."AgencyProxyEndpoint" USING btree ("agencyId", "updatedAt");

CREATE INDEX "AgencyProxyEndpoint_encryptionMode_idx" ON public."AgencyProxyEndpoint" USING btree ("encryptionMode");

CREATE UNIQUE INDEX "AgencyRoleOverride_agencyId_roleKey_key" ON public."AgencyRoleOverride" USING btree ("agencyId", "roleKey");

CREATE INDEX "AgencySubPermissionOverride_agencyId_idx" ON public."AgencySubPermissionOverride" USING btree ("agencyId");

CREATE UNIQUE INDEX "AgencySubPermissionOverride_unique_key" ON public."AgencySubPermissionOverride" USING btree ("agencyId", "roleKey", "subPermKey");

CREATE INDEX "AgencySubscription_agencyId_idx" ON public."AgencySubscription" USING btree ("agencyId");

CREATE INDEX "AgencySubscription_agency_created_id_idx" ON public."AgencySubscription" USING btree ("agencyId", "createdAt", id);

CREATE INDEX "AgencyTelegramMtprotoAccount_agencyId_idx" ON public."AgencyTelegramMtprotoAccount" USING btree ("agencyId");

CREATE INDEX "AnalyticsCollectionDemand_agency_requested_idx" ON public."AnalyticsCollectionDemand" USING btree ("agencyId", "requestedAt");

CREATE INDEX "AnalyticsCollectionDemand_due_v2_idx" ON public."AnalyticsCollectionDemand" USING btree ("completedAt", "quarantinedAt", "nextAttemptAt", "claimUntil", "requestedAt");

CREATE INDEX "AnalyticsCollectionLease_cycle_complete_idx" ON public."AnalyticsCollectionLease" USING btree ("cycleKey", "completedAt");

CREATE INDEX "AnalyticsCollectionLease_leaseUntil_idx" ON public."AnalyticsCollectionLease" USING btree ("leaseUntil");

CREATE INDEX "AnalyticsCoverage_agency_creator_type_day_idx" ON public."AnalyticsCoverage" USING btree ("agencyId", "creatorId", "dataType", "coverageDate");

CREATE UNIQUE INDEX "AnalyticsCoverage_creator_day_key" ON public."AnalyticsCoverage" USING btree ("creatorId", "dataType", "coverageDate", "sourceTimezone");

CREATE INDEX "AnalyticsCoverage_creator_type_status_day_idx" ON public."AnalyticsCoverage" USING btree ("creatorId", "dataType", status, "coverageDate");

CREATE INDEX "AnalyticsCoverage_ingestBatchId_idx" ON public."AnalyticsCoverage" USING btree ("ingestBatchId");

CREATE INDEX "AnalyticsCoverage_scanProofId_idx" ON public."AnalyticsCoverage" USING btree ("scanProofId");

CREATE INDEX "AnalyticsIngestBatch_agencyId_creatorId_dataType_startedAt_idx" ON public."AnalyticsIngestBatch" USING btree ("agencyId", "creatorId", "dataType", "startedAt");

CREATE INDEX "AnalyticsIngestBatch_creatorId_dataType_status_idx" ON public."AnalyticsIngestBatch" USING btree ("creatorId", "dataType", status);

CREATE UNIQUE INDEX "AnalyticsIngestBatch_idempotencyKey_key" ON public."AnalyticsIngestBatch" USING btree ("idempotencyKey");

CREATE INDEX "AnalyticsIngestBatch_retention_idx" ON public."AnalyticsIngestBatch" USING btree ("dataType", "completedAt", id);

CREATE INDEX "AnalyticsIngestBatch_sourceDeviceId_startedAt_idx" ON public."AnalyticsIngestBatch" USING btree ("sourceDeviceId", "startedAt");

CREATE INDEX "AnalyticsIngestBatch_sourceJobId_idx" ON public."AnalyticsIngestBatch" USING btree ("sourceJobId");

CREATE INDEX "AnalyticsPublication_due_idx" ON public."AnalyticsPublication" USING btree (state, "availableAt", "jobId");

CREATE UNIQUE INDEX "AnalyticsPublication_execution_key" ON public."AnalyticsPublication" USING btree ("jobId", "leaseRevision");

CREATE UNIQUE INDEX "AnalyticsPublication_one_pending_job" ON public."AnalyticsPublication" USING btree ("jobId") WHERE (state = 'PENDING'::text);

CREATE INDEX "AnalyticsPublication_scope_idx" ON public."AnalyticsPublication" USING btree ("agencyId", "creatorId", state);

CREATE INDEX "AnalyticsScanProof_agency_creator_type_commit_idx" ON public."AnalyticsScanProof" USING btree ("agencyId", "creatorId", "dataType", "committedAt");

CREATE INDEX "AnalyticsScanProof_createdAt_id_idx" ON public."AnalyticsScanProof" USING btree ("createdAt", id);

CREATE UNIQUE INDEX "AnalyticsScanProof_creator_type_run_key" ON public."AnalyticsScanProof" USING btree ("creatorId", "dataType", "scanRunId");

CREATE INDEX "AnalyticsScanProof_creator_type_window_idx" ON public."AnalyticsScanProof" USING btree ("creatorId", "dataType", "scanFrom", "scanTo");

CREATE INDEX "AnalyticsScanProof_sourceJobId_idx" ON public."AnalyticsScanProof" USING btree ("sourceJobId");

CREATE INDEX "AuditLog_action_idx" ON public."AuditLog" USING btree (action);

CREATE INDEX "AuditLog_actorUserId_idx" ON public."AuditLog" USING btree ("actorUserId");

CREATE INDEX "AuditLog_agencyId_createdAt_idx" ON public."AuditLog" USING btree ("agencyId", "createdAt");

CREATE INDEX "AuditLog_agencyId_idx" ON public."AuditLog" USING btree ("agencyId");

CREATE INDEX "AuditLog_createdAt_idx" ON public."AuditLog" USING btree ("createdAt");

CREATE INDEX "AuditLog_targetType_targetId_idx" ON public."AuditLog" USING btree ("targetType", "targetId");

CREATE INDEX "AuthMailOutbox_due_idx" ON public."AuthMailOutbox" USING btree (status, "nextAttemptAt");

CREATE INDEX "AuthMailOutbox_user_idx" ON public."AuthMailOutbox" USING btree ("userId", kind, "createdAt");

CREATE INDEX "AuthToken_expiresAt_idx" ON public."AuthToken" USING btree ("expiresAt");

CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON public."AuthToken" USING btree ("tokenHash");

CREATE INDEX "AuthToken_type_idx" ON public."AuthToken" USING btree (type);

CREATE INDEX "AuthToken_userId_idx" ON public."AuthToken" USING btree ("userId");

CREATE INDEX "AuthToken_verification_code_idx" ON public."AuthToken" USING btree ("userId", type, "codeHash", "createdAt");

CREATE INDEX "AuthorizationSessionBoundary_agency_user_ended_idx" ON public."AuthorizationSessionBoundary" USING btree ("agencyId", "userId", "endedAt");

CREATE INDEX "AutomationBumpFanState_agencyId_idx" ON public."AutomationBumpFanState" USING btree ("agencyId");

CREATE INDEX "AutomationBumpFanState_creatorId_cooldownUntil_idx" ON public."AutomationBumpFanState" USING btree ("creatorId", "cooldownUntil");

CREATE UNIQUE INDEX "AutomationBumpFanState_creatorId_fanId_key" ON public."AutomationBumpFanState" USING btree ("creatorId", "fanId");

CREATE INDEX "AutomationBumpFanState_creatorId_lastOnlineAt_idx" ON public."AutomationBumpFanState" USING btree ("creatorId", "lastOnlineAt");

CREATE INDEX "AutomationBumpFanState_creatorId_pendingCancelAt_idx" ON public."AutomationBumpFanState" USING btree ("creatorId", "pendingCancelAt");

CREATE INDEX "AutomationBumpFanState_creatorId_updatedAt_idx" ON public."AutomationBumpFanState" USING btree ("creatorId", "updatedAt");

CREATE INDEX "AutomationBumpFanState_lastSentAt_idx" ON public."AutomationBumpFanState" USING btree ("lastSentAt");

CREATE INDEX "AutomationContentCandidate_agencyId_creatorId_state_idx" ON public."AutomationContentCandidate" USING btree ("agencyId", "creatorId", state);

CREATE UNIQUE INDEX "AutomationContentCandidate_creatorId_contentType_contentId_key" ON public."AutomationContentCandidate" USING btree ("creatorId", "contentType", "contentId");

CREATE INDEX "AutomationContentCandidate_creatorId_cooldownUntil_idx" ON public."AutomationContentCandidate" USING btree ("creatorId", "cooldownUntil");

CREATE INDEX "AutomationContentCandidate_creatorId_ownerFanId_idx" ON public."AutomationContentCandidate" USING btree ("creatorId", "ownerFanId");

CREATE INDEX "AutomationContentCandidate_creatorId_publishedAt_idx" ON public."AutomationContentCandidate" USING btree ("creatorId", "publishedAt");

CREATE INDEX "AutomationContentCandidate_current_cursor_idx" ON public."AutomationContentCandidate" USING btree ("creatorId", "contentType", "snapshotRunId", "contentId");

CREATE INDEX "AutomationContentCandidate_snapshotRunId_idx" ON public."AutomationContentCandidate" USING btree ("snapshotRunId");

CREATE INDEX "AutomationContentDiscoveryState_agencyId_creatorId_status_idx" ON public."AutomationContentDiscoveryState" USING btree ("agencyId", "creatorId", status);

CREATE INDEX "AutomationContentDiscoveryState_creatorId_lastScannedAt_idx" ON public."AutomationContentDiscoveryState" USING btree ("creatorId", "lastScannedAt");

CREATE INDEX "AutomationContentDiscoveryState_creatorId_lastSuccessAt_idx" ON public."AutomationContentDiscoveryState" USING btree ("creatorId", "lastSuccessAt");

CREATE UNIQUE INDEX "AutomationContentDiscoveryState_creatorId_ownerFanId_sourceKey_" ON public."AutomationContentDiscoveryState" USING btree ("creatorId", "ownerFanId", "sourceKey");

CREATE INDEX "AutomationContentDiscoveryState_creatorId_snapshotRunId_idx" ON public."AutomationContentDiscoveryState" USING btree ("creatorId", "snapshotRunId");

CREATE INDEX "AutomationControlState_agencyId_creatorId_idx" ON public."AutomationControlState" USING btree ("agencyId", "creatorId");

CREATE INDEX "AutomationControlState_agencyId_moduleKey_idx" ON public."AutomationControlState" USING btree ("agencyId", "moduleKey");

CREATE UNIQUE INDEX "AutomationControlState_agencyId_scopeKey_key" ON public."AutomationControlState" USING btree ("agencyId", "scopeKey");

CREATE UNIQUE INDEX "AutomationDelivery_active_target_unique" ON public."AutomationDelivery" USING btree ("creatorId", "moduleKey", "actionType", "targetId") WHERE (("targetId" IS NOT NULL) AND (status = ANY (ARRAY['QUEUED'::text, 'CLAIMED'::text, 'RUNNING'::text, 'RETRY_SCHEDULED'::text])));

CREATE INDEX "AutomationDelivery_agencyId_moduleKey_actionType_status_idx" ON public."AutomationDelivery" USING btree ("agencyId", "moduleKey", "actionType", status);

CREATE INDEX "AutomationDelivery_agencyId_originKind_status_idx" ON public."AutomationDelivery" USING btree ("agencyId", "originKind", status);

CREATE INDEX "AutomationDelivery_agencyId_status_idx" ON public."AutomationDelivery" USING btree ("agencyId", status);

CREATE INDEX "AutomationDelivery_agency_action_remote_state_idx" ON public."AutomationDelivery" USING btree ("agencyId", "actionType", "remoteLifecycleState");

CREATE INDEX "AutomationDelivery_cancelAt_idx" ON public."AutomationDelivery" USING btree ("cancelAt");

CREATE INDEX "AutomationDelivery_claimUntil_idx" ON public."AutomationDelivery" USING btree ("claimUntil");

CREATE INDEX "AutomationDelivery_claimedByDeviceId_status_idx" ON public."AutomationDelivery" USING btree ("claimedByDeviceId", status);

CREATE INDEX "AutomationDelivery_creatorId_fanId_idx" ON public."AutomationDelivery" USING btree ("creatorId", "fanId");

CREATE INDEX "AutomationDelivery_creatorId_messageId_idx" ON public."AutomationDelivery" USING btree ("creatorId", "messageId");

CREATE INDEX "AutomationDelivery_creatorId_status_notBefore_idx" ON public."AutomationDelivery" USING btree ("creatorId", status, "notBefore");

CREATE INDEX "AutomationDelivery_creatorId_targetId_idx" ON public."AutomationDelivery" USING btree ("creatorId", "targetId");

CREATE INDEX "AutomationDelivery_creator_action_remote_state_idx" ON public."AutomationDelivery" USING btree ("creatorId", "actionType", "remoteLifecycleState");

CREATE INDEX "AutomationDelivery_creator_action_remote_target_idx" ON public."AutomationDelivery" USING btree ("creatorId", "actionType", "remoteTargetId");

CREATE INDEX "AutomationDelivery_creator_status_cancelAt_idx" ON public."AutomationDelivery" USING btree ("creatorId", status, "cancelAt");

CREATE UNIQUE INDEX "AutomationDelivery_creator_write_lease_unique" ON public."AutomationDelivery" USING btree ("creatorId") WHERE (status = ANY (ARRAY['CLAIMED'::text, 'RUNNING'::text, 'COMMITTING'::text, 'RECONCILE_REQUIRED'::text]));

CREATE INDEX "AutomationDelivery_expired_lease_idx" ON public."AutomationDelivery" USING btree ("agencyId", "claimUntil", id) WHERE ((status = ANY (ARRAY['CLAIMED'::text, 'RUNNING'::text, 'COMMITTING'::text, 'RECONCILE_REQUIRED'::text])) AND ("claimUntil" IS NOT NULL));

CREATE INDEX "AutomationDelivery_failureCategory_idx" ON public."AutomationDelivery" USING btree ("failureCategory");

CREATE INDEX "AutomationDelivery_fair_claim_idx" ON public."AutomationDelivery" USING btree ("agencyId", "creatorId", "claimedAt" DESC) WHERE (("originKind" = 'AUTOMATION'::text) AND ("claimedAt" IS NOT NULL));

CREATE INDEX "AutomationDelivery_fair_finish_idx" ON public."AutomationDelivery" USING btree ("agencyId", "creatorId", "finishedAt" DESC) WHERE (("originKind" = 'AUTOMATION'::text) AND (status = 'COMPLETED'::text) AND ("finishedAt" IS NOT NULL));

CREATE INDEX "AutomationDelivery_finishedAt_idx" ON public."AutomationDelivery" USING btree ("finishedAt");

CREATE UNIQUE INDEX "AutomationDelivery_idempotencyKey_key" ON public."AutomationDelivery" USING btree ("idempotencyKey");

CREATE UNIQUE INDEX "AutomationDelivery_mass_unack_intent_unique" ON public."AutomationDelivery" USING btree ("creatorId") WHERE (("actionType" = 'MASS_QUEUE_CREATE'::text) AND ("intentAcknowledgedAt" IS NULL));

CREATE INDEX "AutomationDelivery_pending_creator_idx" ON public."AutomationDelivery" USING btree ("agencyId", "creatorId", priority DESC, "notBefore", "createdAt", id) WHERE (("originKind" = 'AUTOMATION'::text) AND (status = ANY (ARRAY['QUEUED'::text, 'RETRY_SCHEDULED'::text, 'RECONCILE_REQUIRED'::text])));

CREATE INDEX "AutomationDelivery_ruleId_idx" ON public."AutomationDelivery" USING btree ("ruleId");

CREATE INDEX "AutomationDelivery_sentAt_idx" ON public."AutomationDelivery" USING btree ("sentAt");

CREATE INDEX "AutomationDelivery_sourceDeviceId_status_idx" ON public."AutomationDelivery" USING btree ("sourceDeviceId", status);

CREATE INDEX "AutomationDelivery_stranded_idx" ON public."AutomationDelivery" USING btree ("agencyId", "writeCommitAt", id) WHERE ((status = 'RECONCILE_REQUIRED'::text) AND ("claimUntil" IS NULL));

CREATE INDEX "AutomationEvent_agencyId_createdAt_idx" ON public."AutomationEvent" USING btree ("agencyId", "createdAt");

CREATE INDEX "AutomationEvent_agencyId_type_createdAt_idx" ON public."AutomationEvent" USING btree ("agencyId", type, "createdAt");

CREATE INDEX "AutomationEvent_createdAt_idx" ON public."AutomationEvent" USING btree ("createdAt");

CREATE INDEX "AutomationEvent_creatorId_fanId_idx" ON public."AutomationEvent" USING btree ("creatorId", "fanId");

CREATE INDEX "AutomationEvent_jobId_idx" ON public."AutomationEvent" USING btree ("jobId");

CREATE INDEX "AutomationEvent_messageId_idx" ON public."AutomationEvent" USING btree ("messageId");

CREATE INDEX "AutomationEvent_taskId_idx" ON public."AutomationEvent" USING btree ("taskId");

CREATE INDEX "AutomationMonthlyAggregate_agencyId_periodStart_idx" ON public."AutomationMonthlyAggregate" USING btree ("agencyId", "periodStart");

CREATE UNIQUE INDEX "AutomationMonthlyAggregate_creatorId_moduleKey_actionType_perio" ON public."AutomationMonthlyAggregate" USING btree ("creatorId", "moduleKey", "actionType", "periodStart");

CREATE INDEX "AutomationMonthlyAggregate_creatorId_moduleKey_periodStart_idx" ON public."AutomationMonthlyAggregate" USING btree ("creatorId", "moduleKey", "periodStart");

CREATE INDEX "AutomationMonthlyAggregate_creatorId_periodStart_idx" ON public."AutomationMonthlyAggregate" USING btree ("creatorId", "periodStart");

CREATE UNIQUE INDEX "AutomationTask_agencyId_clientId_key" ON public."AutomationTask" USING btree ("agencyId", "clientId");

CREATE INDEX "AutomationTask_agencyId_type_status_idx" ON public."AutomationTask" USING btree ("agencyId", type, status);

CREATE INDEX "AutomationTask_creatorId_type_status_idx" ON public."AutomationTask" USING btree ("creatorId", type, status);

CREATE INDEX "AutomationTask_deletedAt_idx" ON public."AutomationTask" USING btree ("deletedAt");

CREATE INDEX "AutomationTask_enabled_idx" ON public."AutomationTask" USING btree (enabled);

CREATE INDEX "AutomationTask_status_deletedAt_idx" ON public."AutomationTask" USING btree (status, "deletedAt");

CREATE INDEX "AutomationTask_updatedAt_idx" ON public."AutomationTask" USING btree ("updatedAt");

CREATE INDEX "BillingOrder_agencyId_createdAt_idx" ON public."BillingOrder" USING btree ("agencyId", "createdAt");

CREATE UNIQUE INDEX "BillingOrder_agencyId_provider_testMode_checkoutKey_key" ON public."BillingOrder" USING btree ("agencyId", provider, "testMode", "checkoutKey");

CREATE INDEX "BillingOrder_agencyId_status_idx" ON public."BillingOrder" USING btree ("agencyId", status);

CREATE UNIQUE INDEX "BillingOrder_provider_testMode_providerInvoiceId_key" ON public."BillingOrder" USING btree (provider, "testMode", "providerInvoiceId");

CREATE INDEX "BillingOrder_requestHash_idx" ON public."BillingOrder" USING btree ("requestHash");

CREATE INDEX "BillingOrder_status_createdAt_idx" ON public."BillingOrder" USING btree (status, "createdAt");

CREATE INDEX "BillingOrderLine_agencyId_creatorId_createdAt_idx" ON public."BillingOrderLine" USING btree ("agencyId", "creatorId", "createdAt");

CREATE INDEX "BillingOrderLine_creatorId_createdAt_idx" ON public."BillingOrderLine" USING btree ("creatorId", "createdAt");

CREATE UNIQUE INDEX "BillingOrderLine_orderId_creatorId_key" ON public."BillingOrderLine" USING btree ("orderId", "creatorId");

CREATE INDEX "BillingPaymentAttempt_orderId_createdAt_idx" ON public."BillingPaymentAttempt" USING btree ("orderId", "createdAt");

CREATE INDEX "BillingPaymentAttempt_providerStatus_idx" ON public."BillingPaymentAttempt" USING btree ("providerStatus");

CREATE UNIQUE INDEX "BillingPaymentAttempt_provider_testMode_providerPaymentId_key" ON public."BillingPaymentAttempt" USING btree (provider, "testMode", "providerPaymentId");

CREATE UNIQUE INDEX "BillingProviderEvent_eventKey_key" ON public."BillingProviderEvent" USING btree ("eventKey");

CREATE INDEX "BillingProviderEvent_orderId_receivedAt_idx" ON public."BillingProviderEvent" USING btree ("orderId", "receivedAt");

CREATE INDEX "BillingProviderEvent_paymentAttemptId_receivedAt_idx" ON public."BillingProviderEvent" USING btree ("paymentAttemptId", "receivedAt");

CREATE INDEX "BillingProviderEvent_providerStatus_idx" ON public."BillingProviderEvent" USING btree ("providerStatus");

CREATE INDEX "BillingProviderEvent_receivedAt_idx" ON public."BillingProviderEvent" USING btree ("receivedAt");

CREATE INDEX "BillingWalletTransaction_agencyId_createdAt_idx" ON public."BillingWalletTransaction" USING btree ("agencyId", "createdAt");

CREATE INDEX "BillingWalletTransaction_agencyId_creatorId_createdAt_idx" ON public."BillingWalletTransaction" USING btree ("agencyId", "creatorId", "createdAt");

CREATE UNIQUE INDEX "BillingWalletTransaction_idempotencyKey_key" ON public."BillingWalletTransaction" USING btree ("idempotencyKey");

CREATE INDEX "BillingWalletTransaction_orderId_idx" ON public."BillingWalletTransaction" USING btree ("orderId");

CREATE INDEX "BillingWalletTransaction_periodId_idx" ON public."BillingWalletTransaction" USING btree ("periodId");

CREATE INDEX "BumpDeliveryStat_agencyId_day_idx" ON public."BumpDeliveryStat" USING btree ("agencyId", day);

CREATE INDEX "BumpDeliveryStat_creatorId_day_idx" ON public."BumpDeliveryStat" USING btree ("creatorId", day);

CREATE UNIQUE INDEX "BumpDeliveryStat_creatorId_templateId_day_key" ON public."BumpDeliveryStat" USING btree ("creatorId", "templateId", day);

CREATE INDEX "CampaignFanRefreshPromotionSignal_claim_due_idx" ON public."CampaignFanRefreshPromotionSignal" USING btree ("dueAt", "creatorId", COALESCE("claimUntil", '-infinity'::timestamp without time zone));

CREATE INDEX "CampaignFanRefreshPromotionSignal_due_claim_creator_idx" ON public."CampaignFanRefreshPromotionSignal" USING btree ("dueAt", "claimUntil", "creatorId");

CREATE INDEX "CampaignReadChange_creator_v1" ON public."CampaignReadChange" USING btree ("creatorId", id);

CREATE INDEX "CampaignReadMetric_paying_v1" ON public."CampaignReadMetric" USING btree ("creatorId", "campaignId", "rangeKey", "fanId") WHERE (paying = true);

CREATE INDEX "CampaignReadReceipt_due_v1" ON public."CampaignReadReceipt" USING btree ("creatorId", "nextDueAt", kind, "sourceId") WHERE ("nextDueAt" IS NOT NULL);

CREATE INDEX "CampaignReadRepairInterval_queue_v2" ON public."CampaignReadRepairInterval" USING btree ("creatorId", "fanId", id);

CREATE UNIQUE INDEX "ContentBlock_collectionId_clientId_key" ON public."ContentBlock" USING btree ("collectionId", "clientId");

CREATE INDEX "ContentBlock_collectionId_order_idx" ON public."ContentBlock" USING btree ("collectionId", "order");

CREATE INDEX "ContentBlock_status_purgeAfter_idx" ON public."ContentBlock" USING btree (status, "purgeAfter");

CREATE UNIQUE INDEX "ContentCollection_agencyId_clientId_key" ON public."ContentCollection" USING btree ("agencyId", "clientId");

CREATE INDEX "ContentCollection_agencyId_kind_status_idx" ON public."ContentCollection" USING btree ("agencyId", kind, status);

CREATE INDEX "ContentCollection_creatorId_kind_status_idx" ON public."ContentCollection" USING btree ("creatorId", kind, status);

CREATE INDEX "ContentCollection_deletedAt_idx" ON public."ContentCollection" USING btree ("deletedAt");

CREATE INDEX "ContentCollection_purgeAfter_idx" ON public."ContentCollection" USING btree ("purgeAfter");

CREATE INDEX "ContentCollection_updatedAt_idx" ON public."ContentCollection" USING btree ("updatedAt");

CREATE INDEX "ContentUsageEvent_agencyId_createdAt_idx" ON public."ContentUsageEvent" USING btree ("agencyId", "createdAt");

CREATE INDEX "ContentUsageEvent_collectionId_idx" ON public."ContentUsageEvent" USING btree ("collectionId");

CREATE INDEX "ContentUsageEvent_creatorId_fanId_idx" ON public."ContentUsageEvent" USING btree ("creatorId", "fanId");

CREATE UNIQUE INDEX "CreatorAccount_active_remote_identity_unique" ON public."CreatorAccount" USING btree ("agencyId", "remoteId") WHERE (("deletedAt" IS NULL) AND ("remoteId" IS NOT NULL));

CREATE UNIQUE INDEX "CreatorAccount_active_username_identity_unique" ON public."CreatorAccount" USING btree ("agencyId", lower(COALESCE("platformUsername", "enrollmentExpectedUsername", username))) WHERE (("deletedAt" IS NULL) AND (COALESCE("platformUsername", "enrollmentExpectedUsername", username) IS NOT NULL));

CREATE UNIQUE INDEX "CreatorAccount_agencyId_id_key" ON public."CreatorAccount" USING btree ("agencyId", id);

CREATE INDEX "CreatorAccount_agencyId_idx" ON public."CreatorAccount" USING btree ("agencyId");

CREATE INDEX "CreatorAccount_agencyId_telegramAccountId_idx" ON public."CreatorAccount" USING btree ("agencyId", "telegramAccountId");

CREATE INDEX "CreatorAccount_agencyId_telegramUserId_idx" ON public."CreatorAccount" USING btree ("agencyId", "telegramUserId");

CREATE INDEX "CreatorAccount_deletedAt_idx" ON public."CreatorAccount" USING btree ("deletedAt");

CREATE INDEX "CreatorAccount_live_catalog_idx" ON public."CreatorAccount" USING btree ("agencyId", id) WHERE ("deletedAt" IS NULL);

CREATE INDEX "CreatorAccount_status_deleted_id_idx" ON public."CreatorAccount" USING btree (status, "deletedAt", id);

CREATE INDEX "CreatorAccount_status_idx" ON public."CreatorAccount" USING btree (status);

CREATE INDEX "CreatorAccount_telegram_runtime_demand_idx" ON public."CreatorAccount" USING btree ("agencyId", id) WHERE (("deletedAt" IS NULL) AND ("telegramContact" IS NOT NULL) AND (btrim("telegramContact") <> ''::text));

CREATE INDEX "AnalyticsFactPublication_dirty_idx" ON public."CreatorAnalyticsFactPublication" USING btree ("creatorId", dirty, kind, "factId");

CREATE UNIQUE INDEX "CreatorAnalyticsPublicationState_agencyId_creatorId_key" ON public."CreatorAnalyticsPublicationState" USING btree ("agencyId", "creatorId");

CREATE INDEX "CreatorBillingEntitlement_agencyId_coreValidUntil_idx" ON public."CreatorBillingEntitlement" USING btree ("agencyId", "coreValidUntil");

CREATE INDEX "CreatorBillingEntitlement_aiChatterValidUntil_idx" ON public."CreatorBillingEntitlement" USING btree ("aiChatterValidUntil");

CREATE INDEX "CreatorBillingEntitlement_coreValidUntil_idx" ON public."CreatorBillingEntitlement" USING btree ("coreValidUntil");

CREATE UNIQUE INDEX "CreatorBillingEntitlement_creatorId_key" ON public."CreatorBillingEntitlement" USING btree ("creatorId");

CREATE INDEX "CreatorBillingEntitlement_outreachValidUntil_idx" ON public."CreatorBillingEntitlement" USING btree ("outreachValidUntil");

CREATE INDEX "CreatorBillingPeriod_agencyId_creatorId_startedAt_idx" ON public."CreatorBillingPeriod" USING btree ("agencyId", "creatorId", "startedAt");

CREATE INDEX "CreatorBillingPeriod_creatorId_endsAt_idx" ON public."CreatorBillingPeriod" USING btree ("creatorId", "endsAt");

CREATE UNIQUE INDEX "CreatorBillingPeriod_renewalKey_key" ON public."CreatorBillingPeriod" USING btree ("renewalKey");

CREATE INDEX "CreatorBillingPeriod_status_endsAt_idx" ON public."CreatorBillingPeriod" USING btree (status, "endsAt");

CREATE UNIQUE INDEX "CreatorBillingPeriod_walletTransactionId_key" ON public."CreatorBillingPeriod" USING btree ("walletTransactionId");

CREATE INDEX "CreatorBillingProfile_agencyId_idx" ON public."CreatorBillingProfile" USING btree ("agencyId");

CREATE UNIQUE INDEX "CreatorBillingProfile_creatorId_key" ON public."CreatorBillingProfile" USING btree ("creatorId");

CREATE INDEX "CreatorCampaign_agencyId_creatorId_isActive_idx" ON public."CreatorCampaign" USING btree ("agencyId", "creatorId", "isActive");

CREATE INDEX "CreatorCampaign_creatorId_collectedAt_idx" ON public."CreatorCampaign" USING btree ("creatorId", "collectedAt");

CREATE UNIQUE INDEX "CreatorCampaign_creatorId_externalCampaignId_key" ON public."CreatorCampaign" USING btree ("creatorId", "externalCampaignId");

CREATE UNIQUE INDEX "CreatorCampaign_creatorId_id_key" ON public."CreatorCampaign" USING btree ("creatorId", id);

CREATE INDEX "CreatorCampaign_creatorId_sourceScanRunId_idx" ON public."CreatorCampaign" USING btree ("creatorId", "sourceScanRunId");

CREATE INDEX "CreatorCampaign_creatorId_sourceScanStartedAt_idx" ON public."CreatorCampaign" USING btree ("creatorId", "sourceScanStartedAt");

CREATE INDEX "CreatorCampaign_frontier_due_idx" ON public."CreatorCampaign" USING btree ("creatorId", "claimersNextDueAt", "externalCampaignId");

CREATE INDEX "CreatorCampaign_frontier_target_idx" ON public."CreatorCampaign" USING btree ("creatorId", "claimersTargetRunId", "externalCampaignId");

CREATE INDEX "CreatorCampaign_run_segment_idx" ON public."CreatorCampaign" USING btree ("creatorId", "sourceScanRunId", "externalCampaignId");

CREATE INDEX "CreatorCampaign_sourceJobId_idx" ON public."CreatorCampaign" USING btree ("sourceJobId");

CREATE UNIQUE INDEX "CreatorCampaignCollectionState_agency_creator_key" ON public."CreatorCampaignCollectionState" USING btree ("agencyId", "creatorId");

CREATE INDEX "CreatorCampaignCollectionState_agency_status_idx" ON public."CreatorCampaignCollectionState" USING btree ("agencyId", status, "updatedAt");

CREATE UNIQUE INDEX "CreatorCampaignCollectionState_creatorId_key" ON public."CreatorCampaignCollectionState" USING btree ("creatorId");

CREATE INDEX "CreatorCampaignCollectionState_creator_baseline_idx" ON public."CreatorCampaignCollectionState" USING btree ("creatorId", "baselineVerifiedAt");

CREATE INDEX "CreatorCampaignCollectionState_creator_catchup_idx" ON public."CreatorCampaignCollectionState" USING btree ("creatorId", "lastCatchupCompletedAt");

CREATE INDEX "CreatorCampaignCollectionState_directory_due_idx" ON public."CreatorCampaignCollectionState" USING btree ("campaignDirectoryDiscoveryDueAt", "creatorId");

CREATE INDEX "CreatorCampaignFan_agencyId_creatorId_campaignId_idx" ON public."CreatorCampaignFan" USING btree ("agencyId", "creatorId", "campaignId");

CREATE UNIQUE INDEX "CreatorCampaignFan_campaignId_fanId_key" ON public."CreatorCampaignFan" USING btree ("campaignId", "fanId");

CREATE INDEX "CreatorCampaignFan_creatorId_campaignId_sourceScanRunId_idx" ON public."CreatorCampaignFan" USING btree ("creatorId", "campaignId", "sourceScanRunId");

CREATE INDEX "CreatorCampaignFan_creatorId_campaignId_sourceScanStartedAt_idx" ON public."CreatorCampaignFan" USING btree ("creatorId", "campaignId", "sourceScanStartedAt");

CREATE INDEX "CreatorCampaignFan_creatorId_fanId_idx" ON public."CreatorCampaignFan" USING btree ("creatorId", "fanId");

CREATE INDEX "CreatorCampaignFan_sourceJobId_idx" ON public."CreatorCampaignFan" USING btree ("sourceJobId");

CREATE INDEX "CreatorCampaignFan_subscriptionEventId_idx" ON public."CreatorCampaignFan" USING btree ("subscriptionEventId");

CREATE INDEX "CreatorCampaignFanRefreshWork_campaignJob_idx" ON public."CreatorCampaignFanRefreshWork" USING btree ("campaignJobId");

CREATE UNIQUE INDEX "CreatorCampaignFanRefreshWork_creator_run_fan_key" ON public."CreatorCampaignFanRefreshWork" USING btree ("creatorId", "scanRunId", "onlyFansUserId");

CREATE INDEX "CreatorCampaignFanRefreshWork_creator_run_id_idx" ON public."CreatorCampaignFanRefreshWork" USING btree ("creatorId", "scanRunId", id);

CREATE INDEX "CreatorCampaignFanRefreshWork_creator_run_idx" ON public."CreatorCampaignFanRefreshWork" USING btree ("creatorId", "scanRunId");

CREATE INDEX "CreatorCampaignFanRefreshWork_creator_run_status_idx" ON public."CreatorCampaignFanRefreshWork" USING btree ("creatorId", "scanRunId", status);

CREATE INDEX "CreatorCampaignFanRefreshWork_demand_status_idx" ON public."CreatorCampaignFanRefreshWork" USING btree ("demandId", status);

CREATE INDEX "CreatorCampaignFanRefreshWork_refreshJob_idx" ON public."CreatorCampaignFanRefreshWork" USING btree ("refreshJobId");

CREATE UNIQUE INDEX "CampaignFrontierFan_campaign_kind_user_uq" ON public."CreatorCampaignFrontierFan" USING btree ("campaignId", "frontierKind", "onlyFansUserId");

CREATE INDEX "CampaignFrontierFan_creator_campaign_kind_idx" ON public."CreatorCampaignFrontierFan" USING btree ("creatorId", "campaignId", "frontierKind");

CREATE INDEX "CreatorCampaignFrontierFan_creatorId_onlyFansUserId_idx" ON public."CreatorCampaignFrontierFan" USING btree ("creatorId", "onlyFansUserId");

CREATE UNIQUE INDEX "CreatorCryptoKeyState_agencyId_creatorId_key" ON public."CreatorCryptoKeyState" USING btree ("agencyId", "creatorId");

CREATE INDEX "CreatorCryptoKeyState_agencyId_rootVersion_idx" ON public."CreatorCryptoKeyState" USING btree ("agencyId", "rootVersion");

CREATE INDEX "CreatorCryptoKeyState_agencyId_updatedAt_idx" ON public."CreatorCryptoKeyState" USING btree ("agencyId", "updatedAt");

CREATE UNIQUE INDEX "CreatorCryptoKeyState_creatorId_key" ON public."CreatorCryptoKeyState" USING btree ("creatorId");

CREATE INDEX "CreatorDailyMetrics_agencyId_creatorId_date_idx" ON public."CreatorDailyMetrics" USING btree ("agencyId", "creatorId", date);

CREATE INDEX "CreatorDailyMetrics_creatorId_date_idx" ON public."CreatorDailyMetrics" USING btree ("creatorId", date);

CREATE UNIQUE INDEX "CreatorDailyMetrics_creatorId_date_sourceTimezone_key" ON public."CreatorDailyMetrics" USING btree ("creatorId", date, "sourceTimezone");

CREATE UNIQUE INDEX "CreatorDeviceKeyWrap_agencyId_creatorId_keyVersion_deviceId_key" ON public."CreatorDeviceKeyWrap" USING btree ("agencyId", "creatorId", "keyVersion", "deviceId");

CREATE INDEX "CreatorDeviceKeyWrap_agencyId_creatorId_keyVersion_idx" ON public."CreatorDeviceKeyWrap" USING btree ("agencyId", "creatorId", "keyVersion");

CREATE INDEX "CreatorDeviceKeyWrap_deviceId_revokedAt_idx" ON public."CreatorDeviceKeyWrap" USING btree ("deviceId", "revokedAt");

CREATE INDEX "CreatorEarningsDaily_agencyId_creatorId_date_idx" ON public."CreatorEarningsDaily" USING btree ("agencyId", "creatorId", date);

CREATE INDEX "CreatorEarningsDaily_creatorId_date_idx" ON public."CreatorEarningsDaily" USING btree ("creatorId", date);

CREATE UNIQUE INDEX "CreatorEarningsDaily_creatorId_date_sourceTimezone_key" ON public."CreatorEarningsDaily" USING btree ("creatorId", date, "sourceTimezone");

CREATE INDEX "CreatorEarningsDaily_creatorId_sourceScanRunId_idx" ON public."CreatorEarningsDaily" USING btree ("creatorId", "sourceScanRunId");

CREATE INDEX "CreatorEarningsDaily_scanProofId_idx" ON public."CreatorEarningsDaily" USING btree ("scanProofId");

CREATE INDEX "CreatorEarningsDaily_sourceJobId_idx" ON public."CreatorEarningsDaily" USING btree ("sourceJobId");

CREATE INDEX "CreatorEarningsTotal_agencyId_creatorId_category_idx" ON public."CreatorEarningsTotal" USING btree ("agencyId", "creatorId", category);

CREATE UNIQUE INDEX "CreatorEarningsTotal_creatorId_category_key" ON public."CreatorEarningsTotal" USING btree ("creatorId", category);

CREATE INDEX "CreatorEarningsTotal_creatorId_sourceJobId_idx" ON public."CreatorEarningsTotal" USING btree ("creatorId", "sourceJobId");

CREATE INDEX "CreatorEarningsTotal_sourceJobId_idx" ON public."CreatorEarningsTotal" USING btree ("sourceJobId");

CREATE INDEX "CreatorFan_agencyId_creatorId_idx" ON public."CreatorFan" USING btree ("agencyId", "creatorId");

CREATE UNIQUE INDEX "CreatorFan_creatorId_id_key" ON public."CreatorFan" USING btree ("creatorId", id);

CREATE INDEX "CreatorFan_creatorId_identityObservedAt_idx" ON public."CreatorFan" USING btree ("creatorId", "identityObservedAt");

CREATE INDEX "CreatorFan_creatorId_lastSeenAt_idx" ON public."CreatorFan" USING btree ("creatorId", "lastSeenAt");

CREATE UNIQUE INDEX "CreatorFan_creatorId_onlyFansUserId_key" ON public."CreatorFan" USING btree ("creatorId", "onlyFansUserId");

CREATE INDEX "CreatorFanRefreshDemand_active_job_idx" ON public."CreatorFanRefreshDemand" USING btree ("activeRefreshJobId");

CREATE INDEX "CreatorFanRefreshDemand_canonical_heal_idx" ON public."CreatorFanRefreshDemand" USING btree ("creatorId", "updatedAt", id) WHERE ((status)::text = ANY ((ARRAY['QUEUED'::character varying, 'FAILED'::character varying])::text[]));

CREATE UNIQUE INDEX "CreatorFanRefreshDemand_creator_fan_key" ON public."CreatorFanRefreshDemand" USING btree ("creatorId", "onlyFansUserId");

CREATE INDEX "CreatorFanRefreshDemand_creator_status_idx" ON public."CreatorFanRefreshDemand" USING btree ("creatorId", status, "updatedAt");

CREATE INDEX "CreatorFanRefreshDemand_promoter_ready_idx" ON public."CreatorFanRefreshDemand" USING btree ("creatorId", "lastRequestedAt", id) WHERE (((status)::text = 'QUEUED'::text) AND ("activeRefreshJobId" IS NULL));

CREATE INDEX "CreatorFanRefreshDemand_quarantine_idx" ON public."CreatorFanRefreshDemand" USING btree ("creatorId", "quarantinedAt");

CREATE INDEX "CreatorFanRefreshDemand_recovery_order_idx" ON public."CreatorFanRefreshDemand" USING btree ("creatorId", COALESCE("nextRetryAt", "lastFailedAt", "updatedAt"), id) WHERE (((status)::text = 'FAILED'::text) AND ("activeRefreshJobId" IS NULL));

CREATE INDEX "CreatorFanRefreshDemand_retry_due_idx" ON public."CreatorFanRefreshDemand" USING btree (status, "nextRetryAt", "creatorId");

CREATE INDEX "CreatorFanRelationshipCurrent_agencyId_creatorId_observedAt_idx" ON public."CreatorFanRelationshipCurrent" USING btree ("agencyId", "creatorId", "observedAt");

CREATE UNIQUE INDEX "CreatorFanRelationshipCurrent_creatorId_fanRecordId_key" ON public."CreatorFanRelationshipCurrent" USING btree ("creatorId", "fanRecordId");

CREATE UNIQUE INDEX "CreatorFanRelationshipCurrent_creatorId_onlyFansUserId_key" ON public."CreatorFanRelationshipCurrent" USING btree ("creatorId", "onlyFansUserId");

CREATE INDEX "CreatorFanRelationshipCurrent_sourceDeliveryId_idx" ON public."CreatorFanRelationshipCurrent" USING btree ("sourceDeliveryId");

CREATE INDEX "CreatorFanRelationshipCurrent_sourceDeviceId_idx" ON public."CreatorFanRelationshipCurrent" USING btree ("sourceDeviceId");

CREATE INDEX "CreatorFanRelationshipCurrent_sourceJobId_idx" ON public."CreatorFanRelationshipCurrent" USING btree ("sourceJobId");

CREATE INDEX "CreatorFanValueCurrent_agencyId_creatorId_fetchedAt_idx" ON public."CreatorFanValueCurrent" USING btree ("agencyId", "creatorId", "fetchedAt");

CREATE UNIQUE INDEX "CreatorFanValueCurrent_creatorId_fanId_key" ON public."CreatorFanValueCurrent" USING btree ("creatorId", "fanId");

CREATE INDEX "CreatorFanValueCurrent_creatorId_totalNetCents_idx" ON public."CreatorFanValueCurrent" USING btree ("creatorId", "totalNetCents");

CREATE INDEX "CreatorFanValueCurrent_sourceDeliveryId_idx" ON public."CreatorFanValueCurrent" USING btree ("sourceDeliveryId");

CREATE INDEX "CreatorFanValueCurrent_sourceDeviceId_idx" ON public."CreatorFanValueCurrent" USING btree ("sourceDeviceId");

CREATE INDEX "CreatorFanValueCurrent_sourceJobId_idx" ON public."CreatorFanValueCurrent" USING btree ("sourceJobId");

CREATE UNIQUE INDEX "CreatorFinancialCollectionState_agency_creator_key" ON public."CreatorFinancialCollectionState" USING btree ("agencyId", "creatorId");

CREATE INDEX "CreatorFinancialCollectionState_agency_status_idx" ON public."CreatorFinancialCollectionState" USING btree ("agencyId", status, "updatedAt");

CREATE UNIQUE INDEX "CreatorFinancialCollectionState_creatorId_key" ON public."CreatorFinancialCollectionState" USING btree ("creatorId");

CREATE INDEX "CreatorFinancialCollectionState_creator_baseline_idx" ON public."CreatorFinancialCollectionState" USING btree ("creatorId", "baselineVerifiedAt");

CREATE INDEX "CreatorFinancialCollectionState_creator_catchup_idx" ON public."CreatorFinancialCollectionState" USING btree ("creatorId", "lastCatchupCompletedAt");

CREATE INDEX "CreatorFinancialTransaction_agencyId_creatorId_occurredAt_idx" ON public."CreatorFinancialTransaction" USING btree ("agencyId", "creatorId", "occurredAt");

CREATE UNIQUE INDEX "CreatorFinancialTransaction_creatorId_externalTransactionId_key" ON public."CreatorFinancialTransaction" USING btree ("creatorId", "externalTransactionId");

CREATE INDEX "CreatorFinancialTransaction_creatorId_fanId_occurredAt_idx" ON public."CreatorFinancialTransaction" USING btree ("creatorId", "fanId", "occurredAt");

CREATE INDEX "CreatorFinancialTransaction_creatorId_scanRunId_page_idx" ON public."CreatorFinancialTransaction" USING btree ("creatorId", "scanRunId", page);

CREATE INDEX "CreatorFinancialTransaction_creatorId_sourceJobId_page_idx" ON public."CreatorFinancialTransaction" USING btree ("creatorId", "sourceJobId", page);

CREATE INDEX "CreatorFinancialTransaction_creatorId_transactionType_occurredA" ON public."CreatorFinancialTransaction" USING btree ("creatorId", "transactionType", "occurredAt");

CREATE INDEX "CreatorFinancialTransaction_sourceJobId_idx" ON public."CreatorFinancialTransaction" USING btree ("sourceJobId");

CREATE INDEX "CreatorLocalMessageCoverage_agencyId_creatorId_coverageStatus_i" ON public."CreatorLocalMessageCoverage" USING btree ("agencyId", "creatorId", "coverageStatus");

CREATE UNIQUE INDEX "CreatorLocalMessageCoverage_creatorId_deviceId_key" ON public."CreatorLocalMessageCoverage" USING btree ("creatorId", "deviceId");

CREATE INDEX "CreatorLocalMessageCoverage_deviceId_lastVerifiedAt_idx" ON public."CreatorLocalMessageCoverage" USING btree ("deviceId", "lastVerifiedAt");

CREATE INDEX "CreatorMediaAsset_agencyId_creatorId_catalogActive_sortingStatu" ON public."CreatorMediaAsset" USING btree ("agencyId", "creatorId", "catalogActive", "sortingStatus", "lastSeenAt");

CREATE INDEX "CreatorMediaAsset_creatorId_catalogActive_revenueCents_idx" ON public."CreatorMediaAsset" USING btree ("creatorId", "catalogActive", "revenueCents");

CREATE INDEX "CreatorMediaAsset_creatorId_catalogActive_sentCount_lastSeenAt_" ON public."CreatorMediaAsset" USING btree ("creatorId", "catalogActive", "sentCount", "lastSeenAt");

CREATE UNIQUE INDEX "CreatorMediaAsset_creatorId_mediaId_key" ON public."CreatorMediaAsset" USING btree ("creatorId", "mediaId");

CREATE INDEX "CreatorMediaAsset_customOrderId_idx" ON public."CreatorMediaAsset" USING btree ("customOrderId");

CREATE INDEX "CreatorMediaAsset_customSubmissionId_idx" ON public."CreatorMediaAsset" USING btree ("customSubmissionId");

CREATE INDEX "CreatorMediaAsset_lastSeenJobId_idx" ON public."CreatorMediaAsset" USING btree ("lastSeenJobId");

CREATE INDEX "CreatorMediaUsageContribution_assetId_idx" ON public."CreatorMediaUsageContribution" USING btree ("assetId");

CREATE INDEX "CreatorMediaUsageContribution_creatorId_mediaId_idx" ON public."CreatorMediaUsageContribution" USING btree ("creatorId", "mediaId");

CREATE INDEX "CreatorMediaUsageContribution_creatorId_sourceKey_idx" ON public."CreatorMediaUsageContribution" USING btree ("creatorId", "sourceKey");

CREATE UNIQUE INDEX "CreatorMediaUsageContribution_creatorId_sourceKey_mediaId_key" ON public."CreatorMediaUsageContribution" USING btree ("creatorId", "sourceKey", "mediaId");

CREATE INDEX "CreatorMediaUsageSourceState_agencyId_creatorId_updatedAt_idx" ON public."CreatorMediaUsageSourceState" USING btree ("agencyId", "creatorId", "updatedAt");

CREATE UNIQUE INDEX "CreatorMediaUsageSourceState_creatorId_sourceKey_key" ON public."CreatorMediaUsageSourceState" USING btree ("creatorId", "sourceKey");

CREATE INDEX "CreatorMessagesDaily_agencyId_creatorId_date_idx" ON public."CreatorMessagesDaily" USING btree ("agencyId", "creatorId", date);

CREATE INDEX "CreatorMessagesDaily_creatorId_date_idx" ON public."CreatorMessagesDaily" USING btree ("creatorId", date);

CREATE UNIQUE INDEX "CreatorMessagesDaily_creatorId_date_sourceTimezone_key" ON public."CreatorMessagesDaily" USING btree ("creatorId", date, "sourceTimezone");

CREATE INDEX "CreatorMessagesDaily_sourceJobId_idx" ON public."CreatorMessagesDaily" USING btree ("sourceJobId");

CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_creatorId_key" ON public."CreatorNetworkProfile" USING btree ("agencyId", "creatorId");

CREATE INDEX "CreatorNetworkProfile_agencyId_idx" ON public."CreatorNetworkProfile" USING btree ("agencyId");

CREATE INDEX "CreatorNetworkProfile_agencyId_mode_idx" ON public."CreatorNetworkProfile" USING btree ("agencyId", mode);

CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_proxyEndpointId_key" ON public."CreatorNetworkProfile" USING btree ("agencyId", "proxyEndpointId");

CREATE INDEX "CreatorNotificationScanItem_job_outcome_page_idx" ON public."CreatorNotificationScanItem" USING btree ("creatorId", "sourceJobId", outcome, page);

CREATE INDEX "CreatorNotificationScanItem_reason_idx" ON public."CreatorNotificationScanItem" USING btree ("creatorId", "reasonCode");

CREATE INDEX "CreatorNotificationScanItem_retention_idx" ON public."CreatorNotificationScanItem" USING btree ("createdAt", id);

CREATE INDEX "CreatorNotificationScanItem_run_page_idx" ON public."CreatorNotificationScanItem" USING btree ("creatorId", "scanRunId", page);

CREATE UNIQUE INDEX "CreatorNotificationScanItem_run_page_ordinal_key" ON public."CreatorNotificationScanItem" USING btree ("creatorId", "scanRunId", page, ordinal);

CREATE INDEX "CreatorNotificationScanItem_sourceJobId_idx" ON public."CreatorNotificationScanItem" USING btree ("sourceJobId");

CREATE INDEX "CreatorNotificationSyncState_agencyId_status_updatedAt_idx" ON public."CreatorNotificationSyncState" USING btree ("agencyId", status, "updatedAt");

CREATE UNIQUE INDEX "CreatorNotificationSyncState_agency_creator_key" ON public."CreatorNotificationSyncState" USING btree ("agencyId", "creatorId");

CREATE UNIQUE INDEX "CreatorNotificationSyncState_creatorId_key" ON public."CreatorNotificationSyncState" USING btree ("creatorId");

CREATE INDEX "CreatorNotificationSyncState_creator_full_idx" ON public."CreatorNotificationSyncState" USING btree ("creatorId", "fullBackfillCompletedAt");

CREATE INDEX "CreatorNotificationSyncState_sourceJobId_idx" ON public."CreatorNotificationSyncState" USING btree ("sourceJobId");

CREATE INDEX "CreatorPaidSubscription_agencyId_creatorId_paidAt_idx" ON public."CreatorPaidSubscription" USING btree ("agencyId", "creatorId", "paidAt");

CREATE UNIQUE INDEX "CreatorPaidSubscription_creatorId_eventFingerprint_key" ON public."CreatorPaidSubscription" USING btree ("creatorId", "eventFingerprint");

CREATE UNIQUE INDEX "CreatorPaidSubscription_creatorId_externalTransactionId_key" ON public."CreatorPaidSubscription" USING btree ("creatorId", "externalTransactionId");

CREATE INDEX "CreatorPaidSubscription_creatorId_fanId_paidAt_idx" ON public."CreatorPaidSubscription" USING btree ("creatorId", "fanId", "paidAt");

CREATE INDEX "CreatorPaidSubscription_sourceJobId_idx" ON public."CreatorPaidSubscription" USING btree ("sourceJobId");

CREATE UNIQUE INDEX "CreatorPaidSubscription_subscriptionEventId_key" ON public."CreatorPaidSubscription" USING btree ("subscriptionEventId");

CREATE INDEX "CreatorPostComment_agencyId_creatorId_commentedAt_idx" ON public."CreatorPostComment" USING btree ("agencyId", "creatorId", "commentedAt");

CREATE UNIQUE INDEX "CreatorPostComment_creatorId_eventFingerprint_key" ON public."CreatorPostComment" USING btree ("creatorId", "eventFingerprint");

CREATE UNIQUE INDEX "CreatorPostComment_creatorId_externalNotificationId_key" ON public."CreatorPostComment" USING btree ("creatorId", "externalNotificationId");

CREATE INDEX "CreatorPostComment_creatorId_fanId_commentedAt_idx" ON public."CreatorPostComment" USING btree ("creatorId", "fanId", "commentedAt");

CREATE UNIQUE INDEX "CreatorPostComment_creatorId_onlyFansCommentId_key" ON public."CreatorPostComment" USING btree ("creatorId", "onlyFansCommentId");

CREATE INDEX "CreatorPostComment_creatorId_onlyFansPostId_commentedAt_idx" ON public."CreatorPostComment" USING btree ("creatorId", "onlyFansPostId", "commentedAt");

CREATE INDEX "CreatorPostComment_sourceJobId_idx" ON public."CreatorPostComment" USING btree ("sourceJobId");

CREATE INDEX "CreatorPostLike_agencyId_creatorId_likedAt_idx" ON public."CreatorPostLike" USING btree ("agencyId", "creatorId", "likedAt");

CREATE UNIQUE INDEX "CreatorPostLike_creatorId_eventFingerprint_key" ON public."CreatorPostLike" USING btree ("creatorId", "eventFingerprint");

CREATE UNIQUE INDEX "CreatorPostLike_creatorId_externalNotificationId_key" ON public."CreatorPostLike" USING btree ("creatorId", "externalNotificationId");

CREATE INDEX "CreatorPostLike_creatorId_fanId_likedAt_idx" ON public."CreatorPostLike" USING btree ("creatorId", "fanId", "likedAt");

CREATE UNIQUE INDEX "CreatorPostLike_creatorId_onlyFansLikeId_key" ON public."CreatorPostLike" USING btree ("creatorId", "onlyFansLikeId");

CREATE INDEX "CreatorPostLike_creatorId_onlyFansPostId_likedAt_idx" ON public."CreatorPostLike" USING btree ("creatorId", "onlyFansPostId", "likedAt");

CREATE INDEX "CreatorPostLike_sourceJobId_idx" ON public."CreatorPostLike" USING btree ("sourceJobId");

CREATE INDEX "CreatorSale_agencyId_creatorId_purchasedAt_idx" ON public."CreatorSale" USING btree ("agencyId", "creatorId", "purchasedAt");

CREATE INDEX "CreatorSale_consequence_job_cursor_idx" ON public."CreatorSale" USING btree ("agencyId", "creatorId", "sourceJobId", id);

CREATE UNIQUE INDEX "CreatorSale_creatorId_eventFingerprint_key" ON public."CreatorSale" USING btree ("creatorId", "eventFingerprint");

CREATE UNIQUE INDEX "CreatorSale_creatorId_externalNotificationId_key" ON public."CreatorSale" USING btree ("creatorId", "externalNotificationId");

CREATE UNIQUE INDEX "CreatorSale_creatorId_externalTransactionId_key" ON public."CreatorSale" USING btree ("creatorId", "externalTransactionId");

CREATE INDEX "CreatorSale_creatorId_fanId_purchasedAt_idx" ON public."CreatorSale" USING btree ("creatorId", "fanId", "purchasedAt");

CREATE INDEX "CreatorSale_creatorId_messageId_idx" ON public."CreatorSale" USING btree ("creatorId", "messageId");

CREATE INDEX "CreatorSale_creatorId_postId_idx" ON public."CreatorSale" USING btree ("creatorId", "postId");

CREATE INDEX "CreatorSale_history_repair_cursor_idx" ON public."CreatorSale" USING btree ("agencyId", "creatorId", "createdAt", id);

CREATE INDEX "CreatorSale_sourceJobId_idx" ON public."CreatorSale" USING btree ("sourceJobId");

CREATE INDEX "CreatorSessionState_agencyId_idx" ON public."CreatorSessionState" USING btree ("agencyId");

CREATE INDEX "CreatorSessionState_capturedByDeviceId_idx" ON public."CreatorSessionState" USING btree ("capturedByDeviceId");

CREATE INDEX "CreatorSessionState_capturedByUserId_idx" ON public."CreatorSessionState" USING btree ("capturedByUserId");

CREATE UNIQUE INDEX "CreatorSessionState_creatorId_key" ON public."CreatorSessionState" USING btree ("creatorId");

CREATE INDEX "CreatorSessionState_encryptionMode_idx" ON public."CreatorSessionState" USING btree ("encryptionMode");

CREATE INDEX "CreatorSessionState_status_idx" ON public."CreatorSessionState" USING btree (status);

CREATE INDEX "CreatorSessionState_updatedAt_idx" ON public."CreatorSessionState" USING btree ("updatedAt");

CREATE INDEX "CreatorSubscriptionEvent_agency_creator_occurred_idx" ON public."CreatorSubscriptionEvent" USING btree ("agencyId", "creatorId", "occurredAt");

CREATE INDEX "CreatorSubscriptionEvent_consequence_job_cursor_idx" ON public."CreatorSubscriptionEvent" USING btree ("agencyId", "creatorId", "sourceJobId", id);

CREATE UNIQUE INDEX "CreatorSubscriptionEvent_creatorId_eventFingerprint_key" ON public."CreatorSubscriptionEvent" USING btree ("creatorId", "eventFingerprint");

CREATE UNIQUE INDEX "CreatorSubscriptionEvent_creatorId_externalNotificationId_key" ON public."CreatorSubscriptionEvent" USING btree ("creatorId", "externalNotificationId");

CREATE INDEX "CreatorSubscriptionEvent_creatorId_externalTransactionId_idx" ON public."CreatorSubscriptionEvent" USING btree ("creatorId", "externalTransactionId");

CREATE UNIQUE INDEX "CreatorSubscriptionEvent_creatorId_id_key" ON public."CreatorSubscriptionEvent" USING btree ("creatorId", id);

CREATE INDEX "CreatorSubscriptionEvent_creator_fan_occurred_idx" ON public."CreatorSubscriptionEvent" USING btree ("creatorId", "fanId", "occurredAt");

CREATE INDEX "CreatorSubscriptionEvent_creator_type_occurred_idx" ON public."CreatorSubscriptionEvent" USING btree ("creatorId", "eventType", "occurredAt");

CREATE INDEX "CreatorSubscriptionEvent_history_repair_cursor_idx" ON public."CreatorSubscriptionEvent" USING btree ("agencyId", "creatorId", "createdAt", id);

CREATE INDEX "CreatorSubscriptionEvent_sourceJobId_idx" ON public."CreatorSubscriptionEvent" USING btree ("sourceJobId");

CREATE INDEX "CreatorSubscriptionLedger_agencyId_creatorId_fanId_occurredAt_i" ON public."CreatorSubscriptionLedger" USING btree ("agencyId", "creatorId", "fanId", "occurredAt");

CREATE INDEX "CreatorSubscriptionLedger_agencyId_creatorId_organicConfirmed_a" ON public."CreatorSubscriptionLedger" USING btree ("agencyId", "creatorId", "organicConfirmed", "attributionAttempts");

CREATE INDEX "CreatorSubscriptionLedger_agencyId_creatorId_sourceId_occurredA" ON public."CreatorSubscriptionLedger" USING btree ("agencyId", "creatorId", "sourceId", "occurredAt");

CREATE UNIQUE INDEX "CreatorSubscriptionLedger_agencyId_eventHash_key" ON public."CreatorSubscriptionLedger" USING btree ("agencyId", "eventHash");

CREATE INDEX "CreatorSubscriptionLedger_retention_idx" ON public."CreatorSubscriptionLedger" USING btree ("sourceId", "organicConfirmed", "amountCents", "occurredAt");

CREATE INDEX "CreatorSubscriptionState_agencyId_creatorId_status_idx" ON public."CreatorSubscriptionState" USING btree ("agencyId", "creatorId", status);

CREATE UNIQUE INDEX "CreatorSubscriptionState_creatorId_fanId_key" ON public."CreatorSubscriptionState" USING btree ("creatorId", "fanId");

CREATE INDEX "CreatorSubscriptionState_creatorId_lastEventAt_idx" ON public."CreatorSubscriptionState" USING btree ("creatorId", "lastEventAt");

CREATE UNIQUE INDEX "CreatorSubscriptionState_updatedFromEventId_key" ON public."CreatorSubscriptionState" USING btree ("updatedFromEventId");

CREATE INDEX "CreatorTaskActivity_agencyId_creatorId_updatedAt_idx" ON public."CreatorTaskActivity" USING btree ("agencyId", "creatorId", "updatedAt");

CREATE INDEX "CreatorTaskActivity_creatorId_updatedAt_idx" ON public."CreatorTaskActivity" USING btree ("creatorId", "updatedAt");

CREATE UNIQUE INDEX "CreatorTaskActivity_jobId_key" ON public."CreatorTaskActivity" USING btree ("jobId");

CREATE INDEX "CreatorTaskActivity_status_updatedAt_idx" ON public."CreatorTaskActivity" USING btree (status, "updatedAt");

CREATE INDEX "CreatorTip_agencyId_creatorId_tippedAt_idx" ON public."CreatorTip" USING btree ("agencyId", "creatorId", "tippedAt");

CREATE INDEX "CreatorTip_consequence_job_cursor_idx" ON public."CreatorTip" USING btree ("agencyId", "creatorId", "sourceJobId", id);

CREATE UNIQUE INDEX "CreatorTip_creatorId_eventFingerprint_key" ON public."CreatorTip" USING btree ("creatorId", "eventFingerprint");

CREATE UNIQUE INDEX "CreatorTip_creatorId_externalNotificationId_key" ON public."CreatorTip" USING btree ("creatorId", "externalNotificationId");

CREATE UNIQUE INDEX "CreatorTip_creatorId_externalTransactionId_key" ON public."CreatorTip" USING btree ("creatorId", "externalTransactionId");

CREATE INDEX "CreatorTip_creatorId_fanId_tippedAt_idx" ON public."CreatorTip" USING btree ("creatorId", "fanId", "tippedAt");

CREATE INDEX "CreatorTip_history_repair_cursor_idx" ON public."CreatorTip" USING btree ("agencyId", "creatorId", "createdAt", id);

CREATE INDEX "CreatorTip_sourceJobId_idx" ON public."CreatorTip" USING btree ("sourceJobId");

CREATE INDEX "CustomContentReviewDecision_agency_actor_decided_idx" ON public."CustomContentReviewDecision" USING btree ("agencyId", "actorMemberId", "decidedAt");

CREATE INDEX "CustomContentReviewDecision_agency_order_decided_idx" ON public."CustomContentReviewDecision" USING btree ("agencyId", "customOrderId", "decidedAt");

CREATE UNIQUE INDEX "CustomContentReviewDecision_submission_revision_key" ON public."CustomContentReviewDecision" USING btree ("submissionId", "decisionRevision");

CREATE INDEX "CCS_overdue_bounded_scan_idx" ON public."CustomContentSubmission" USING btree ("agencyId", "reviewStatus", "reviewedAt", id) WHERE ("customOrderId" IS NOT NULL);

CREATE INDEX "CCS_pipeline_fairness_idx" ON public."CustomContentSubmission" USING btree ("agencyId", "pipelineDisposition", "pipelineLastAttemptAt" NULLS FIRST, "receivedAt", "createdAt", id);

CREATE INDEX "CCS_review_bounded_scan_idx" ON public."CustomContentSubmission" USING btree ("agencyId", "pipelineDisposition", "reviewStatus", "receivedAt", "createdAt", id);

CREATE INDEX "CCS_source_pipeline_fairness_idx" ON public."CustomContentSubmission" USING btree ("agencyId", "telegramSourceAccountId", "pipelineDisposition", "pipelineLastAttemptAt" NULLS FIRST, "receivedAt", "createdAt", id);

CREATE INDEX "CustomContentSubmission_agencyId_creatorId_receivedAt_idx" ON public."CustomContentSubmission" USING btree ("agencyId", "creatorId", "receivedAt");

CREATE INDEX "CustomContentSubmission_agencyId_reviewStatus_receivedAt_idx" ON public."CustomContentSubmission" USING btree ("agencyId", "reviewStatus", "receivedAt");

CREATE INDEX "CustomContentSubmission_agencyId_telegramSourceAccountId_telegr" ON public."CustomContentSubmission" USING btree ("agencyId", "telegramSourceAccountId", "telegramSourceUserId");

CREATE INDEX "CustomContentSubmission_agency_pipelineDisposition_nextAttempt_" ON public."CustomContentSubmission" USING btree ("agencyId", "pipelineDisposition", "pipelineNextAttemptAt", "receivedAt");

CREATE INDEX "CustomContentSubmission_agency_pipelineDisposition_receivedAt_i" ON public."CustomContentSubmission" USING btree ("agencyId", "pipelineDisposition", "receivedAt");

CREATE INDEX "CustomContentSubmission_agency_sourceAccount_pipelineDispositio" ON public."CustomContentSubmission" USING btree ("agencyId", "telegramSourceAccountId", "pipelineDisposition", "receivedAt");

CREATE INDEX "CustomContentSubmission_customOrderId_receivedAt_idx" ON public."CustomContentSubmission" USING btree ("customOrderId", "receivedAt");

CREATE UNIQUE INDEX "CustomContentSubmission_one_approved_per_order_key" ON public."CustomContentSubmission" USING btree ("customOrderId") WHERE (("reviewStatus" = 'APPROVED'::"CustomContentReviewStatus") AND ("customOrderId" IS NOT NULL));

CREATE UNIQUE INDEX "CustomContentSubmission_one_waiting_per_order_key" ON public."CustomContentSubmission" USING btree ("customOrderId") WHERE (("customOrderId" IS NOT NULL) AND ("reviewStatus" = 'WAITING_REVIEW'::"CustomContentReviewStatus"));

CREATE INDEX "CustomContentSubmission_reviewedByMemberId_idx" ON public."CustomContentSubmission" USING btree ("reviewedByMemberId");

CREATE INDEX "CustomContentSubmission_source_history_keyset_idx" ON public."CustomContentSubmission" USING btree ("agencyId", "pipelineDisposition", id) WHERE ("pipelineDisposition" = ANY (ARRAY['ACTIVE'::text, 'SALVAGE'::text]));

CREATE UNIQUE INDEX "CustomContentSubmission_telegramSourceKey_key" ON public."CustomContentSubmission" USING btree ("telegramSourceKey");

CREATE INDEX "CustomDeliveryReceipt_agencyId_creatorId_occurredAt_idx" ON public."CustomDeliveryReceipt" USING btree ("agencyId", "creatorId", "occurredAt");

CREATE INDEX "CustomDeliveryReceipt_agencyId_occurredAt_idx" ON public."CustomDeliveryReceipt" USING btree ("agencyId", "occurredAt");

CREATE INDEX "CustomDeliveryReceipt_customOrderId_occurredAt_idx" ON public."CustomDeliveryReceipt" USING btree ("customOrderId", "occurredAt");

CREATE UNIQUE INDEX "CustomDeliveryReceipt_provider_message_key" ON public."CustomDeliveryReceipt" USING btree ("agencyId", "creatorId", "messageId");

CREATE INDEX "CustomDeliveryReceipt_submissionId_occurredAt_idx" ON public."CustomDeliveryReceipt" USING btree ("submissionId", "occurredAt");

CREATE UNIQUE INDEX "CustomDeliveryReceipt_write_revision_key" ON public."CustomDeliveryReceipt" USING btree ("writeId", "writeCommitRevision");

CREATE INDEX "CustomOrder_agencyId_creatorId_dialogId_createdAt_idx" ON public."CustomOrder" USING btree ("agencyId", "creatorId", "dialogId", "createdAt");

CREATE INDEX "CustomOrder_agencyId_creatorId_status_dueAt_idx" ON public."CustomOrder" USING btree ("agencyId", "creatorId", status, "dueAt");

CREATE INDEX "CustomOrder_agencyId_creatorId_status_scheduledAt_idx" ON public."CustomOrder" USING btree ("agencyId", "creatorId", status, "scheduledAt");

CREATE INDEX "CustomOrder_agencyId_creatorId_telegramTaskMessageId_idx" ON public."CustomOrder" USING btree ("agencyId", "creatorId", "telegramTaskMessageId");

CREATE INDEX "CustomOrder_agencyId_status_dueAt_idx" ON public."CustomOrder" USING btree ("agencyId", status, "dueAt");

CREATE INDEX "CustomOrder_agencyId_status_nextReminderAt_idx" ON public."CustomOrder" USING btree ("agencyId", status, "nextReminderAt");

CREATE INDEX "CustomOrder_agencyId_status_scheduledAt_idx" ON public."CustomOrder" USING btree ("agencyId", status, "scheduledAt");

CREATE INDEX "CustomOrder_agencyId_type_status_physicalStatusChangedAt_idx" ON public."CustomOrder" USING btree ("agencyId", type, status, "physicalStatusChangedAt");

CREATE UNIQUE INDEX "CustomOrder_agency_clientMutationId_key" ON public."CustomOrder" USING btree ("agencyId", "clientMutationId");

CREATE INDEX "CustomOrder_call_pending_end_rank_idx" ON public."CustomOrder" USING btree ("agencyId", (("scheduledAt" + ((GREATEST(1, LEAST(1440, COALESCE("durationMinutes", 1))))::double precision * '00:01:00'::interval))), id) WHERE ((type = 'CALL'::"CustomOrderType") AND (status = 'PENDING'::"CustomOrderStatus") AND ("scheduledAt" IS NOT NULL));

CREATE INDEX "CustomOrder_creatorId_dialogId_status_idx" ON public."CustomOrder" USING btree ("creatorId", "dialogId", status);

CREATE INDEX "CustomOrder_provider_operational_work_idx" ON public."CustomOrder" USING btree ("agencyId", "providerOperationalDirty", status, id);

CREATE INDEX "CustomOrder_reminder_bounded_scan_idx" ON public."CustomOrder" USING btree ("agencyId", status, "nextReminderAt", id) WHERE ((status = 'PENDING'::"CustomOrderStatus") AND ("nextReminderAt" IS NOT NULL));

CREATE INDEX "DeviceCommand_agencyId_idx" ON public."DeviceCommand" USING btree ("agencyId");

CREATE INDEX "DeviceCommand_deliveredAt_idx" ON public."DeviceCommand" USING btree ("deliveredAt");

CREATE INDEX "DeviceCommand_deviceId_idx" ON public."DeviceCommand" USING btree ("deviceId");

CREATE INDEX "DeviceCreatorBinding_agencyId_idx" ON public."DeviceCreatorBinding" USING btree ("agencyId");

CREATE INDEX "DeviceCreatorBinding_creatorId_idx" ON public."DeviceCreatorBinding" USING btree ("creatorId");

CREATE UNIQUE INDEX "DeviceCreatorBinding_deviceId_creatorId_key" ON public."DeviceCreatorBinding" USING btree ("deviceId", "creatorId");

CREATE INDEX "DeviceCreatorBinding_deviceId_sessionReadReady_lastSeenAt_idx" ON public."DeviceCreatorBinding" USING btree ("deviceId", "sessionReadReady", "lastSeenAt");

CREATE INDEX "DeviceCreatorBinding_deviceId_sessionWriteReady_lastSeenAt_idx" ON public."DeviceCreatorBinding" USING btree ("deviceId", "sessionWriteReady", "lastSeenAt");

CREATE INDEX "DeviceCreatorBinding_lastSeenAt_idx" ON public."DeviceCreatorBinding" USING btree ("lastSeenAt");

CREATE UNIQUE INDEX "DeviceCryptoIdentity_agencyId_fingerprint_key" ON public."DeviceCryptoIdentity" USING btree ("agencyId", fingerprint);

CREATE INDEX "DeviceCryptoIdentity_agencyId_status_idx" ON public."DeviceCryptoIdentity" USING btree ("agencyId", status);

CREATE INDEX "DeviceCryptoIdentity_agencyId_userId_idx" ON public."DeviceCryptoIdentity" USING btree ("agencyId", "userId");

CREATE INDEX "DialogControlResumeDemand_agencyId_creatorId_idx" ON public."DialogControlResumeDemand" USING btree ("agencyId", "creatorId");

CREATE INDEX "DialogControlResumeDemand_status_nextAttemptAt_id_idx" ON public."DialogControlResumeDemand" USING btree (status, "nextAttemptAt", id);

CREATE INDEX "DialogReconciliationTarget_agencyId_status_priority_requestedAt" ON public."DialogReconciliationTarget" USING btree ("agencyId", status, priority, "requestedAt");

CREATE UNIQUE INDEX "DialogReconciliationTarget_creatorId_dialogId_messageId_key" ON public."DialogReconciliationTarget" USING btree ("creatorId", "dialogId", "messageId");

CREATE INDEX "DialogReconciliationTarget_creatorId_dialogId_status_priority_r" ON public."DialogReconciliationTarget" USING btree ("creatorId", "dialogId", status, priority, "requestedAt");

CREATE INDEX "DialogScanChunkCommit_creatorId_dialogId_committedAt_idx" ON public."DialogScanChunkCommit" USING btree ("creatorId", "dialogId", "committedAt");

CREATE INDEX "DialogScanChunkCommit_jobId_idx" ON public."DialogScanChunkCommit" USING btree ("jobId");

CREATE UNIQUE INDEX "DialogScanChunkCommit_runId_chunkKey_key" ON public."DialogScanChunkCommit" USING btree ("runId", "chunkKey");

CREATE INDEX "DialogScanRun_agencyId_status_idx" ON public."DialogScanRun" USING btree ("agencyId", status);

CREATE INDEX "DialogScanRun_createdAt_idx" ON public."DialogScanRun" USING btree ("createdAt");

CREATE INDEX "DialogScanRun_creatorId_dialogId_status_idx" ON public."DialogScanRun" USING btree ("creatorId", "dialogId", status);

CREATE INDEX "DialogScanRun_jobId_idx" ON public."DialogScanRun" USING btree ("jobId");

CREATE UNIQUE INDEX "DialogScanRun_jobId_key" ON public."DialogScanRun" USING btree ("jobId");

CREATE UNIQUE INDEX "DialogScanRun_one_active_per_dialog_idx" ON public."DialogScanRun" USING btree ("creatorId", "dialogId") WHERE (status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'PAUSED'::text]));

CREATE INDEX "DialogScanState_activeJobId_idx" ON public."DialogScanState" USING btree ("activeJobId");

CREATE INDEX "DialogScanState_activeRunId_idx" ON public."DialogScanState" USING btree ("activeRunId");

CREATE INDEX "DialogScanState_agencyId_status_idx" ON public."DialogScanState" USING btree ("agencyId", status);

CREATE UNIQUE INDEX "DialogScanState_creatorId_dialogId_key" ON public."DialogScanState" USING btree ("creatorId", "dialogId");

CREATE INDEX "DialogScanState_creatorId_status_idx" ON public."DialogScanState" USING btree ("creatorId", status);

CREATE INDEX "DomainWorkClaimAgencyState_dispatch_idx" ON public."DomainWorkClaimAgencyState" USING btree ("workClass", "activeGeneration", "nextDispatchAt", revision, "agencyId");

CREATE UNIQUE INDEX "DomainWorkClaimAgencyState_identity_key" ON public."DomainWorkClaimAgencyState" USING btree ("agencyId", "workClass");

CREATE INDEX "DomainWorkClaimLocatorMutationIntent_agency_idx" ON public."DomainWorkClaimLocatorMutationIntent" USING btree ("agencyId");

CREATE INDEX "DomainWorkClaimShardState_dispatch_idx" ON public."DomainWorkClaimShardState" USING btree ("agencyId", "workClass", "activeGeneration", "nextDispatchAt", revision, "claimShard");

CREATE UNIQUE INDEX "DomainWorkClaimShardState_identity_key" ON public."DomainWorkClaimShardState" USING btree ("agencyId", "workClass", "claimShard");

CREATE INDEX "DomainWorkItem_blocked_dependency_partial_idx" ON public."DomainWorkItem" USING btree ("agencyId", "dependencyKind", "dependencyKey", "dependencyRevision", id) WHERE (state = 'BLOCKED'::text);

CREATE INDEX "DomainWorkItem_claimable_agency_shard_a36_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", phase3_domain_work_claim_shard("partitionKey"), phase3_domain_work_claimable_at(state, "availableAt", "nextAttemptAt", "leaseUntil"), "partitionKey", id) WHERE (("isOutstanding" = true) AND (state = ANY (ARRAY['READY'::text, 'CLAIMED'::text])));

CREATE INDEX "DomainWorkItem_claimable_creator_a36_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", "creatorId", phase3_domain_work_claimable_at(state, "availableAt", "nextAttemptAt", "leaseUntil"), id) WHERE (("isOutstanding" = true) AND ("creatorId" IS NOT NULL) AND (state = ANY (ARRAY['READY'::text, 'CLAIMED'::text])));

CREATE INDEX "DomainWorkItem_claimable_global_a36_idx" ON public."DomainWorkItem" USING btree ("workClass", "activeGeneration", phase3_domain_work_claimable_at(state, "availableAt", "nextAttemptAt", "leaseUntil"), "agencyId", "partitionKey", id) WHERE (("isOutstanding" = true) AND (state = ANY (ARRAY['READY'::text, 'CLAIMED'::text])));

CREATE INDEX "DomainWorkItem_claimable_partition_a36_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", "partitionKey", phase3_domain_work_claimable_at(state, "availableAt", "nextAttemptAt", "leaseUntil"), id) WHERE (("isOutstanding" = true) AND (state = ANY (ARRAY['READY'::text, 'CLAIMED'::text])));

CREATE INDEX "DomainWorkItem_class_due_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", state, "availableAt", id);

CREATE INDEX "DomainWorkItem_current_activation_a36_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "partitionKey", "activeGeneration", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_current_agency_due_v3_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", "availableAt", "partitionKey", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_current_agency_partition_due_v3_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", "partitionKey", "availableAt", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_current_broad_due_idx" ON public."DomainWorkItem" USING btree ("workClass", "activeGeneration", "agencyId", "partitionKey", "availableAt", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_current_broad_due_v3_idx" ON public."DomainWorkItem" USING btree ("workClass", "activeGeneration", "availableAt", "agencyId", "partitionKey", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_current_class_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_current_family_probe_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_current_partition_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "partitionKey", "activeGeneration", "availableAt", id) WHERE ("isOutstanding" = true);

CREATE INDEX "DomainWorkItem_dependency_idx" ON public."DomainWorkItem" USING btree ("agencyId", "dependencyKind", "dependencyKey", "dependencyRevision", id);

CREATE INDEX "DomainWorkItem_global_due_idx" ON public."DomainWorkItem" USING btree (state, "availableAt", id);

CREATE UNIQUE INDEX "DomainWorkItem_identity_key" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "objectType", "objectId");

CREATE INDEX "DomainWorkItem_legacy_claim_drain_idx" ON public."DomainWorkItem" USING btree ("workClass", state, "leaseUntil", "claimExecutionGeneration", id) WHERE (("isOutstanding" = true) AND (state = 'CLAIMED'::text));

CREATE INDEX "DomainWorkItem_parent_due_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "parentObjectId", state, "availableAt", id);

CREATE INDEX "DomainWorkItem_partition_due_idx" ON public."DomainWorkItem" USING btree ("agencyId", "partitionKey", state, "availableAt", id);

CREATE INDEX "DomainWorkItem_ready_due_partial_idx" ON public."DomainWorkItem" USING btree ("agencyId", "partitionKey", "availableAt", id) WHERE (state = 'READY'::text);

CREATE INDEX "DomainWorkItem_scoped_creator_due_current_idx" ON public."DomainWorkItem" USING btree ("agencyId", "workClass", "activeGeneration", "creatorId", "availableAt", id) WHERE (("isOutstanding" = true) AND ("creatorId" IS NOT NULL));

CREATE INDEX "DomainWorkMemberScopeShardState_agency_member_idx" ON public."DomainWorkMemberScopeShardState" USING btree ("agencyId", "memberId");

CREATE INDEX "DomainWorkMemberScopeShardState_claim_idx" ON public."DomainWorkMemberScopeShardState" USING btree ("memberId", "accessEpoch", "lastSelectedAt", revision, "claimShard");

CREATE UNIQUE INDEX "DomainWorkMemberScopeShardState_identity_key" ON public."DomainWorkMemberScopeShardState" USING btree ("memberId", "claimShard");

CREATE INDEX "DomainWorkReadyAgency_due_idx" ON public."DomainWorkReadyAgency" USING btree ("workClass", "activeGeneration", "nextDueAt", "agencyId");

CREATE UNIQUE INDEX "DomainWorkReadyAgency_identity_key" ON public."DomainWorkReadyAgency" USING btree ("agencyId", "workClass");

CREATE INDEX "DomainWorkReadyPartition_due_idx" ON public."DomainWorkReadyPartition" USING btree ("agencyId", "workClass", "activeGeneration", "nextDueAt", "partitionKey");

CREATE UNIQUE INDEX "DomainWorkReadyPartition_identity_key" ON public."DomainWorkReadyPartition" USING btree ("agencyId", "workClass", "partitionKey");

CREATE INDEX "FanConsumerCursor_agency_creator_idx" ON public."FanConsumerCursor" USING btree ("agencyId", "creatorId");

CREATE INDEX "FanObservationReadLease_deliveryId_leaseRevision_idx" ON public."FanObservationReadLease" USING btree ("deliveryId", "leaseRevision");

CREATE INDEX "FanObservationReadLease_expiresAt_idx" ON public."FanObservationReadLease" USING btree ("expiresAt");

CREATE INDEX "FanObservationReadLease_jobId_leaseRevision_idx" ON public."FanObservationReadLease" USING btree ("jobId", "leaseRevision");

CREATE UNIQUE INDEX "FanObservationReadLease_token_key" ON public."FanObservationReadLease" USING btree (token);

CREATE INDEX "FanObservationToken_createdAt_idx" ON public."FanObservationToken" USING btree ("createdAt");

CREATE INDEX "FanObservationToken_creatorId_observedAt_idx" ON public."FanObservationToken" USING btree ("creatorId", "observedAt");

CREATE INDEX "FanObservationToken_jobId_consumedAt_idx" ON public."FanObservationToken" USING btree ("jobId", "consumedAt");

CREATE INDEX "FanObservationToken_jobId_leaseRevision_idx" ON public."FanObservationToken" USING btree ("jobId", "leaseRevision");

CREATE INDEX "FinancialObservedFact_time_idx" ON public."FinancialObservedFact" USING btree ("runId", "windowIndex", "occurredAt", "externalId");

CREATE INDEX "FinancialReceiptRun_agencyId_creatorId_id_idx" ON public."FinancialReceiptRun" USING btree ("agencyId", "creatorId", id);

CREATE INDEX "FinancialReceiptRun_retention_idx" ON public."FinancialReceiptRun" USING btree ("creatorId", "createdAt", id);

CREATE INDEX "FollowAutomationCandidate_agencyId_creatorId_state_idx" ON public."FollowAutomationCandidate" USING btree ("agencyId", "creatorId", state);

CREATE INDEX "FollowAutomationCandidate_creatorId_cooldownUntil_idx" ON public."FollowAutomationCandidate" USING btree ("creatorId", "cooldownUntil");

CREATE UNIQUE INDEX "FollowAutomationCandidate_creatorId_fanId_key" ON public."FollowAutomationCandidate" USING btree ("creatorId", "fanId");

CREATE INDEX "FollowAutomationCandidate_creatorId_phase_idx" ON public."FollowAutomationCandidate" USING btree ("creatorId", phase);

CREATE INDEX "FollowAutomationCandidate_creatorId_waitReturnUntil_idx" ON public."FollowAutomationCandidate" USING btree ("creatorId", "waitReturnUntil");

CREATE INDEX "FollowAutomationCandidate_snapshotRunId_idx" ON public."FollowAutomationCandidate" USING btree ("snapshotRunId");

CREATE INDEX "FollowBackCandidate_agencyId_creatorId_state_idx" ON public."FollowBackCandidate" USING btree ("agencyId", "creatorId", state);

CREATE INDEX "FollowBackCandidate_creatorId_cooldownUntil_idx" ON public."FollowBackCandidate" USING btree ("creatorId", "cooldownUntil");

CREATE INDEX "FollowBackCandidate_creatorId_eligibilityReason_idx" ON public."FollowBackCandidate" USING btree ("creatorId", "eligibilityReason");

CREATE UNIQUE INDEX "FollowBackCandidate_creatorId_fanId_key" ON public."FollowBackCandidate" USING btree ("creatorId", "fanId");

CREATE INDEX "FollowBackCandidate_snapshotRunId_idx" ON public."FollowBackCandidate" USING btree ("snapshotRunId");

CREATE INDEX "HiddenOnlineUser_agencyId_status_idx" ON public."HiddenOnlineUser" USING btree ("agencyId", status);

CREATE UNIQUE INDEX "HiddenOnlineUser_creatorId_fanId_key" ON public."HiddenOnlineUser" USING btree ("creatorId", "fanId");

CREATE INDEX "HiddenOnlineUser_creatorId_status_idx" ON public."HiddenOnlineUser" USING btree ("creatorId", status);

CREATE INDEX "HiddenOnlineUser_fanId_idx" ON public."HiddenOnlineUser" USING btree ("fanId");

CREATE INDEX "HiddenOnlineUser_lastSignalAt_idx" ON public."HiddenOnlineUser" USING btree ("lastSignalAt");

CREATE INDEX "JobInstance_agencyId_idempotencyKey_idx" ON public."JobInstance" USING btree ("agencyId", "idempotencyKey");

CREATE INDEX "JobInstance_agencyId_idx" ON public."JobInstance" USING btree ("agencyId");

CREATE INDEX "JobInstance_analytics_retention_idx" ON public."JobInstance" USING btree ("jobKey", status, "completedAt", id);

CREATE INDEX "JobInstance_analytics_terminal_updated_retention_idx" ON public."JobInstance" USING btree ("jobKey", status, "updatedAt", id);

CREATE INDEX "JobInstance_claimedByDeviceId_idx" ON public."JobInstance" USING btree ("claimedByDeviceId");

CREATE INDEX "JobInstance_creatorId_idx" ON public."JobInstance" USING btree ("creatorId");

CREATE UNIQUE INDEX "JobInstance_idempotencyKey_key" ON public."JobInstance" USING btree ("idempotencyKey");

CREATE INDEX "JobInstance_jobKey_idx" ON public."JobInstance" USING btree ("jobKey");

CREATE INDEX "JobInstance_leaseUntil_idx" ON public."JobInstance" USING btree ("leaseUntil");

CREATE INDEX "JobInstance_status_nextRunAt_idx" ON public."JobInstance" USING btree (status, "nextRunAt");

CREATE INDEX "LoginAdmissionBucket_expiresAt_id_idx" ON public."LoginAdmissionBucket" USING btree ("expiresAt", id);

CREATE INDEX "MaintenanceAdmissionClassState_turn_idx" ON public."MaintenanceAdmissionClassState" USING btree (generation, "turnCount", ordinal);

CREATE INDEX "MaintenanceLaneState_due_idx" ON public."MaintenanceLaneState" USING btree ("nextRunAt", "completedAt");

CREATE INDEX "MaintenanceLaneState_leaseUntil_idx" ON public."MaintenanceLaneState" USING btree ("leaseUntil");

CREATE INDEX "ManagementCommandReceipt_agencyId_id_idx" ON public."ManagementCommandReceipt" USING btree ("agencyId", id);

CREATE INDEX "MassCreatorDeliveryState_agency_creator_idx" ON public."MassCreatorDeliveryState" USING btree ("agencyId", "creatorId");

CREATE INDEX "MassQueueObservation_creator_idx" ON public."MassQueueObservation" USING btree ("agencyId", "creatorId", sequence);

CREATE INDEX "MassQueueObservation_retention_idx" ON public."MassQueueObservation" USING btree ("retainUntil", id);

CREATE INDEX "MediaLibraryScanItem_agencyId_creatorId_jobId_idx" ON public."MediaLibraryScanItem" USING btree ("agencyId", "creatorId", "jobId");

CREATE UNIQUE INDEX "MediaLibraryScanItem_jobId_mediaId_key" ON public."MediaLibraryScanItem" USING btree ("jobId", "mediaId");

CREATE INDEX "MessageLibraryCommandReceipt_agencyId_id_idx" ON public."MessageLibraryCommandReceipt" USING btree ("agencyId", id);

CREATE INDEX "ModuleSetting_agencyId_idx" ON public."ModuleSetting" USING btree ("agencyId");

CREATE UNIQUE INDEX "ModuleSetting_agencyId_moduleKey_key" ON public."ModuleSetting" USING btree ("agencyId", "moduleKey");

CREATE INDEX "ModuleSetting_moduleKey_idx" ON public."ModuleSetting" USING btree ("moduleKey");

CREATE INDEX "MoneyAttribution_agencyId_attributedToMemberId_occurredAt_idx" ON public."MoneyAttribution" USING btree ("agencyId", "attributedToMemberId", "occurredAt");

CREATE UNIQUE INDEX "MoneyAttribution_agencyId_eventHash_key" ON public."MoneyAttribution" USING btree ("agencyId", "eventHash");

CREATE INDEX "MoneyAttribution_agencyId_locked_occurredAt_idx" ON public."MoneyAttribution" USING btree ("agencyId", locked, "occurredAt");

CREATE INDEX "MoneyAttribution_agencyId_occurredAt_idx" ON public."MoneyAttribution" USING btree ("agencyId", "occurredAt");

CREATE INDEX "NotificationFactReceipt_creatorId_jobId_idx" ON public."NotificationFactReceipt" USING btree ("creatorId", "jobId");

CREATE INDEX "OfProviderRequestGateState_active_expiry_idx" ON public."OfProviderRequestGateState" USING btree ("activeExpiresAt");

CREATE INDEX "OfProviderRequestGateState_next_allowed_idx" ON public."OfProviderRequestGateState" USING btree ("nextAllowedAt");

CREATE INDEX "OfProviderRequestGateWaiter_bucket_ticket_idx" ON public."OfProviderRequestGateWaiter" USING btree (priority, category, ticket);

CREATE INDEX "OfProviderRequestGateWaiter_creator_ticket_idx" ON public."OfProviderRequestGateWaiter" USING btree ("creatorId", ticket);

CREATE INDEX "OfProviderRequestGateWaiter_lease_idx" ON public."OfProviderRequestGateWaiter" USING btree ("leaseUntil");

CREATE INDEX "OfProviderRequestGateWaiter_owner_lease_idx" ON public."OfProviderRequestGateWaiter" USING btree ("ownerInstanceId", "leaseUntil");

CREATE INDEX "OperationalControlState_agencyId_creatorId_idx" ON public."OperationalControlState" USING btree ("agencyId", "creatorId");

CREATE UNIQUE INDEX "Phase2DependencyState_identity_key" ON public."Phase2DependencyState" USING btree ("agencyId", "dependencyKind", "dependencyKey");

CREATE INDEX "Phase2DependencyState_revision_idx" ON public."Phase2DependencyState" USING btree ("agencyId", "dependencyKind", revision);

CREATE INDEX "Phase2WorkBroadClaimPartitionState_claim_idx" ON public."Phase2WorkBroadClaimPartitionState" USING btree ("agencyId", "workClass", "activeGeneration", "lastClaimedAt", "partitionKey");

CREATE UNIQUE INDEX "Phase2WorkBroadClaimPartitionState_identity_key" ON public."Phase2WorkBroadClaimPartitionState" USING btree ("agencyId", "workClass", "partitionKey");

CREATE INDEX "Phase2WorkBroadClaimPartitionState_recovery_idx" ON public."Phase2WorkBroadClaimPartitionState" USING btree ("workClass", "activeGeneration", "lastClaimedAt", "agencyId", "partitionKey");

CREATE INDEX "Phase2WorkBroadClaimPartitionState_shard_due_idx" ON public."Phase2WorkBroadClaimPartitionState" USING btree ("agencyId", "workClass", "activeGeneration", "claimShard", "nextClaimableAt", revision, "partitionKey");

CREATE INDEX "Phase2WorkCoverage_active_idx" ON public."Phase2WorkCoverage" USING btree ("agencyId", family, active);

CREATE UNIQUE INDEX "Phase2WorkCoverage_identity_key" ON public."Phase2WorkCoverage" USING btree ("agencyId", family, generation);

CREATE INDEX "Phase2WorkFamilyState_claim_v3_idx" ON public."Phase2WorkFamilyState" USING btree ("workClass", "activeGeneration", "lastBroadClaimedAt", "lastRequestedAt", "agencyId") WHERE ("outstandingCount" > 0);

CREATE UNIQUE INDEX "Phase2WorkFamilyState_identity_key" ON public."Phase2WorkFamilyState" USING btree ("agencyId", "workClass");

CREATE INDEX "Phase2WorkFamilyState_outstanding_idx" ON public."Phase2WorkFamilyState" USING btree ("agencyId", "outstandingCount", "workClass");

CREATE INDEX "ProviderCapacityContribution_due_idx" ON public."ProviderCapacityContribution" USING btree ("nextDueAt", kind, "sourceId") WHERE ("nextDueAt" IS NOT NULL);

CREATE INDEX "ProviderCapacityContribution_oldest_idx" ON public."ProviderCapacityContribution" USING btree (bucket, "oldestAt") WHERE ("oldestAt" IS NOT NULL);

CREATE INDEX "ProviderCapacityDebtState_status_sampled_idx" ON public."ProviderCapacityDebtState" USING btree (status, "sampledAt");

CREATE INDEX "ProviderCapacityDirty_turn_idx" ON public."ProviderCapacityDirty" USING btree ("touchedAt", kind, "sourceId");

CREATE INDEX "ProviderOperationalDebt_account_work_idx" ON public."ProviderOperationalDebt" USING btree ("agencyId", "accountId", "debtClass", "updatedAt");

CREATE INDEX "ProviderOperationalDebt_creator_work_idx" ON public."ProviderOperationalDebt" USING btree ("agencyId", "creatorId", "debtClass", "updatedAt");

CREATE UNIQUE INDEX "ProviderOperationalDebt_identity_key" ON public."ProviderOperationalDebt" USING btree ("agencyId", "accountId", "debtClass", "objectType", "objectId");

CREATE INDEX "ProviderOperationalDebt_order_idx" ON public."ProviderOperationalDebt" USING btree ("agencyId", "customOrderId", "updatedAt");

CREATE INDEX "ProviderOperationalDebt_submission_idx" ON public."ProviderOperationalDebt" USING btree ("agencyId", "customSubmissionId", "updatedAt");

CREATE INDEX "RefreshSession_agencyId_idx" ON public."RefreshSession" USING btree ("agencyId");

CREATE INDEX "RefreshSession_authorizationSessionId_idx" ON public."RefreshSession" USING btree ("authorizationSessionId");

CREATE INDEX "RefreshSession_authorization_history_idx" ON public."RefreshSession" USING btree ("authorizationSessionId", "agencyId", "userId", "expiresAt" DESC) WHERE ("authorizationSessionId" IS NOT NULL);

CREATE INDEX "RefreshSession_deviceId_idx" ON public."RefreshSession" USING btree ("deviceId");

CREATE INDEX "RefreshSession_expiresAt_idx" ON public."RefreshSession" USING btree ("expiresAt");

CREATE INDEX "RefreshSession_impersonatedByAdminId_idx" ON public."RefreshSession" USING btree ("impersonatedByAdminId");

CREATE INDEX "RefreshSession_live_agency_lookup_idx" ON public."RefreshSession" USING btree ("agencyId", "expiresAt" DESC, "userId", "deviceId") INCLUDE (id, "authorizationSessionId") WHERE ("revokedAt" IS NULL);

CREATE INDEX "RefreshSession_live_authorization_lookup_idx" ON public."RefreshSession" USING btree ("userId", "agencyId", "deviceId", "authorizationSessionId", "expiresAt" DESC) INCLUDE (id) WHERE ("revokedAt" IS NULL);

CREATE INDEX "RefreshSession_live_lineage_lookup_idx" ON public."RefreshSession" USING btree ("authorizationSessionId", "userId", "agencyId", "deviceId", "expiresAt" DESC) INCLUDE (id) WHERE (("revokedAt" IS NULL) AND ("authorizationSessionId" IS NOT NULL));

CREATE INDEX "RefreshSession_live_user_lookup_idx" ON public."RefreshSession" USING btree ("userId", "expiresAt" DESC, "lastUsedAt" DESC, "createdAt" DESC) INCLUDE (id, "agencyId", "deviceId", "authorizationSessionId", "rememberDevice") WHERE ("revokedAt" IS NULL);

CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON public."RefreshSession" USING btree ("tokenHash");

CREATE INDEX "RefreshSession_userId_idx" ON public."RefreshSession" USING btree ("userId");

CREATE INDEX "RefreshSession_user_history_created_idx" ON public."RefreshSession" USING btree ("userId", "createdAt" DESC);

CREATE INDEX "RetentionSweepLease_leaseUntil_idx" ON public."RetentionSweepLease" USING btree ("leaseUntil");

CREATE INDEX "SfsTargetCandidate_agencyId_creatorId_state_idx" ON public."SfsTargetCandidate" USING btree ("agencyId", "creatorId", state);

CREATE INDEX "SfsTargetCandidate_creatorId_phase_idx" ON public."SfsTargetCandidate" USING btree ("creatorId", phase);

CREATE INDEX "SfsTargetCandidate_creatorId_targetUserId_idx" ON public."SfsTargetCandidate" USING btree ("creatorId", "targetUserId");

CREATE UNIQUE INDEX "SfsTargetCandidate_creatorId_targetUserId_key" ON public."SfsTargetCandidate" USING btree ("creatorId", "targetUserId");

CREATE INDEX "SfsTargetCandidate_creatorId_unfollowAt_idx" ON public."SfsTargetCandidate" USING btree ("creatorId", "unfollowAt");

CREATE INDEX "SfsTargetCandidate_creatorId_usedForever_idx" ON public."SfsTargetCandidate" USING btree ("creatorId", "usedForever");

CREATE INDEX "SfsTargetCandidate_creatorId_username_idx" ON public."SfsTargetCandidate" USING btree ("creatorId", username);

CREATE INDEX "SfsTargetCandidate_scanJobId_idx" ON public."SfsTargetCandidate" USING btree ("scanJobId");

CREATE UNIQUE INDEX "SubscriberDirectoryMaintenanceSignal_creator_kind_key" ON public."SubscriberDirectoryMaintenanceSignal" USING btree ("creatorId", kind);

CREATE INDEX "SubscriberDirectoryMaintenanceSignal_due_claim_idx" ON public."SubscriberDirectoryMaintenanceSignal" USING btree ("dueAt", "creatorId", kind, COALESCE("claimUntil", '-infinity'::timestamp without time zone)) WHERE (attempts < 100);

CREATE INDEX "SubscriberDirectoryMaintenanceSignal_poison_idx" ON public."SubscriberDirectoryMaintenanceSignal" USING btree (attempts DESC, "dueAt", "creatorId", kind) WHERE (attempts >= 100);

CREATE INDEX "SubscriberDirectoryState_agencyId_status_idx" ON public."SubscriberDirectoryState" USING btree ("agencyId", status);

CREATE UNIQUE INDEX "SubscriberDirectoryState_creatorId_key" ON public."SubscriberDirectoryState" USING btree ("creatorId");

CREATE INDEX "SubscriberDirectoryState_nextScanAt_idx" ON public."SubscriberDirectoryState" USING btree ("nextScanAt");

CREATE INDEX "SubscriberScanItem_agencyId_creatorId_idx" ON public."SubscriberScanItem" USING btree ("agencyId", "creatorId");

CREATE INDEX "SubscriberScanItem_creatorId_fanId_idx" ON public."SubscriberScanItem" USING btree ("creatorId", "fanId");

CREATE UNIQUE INDEX "SubscriberScanItem_runId_fanId_key" ON public."SubscriberScanItem" USING btree ("runId", "fanId");

CREATE INDEX "SubscriberScanItem_runId_lastSeenIsNull_idx" ON public."SubscriberScanItem" USING btree ("runId", "lastSeenIsNull");

CREATE INDEX "SubscriberScanItem_run_id_cursor_idx" ON public."SubscriberScanItem" USING btree ("runId", id);

CREATE INDEX "SubscriberScanItem_run_pageOffset_idx" ON public."SubscriberScanItem" USING btree ("runId", "pageOffset");

CREATE UNIQUE INDEX "SubscriberScanPage_runId_offset_key" ON public."SubscriberScanPage" USING btree ("runId", "offset");

CREATE INDEX "SubscriberScanPage_runId_receivedAt_idx" ON public."SubscriberScanPage" USING btree ("runId", "receivedAt");

CREATE INDEX "SubscriberScanRun_agencyId_creatorId_status_idx" ON public."SubscriberScanRun" USING btree ("agencyId", "creatorId", status);

CREATE INDEX "SubscriberScanRun_creatorId_createdAt_idx" ON public."SubscriberScanRun" USING btree ("creatorId", "createdAt");

CREATE INDEX "SubscriberScanRun_creator_publication_generation_idx" ON public."SubscriberScanRun" USING btree ("creatorId", "publicationGeneration");

CREATE INDEX "SubscriberScanRun_creator_published_generation_idx" ON public."SubscriberScanRun" USING btree ("agencyId", "creatorId", "publicationGeneration" DESC, id DESC) WHERE ((status = ANY (ARRAY['PUBLISHED'::text, 'SUPERSEDED'::text])) AND ("publicationStatus" = 'COMPLETE'::text));

CREATE INDEX "SubscriberScanRun_creator_reconcile_idx" ON public."SubscriberScanRun" USING btree ("creatorId", "updatedAt", id) WHERE ((status = ANY (ARRAY['PUBLISHED'::text, 'SUPERSEDED'::text])) AND ("publicationStatus" = 'COMPLETE'::text) AND ("publicationJobReconciledAt" IS NULL));

CREATE UNIQUE INDEX "SubscriberScanRun_jobId_key" ON public."SubscriberScanRun" USING btree ("jobId");

CREATE UNIQUE INDEX "SubscriberScanRun_one_active_creator_key" ON public."SubscriberScanRun" USING btree ("creatorId") WHERE (status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text]));

CREATE INDEX "SubscriberScanRun_publication_debt_idx" ON public."SubscriberScanRun" USING btree ("agencyId", "creatorId", "updatedAt", id) WHERE (("fanProjectionStatus" = 'COMPLETE'::text) AND ("hasMore" = false) AND ("publicationStatus" = ANY (ARRAY['PENDING'::text, 'CURRENT'::text, 'PREVIOUS'::text, 'FINALIZE'::text])));

CREATE INDEX "SubscriberScanRun_publication_job_reconcile_idx" ON public."SubscriberScanRun" USING btree ("updatedAt", id) WHERE ((status = ANY (ARRAY['PUBLISHED'::text, 'SUPERSEDED'::text])) AND ("publicationStatus" = 'COMPLETE'::text) AND ("publicationJobReconciledAt" IS NULL));

CREATE INDEX "SubscriberScanRun_publication_recovery_idx" ON public."SubscriberScanRun" USING btree (status, "publicationStatus", "updatedAt");

CREATE INDEX "SubscriberScanRun_retention_eligible_idx" ON public."SubscriberScanRun" USING btree ("creatorId", "createdAt" DESC, id) WHERE ((status = ANY (ARRAY['SUPERSEDED'::text, 'FAILED'::text])) AND ("publicationStatus" = 'COMPLETE'::text));

CREATE INDEX "SubscriberScanRun_status_updatedAt_idx" ON public."SubscriberScanRun" USING btree (status, "updatedAt");

CREATE INDEX "SystemSetting_key_idx" ON public."SystemSetting" USING btree (key);

CREATE UNIQUE INDEX "SystemSetting_key_key" ON public."SystemSetting" USING btree (key);

CREATE INDEX "SystemSetting_updatedAt_idx" ON public."SystemSetting" USING btree ("updatedAt");

CREATE INDEX "TeamActivityContribution_agency_creator_day_idx" ON public."TeamActivityContribution" USING btree ("agencyId", "creatorId", day);

CREATE UNIQUE INDEX "TeamActivityContribution_agency_event_semantic_key" ON public."TeamActivityContribution" USING btree ("agencyId", "eventKind", "semanticKey");

CREATE INDEX "TeamActivityContribution_agency_member_day_idx" ON public."TeamActivityContribution" USING btree ("agencyId", "memberId", day);

CREATE INDEX "TeamActivityContribution_agency_state_event_idx" ON public."TeamActivityContribution" USING btree ("agencyId", state, "sourceEventAt");

CREATE INDEX "TeamActivityEvent_agencyId_accountId_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "accountId", ts);

CREATE INDEX "TeamActivityEvent_agencyId_actionSource_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "actionSource", ts);

CREATE INDEX "TeamActivityEvent_agencyId_automationDeliveryId_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "automationDeliveryId");

CREATE INDEX "TeamActivityEvent_agencyId_broadcastDispatchId_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "broadcastDispatchId");

CREATE INDEX "TeamActivityEvent_agencyId_contentId_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "contentId");

CREATE INDEX "TeamActivityEvent_agencyId_correlationId_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "correlationId");

CREATE INDEX "TeamActivityEvent_agencyId_coverageId_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "coverageId", ts);

CREATE INDEX "TeamActivityEvent_agencyId_creatorId_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "creatorId", ts);

CREATE UNIQUE INDEX "TeamActivityEvent_agencyId_deviceId_localId_key" ON public."TeamActivityEvent" USING btree ("agencyId", "deviceId", "localId");

CREATE INDEX "TeamActivityEvent_agencyId_eventKind_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "eventKind", ts);

CREATE INDEX "TeamActivityEvent_agencyId_historicalProjectionVersion_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "historicalProjectionVersion", ts);

CREATE INDEX "TeamActivityEvent_agencyId_memberId_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "memberId", ts);

CREATE INDEX "TeamActivityEvent_agencyId_messageId_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "messageId");

CREATE INDEX "TeamActivityEvent_agencyId_pendingProjectionVersion_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "pendingProjectionVersion", ts);

CREATE INDEX "TeamActivityEvent_agencyId_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", ts);

CREATE INDEX "TeamActivityEvent_agencyId_type_ts_idx" ON public."TeamActivityEvent" USING btree ("agencyId", type, ts);

CREATE INDEX "TeamActivityEvent_agency_event_semantic_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "eventKind", "semanticEventKey");

CREATE INDEX "TeamActivityEvent_dialog_kind_order_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "creatorId", "dialogId", "eventKind", ts, id);

CREATE INDEX "TeamActivityEvent_dialog_message_identity_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "creatorId", "dialogId", "eventKind", "messageId", ts, id);

CREATE INDEX "TeamActivityEvent_dialog_projection_enumeration_v1_idx" ON public."TeamActivityEvent" USING btree ("agencyId", id) WHERE ((("dialogProjectionVersion" IS NULL) OR ("dialogProjectionVersion" <> 'team_dialog_projection_v1'::text)) AND (("eventKind" = ANY (ARRAY['FAN_MESSAGE_RECEIVED'::text, 'DIALOG_SEEN'::text, 'DIALOG_SESSION'::text])) OR (("eventKind" = 'MESSAGE_SEND_CONFIRMED'::text) AND (upper(COALESCE("actionSource", ''::text)) = 'MANUAL'::text) AND (upper(COALESCE(lifecycle, ''::text)) = 'CONFIRMED'::text))));

CREATE INDEX "TeamActivityEvent_dialog_projection_work_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "creatorId", "dialogId", "dialogProjectionVersion", ts, id);

CREATE INDEX "TeamActivityEvent_legacy_pending_bootstrap_idx" ON public."TeamActivityEvent" USING btree ("agencyId", ts, id) WHERE ((extra ->> 'sourceDetail'::text) = 'crm_pending_bootstrap_v1'::text);

CREATE INDEX "TeamActivityEvent_pending_projection_work_idx" ON public."TeamActivityEvent" USING btree ("pendingProjectionVersion", ts, id);

CREATE INDEX "TeamActivityEvent_pending_repair_identity_idx" ON public."TeamActivityEvent" USING btree ("agencyId", "creatorId", "dialogId", "eventKind", COALESCE(NULLIF("messageId", ''::text), NULLIF("localId", ''::text), id), ts, id) WHERE ("eventKind" = 'FAN_MESSAGE_RECEIVED'::text);

CREATE INDEX "TeamActivityEvent_type_ts_idx" ON public."TeamActivityEvent" USING btree (type, ts);

CREATE UNIQUE INDEX "TeamCoverageSession_agencyId_coverageId_key" ON public."TeamCoverageSession" USING btree ("agencyId", "coverageId");

CREATE INDEX "TeamCoverageSession_agencyId_creatorId_memberId_startedAt_idx" ON public."TeamCoverageSession" USING btree ("agencyId", "creatorId", "memberId", "startedAt");

CREATE INDEX "TeamCoverageSession_agencyId_creatorId_startedAt_idx" ON public."TeamCoverageSession" USING btree ("agencyId", "creatorId", "startedAt");

CREATE INDEX "TeamCoverageSession_agencyId_memberId_startedAt_idx" ON public."TeamCoverageSession" USING btree ("agencyId", "memberId", "startedAt");

CREATE INDEX "TeamCoverageSession_agency_endedAt_idx" ON public."TeamCoverageSession" USING btree ("agencyId", "endedAt");

CREATE INDEX "TeamCoverageSession_endedAt_idx" ON public."TeamCoverageSession" USING btree ("endedAt");

CREATE INDEX "TeamDialogSession_agencyId_creatorId_dialogId_startedAt_idx" ON public."TeamDialogSession" USING btree ("agencyId", "creatorId", "dialogId", "startedAt");

CREATE INDEX "TeamDialogSession_agencyId_memberId_creatorId_dialogId_startedA" ON public."TeamDialogSession" USING btree ("agencyId", "memberId", "creatorId", "dialogId", "startedAt");

CREATE INDEX "TeamDialogSession_agencyId_memberId_startedAt_idx" ON public."TeamDialogSession" USING btree ("agencyId", "memberId", "startedAt");

CREATE UNIQUE INDEX "TeamDialogSession_agencyId_sessionId_key" ON public."TeamDialogSession" USING btree ("agencyId", "sessionId");

CREATE INDEX "TeamDialogSession_agency_endedAt_idx" ON public."TeamDialogSession" USING btree ("agencyId", "endedAt");

CREATE INDEX "TeamDialogSession_agency_startedAt_idx" ON public."TeamDialogSession" USING btree ("agencyId", "startedAt");

CREATE INDEX "TeamMemberActivityDaily_agency_creator_day_idx" ON public."TeamMemberActivityDaily" USING btree ("agencyId", "creatorId", day);

CREATE INDEX "TeamMemberActivityDaily_agency_day_idx" ON public."TeamMemberActivityDaily" USING btree ("agencyId", day);

CREATE UNIQUE INDEX "TeamMemberActivityDaily_agency_member_creator_day_key" ON public."TeamMemberActivityDaily" USING btree ("agencyId", "memberId", "creatorKey", day);

CREATE INDEX "TeamMemberActivityDaily_agency_member_day_idx" ON public."TeamMemberActivityDaily" USING btree ("agencyId", "memberId", day);

CREATE INDEX "TeamMemberFunction_agencyId_functionKey_memberId_idx" ON public."TeamMemberFunction" USING btree ("agencyId", "functionKey", "memberId");

CREATE UNIQUE INDEX "TeamMemberFunction_agencyId_memberId_functionKey_key" ON public."TeamMemberFunction" USING btree ("agencyId", "memberId", "functionKey");

CREATE INDEX "TeamMemberFunction_memberId_idx" ON public."TeamMemberFunction" USING btree ("memberId");

CREATE INDEX "TeamMoneyAttributionFact_agency_active_occurred_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "attributionActive", "occurredAt");

CREATE INDEX "TeamMoneyAttributionFact_agency_creator_occurred_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "creatorId", "occurredAt");

CREATE INDEX "TeamMoneyAttributionFact_agency_member_dialog_occurred_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "memberId", "dialogId", "occurredAt");

CREATE INDEX "TeamMoneyAttributionFact_agency_source_member_occurred_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "sourceType", "memberId", "occurredAt");

CREATE INDEX "TeamMoneyAttributionFact_agency_source_root_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "sourceType", "rootId");

CREATE UNIQUE INDEX "TeamMoneyAttributionFact_agency_source_row_key" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "sourceType", "sourceRowId");

CREATE INDEX "TeamMoneyAttributionFact_business_key_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "sourceType", "canonicalBusinessKey");

CREATE INDEX "TeamMoneyAttributionFact_canonicalMoneyId_idx" ON public."TeamMoneyAttributionFact" USING btree ("canonicalMoneyId");

CREATE INDEX "TeamMoneyAttributionFact_classification_read_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "classificationState", "sourceType", "occurredAt");

CREATE INDEX "TeamMoneyAttributionFact_creatorSaleId_idx" ON public."TeamMoneyAttributionFact" USING btree ("creatorSaleId");

CREATE INDEX "TeamMoneyAttributionFact_creatorTipId_idx" ON public."TeamMoneyAttributionFact" USING btree ("creatorTipId");

CREATE INDEX "TeamMoneyAttributionFact_dialog_summary_idx" ON public."TeamMoneyAttributionFact" USING btree ("agencyId", "memberId", "creatorId", COALESCE(NULLIF("fanId", ''::text), NULLIF("dialogId", ''::text)), "occurredAt") WHERE ("attributionActive" = true);

CREATE INDEX "TeamMoneyAttributionFact_financialTransactionId_idx" ON public."TeamMoneyAttributionFact" USING btree ("financialTransactionId");

CREATE INDEX "TeamMoneyDailyRollup_agency_creator_day_idx" ON public."TeamMoneyDailyRollup" USING btree ("agencyId", "creatorId", day);

CREATE INDEX "TeamMoneyDailyRollup_agency_day_member_idx" ON public."TeamMoneyDailyRollup" USING btree ("agencyId", day, "memberId");

CREATE UNIQUE INDEX "TeamMoneyDailyRollup_identity_key" ON public."TeamMoneyDailyRollup" USING btree ("agencyId", "memberId", "creatorKey", "sourceType", currency, day);

CREATE INDEX "TeamMoneyLifetimeRollup_agency_creator_idx" ON public."TeamMoneyLifetimeRollup" USING btree ("agencyId", "creatorId");

CREATE INDEX "TeamMoneyLifetimeRollup_agency_member_idx" ON public."TeamMoneyLifetimeRollup" USING btree ("agencyId", "memberId");

CREATE UNIQUE INDEX "TeamMoneyLifetimeRollup_identity_key" ON public."TeamMoneyLifetimeRollup" USING btree ("agencyId", "memberId", "creatorKey", "sourceType", currency);

CREATE INDEX "TeamMoneyRollupContribution_active_day_idx" ON public."TeamMoneyRollupContribution" USING btree ("agencyId", active, day);

CREATE UNIQUE INDEX "TeamMoneyRollupContribution_sourceFactId_key" ON public."TeamMoneyRollupContribution" USING btree ("sourceFactId");

CREATE INDEX "TeamMutationReceipt_agencyId_id_idx" ON public."TeamMutationReceipt" USING btree ("agencyId", id);

CREATE UNIQUE INDEX "TeamObservationState_agencyId_creatorId_key" ON public."TeamObservationState" USING btree ("agencyId", "creatorId");

CREATE INDEX "TeamObservationState_agencyId_currentScanStatus_idx" ON public."TeamObservationState" USING btree ("agencyId", "currentScanStatus");

CREATE INDEX "TeamObservationState_agencyId_lastObservedAt_idx" ON public."TeamObservationState" USING btree ("agencyId", "lastObservedAt");

CREATE INDEX "TeamObservationState_lockedUntil_idx" ON public."TeamObservationState" USING btree ("lockedUntil");

CREATE UNIQUE INDEX "TeamPendingDialogState_agencyId_creatorId_dialogId_key" ON public."TeamPendingDialogStateCurrent" USING btree ("agencyId", "creatorId", "dialogId");

CREATE INDEX "TeamPendingDialogState_agencyId_creatorId_status_firstIncomingA" ON public."TeamPendingDialogStateCurrent" USING btree ("agencyId", "creatorId", status, "firstIncomingAt");

CREATE INDEX "TeamPendingDialogState_agencyId_ownerMemberId_status_idx" ON public."TeamPendingDialogStateCurrent" USING btree ("agencyId", "ownerMemberId", status);

CREATE INDEX "TeamPendingDialogState_agencyId_status_firstIncomingAt_idx" ON public."TeamPendingDialogStateCurrent" USING btree ("agencyId", status, "firstIncomingAt");

CREATE INDEX "TeamPendingDialogState_operational_owner_scan_idx" ON public."TeamPendingDialogStateCurrent" USING btree ("agencyId", "derivationVersion", "projectionState", status, "ownerMemberId", "firstIncomingAt", id);

CREATE INDEX "TeamPpvClaimAudit_agencyId_actorMemberId_createdAt_idx" ON public."TeamPpvClaimAudit" USING btree ("agencyId", "actorMemberId", "createdAt");

CREATE INDEX "TeamPpvClaimAudit_agencyId_createdAt_idx" ON public."TeamPpvClaimAudit" USING btree ("agencyId", "createdAt");

CREATE INDEX "TeamPpvClaimAudit_agencyId_jobId_createdAt_idx" ON public."TeamPpvClaimAudit" USING btree ("agencyId", "jobId", "createdAt");

CREATE INDEX "TeamPpvClaimAudit_agencyId_purchaseId_createdAt_idx" ON public."TeamPpvClaimAudit" USING btree ("agencyId", "purchaseId", "createdAt");

CREATE INDEX "TeamPpvClaimAudit_agencyId_selectedMemberId_createdAt_idx" ON public."TeamPpvClaimAudit" USING btree ("agencyId", "selectedMemberId", "createdAt");

CREATE INDEX "TeamPpvPurchaseLedger_agencyId_attributedMemberId_purchasedAt_i" ON public."TeamPpvPurchaseLedger" USING btree ("agencyId", "attributedMemberId", "purchasedAt");

CREATE INDEX "TeamPpvPurchaseLedger_agencyId_creatorSaleId_idx" ON public."TeamPpvPurchaseLedger" USING btree ("agencyId", "creatorSaleId");

CREATE INDEX "TeamPpvPurchaseLedger_agencyId_financialStatus_purchasedAt_idx" ON public."TeamPpvPurchaseLedger" USING btree ("agencyId", "financialStatus", "purchasedAt");

CREATE INDEX "TeamPpvPurchaseLedger_agencyId_financialTransactionId_idx" ON public."TeamPpvPurchaseLedger" USING btree ("agencyId", "financialTransactionId");

CREATE INDEX "TeamPpvPurchaseLedger_agencyId_messageId_idx" ON public."TeamPpvPurchaseLedger" USING btree ("agencyId", "messageId");

CREATE UNIQUE INDEX "TeamPpvPurchaseLedger_agencyId_purchaseId_key" ON public."TeamPpvPurchaseLedger" USING btree ("agencyId", "purchaseId");

CREATE INDEX "TeamPpvPurchaseLedger_agencyId_status_purchasedAt_idx" ON public."TeamPpvPurchaseLedger" USING btree ("agencyId", status, "purchasedAt");

CREATE UNIQUE INDEX "TeamPpvPurchaseLedger_creatorSaleId_key" ON public."TeamPpvPurchaseLedger" USING btree ("creatorSaleId");

CREATE UNIQUE INDEX "TeamPpvPurchaseLedger_financialTransactionId_key" ON public."TeamPpvPurchaseLedger" USING btree ("financialTransactionId");

CREATE INDEX "TeamPpvResolveJob_agencyId_messageId_idx" ON public."TeamPpvResolveJob" USING btree ("agencyId", "messageId");

CREATE UNIQUE INDEX "TeamPpvResolveJob_agencyId_purchaseId_messageId_key" ON public."TeamPpvResolveJob" USING btree ("agencyId", "purchaseId", "messageId");

CREATE INDEX "TeamPpvResolveJob_agencyId_status_createdAt_idx" ON public."TeamPpvResolveJob" USING btree ("agencyId", status, "createdAt");

CREATE INDEX "TeamResponseCase_agencyId_classification_replyAt_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", classification, "replyAt");

CREATE INDEX "TeamResponseCase_agencyId_creatorId_dialogId_replyAt_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "creatorId", "dialogId", "replyAt");

CREATE UNIQUE INDEX "TeamResponseCase_agencyId_creatorId_replyMessageId_key" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "creatorId", "replyMessageId");

CREATE INDEX "TeamResponseCase_agencyId_memberId_replyAt_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "memberId", "replyAt");

CREATE INDEX "TeamResponseCase_agencyId_slaEligible_replyAt_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "slaEligible", "replyAt");

CREATE INDEX "TeamResponseCase_agency_creator_member_replyAt_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "creatorId", "memberId", "replyAt");

CREATE INDEX "TeamResponseCase_agency_projection_state_reply_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "projectionState", "replyAt", id);

CREATE INDEX "TeamResponseCase_agency_replyAt_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "replyAt");

CREATE INDEX "TeamResponseCase_agency_replyMessage_lookup_idx" ON public."TeamResponseCaseCurrent" USING btree ("agencyId", "replyMessageId");

CREATE UNIQUE INDEX "TeamSentMessageLedger_agencyId_accountId_localSeed_key" ON public."TeamSentMessageLedger" USING btree ("agencyId", "accountId", "localSeed");

CREATE INDEX "TeamSentMessageLedger_agencyId_accountId_messageId_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "accountId", "messageId");

CREATE UNIQUE INDEX "TeamSentMessageLedger_agencyId_accountId_messageId_key" ON public."TeamSentMessageLedger" USING btree ("agencyId", "accountId", "messageId");

CREATE INDEX "TeamSentMessageLedger_agencyId_creatorId_sentAt_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "creatorId", "sentAt");

CREATE INDEX "TeamSentMessageLedger_agencyId_dialogId_sentAt_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "dialogId", "sentAt");

CREATE INDEX "TeamSentMessageLedger_agencyId_isPpv_sentAt_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "isPpv", "sentAt");

CREATE INDEX "TeamSentMessageLedger_agencyId_memberId_sentAt_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "memberId", "sentAt");

CREATE INDEX "TeamSentMessageLedger_agencyId_messageId_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "messageId");

CREATE INDEX "TeamSentMessageLedger_dialog_canonical_order_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "creatorId", "dialogId", "sentAt", "telemetryEventId", id) WHERE (source = ANY (ARRAY['manual'::text, 'manual_chat'::text]));

CREATE INDEX "TeamSentMessageLedger_dialog_reply_order_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "creatorId", "dialogId", "sentAt", id) WHERE (source = ANY (ARRAY['manual'::text, 'manual_chat'::text]));

CREATE INDEX "TeamSentMessageLedger_retention_compact_idx" ON public."TeamSentMessageLedger" USING btree ("sentAt", id) WHERE ("compactedAt" IS NULL);

CREATE INDEX "TeamSentMessageLedger_temporal_order_v3_idx" ON public."TeamSentMessageLedger" USING btree ("agencyId", "creatorId", "dialogId", "sentAt", "telemetryEventId", id);

CREATE INDEX "TeamShift_agencyId_startsAt_idx" ON public."TeamShift" USING btree ("agencyId", "startsAt");

CREATE INDEX "TeamShift_agencyId_status_startsAt_idx" ON public."TeamShift" USING btree ("agencyId", status, "startsAt");

CREATE INDEX "TeamShift_memberId_startsAt_idx" ON public."TeamShift" USING btree ("memberId", "startsAt");

CREATE INDEX "TeamShiftCreator_creatorId_shiftId_idx" ON public."TeamShiftCreator" USING btree ("creatorId", "shiftId");

CREATE INDEX "TeamShiftCreator_creatorRefId_shiftId_idx" ON public."TeamShiftCreator" USING btree ("creatorRefId", "shiftId");

CREATE INDEX "TeamTipLedger_agencyId_attributedMemberId_receivedAt_idx" ON public."TeamTipLedger" USING btree ("agencyId", "attributedMemberId", "receivedAt");

CREATE INDEX "TeamTipLedger_agencyId_creatorId_receivedAt_idx" ON public."TeamTipLedger" USING btree ("agencyId", "creatorId", "receivedAt");

CREATE INDEX "TeamTipLedger_agencyId_creatorTipId_idx" ON public."TeamTipLedger" USING btree ("agencyId", "creatorTipId");

CREATE UNIQUE INDEX "TeamTipLedger_agencyId_eventHash_key" ON public."TeamTipLedger" USING btree ("agencyId", "eventHash");

CREATE INDEX "TeamTipLedger_agencyId_fanId_receivedAt_idx" ON public."TeamTipLedger" USING btree ("agencyId", "fanId", "receivedAt");

CREATE INDEX "TeamTipLedger_agencyId_financialStatus_receivedAt_idx" ON public."TeamTipLedger" USING btree ("agencyId", "financialStatus", "receivedAt");

CREATE INDEX "TeamTipLedger_agencyId_status_receivedAt_idx" ON public."TeamTipLedger" USING btree ("agencyId", status, "receivedAt");

CREATE UNIQUE INDEX "TeamTipLedger_creatorTipId_key" ON public."TeamTipLedger" USING btree ("creatorTipId");

CREATE INDEX "TelegramDeliveryIntent_agencyId_accountId_remoteRecipientTelegr" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "accountId", "remoteRecipientTelegramUserId", state);

CREATE INDEX "TelegramDeliveryIntent_agencyId_accountId_state_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "accountId", state);

CREATE INDEX "TelegramDeliveryIntent_agencyId_creatorId_state_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "creatorId", state);

CREATE INDEX "TelegramDeliveryIntent_agencyId_customOrderId_kind_createdAt_id" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "customOrderId", kind, "createdAt");

CREATE INDEX "TelegramDeliveryIntent_agencyId_customSubmissionId_kind_created" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "customSubmissionId", kind, "createdAt");

CREATE INDEX "TelegramDeliveryIntent_agencyId_state_createdAt_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", state, "createdAt");

CREATE INDEX "TelegramDeliveryIntent_agencyId_state_projectionBlockedAt_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", state, "projectionBlockedAt");

CREATE INDEX "TelegramDeliveryIntent_agencyId_state_providerBindingRetryAt_id" ON public."TelegramDeliveryIntent" USING btree ("agencyId", state, "providerBindingRetryAt");

CREATE INDEX "TelegramDeliveryIntent_customOrderId_remoteMessageId_idx" ON public."TelegramDeliveryIntent" USING btree ("customOrderId", "remoteMessageId");

CREATE INDEX "TelegramDeliveryIntent_expired_commit_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "commitStartedAt", id) WHERE (state = 'COMMITTING'::text);

CREATE INDEX "TelegramDeliveryIntent_failed_precommit_queue_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "updatedAt", "createdAt", id) WHERE ((state = 'FAILED_PRECOMMIT'::text) AND ("commitStartedAt" IS NULL));

CREATE UNIQUE INDEX "TelegramDeliveryIntent_logicalKey_key" ON public."TelegramDeliveryIntent" USING btree ("logicalKey");

CREATE UNIQUE INDEX "TelegramDeliveryIntent_one_cancellation_per_order_key" ON public."TelegramDeliveryIntent" USING btree ("customOrderId") WHERE (kind = 'CANCELLATION'::text);

CREATE UNIQUE INDEX "TelegramDeliveryIntent_one_revision_request_per_submission_key" ON public."TelegramDeliveryIntent" USING btree ("customSubmissionId") WHERE ((kind = 'REVISION_REQUEST'::text) AND ("customSubmissionId" IS NOT NULL));

CREATE UNIQUE INDEX "TelegramDeliveryIntent_one_task_per_order_key" ON public."TelegramDeliveryIntent" USING btree ("customOrderId") WHERE (kind = 'TASK'::text);

CREATE INDEX "TelegramDeliveryIntent_pending_billing_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "creatorId", "createdAt", id) WHERE (state = ANY (ARRAY['PLANNED'::text, 'CLAIMED'::text, 'FAILED_PRECOMMIT'::text]));

CREATE INDEX "TelegramDeliveryIntent_precommit_provider_blocked_queue_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "updatedAt", "createdAt", id) WHERE ((state = 'PLANNED'::text) AND ("commitStartedAt" IS NULL) AND ("outcomeReason" ~~ 'PRECOMMIT_PROVIDER_UNAVAILABLE:%'::text));

CREATE UNIQUE INDEX "TelegramDeliveryIntent_provider_message_key" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "accountId", "remoteMessageId");

CREATE INDEX "TelegramDeliveryIntent_reconciliation_queue_idx" ON public."TelegramDeliveryIntent" USING btree ("agencyId", "commitStartedAt", "createdAt", id) WHERE (state = 'RECONCILE_REQUIRED'::text);

CREATE UNIQUE INDEX "TelegramDeliveryIntent_reference_ordinal_key" ON public."TelegramDeliveryIntent" USING btree ("customOrderId", kind, "referenceOrdinal");

CREATE INDEX "TelegramInboundEvent_agencyId_accountId_replyToMessageId_idx" ON public."TelegramInboundEvent" USING btree ("agencyId", "accountId", "replyToMessageId");

CREATE INDEX "TelegramInboundEvent_agencyId_creatorId_sentAt_idx" ON public."TelegramInboundEvent" USING btree ("agencyId", "creatorId", "sentAt");

CREATE INDEX "TelegramInboundEvent_agencyId_customOrderId_sentAt_idx" ON public."TelegramInboundEvent" USING btree ("agencyId", "customOrderId", "sentAt");

CREATE INDEX "TelegramInboundEvent_agencyId_projectionState_observedAt_idx" ON public."TelegramInboundEvent" USING btree ("agencyId", "projectionState", "observedAt");

CREATE INDEX "TelegramInboundEvent_agencyId_projectionState_updatedAt_idx" ON public."TelegramInboundEvent" USING btree ("agencyId", "projectionState", "updatedAt");

CREATE UNIQUE INDEX "TelegramInboundEvent_provider_message_key" ON public."TelegramInboundEvent" USING btree ("agencyId", "accountId", "senderTelegramUserId", "messageId");

CREATE INDEX "TelegramInboundEvent_receipt_reply_pending_idx" ON public."TelegramInboundEvent" USING btree ("agencyId", "accountId", "replyToMessageId", id) WHERE (("submissionId" IS NULL) AND ("projectionState" = ANY (ARRAY['PENDING'::text, 'FAILED_RETRYABLE'::text])) AND ("replyToMessageId" IS NOT NULL));

CREATE INDEX "TelegramInboundEvent_receipt_sender_pending_idx" ON public."TelegramInboundEvent" USING btree ("agencyId", "accountId", "senderTelegramUserId", id) WHERE (("submissionId" IS NULL) AND ("projectionState" = ANY (ARRAY['PENDING'::text, 'FAILED_RETRYABLE'::text])));

CREATE INDEX "TelegramInboundEvent_submissionId_idx" ON public."TelegramInboundEvent" USING btree ("submissionId");

CREATE INDEX "TrafficMetric_period_v2" ON public."TrafficMetric" USING btree ("creatorId", kind, period, "objectId");

CREATE UNIQUE INDEX "TrafficSource_agencyId_creatorId_sourceType_externalId_key" ON public."TrafficSource" USING btree ("agencyId", "creatorId", "sourceType", "externalId");

CREATE INDEX "TrafficSource_agencyId_creatorId_sourceType_idx" ON public."TrafficSource" USING btree ("agencyId", "creatorId", "sourceType");

CREATE INDEX "TrafficSource_agencyId_creatorId_status_idx" ON public."TrafficSource" USING btree ("agencyId", "creatorId", status);

CREATE INDEX "TrafficSourceMember_agencyId_creatorId_fanId_idx" ON public."TrafficSourceMember" USING btree ("agencyId", "creatorId", "fanId");

CREATE UNIQUE INDEX "TrafficSourceMember_agencyId_creatorId_sourceId_fanId_key" ON public."TrafficSourceMember" USING btree ("agencyId", "creatorId", "sourceId", "fanId");

CREATE INDEX "TrafficSourceMember_needsValueRefresh_lastValueFetchedAt_idx" ON public."TrafficSourceMember" USING btree ("needsValueRefresh", "lastValueFetchedAt");

CREATE INDEX "TrafficSourceMember_retention_idx" ON public."TrafficSourceMember" USING btree ("lastRevenueAt", "lastSeenAt", "needsValueRefresh");

CREATE INDEX "TrafficSourceMember_sourceId_fanId_idx" ON public."TrafficSourceMember" USING btree ("sourceId", "fanId");

CREATE INDEX "User_disabledAt_idx" ON public."User" USING btree ("disabledAt");

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);

CREATE INDEX "User_sessionsRevokedAt_idx" ON public."User" USING btree ("sessionsRevokedAt");

CREATE UNIQUE INDEX "VaultUnsortedSnapshot_agencyId_creatorId_key" ON public."VaultUnsortedSnapshot" USING btree ("agencyId", "creatorId");

CREATE INDEX "VaultUnsortedSnapshot_agencyId_idx" ON public."VaultUnsortedSnapshot" USING btree ("agencyId");

CREATE INDEX "VaultUnsortedSnapshot_capturedAt_idx" ON public."VaultUnsortedSnapshot" USING btree ("capturedAt");

CREATE INDEX "VaultUnsortedSnapshot_creatorId_idx" ON public."VaultUnsortedSnapshot" USING btree ("creatorId");

CREATE INDEX "WorkerDevice_agencyId_idx" ON public."WorkerDevice" USING btree ("agencyId");

CREATE INDEX "WorkerDevice_lastSeenAt_idx" ON public."WorkerDevice" USING btree ("lastSeenAt");

CREATE INDEX "WorkerDevice_userId_idx" ON public."WorkerDevice" USING btree ("userId");

CREATE INDEX "WorkspaceSetting_agencyId_idx" ON public."WorkspaceSetting" USING btree ("agencyId");

CREATE UNIQUE INDEX "WorkspaceSetting_agencyId_key_key" ON public."WorkspaceSetting" USING btree ("agencyId", key);


-- Required queue/projection indexes (built directly on empty tables)


CREATE INDEX IF NOT EXISTS "AutomationDelivery_mass_current_v2_idx" ON "AutomationDelivery" ("agencyId","creatorId","id") WHERE ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED','MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND
  ("status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED') OR
   ("actionType" IN ('MASS_QUEUE_CREATE','MASS_NATIVE_QUEUE_CREATE','MASS_PROVIDER_QUEUE_OBSERVED') AND
    ("remoteLifecycleState" IN ('PENDING','UNKNOWN','MIGRATION_RECONCILE_REQUIRED') OR
     ("status"='COMPLETED' AND "remoteLifecycleState" IS NULL) OR
     ("status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry' AND "remoteLifecycleState" IS DISTINCT FROM 'SETTLED'))) OR
   ("actionType" IN ('MASS_QUEUE_CANCEL','MASS_NATIVE_QUEUE_CANCEL') AND "status"='FAILED' AND "failureCode"='outcome_unresolved_do_not_retry'))) ;

CREATE INDEX IF NOT EXISTS "FanObservationToken_expiry_id_idx" ON "FanObservationToken" ("createdAt","id");

CREATE INDEX IF NOT EXISTS "OfProviderRequestGateWaiter_expiry_id_idx" ON "OfProviderRequestGateWaiter" ("leaseUntil","waiterId");

CREATE INDEX IF NOT EXISTS "DomainWorkItem_notification_identity_recovery_idx" ON "DomainWorkItem" ("id") WHERE "state"='RECONCILE_REQUIRED' AND "terminalCause"='RETRY_EXHAUSTED:BAD_TRAFFIC_DIRTY_INPUT' AND "workClass" IN ('NOTIFICATION_CONSEQUENCES','NOTIFICATION_CONSEQUENCES_V2','NOTIFICATION_FACT_RECEIPTS') AND ("lastRepair"->>'kind') IS DISTINCT FROM 'notification_identity_recovery_v1';

CREATE INDEX IF NOT EXISTS "AnalyticsIngestBatch_publication_idx" ON "AnalyticsIngestBatch" ("sourceJobId","dataType","id");

CREATE INDEX IF NOT EXISTS "CreatorEarningsDaily_publication_idx" ON "CreatorEarningsDaily" ("creatorId","sourceJobId","sourceScanRunId","id");

CREATE INDEX IF NOT EXISTS "AnalyticsCoverage_publication_idx" ON "AnalyticsCoverage" ("creatorId","dataType","id");

CREATE INDEX IF NOT EXISTS "CreatorCampaign_publication_idx" ON "CreatorCampaign" ("creatorId","sourceScanRunId","id");

CREATE INDEX IF NOT EXISTS "CreatorCampaign_retire_page_idx" ON "CreatorCampaign" ("creatorId","isActive","id");

CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_publication_idx" ON "CreatorFinancialTransaction" ("creatorId","sourceJobId","scanRunId","id");

CREATE UNIQUE INDEX IF NOT EXISTS "TrafficSource_canonical_key" ON "TrafficSource" ("canonicalCampaignId");

CREATE INDEX IF NOT EXISTS "TrafficSource_page_v2" ON "TrafficSource" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "TrafficSourceMember_fan_page_v2" ON "TrafficSourceMember" ("creatorId","fanId","id");

CREATE INDEX IF NOT EXISTS "TrafficSourceMember_buyers_page_v2" ON "TrafficSourceMember" ("creatorId","sourceId","fanId") WHERE ("projectionMetrics"->>'valuePayingFans')='1';

CREATE INDEX IF NOT EXISTS "TrafficSourceMember_attribution_v2" ON "TrafficSourceMember" ("creatorId","fanId","lastSeenAt" DESC,"id" DESC);

CREATE INDEX IF NOT EXISTS "TrafficReceipt_repair_page_v2" ON "CreatorSubscriptionLedger" ("creatorId","fanId","id") WHERE "sourceId" IS NULL;

CREATE INDEX IF NOT EXISTS "TrafficReceipt_backfill_page_v2" ON "CreatorSubscriptionLedger" ("creatorId","id");

CREATE INDEX IF NOT EXISTS "CampaignFan_traffic_page_v2" ON "CreatorCampaignFan" ("creatorId","id");

CREATE INDEX IF NOT EXISTS "Campaign_traffic_page_v2" ON "CreatorCampaign" ("creatorId","id");

CREATE INDEX IF NOT EXISTS "TrafficDomainWork_pending_v2" ON "DomainWorkItem" ("creatorId","workClass") WHERE "isOutstanding";

CREATE INDEX IF NOT EXISTS "CampaignFan_read_fan_page_v1" ON "CreatorCampaignFan" ("creatorId","fanId","id");

CREATE INDEX IF NOT EXISTS "CampaignFan_read_attribution_v1" ON "CreatorCampaignFan" ("creatorId","fanId","attributedAt" DESC,"id" DESC);

CREATE INDEX IF NOT EXISTS "Financial_read_repair_v1" ON "CreatorFinancialTransaction" ("creatorId","fanId","occurredAt","id");

CREATE INDEX IF NOT EXISTS "Financial_read_backfill_v1" ON "CreatorFinancialTransaction" ("creatorId","id");

CREATE INDEX IF NOT EXISTS "Campaign_frontier_unknown_v1" ON "CreatorCampaign" ("creatorId","sourceScanRunId","claimersNextDueAt","externalCampaignId") WHERE "claimersObservationVersion" < 1;

CREATE INDEX IF NOT EXISTS "Campaign_directory_due_v2" ON "CreatorCampaign" ("creatorId","sourceScanRunId","sourceScanStartedAt","claimersNextDueAt","externalCampaignId");

CREATE INDEX IF NOT EXISTS "Campaign_directory_unknown_v2" ON "CreatorCampaign" ("creatorId","sourceScanRunId","sourceScanStartedAt","claimersNextDueAt","externalCampaignId") WHERE "claimersObservationVersion" < 1;

CREATE INDEX IF NOT EXISTS "Campaign_fan_refresh_ready_v1" ON "CreatorFanRefreshDemand" ("creatorId","lastRequestedAt","id") WHERE "status" = 'QUEUED' AND "activeRefreshJobId" IS NULL;

CREATE INDEX IF NOT EXISTS "Campaign_fan_refresh_retry_v1" ON "CreatorFanRefreshDemand" ("creatorId","nextRetryAt","id") WHERE "status" = 'FAILED' AND "activeRefreshJobId" IS NULL AND "quarantinedAt" IS NULL AND "nextRetryAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Campaign_fan_refresh_heal_v1" ON "CreatorFanRefreshDemand" ("creatorId","id") WHERE "status"::text = ANY (ARRAY['QUEUED'::text,'FAILED'::text]);

CREATE INDEX IF NOT EXISTS "TrafficSourceMember_backfill_page_v3" ON "TrafficSourceMember" ("creatorId","id");

CREATE INDEX IF NOT EXISTS "Campaign_refresh_retryable_status_v2" ON "CreatorFanRefreshDemand" ("creatorId","id") WHERE "status" = 'FAILED' AND "quarantinedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Campaign_refresh_quarantine_status_v2" ON "CreatorFanRefreshDemand" ("creatorId","id") WHERE "status" = 'FAILED' AND "quarantinedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Campaign_refresh_latest_failure_v2" ON "CreatorFanRefreshDemand" ("creatorId","lastFailedAt" DESC,"id") WHERE "status" = 'FAILED';

CREATE INDEX IF NOT EXISTS "Campaign_refresh_next_retry_v2" ON "CreatorFanRefreshDemand" ("creatorId","nextRetryAt","id") WHERE "status" = 'FAILED' AND "quarantinedAt" IS NULL AND "nextRetryAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Campaign_refresh_force_repair_v2" ON "CreatorFanRefreshDemand" ("creatorId",COALESCE("nextRetryAt","lastFailedAt","updatedAt"),"id") WHERE "status" = 'FAILED' AND "activeRefreshJobId" IS NULL;

CREATE INDEX IF NOT EXISTS "Campaign_fair_pages_v1" ON "CreatorCampaign" ("creatorId","claimersCursorRunId","claimersCursorPending","claimersCursorPage","externalCampaignId");

CREATE INDEX IF NOT EXISTS "Campaign_fair_schedule_v1" ON "CreatorCampaign" ("creatorId","sourceScanRunId","claimersEligibleAt","externalCampaignId");

CREATE INDEX IF NOT EXISTS "Campaign_directory_due_v1" ON "CreatorCampaign" ("creatorId","sourceScanRunId","claimersNextDueAt","externalCampaignId");

CREATE INDEX IF NOT EXISTS "Subscription_state_latest_v1" ON "CreatorSubscriptionEvent" ("creatorId","fanId","occurredAt" DESC,"id" DESC);

CREATE INDEX IF NOT EXISTS "Subscription_state_currency_v1" ON "CreatorSubscriptionEvent" ("creatorId","fanId","occurredAt" DESC,"id" DESC) WHERE "currency" ~ '^[A-Z]{3}$';

CREATE INDEX IF NOT EXISTS "Subscription_state_price_v1" ON "CreatorSubscriptionEvent" ("creatorId","fanId","occurredAt" DESC,"id" DESC) WHERE "observedPriceCents" >= 0;

CREATE INDEX IF NOT EXISTS "Subscription_state_status_v1" ON "CreatorSubscriptionEvent" ("creatorId","fanId","occurredAt" DESC,"id" DESC) WHERE "eventType" IN ('SUBSCRIBED_FREE'::"CreatorSubscriptionEventType",'SUBSCRIBED_PAID'::"CreatorSubscriptionEventType",'SUBSCRIBED_UNKNOWN'::"CreatorSubscriptionEventType",'RENEWED'::"CreatorSubscriptionEventType",'RESUBSCRIBED'::"CreatorSubscriptionEventType",'EXPIRED'::"CreatorSubscriptionEventType");

CREATE INDEX IF NOT EXISTS "Subscription_state_started_v1" ON "CreatorSubscriptionEvent" ("creatorId","fanId","occurredAt" DESC,"id" DESC) WHERE "eventType" IN ('SUBSCRIBED_FREE'::"CreatorSubscriptionEventType",'SUBSCRIBED_PAID'::"CreatorSubscriptionEventType",'SUBSCRIBED_UNKNOWN'::"CreatorSubscriptionEventType",'RESUBSCRIBED'::"CreatorSubscriptionEventType");

CREATE INDEX IF NOT EXISTS "Subscription_state_renewed_v1" ON "CreatorSubscriptionEvent" ("creatorId","fanId","occurredAt" DESC,"id" DESC) WHERE "eventType" = 'RENEWED'::"CreatorSubscriptionEventType";

CREATE INDEX IF NOT EXISTS "Subscription_state_renewal_v1" ON "CreatorSubscriptionEvent" ("creatorId","fanId","occurredAt" DESC,"id" DESC) WHERE "eventType" IN ('AUTO_RENEW_ENABLED'::"CreatorSubscriptionEventType",'AUTO_RENEW_DISABLED'::"CreatorSubscriptionEventType");

CREATE INDEX IF NOT EXISTS "CreatorSale_analytics_adoption_idx" ON "CreatorSale" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "CreatorTip_analytics_adoption_idx" ON "CreatorTip" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "CreatorSubscriptionEvent_analytics_adoption_idx" ON "CreatorSubscriptionEvent" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "CreatorPaidSubscription_analytics_adoption_idx" ON "CreatorPaidSubscription" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "CreatorPostLike_analytics_adoption_idx" ON "CreatorPostLike" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "CreatorPostComment_analytics_adoption_idx" ON "CreatorPostComment" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "CreatorFinancialTransaction_analytics_adoption_idx" ON "CreatorFinancialTransaction" ("agencyId","creatorId","id");

CREATE INDEX IF NOT EXISTS "CreatorMessagesDaily_analytics_adoption_idx" ON "CreatorMessagesDaily" ("agencyId","creatorId","id");

ALTER TABLE "AdminCommand" ADD CONSTRAINT "AdminCommand_status_check" CHECK (((status = ANY (ARRAY['RUNNING'::text, 'SUCCEEDED'::text, 'REJECTED'::text, 'QUEUED'::text, 'PAUSED_AUTH'::text, 'STOPPED_TARGET'::text, 'COMPLETED_WITH_REJECTIONS'::text, 'CANCELLED'::text, 'RESUMED'::text])) OR ((action = 'retention.run'::text) AND (status = ANY (ARRAY['PARTIAL'::text, 'FAILED'::text])))));

ALTER TABLE "AdminCommandAudit" ADD CONSTRAINT "AdminCommandAudit_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "AdminCommand"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AdminSupportGrant" ADD CONSTRAINT "AdminSupportGrant_epoch_positive" CHECK (("actorAccessEpoch" >= 1));

ALTER TABLE "AdminSupportGrant" ADD CONSTRAINT "AdminSupportGrant_expiry" CHECK ((("expiresAt" > "createdAt") AND ("expiresAt" <= ("createdAt" + '00:30:00'::interval))));

ALTER TABLE "AgencyBillingWallet" ADD CONSTRAINT "AgencyBillingWallet_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyCreatorCatalogGenerationBoundary" ADD CONSTRAINT "AgencyCreatorCatalogGenerationBoundary_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyCreatorCatalogState" ADD CONSTRAINT "AgencyCreatorCatalogState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyCreatorCatalogState" ADD CONSTRAINT "AgencyCreatorCatalogState_generation_positive" CHECK ((generation > 0));

ALTER TABLE "AgencyCryptoOwnerKeyWrap" ADD CONSTRAINT "AgencyCryptoOwnerKeyWrap_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyCryptoOwnerKeyWrap" ADD CONSTRAINT "AgencyCryptoOwnerKeyWrap_createdByDeviceId_fkey" FOREIGN KEY ("createdByDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AgencyCryptoRoot" ADD CONSTRAINT "AgencyCryptoRoot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyCryptoRoot" ADD CONSTRAINT "AgencyCryptoRoot_initializedByDeviceId_fkey" FOREIGN KEY ("initializedByDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AgencyCryptoRootBridge" ADD CONSTRAINT "AgencyCryptoRootBridge_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyCryptoRootBridge" ADD CONSTRAINT "AgencyCryptoRootBridge_createdByDeviceId_fkey" FOREIGN KEY ("createdByDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AgencyCustomRole" ADD CONSTRAINT "AgencyCustomRole_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyInvitation" ADD CONSTRAINT "AgencyInvitation_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyInvitation" ADD CONSTRAINT "AgencyInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyMember" ADD CONSTRAINT "AgencyMember_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyMember" ADD CONSTRAINT "AgencyMember_assignedCreators_cardinality_check" CHECK ((cardinality(phase2_scope_creator_ids("assignedCreators")) <= 10000));

ALTER TABLE "AgencyMember" ADD CONSTRAINT "AgencyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyMemberCreatorAccessCurrent" ADD CONSTRAINT "AgencyMemberCreatorAccessCurrent_claimShard_check" CHECK ((("claimShard" >= 0) AND ("claimShard" < 128)));

ALTER TABLE "AgencyProxyEndpoint" ADD CONSTRAINT "AgencyProxyEndpoint_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyProxyEndpoint" ADD CONSTRAINT "AgencyProxyEndpoint_agencyId_ownerCreatorId_fkey" FOREIGN KEY ("agencyId", "ownerCreatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyRoleOverride" ADD CONSTRAINT "AgencyRoleOverride_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencySubPermissionOverride" ADD CONSTRAINT "AgencySubPermissionOverride_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AgencyTelegramMtprotoAccount" ADD CONSTRAINT "AgencyTelegramMtprotoAccount_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AnalyticsCollectionDemand" ADD CONSTRAINT "AnalyticsCollectionDemand_member_scope_shape_check" CHECK ((("scopeMode" <> 'MEMBER_CURRENT'::text) OR ("creatorIds" IS NULL) OR ("creatorIds" = 'null'::jsonb)));

ALTER TABLE "AnalyticsCollectionDemand" ADD CONSTRAINT "AnalyticsCollectionDemand_scopeMode_check" CHECK (("scopeMode" = ANY (ARRAY['LEGACY'::text, 'MEMBER_CURRENT'::text])));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_complete_state_check" CHECK (((status <> 'COMPLETE'::"AnalyticsCoverageStatus") OR (("lastErrorCode" IS NULL) AND ("lastErrorMessage" IS NULL) AND ("retryAfterAt" IS NULL))));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_error_state_check" CHECK (((status <> ALL (ARRAY['FAILED'::"AnalyticsCoverageStatus", 'UNAVAILABLE'::"AnalyticsCoverageStatus"])) OR (("lastErrorCode" IS NOT NULL) AND (length(btrim("lastErrorCode")) > 0))));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_ingestBatchId_fkey" FOREIGN KEY ("ingestBatchId") REFERENCES "AnalyticsIngestBatch"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_metadata_length_check" CHECK ((((length(btrim("sourceTimezone")) >= 1) AND (length(btrim("sourceTimezone")) <= 100)) AND (("sourceCursorStart" IS NULL) OR (length("sourceCursorStart") <= 500)) AND (("sourceCursorEnd" IS NULL) OR (length("sourceCursorEnd") <= 500)) AND (("lastErrorCode" IS NULL) OR (length("lastErrorCode") <= 120)) AND (("lastErrorMessage" IS NULL) OR (length("lastErrorMessage") <= 2000))));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_missing_state_check" CHECK (((status <> 'MISSING'::"AnalyticsCoverageStatus") OR (("coveredFromAt" IS NULL) AND ("coveredToAt" IS NULL) AND ("sourceCursorStart" IS NULL) AND ("sourceCursorEnd" IS NULL))));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_non_empty_timezone_check" CHECK ((length(btrim("sourceTimezone")) > 0));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_notification_complete_day_check" CHECK ((("dataType" <> ALL (ARRAY['NOTIFICATION_PURCHASES'::"AnalyticsDataType", 'NOTIFICATION_TIPS'::"AnalyticsDataType", 'NOTIFICATION_SUBSCRIPTIONS'::"AnalyticsDataType", 'NOTIFICATION_LIKES'::"AnalyticsDataType", 'NOTIFICATION_COMMENTS'::"AnalyticsDataType"])) OR (status <> 'COMPLETE'::"AnalyticsCoverageStatus") OR (("sourceTimezone" = 'UTC'::text) AND ("coveredFromAt" = ("coverageDate")::timestamp without time zone) AND ("coveredToAt" >= ((("coverageDate")::timestamp without time zone + '1 day'::interval) - '00:00:00.001'::interval)))));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_notification_interval_day_check" CHECK ((("dataType" <> ALL (ARRAY['NOTIFICATION_PURCHASES'::"AnalyticsDataType", 'NOTIFICATION_TIPS'::"AnalyticsDataType", 'NOTIFICATION_SUBSCRIPTIONS'::"AnalyticsDataType", 'NOTIFICATION_LIKES'::"AnalyticsDataType", 'NOTIFICATION_COMMENTS'::"AnalyticsDataType"])) OR ((("coveredFromAt" IS NULL) OR ("coveredFromAt" >= ("coverageDate")::timestamp without time zone)) AND (("coveredToAt" IS NULL) OR ("coveredToAt" < (("coverageDate")::timestamp without time zone + '1 day'::interval))) AND (("coveredFromAt" IS NULL) OR ("coveredToAt" IS NULL) OR ("coveredFromAt" <= "coveredToAt")))));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_partial_evidence_check" CHECK (((status <> 'PARTIAL'::"AnalyticsCoverageStatus") OR ("coveredFromAt" IS NOT NULL) OR ("coveredToAt" IS NOT NULL) OR ("sourceCursorStart" IS NOT NULL) OR ("sourceCursorEnd" IS NOT NULL)));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_scanProofId_fkey" FOREIGN KEY ("scanProofId") REFERENCES "AnalyticsScanProof"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_valid_interval_check" CHECK ((("coveredFromAt" IS NULL) OR ("coveredToAt" IS NULL) OR ("coveredToAt" >= "coveredFromAt")));

ALTER TABLE "AnalyticsCoverage" ADD CONSTRAINT "AnalyticsCoverage_verified_state_check" CHECK (((status <> ALL (ARRAY['PARTIAL'::"AnalyticsCoverageStatus", 'COMPLETE'::"AnalyticsCoverageStatus", 'FAILED'::"AnalyticsCoverageStatus", 'UNAVAILABLE'::"AnalyticsCoverageStatus"])) OR ("lastVerifiedAt" IS NOT NULL)));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_checksum_check" CHECK (("payloadChecksum" ~ '^[A-Fa-f0-9]{64}$'::text));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_committed_counts_check" CHECK (((status <> 'COMMITTED'::"AnalyticsIngestStatus") OR (((("insertedRows" + "updatedRows") + "unchangedRows") = "receivedRows") AND ("rejectedRows" = 0))));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_failed_error_check" CHECK (((status <> 'FAILED'::"AnalyticsIngestStatus") OR (("lastErrorCode" IS NOT NULL) AND (length(btrim("lastErrorCode")) > 0))));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_metadata_length_check" CHECK ((((length(btrim("idempotencyKey")) >= 8) AND (length(btrim("idempotencyKey")) <= 240)) AND ((length(btrim("sourceTimezone")) >= 1) AND (length(btrim("sourceTimezone")) <= 100)) AND ((length(btrim("collectorVersion")) >= 1) AND (length(btrim("collectorVersion")) <= 80)) AND (("lastErrorCode" IS NULL) OR (length("lastErrorCode") <= 120)) AND (("lastErrorMessage" IS NULL) OR (length("lastErrorMessage") <= 2000))));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_non_empty_metadata_check" CHECK (((length(btrim("idempotencyKey")) > 0) AND (length(btrim("sourceTimezone")) > 0) AND (length(btrim("collectorVersion")) > 0)));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_non_negative_counts_check" CHECK ((("receivedRows" >= 0) AND ("insertedRows" >= 0) AND ("updatedRows" >= 0) AND ("unchangedRows" >= 0) AND ("rejectedRows" >= 0)));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_notification_schema_check" CHECK ((("dataType" <> 'NOTIFICATIONS'::"AnalyticsDataType") OR ("schemaVersion" >= 3)));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_positive_schema_version_check" CHECK (("schemaVersion" > 0));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_processed_counts_check" CHECK ((((("insertedRows" + "updatedRows") + "unchangedRows") + "rejectedRows") <= "receivedRows"));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_rejected_counts_check" CHECK (((status <> 'REJECTED'::"AnalyticsIngestStatus") OR ("rejectedRows" = "receivedRows")));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_terminal_state_check" CHECK ((((status = 'RECEIVED'::"AnalyticsIngestStatus") AND ("completedAt" IS NULL)) OR ((status <> 'RECEIVED'::"AnalyticsIngestStatus") AND ("completedAt" IS NOT NULL))));

ALTER TABLE "AnalyticsIngestBatch" ADD CONSTRAINT "AnalyticsIngestBatch_valid_range_check" CHECK (("rangeTo" >= "rangeFrom"));

ALTER TABLE "AnalyticsPlanningBudget" ADD CONSTRAINT "AnalyticsPlanningBudget_reservedCalls_check" CHECK (("reservedCalls" >= 0));

ALTER TABLE "AnalyticsPlanningBudget" ADD CONSTRAINT "AnalyticsPlanningBudget_reservedJobs_check" CHECK (("reservedJobs" >= 0));

ALTER TABLE "AnalyticsPublication" ADD CONSTRAINT "AnalyticsPublication_attempts_check" CHECK ((attempts >= 0));

ALTER TABLE "AnalyticsPublication" ADD CONSTRAINT "AnalyticsPublication_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "JobInstance"(id) ON DELETE CASCADE;

ALTER TABLE "AnalyticsPublication" ADD CONSTRAINT "AnalyticsPublication_state_check" CHECK ((state = ANY (ARRAY['PENDING'::text, 'COMMITTED'::text, 'REJECTED'::text, 'CANCELLED'::text])));

ALTER TABLE "AnalyticsPublicationInputClock" ADD CONSTRAINT "AnalyticsPublicationInputClock_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "JobInstance"(id) ON DELETE CASCADE;

ALTER TABLE "AnalyticsScanProof" ADD CONSTRAINT "AnalyticsScanProof_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AuthMailOutbox" ADD CONSTRAINT "AuthMailOutbox_authTokenId_fkey" FOREIGN KEY ("authTokenId") REFERENCES "AuthToken"(id) ON DELETE CASCADE;

ALTER TABLE "AuthMailOutbox" ADD CONSTRAINT "AuthMailOutbox_status" CHECK ((status = ANY (ARRAY['PENDING'::text, 'COMMITTING'::text, 'UNKNOWN'::text, 'SENT'::text, 'FAILED'::text, 'EXPIRED'::text])));

ALTER TABLE "AuthMailOutbox" ADD CONSTRAINT "AuthMailOutbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE;

ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationBumpFanState" ADD CONSTRAINT "AutomationBumpFanState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationBumpFanState" ADD CONSTRAINT "AutomationBumpFanState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationContentCandidate" ADD CONSTRAINT "AutomationContentCandidate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationContentCandidate" ADD CONSTRAINT "AutomationContentCandidate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationContentDiscoveryState" ADD CONSTRAINT "AutomationContentDiscoveryState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationContentDiscoveryState" ADD CONSTRAINT "AutomationContentDiscoveryState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationControlState" ADD CONSTRAINT "AutomationControlState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationControlState" ADD CONSTRAINT "AutomationControlState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationDelivery" ADD CONSTRAINT "AutomationDelivery_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationDelivery" ADD CONSTRAINT "AutomationDelivery_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationMonthlyAggregate" ADD CONSTRAINT "AutomationMonthlyAggregate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AutomationMonthlyAggregate" ADD CONSTRAINT "AutomationMonthlyAggregate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "AvatarAsset" ADD CONSTRAINT "AvatarAsset_mime" CHECK (("mimeType" = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])));

ALTER TABLE "AvatarAsset" ADD CONSTRAINT "AvatarAsset_size" CHECK (((octet_length(bytes) >= 1) AND (octet_length(bytes) <= 3145728)));

ALTER TABLE "BillingOrder" ADD CONSTRAINT "BillingOrder_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "BillingOrderLine" ADD CONSTRAINT "BillingOrderLine_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "BillingOrderLine" ADD CONSTRAINT "BillingOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BillingOrder"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "BillingPaymentAttempt" ADD CONSTRAINT "BillingPaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BillingOrder"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "BillingProviderEvent" ADD CONSTRAINT "BillingProviderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BillingOrder"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "BillingProviderEvent" ADD CONSTRAINT "BillingProviderEvent_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "BillingPaymentAttempt"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "BillingReconciliationCursor" ADD CONSTRAINT "BillingReconciliationCursor_nonnegative" CHECK (((cycle >= 0) AND ("failureCount" >= 0)));

ALTER TABLE "BillingReconciliationCursor" ADD CONSTRAINT "BillingReconciliationCursor_owner_lease" CHECK ((("ownerToken" IS NULL) = ("leaseUntil" IS NULL)));

ALTER TABLE "BillingWalletTransaction" ADD CONSTRAINT "BillingWalletTransaction_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "BillingWalletTransaction" ADD CONSTRAINT "BillingWalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "AgencyBillingWallet"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CampaignFanRefreshPromotionSignal" ADD CONSTRAINT "CampaignFanRefreshPromotionSignal_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CampaignProjectionPolicy" ADD CONSTRAINT "CampaignProjectionPolicy_generation_check" CHECK ((generation > 0));

ALTER TABLE "CampaignProjectionPolicy" ADD CONSTRAINT "CampaignProjectionPolicy_id_check" CHECK ((id = 'active'::text));

ALTER TABLE "CampaignProjectionPolicy" ADD CONSTRAINT "CampaignProjectionPolicy_valueFreshnessMs_check" CHECK (("valueFreshnessMs" >= 60000));

ALTER TABLE "CampaignReadChange" ADD CONSTRAINT "CampaignReadChange_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "CampaignReadMetric" ADD CONSTRAINT "CampaignReadMetric_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "CampaignReadReceipt" ADD CONSTRAINT "CampaignReadReceipt_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "CampaignReadRepair" ADD CONSTRAINT "CampaignReadRepair_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "CampaignReadRepairInterval" ADD CONSTRAINT "CampaignReadRepairInterval_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "CampaignReadRepairInterval" ADD CONSTRAINT "CampaignReadRepairInterval_check" CHECK ((("untilAt" IS NULL) OR ("untilAt" > "fromAt")));

ALTER TABLE "CampaignReadStateData" ADD CONSTRAINT "CampaignReadStateData_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "ContentBlock" ADD CONSTRAINT "ContentBlock_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ContentCollection"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ContentCollection" ADD CONSTRAINT "ContentCollection_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ContentCollection" ADD CONSTRAINT "ContentCollection_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorAccount" ADD CONSTRAINT "CreatorAccount_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorAnalyticsDay" ADD CONSTRAINT "CreatorAnalyticsDay_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorAnalyticsDayMember" ADD CONSTRAINT "CreatorAnalyticsDayMember_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorAnalyticsDayMember" ADD CONSTRAINT "CreatorAnalyticsDayMember_refs_check" CHECK ((refs > 0));

ALTER TABLE "CreatorAnalyticsFactPublication" ADD CONSTRAINT "CreatorAnalyticsFactPublication_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorAnalyticsPublicationState" ADD CONSTRAINT "CreatorAnalyticsPublicationState_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorBillingEntitlement" ADD CONSTRAINT "CreatorBillingEntitlement_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorBillingEntitlement" ADD CONSTRAINT "CreatorBillingEntitlement_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorBillingPeriod" ADD CONSTRAINT "CreatorBillingPeriod_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorBillingProfile" ADD CONSTRAINT "CreatorBillingProfile_override_prices_valid" CHECK (((("corePriceOverrideCents" IS NULL) OR ("corePriceOverrideCents" >= 0)) AND (("aiChatterPriceOverrideCents" IS NULL) OR ("aiChatterPriceOverrideCents" >= 0)) AND (("outreachPriceOverrideCents" IS NULL) OR ("outreachPriceOverrideCents" >= 0))));

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "CreatorCampaign_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "CreatorCampaign_counts_check" CHECK (((("claimersCount" IS NULL) OR ("claimersCount" >= 0)) AND (("clicksCount" IS NULL) OR ("clicksCount" >= 0))));

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "CreatorCampaign_identity_check" CHECK ((((length(btrim("externalCampaignId")) >= 1) AND (length(btrim("externalCampaignId")) <= 220)) AND ((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 500)) AND (("campaignType" IS NULL) OR (length("campaignType") <= 80)) AND (("trackingCode" IS NULL) OR (length("trackingCode") <= 220)) AND (("trackingUrl" IS NULL) OR (length("trackingUrl") <= 4000))));

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "CreatorCampaign_scan_generation_pair_check" CHECK ((("sourceScanRunId" IS NULL) = ("sourceScanStartedAt" IS NULL)));

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "CreatorCampaign_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "CreatorCampaign_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "CreatorCampaign_sourceScanRunId_length_check" CHECK ((("sourceScanRunId" IS NULL) OR ((length("sourceScanRunId") >= 1) AND (length("sourceScanRunId") <= 120))));

ALTER TABLE "CreatorCampaign" ADD CONSTRAINT "campaign_fair_cursor_nonnegative" CHECK ((("claimersCursorPage" >= 0) AND ("claimersCursorOffset" >= 0)));

ALTER TABLE "CreatorCampaignCollectionState" ADD CONSTRAINT "CreatorCampaignCollectionState_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCampaignCollectionState" ADD CONSTRAINT "CreatorCampaignCollectionState_completion_nonnegative_chk" CHECK ((("campaignProofCampaignBatches" >= 0) AND ("campaignProofClaimerBatches" >= 0) AND ("campaignProofRejectedBatches" >= 0) AND ("campaignProofRejectedRows" >= 0)));

ALTER TABLE "CreatorCampaignCollectionState" ADD CONSTRAINT "CreatorCampaignCollectionState_fan_value_coverage_nonnegative" CHECK ((("fanValueExpected" >= 0) AND ("fanValueAlreadyFresh" >= 0) AND ("fanValueQueued" >= 0) AND ("fanValueSucceeded" >= 0) AND ("fanValueUnavailable" >= 0) AND ("fanValueFailed" >= 0) AND ("fanValueOutstanding" >= 0)));

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_creatorId_campaignId_fkey" FOREIGN KEY ("creatorId", "campaignId") REFERENCES "CreatorCampaign"("creatorId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_identity_check" CHECK ((("externalClaimerId" IS NULL) OR ((length(btrim("externalClaimerId")) >= 1) AND (length(btrim("externalClaimerId")) <= 220))));

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_scan_generation_pair_check" CHECK ((("sourceScanRunId" IS NULL) = ("sourceScanStartedAt" IS NULL)));

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_sourceScanRunId_length_check" CHECK ((("sourceScanRunId" IS NULL) OR ((length("sourceScanRunId") >= 1) AND (length("sourceScanRunId") <= 120))));

ALTER TABLE "CreatorCampaignFan" ADD CONSTRAINT "CreatorCampaignFan_subscriptionEvent_fkey" FOREIGN KEY ("subscriptionEventId") REFERENCES "CreatorSubscriptionEvent"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorCampaignFanRefreshWork" ADD CONSTRAINT "CreatorCampaignFanRefreshWork_campaignJob_fkey" FOREIGN KEY ("campaignJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCampaignFanRefreshWork" ADD CONSTRAINT "CreatorCampaignFanRefreshWork_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCampaignFanRefreshWork" ADD CONSTRAINT "CreatorCampaignFanRefreshWork_demand_fkey" FOREIGN KEY ("demandId") REFERENCES "CreatorFanRefreshDemand"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorCampaignFanRefreshWork" ADD CONSTRAINT "CreatorCampaignFanRefreshWork_refreshJob_fkey" FOREIGN KEY ("refreshJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorCampaignFrontierFan" ADD CONSTRAINT "CreatorCampaignFrontierFan_creatorId_campaignId_fkey" FOREIGN KEY ("creatorId", "campaignId") REFERENCES "CreatorCampaign"("creatorId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCryptoKeyState" ADD CONSTRAINT "CreatorCryptoKeyState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorCryptoKeyState" ADD CONSTRAINT "CreatorCryptoKeyState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorDailyMetrics" ADD CONSTRAINT "CreatorDailyMetrics_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorDailyMetrics" ADD CONSTRAINT "CreatorDailyMetrics_non_negative_check" CHECK ((("incomingMessages" >= 0) AND ("outgoingMessages" >= 0) AND ("uniqueDialogs" >= 0) AND (likes >= 0) AND ("uniqueLikingFans" >= 0) AND (comments >= 0) AND ("uniqueCommentingFans" >= 0) AND ("newSubscribers" >= 0) AND (renewals >= 0) AND ("expiredSubscribers" >= 0) AND ("autoRenewDisabled" >= 0) AND ("messageSales" >= 0) AND ("postSales" >= 0) AND ("uniqueBuyers" >= 0) AND ("tipsCount" >= 0) AND ("tipsCents" >= 0) AND ("paidSubscriptions" >= 0) AND ("paidSubscriptionsCents" >= 0) AND ("salesCents" >= 0) AND ("totalObservedRevenueCents" >= 0) AND ("dataVersion" > 0)));

ALTER TABLE "CreatorDailyMetrics" ADD CONSTRAINT "CreatorDailyMetrics_timezone_check" CHECK (("sourceTimezone" = 'UTC'::text));

ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorCryptoKeyState"("agencyId", "creatorId") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_createdByDeviceId_fkey" FOREIGN KEY ("createdByDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorDeviceKeyWrap" ADD CONSTRAINT "CreatorDeviceKeyWrap_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_currency_check" CHECK ((currency ~ '^[A-Z]{3}$'::text));

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_non_negative_check" CHECK (((("subscriptionsCents" IS NULL) OR ("subscriptionsCents" >= 0)) AND (("messagesCents" IS NULL) OR ("messagesCents" >= 0)) AND (("tipsCents" IS NULL) OR ("tipsCents" >= 0)) AND (("postsCents" IS NULL) OR ("postsCents" >= 0)) AND (("streamsCents" IS NULL) OR ("streamsCents" >= 0)) AND (("referralsCents" IS NULL) OR ("referralsCents" >= 0)) AND ("totalCents" >= 0)));

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_scanProofId_fkey" FOREIGN KEY ("scanProofId") REFERENCES "AnalyticsScanProof"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_scan_run_check" CHECK ((("sourceScanRunId" IS NULL) OR ((length(btrim("sourceScanRunId")) >= 1) AND (length(btrim("sourceScanRunId")) <= 120))));

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorEarningsDaily" ADD CONSTRAINT "CreatorEarningsDaily_timezone_check" CHECK (("sourceTimezone" = 'UTC'::text));

ALTER TABLE "CreatorEarningsTotal" ADD CONSTRAINT "CreatorEarningsTotal_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorEarningsTotal" ADD CONSTRAINT "CreatorEarningsTotal_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorEarningsTotal" ADD CONSTRAINT "CreatorEarningsTotal_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFan" ADD CONSTRAINT "CreatorFan_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFan" ADD CONSTRAINT "CreatorFan_identity_length_check" CHECK ((((length(btrim("onlyFansUserId")) >= 1) AND (length(btrim("onlyFansUserId")) <= 200)) AND ((username IS NULL) OR (length(username) <= 200)) AND (("displayName" IS NULL) OR (length("displayName") <= 500))));

ALTER TABLE "CreatorFan" ADD CONSTRAINT "CreatorFan_non_empty_onlyfans_id_check" CHECK ((length(btrim("onlyFansUserId")) > 0));

ALTER TABLE "CreatorFan" ADD CONSTRAINT "CreatorFan_seen_range_check" CHECK (("lastSeenAt" >= "firstSeenAt"));

ALTER TABLE "CreatorFanRefreshDemand" ADD CONSTRAINT "CreatorFanRefreshDemand_active_job_fkey" FOREIGN KEY ("activeRefreshJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFanRefreshDemand" ADD CONSTRAINT "CreatorFanRefreshDemand_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFanRefreshDemand" ADD CONSTRAINT "CreatorFanRefreshDemand_revision_nonnegative" CHECK ((("requestedRevision" >= 1) AND ("satisfiedRevision" >= 0) AND ("satisfiedRevision" <= "requestedRevision") AND (("activeRefreshRevision" IS NULL) OR (("activeRefreshRevision" >= 1) AND ("activeRefreshRevision" <= "requestedRevision")))));

ALTER TABLE "CreatorFanRelationshipCurrent" ADD CONSTRAINT "CreatorFanRelationshipCurrent_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFanRelationshipCurrent" ADD CONSTRAINT "CreatorFanRelationshipCurrent_creatorId_fanRecordId_fkey" FOREIGN KEY ("creatorId", "fanRecordId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFanRelationshipCurrent" ADD CONSTRAINT "CreatorFanRelationshipCurrent_sourceDeliveryId_fkey" FOREIGN KEY ("sourceDeliveryId") REFERENCES "AutomationDelivery"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFanRelationshipCurrent" ADD CONSTRAINT "CreatorFanRelationshipCurrent_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFanRelationshipCurrent" ADD CONSTRAINT "CreatorFanRelationshipCurrent_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFanValueCurrent" ADD CONSTRAINT "CreatorFanValueCurrent_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFanValueCurrent" ADD CONSTRAINT "CreatorFanValueCurrent_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFanValueCurrent" ADD CONSTRAINT "CreatorFanValueCurrent_sourceDeliveryId_fkey" FOREIGN KEY ("sourceDeliveryId") REFERENCES "AutomationDelivery"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFanValueCurrent" ADD CONSTRAINT "CreatorFanValueCurrent_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFanValueCurrent" ADD CONSTRAINT "CreatorFanValueCurrent_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFinancialCollectionState" ADD CONSTRAINT "CreatorFinancialCollectionState_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFinancialTransaction" ADD CONSTRAINT "CreatorFinancialTransaction_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorFinancialTransaction" ADD CONSTRAINT "CreatorFinancialTransaction_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorFinancialTransaction" ADD CONSTRAINT "CreatorFinancialTransaction_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorFinancialTransaction" ADD CONSTRAINT "CreatorFinancialTransaction_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorLocalMessageCoverage" ADD CONSTRAINT "CreatorLocalMessageCoverage_counts_check" CHECK ((("dialogsCovered" >= 0) AND ("messagesIndexed" >= 0)));

ALTER TABLE "CreatorLocalMessageCoverage" ADD CONSTRAINT "CreatorLocalMessageCoverage_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorLocalMessageCoverage" ADD CONSTRAINT "CreatorLocalMessageCoverage_dates_check" CHECK ((("oldestMessageAt" IS NULL) OR ("newestMessageAt" IS NULL) OR ("oldestMessageAt" <= "newestMessageAt")));

ALTER TABLE "CreatorLocalMessageCoverage" ADD CONSTRAINT "CreatorLocalMessageCoverage_device_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMediaAsset" ADD CONSTRAINT "CreatorMediaAsset_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMediaAsset" ADD CONSTRAINT "CreatorMediaAsset_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMediaAsset" ADD CONSTRAINT "CreatorMediaAsset_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorMediaAsset" ADD CONSTRAINT "CreatorMediaAsset_customSubmissionId_fkey" FOREIGN KEY ("customSubmissionId") REFERENCES "CustomContentSubmission"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorMediaUsageContribution" ADD CONSTRAINT "CreatorMediaUsageContribution_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMediaUsageContribution" ADD CONSTRAINT "CreatorMediaUsageContribution_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "CreatorMediaAsset"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMediaUsageContribution" ADD CONSTRAINT "CreatorMediaUsageContribution_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMediaUsageSourceState" ADD CONSTRAINT "CreatorMediaUsageSourceState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMediaUsageSourceState" ADD CONSTRAINT "CreatorMediaUsageSourceState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMessagesDaily" ADD CONSTRAINT "CreatorMessagesDaily_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorMessagesDaily" ADD CONSTRAINT "CreatorMessagesDaily_counts_check" CHECK ((("incomingMessages" >= 0) AND ("outgoingMessages" >= 0) AND ("totalMessages" >= 0) AND ("uniqueDialogs" >= 0) AND ("uniqueIncomingFans" >= 0) AND ("uniqueOutgoingFans" >= 0) AND ("totalMessages" = ("incomingMessages" + "outgoingMessages"))));

ALTER TABLE "CreatorMessagesDaily" ADD CONSTRAINT "CreatorMessagesDaily_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorMessagesDaily" ADD CONSTRAINT "CreatorMessagesDaily_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorMessagesDaily" ADD CONSTRAINT "CreatorMessagesDaily_timezone_check" CHECK (("sourceTimezone" = 'UTC'::text));

ALTER TABLE "CreatorMessagesDaily" ADD CONSTRAINT "CreatorMessagesDaily_unique_fans_check" CHECK ((("uniqueIncomingFans" <= "uniqueDialogs") AND ("uniqueOutgoingFans" <= "uniqueDialogs")));

ALTER TABLE "CreatorNetworkProfile" ADD CONSTRAINT "CreatorNetworkProfile_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorNetworkProfile" ADD CONSTRAINT "CreatorNetworkProfile_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorNetworkProfile" ADD CONSTRAINT "CreatorNetworkProfile_proxyEndpointId_fkey" FOREIGN KEY ("agencyId", "proxyEndpointId") REFERENCES "AgencyProxyEndpoint"("agencyId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorNotificationScanItem" ADD CONSTRAINT "CreatorNotificationScanItem_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorNotificationScanItem" ADD CONSTRAINT "CreatorNotificationScanItem_lengths_check" CHECK (((("notificationId" IS NULL) OR (length("notificationId") <= 220)) AND (("sourceType" IS NULL) OR (length("sourceType") <= 120)) AND (("sourceSubType" IS NULL) OR (length("sourceSubType") <= 160)) AND (("fanOnlyFansUserId" IS NULL) OR (length("fanOnlyFansUserId") <= 180)) AND (("postId" IS NULL) OR (length("postId") <= 220)) AND (("commentId" IS NULL) OR (length("commentId") <= 220)) AND (("messageId" IS NULL) OR (length("messageId") <= 220)) AND (("amountCents" IS NULL) OR (abs(("amountCents")::bigint) <= 2147483647)) AND ((currency IS NULL) OR (currency ~ '^[A-Z]{3}$'::text)) AND (("reasonCode" IS NULL) OR (length("reasonCode") <= 160))));

ALTER TABLE "CreatorNotificationScanItem" ADD CONSTRAINT "CreatorNotificationScanItem_page_ordinal_check" CHECK (((page > 0) AND (ordinal >= 0) AND (ordinal < 100)));

ALTER TABLE "CreatorNotificationScanItem" ADD CONSTRAINT "CreatorNotificationScanItem_scanRunId_check" CHECK (((length("scanRunId") >= 8) AND (length("scanRunId") <= 80)));

ALTER TABLE "CreatorNotificationScanItem" ADD CONSTRAINT "CreatorNotificationScanItem_sourceJob_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorNotificationSyncState" ADD CONSTRAINT "CreatorNotificationSyncState_counts_check" CHECK ((("pagesScanned" >= 0) AND ("eventsAccepted" >= 0) AND ("eventsRejected" >= 0) AND ("ignoredEvents" >= 0)));

ALTER TABLE "CreatorNotificationSyncState" ADD CONSTRAINT "CreatorNotificationSyncState_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorNotificationSyncState" ADD CONSTRAINT "CreatorNotificationSyncState_cursor_length_check" CHECK (((("nextCursor" IS NULL) OR (length("nextCursor") <= 220)) AND (("headNotificationId" IS NULL) OR (length("headNotificationId") <= 220)) AND (("tailNotificationId" IS NULL) OR (length("tailNotificationId") <= 220))));

ALTER TABLE "CreatorNotificationSyncState" ADD CONSTRAINT "CreatorNotificationSyncState_mode_check" CHECK ((mode = ANY (ARRAY['full'::text, 'catchup'::text, 'live'::text])));

ALTER TABLE "CreatorNotificationSyncState" ADD CONSTRAINT "CreatorNotificationSyncState_scanRunId_check" CHECK ((("scanRunId" IS NULL) OR ((length("scanRunId") >= 8) AND (length("scanRunId") <= 80))));

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_amount_check" CHECK (("amountCents" > 0));

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_currency_check" CHECK ((currency ~ '^[A-Z]{3}$'::text));

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_fan_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_fingerprint_check" CHECK (((length(btrim("eventFingerprint")) >= 32) AND (length(btrim("eventFingerprint")) <= 64)));

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_period_check" CHECK ((("periodFrom" IS NULL) OR ("periodTo" IS NULL) OR ("periodFrom" <= "periodTo")));

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_sourceDevice_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_sourceJob_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorPaidSubscription" ADD CONSTRAINT "CreatorPaidSubscription_subscriptionEvent_fkey" FOREIGN KEY ("subscriptionEventId") REFERENCES "CreatorSubscriptionEvent"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorPostComment" ADD CONSTRAINT "CreatorPostComment_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorPostComment" ADD CONSTRAINT "CreatorPostComment_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorPostComment" ADD CONSTRAINT "CreatorPostComment_identity_check" CHECK ((((length(btrim("eventFingerprint")) >= 32) AND (length(btrim("eventFingerprint")) <= 64)) AND ((length(btrim("onlyFansPostId")) >= 1) AND (length(btrim("onlyFansPostId")) <= 220)) AND (("onlyFansCommentId" IS NULL) OR ((length(btrim("onlyFansCommentId")) >= 1) AND (length(btrim("onlyFansCommentId")) <= 220))) AND (("externalNotificationId" IS NULL) OR ((length(btrim("externalNotificationId")) >= 1) AND (length(btrim("externalNotificationId")) <= 220))) AND (("externalNotificationId" IS NOT NULL) OR ("onlyFansCommentId" IS NOT NULL))));

ALTER TABLE "CreatorPostComment" ADD CONSTRAINT "CreatorPostComment_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorPostComment" ADD CONSTRAINT "CreatorPostComment_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorPostLike" ADD CONSTRAINT "CreatorPostLike_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorPostLike" ADD CONSTRAINT "CreatorPostLike_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorPostLike" ADD CONSTRAINT "CreatorPostLike_identity_check" CHECK ((((length(btrim("eventFingerprint")) >= 32) AND (length(btrim("eventFingerprint")) <= 64)) AND ((length(btrim("onlyFansPostId")) >= 1) AND (length(btrim("onlyFansPostId")) <= 220)) AND (("externalNotificationId" IS NULL) OR ((length(btrim("externalNotificationId")) >= 1) AND (length(btrim("externalNotificationId")) <= 220))) AND (("onlyFansLikeId" IS NULL) OR ((length(btrim("onlyFansLikeId")) >= 1) AND (length(btrim("onlyFansLikeId")) <= 220))) AND (("externalNotificationId" IS NOT NULL) OR ("onlyFansLikeId" IS NOT NULL))));

ALTER TABLE "CreatorPostLike" ADD CONSTRAINT "CreatorPostLike_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorPostLike" ADD CONSTRAINT "CreatorPostLike_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_amount_positive_check" CHECK (("amountCents" > 0));

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_currency_format_check" CHECK ((currency ~ '^[A-Z]{3}$'::text));

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_identity_length_check" CHECK ((((length(btrim("eventFingerprint")) >= 32) AND (length(btrim("eventFingerprint")) <= 64)) AND (("externalNotificationId" IS NULL) OR (length("externalNotificationId") <= 220)) AND (("externalTransactionId" IS NULL) OR (length("externalTransactionId") <= 220)) AND (("messageId" IS NULL) OR (length("messageId") <= 220)) AND (("postId" IS NULL) OR (length("postId") <= 220)) AND ((length(btrim(currency)) >= 3) AND (length(btrim(currency)) <= 8))));

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSale" ADD CONSTRAINT "CreatorSale_target_consistency_check" CHECK (((("saleType" = 'MESSAGE'::"CreatorSaleType") AND ("postId" IS NULL) AND (("messageId" IS NOT NULL) OR ("externalTransactionId" IS NOT NULL))) OR (("saleType" = 'POST'::"CreatorSaleType") AND ("messageId" IS NULL) AND (("postId" IS NOT NULL) OR ("externalTransactionId" IS NOT NULL))) OR (("saleType" = ANY (ARRAY['STREAM'::"CreatorSaleType", 'OTHER'::"CreatorSaleType"])) AND (NOT (("messageId" IS NOT NULL) AND ("postId" IS NOT NULL))))));

ALTER TABLE "CreatorSessionState" ADD CONSTRAINT "CreatorSessionState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorSessionState" ADD CONSTRAINT "CreatorSessionState_capturedByDeviceId_fkey" FOREIGN KEY ("capturedByDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSessionState" ADD CONSTRAINT "CreatorSessionState_capturedByUserId_fkey" FOREIGN KEY ("capturedByUserId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSessionState" ADD CONSTRAINT "CreatorSessionState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorSubscriptionEvent" ADD CONSTRAINT "CreatorSubscriptionEvent_agency_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorSubscriptionEvent" ADD CONSTRAINT "CreatorSubscriptionEvent_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorSubscriptionEvent" ADD CONSTRAINT "CreatorSubscriptionEvent_currency_format_check" CHECK ((currency ~ '^[A-Z]{3}$'::text));

ALTER TABLE "CreatorSubscriptionEvent" ADD CONSTRAINT "CreatorSubscriptionEvent_identity_length_check" CHECK ((((length(btrim("eventFingerprint")) >= 32) AND (length(btrim("eventFingerprint")) <= 64)) AND (("externalNotificationId" IS NULL) OR (length("externalNotificationId") <= 220)) AND (("externalTransactionId" IS NULL) OR (length("externalTransactionId") <= 220)) AND ((length(btrim(currency)) >= 3) AND (length(btrim(currency)) <= 8))));

ALTER TABLE "CreatorSubscriptionEvent" ADD CONSTRAINT "CreatorSubscriptionEvent_price_semantics_check" CHECK (((("eventType" = 'SUBSCRIBED_FREE'::"CreatorSubscriptionEventType") AND ("observedPriceCents" = 0)) OR (("eventType" = 'SUBSCRIBED_PAID'::"CreatorSubscriptionEventType") AND ("observedPriceCents" > 0)) OR (("eventType" <> ALL (ARRAY['SUBSCRIBED_FREE'::"CreatorSubscriptionEventType", 'SUBSCRIBED_PAID'::"CreatorSubscriptionEventType"])) AND (("observedPriceCents" IS NULL) OR ("observedPriceCents" >= 0)))));

ALTER TABLE "CreatorSubscriptionEvent" ADD CONSTRAINT "CreatorSubscriptionEvent_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSubscriptionEvent" ADD CONSTRAINT "CreatorSubscriptionEvent_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSubscriptionLedger" ADD CONSTRAINT "CreatorSubscriptionLedger_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorSubscriptionLedger" ADD CONSTRAINT "CreatorSubscriptionLedger_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorSubscriptionLedger" ADD CONSTRAINT "CreatorSubscriptionLedger_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrafficSource"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorSubscriptionState" ADD CONSTRAINT "CreatorSubscriptionState_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorSubscriptionState" ADD CONSTRAINT "CreatorSubscriptionState_currency_check" CHECK ((currency ~ '^[A-Z]{3}$'::text));

ALTER TABLE "CreatorSubscriptionState" ADD CONSTRAINT "CreatorSubscriptionState_dates_check" CHECK (((("startedAt" IS NULL) OR ("endedAt" IS NULL) OR ("startedAt" <= "endedAt")) AND (("startedAt" IS NULL) OR ("expiresAt" IS NULL) OR ("startedAt" <= "expiresAt"))));

ALTER TABLE "CreatorSubscriptionState" ADD CONSTRAINT "CreatorSubscriptionState_fan_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorSubscriptionState" ADD CONSTRAINT "CreatorSubscriptionState_price_check" CHECK ((("currentPriceCents" IS NULL) OR ("currentPriceCents" >= 0)));

ALTER TABLE "CreatorSubscriptionState" ADD CONSTRAINT "CreatorSubscriptionState_updatedFromEvent_fkey" FOREIGN KEY ("updatedFromEventId") REFERENCES "CreatorSubscriptionEvent"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorTaskActivity" ADD CONSTRAINT "CreatorTaskActivity_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorTip" ADD CONSTRAINT "CreatorTip_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CreatorTip" ADD CONSTRAINT "CreatorTip_amount_positive_check" CHECK (("amountCents" > 0));

ALTER TABLE "CreatorTip" ADD CONSTRAINT "CreatorTip_creatorId_fanId_fkey" FOREIGN KEY ("creatorId", "fanId") REFERENCES "CreatorFan"("creatorId", id) ON UPDATE CASCADE;

ALTER TABLE "CreatorTip" ADD CONSTRAINT "CreatorTip_currency_format_check" CHECK ((currency ~ '^[A-Z]{3}$'::text));

ALTER TABLE "CreatorTip" ADD CONSTRAINT "CreatorTip_identity_length_check" CHECK ((((length(btrim("eventFingerprint")) >= 32) AND (length(btrim("eventFingerprint")) <= 64)) AND (("externalNotificationId" IS NULL) OR (length("externalNotificationId") <= 220)) AND (("externalTransactionId" IS NULL) OR (length("externalTransactionId") <= 220)) AND (("messageId" IS NULL) OR (length("messageId") <= 220)) AND ((length(btrim(currency)) >= 3) AND (length(btrim(currency)) <= 8))));

ALTER TABLE "CreatorTip" ADD CONSTRAINT "CreatorTip_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CreatorTip" ADD CONSTRAINT "CreatorTip_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "JobInstance"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CustomContentReviewDecision" ADD CONSTRAINT "CustomContentReviewDecision_decision_valid" CHECK ((decision = ANY (ARRAY['APPROVE'::text, 'REQUEST_REVISION'::text])));

ALTER TABLE "CustomContentReviewDecision" ADD CONSTRAINT "CustomContentReviewDecision_revision_positive" CHECK (("decisionRevision" >= 1));

ALTER TABLE "CustomContentReviewDecision" ADD CONSTRAINT "CustomContentReviewDecision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "CustomContentSubmission"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomContentSubmission" ADD CONSTRAINT "CustomContentSubmission_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomContentSubmission" ADD CONSTRAINT "CustomContentSubmission_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomContentSubmission" ADD CONSTRAINT "CustomContentSubmission_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CustomContentSubmission" ADD CONSTRAINT "CustomContentSubmission_pipelineDisposition_check" CHECK (("pipelineDisposition" = ANY (ARRAY['ACTIVE'::text, 'SALVAGE'::text, 'ARCHIVED'::text, 'ABANDONED'::text])));

ALTER TABLE "CustomContentSubmission" ADD CONSTRAINT "CustomContentSubmission_reviewedByMemberId_fkey" FOREIGN KEY ("reviewedByMemberId") REFERENCES "AgencyMember"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "CustomDeliveryReceipt" ADD CONSTRAINT "CustomDeliveryReceipt_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomDeliveryReceipt" ADD CONSTRAINT "CustomDeliveryReceipt_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomDeliveryReceipt" ADD CONSTRAINT "CustomDeliveryReceipt_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "CustomContentSubmission"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_createdByMemberId_fkey" FOREIGN KEY ("createdByMemberId") REFERENCES "AgencyMember"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_telegramCancellationWaiver_pair_check" CHECK (((("telegramCancellationWaivedAt" IS NULL) AND ("telegramCancellationWaiverReason" IS NULL)) OR (("telegramCancellationWaivedAt" IS NOT NULL) AND (NULLIF(btrim("telegramCancellationWaiverReason"), ''::text) IS NOT NULL))));

ALTER TABLE "DeviceCreatorBinding" ADD CONSTRAINT "DeviceCreatorBinding_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DeviceCreatorBinding" ADD CONSTRAINT "DeviceCreatorBinding_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DeviceCreatorBinding" ADD CONSTRAINT "DeviceCreatorBinding_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DeviceCryptoIdentity" ADD CONSTRAINT "DeviceCryptoIdentity_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogReconciliationTarget" ADD CONSTRAINT "DialogReconciliationTarget_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogReconciliationTarget" ADD CONSTRAINT "DialogReconciliationTarget_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogScanChunkCommit" ADD CONSTRAINT "DialogScanChunkCommit_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogScanChunkCommit" ADD CONSTRAINT "DialogScanChunkCommit_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogScanChunkCommit" ADD CONSTRAINT "DialogScanChunkCommit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DialogScanRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogScanRun" ADD CONSTRAINT "DialogScanRun_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogScanRun" ADD CONSTRAINT "DialogScanRun_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogScanState" ADD CONSTRAINT "DialogScanState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DialogScanState" ADD CONSTRAINT "DialogScanState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DomainWorkClaimAgencyState" ADD CONSTRAINT "DomainWorkClaimAgencyState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DomainWorkClaimLocatorMutationIntent" ADD CONSTRAINT "DomainWorkClaimLocatorMutationIntent_txId_fkey" FOREIGN KEY ("txId") REFERENCES "DomainWorkClaimLocatorMutationBatch"("txId") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DomainWorkClaimShardState" ADD CONSTRAINT "DomainWorkClaimShardState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DomainWorkClaimShardState" ADD CONSTRAINT "DomainWorkClaimShardState_claimShard_check" CHECK ((("claimShard" >= 0) AND ("claimShard" < 128)));

ALTER TABLE "DomainWorkItem" ADD CONSTRAINT "DomainWorkItem_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "DomainWorkItem" ADD CONSTRAINT "DomainWorkItem_failure_counter_check" CHECK ((("failureRevision" >= 0) AND ("consecutiveFailures" >= 0)));

ALTER TABLE "DomainWorkMemberScopeShardState" ADD CONSTRAINT "DomainWorkMemberScopeShardState_claimShard_check" CHECK ((("claimShard" >= 0) AND ("claimShard" < 128)));

ALTER TABLE "FanConsumerCursor" ADD CONSTRAINT "FanConsumerCursor_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FanObservationCreatorClock" ADD CONSTRAINT "FanObservationCreatorClock_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FanObservationReadLease" ADD CONSTRAINT "FanObservationReadLease_exactly_one_owner_check" CHECK ((num_nonnulls("jobId", "deliveryId") = 1));

ALTER TABLE "FanObservationToken" ADD CONSTRAINT "FanObservationToken_exactly_one_owner_check" CHECK ((num_nonnulls("jobId", "deliveryId") = 1));

ALTER TABLE "FinancialObservedFact" ADD CONSTRAINT "FinancialObservedFact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinancialReceiptRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FinancialPageReceipt" ADD CONSTRAINT "FinancialPageReceipt_check" CHECK (((page > 0) AND ("windowIndex" >= 0) AND ("windowIndex" < 2) AND (received >= 0) AND (received <= 100) AND (rejected >= 0) AND (rejected <= 100)));

ALTER TABLE "FinancialPageReceipt" ADD CONSTRAINT "FinancialPageReceipt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinancialReceiptRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FinancialReceiptRun" ADD CONSTRAINT "FinancialReceiptRun_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FollowAutomationCandidate" ADD CONSTRAINT "FollowAutomationCandidate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FollowAutomationCandidate" ADD CONSTRAINT "FollowAutomationCandidate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FollowBackCandidate" ADD CONSTRAINT "FollowBackCandidate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "FollowBackCandidate" ADD CONSTRAINT "FollowBackCandidate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "HiddenOnlineUser" ADD CONSTRAINT "HiddenOnlineUser_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "HiddenOnlineUser" ADD CONSTRAINT "HiddenOnlineUser_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "HiddenOnlineUser" ADD CONSTRAINT "HiddenOnlineUser_status_authority_check" CHECK ((status = ANY (ARRAY['active'::text, 'ignored'::text, 'blocked'::text])));

ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "LoginAdmissionBucket" ADD CONSTRAINT "LoginAdmissionBucket_attempts_check" CHECK (((attempts >= 0) AND (attempts <= 10000)));

ALTER TABLE "MaintenanceAdmissionClassState" ADD CONSTRAINT "MaintenanceAdmissionClassState_ordinal_check" CHECK (((ordinal >= 0) AND (ordinal < 64)));

ALTER TABLE "MaintenanceAdmissionClassState" ADD CONSTRAINT "MaintenanceAdmissionClassState_turnCount_check" CHECK (("turnCount" >= 0));

ALTER TABLE "ManagementCommandReceipt" ADD CONSTRAINT "ManagementCommandReceipt_reference_bound" CHECK ((octet_length((reference)::text) <= 8192));

ALTER TABLE "ManagementCommandReceipt" ADD CONSTRAINT "ManagementCommandReceipt_status_check" CHECK ((status = ANY (ARRAY['COMMITTED'::text, 'ABANDONED'::text])));

ALTER TABLE "MassCreatorDeliveryState" ADD CONSTRAINT "MassCreatorDeliveryState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON DELETE CASCADE;

ALTER TABLE "MassCreatorDeliveryState" ADD CONSTRAINT "MassCreatorDeliveryState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON DELETE CASCADE;

ALTER TABLE "MassQueueObservation" ADD CONSTRAINT "MassQueueObservation_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON DELETE CASCADE;

ALTER TABLE "MassQueueObservation" ADD CONSTRAINT "MassQueueObservation_count_check" CHECK (((("receivedCount" >= 0) AND ("receivedCount" <= 100000)) AND (("itemCount" IS NULL) OR (("itemCount" >= 0) AND ("itemCount" <= 100000)))));

ALTER TABLE "MassQueueObservation" ADD CONSTRAINT "MassQueueObservation_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON DELETE CASCADE;

ALTER TABLE "MassQueueObservation" ADD CONSTRAINT "MassQueueObservation_phase_check" CHECK ((phase = ANY (ARRAY['PRESENT'::text, 'CURRENT'::text, 'FINAL'::text])));

ALTER TABLE "MassQueueObservation" ADD CONSTRAINT "MassQueueObservation_purpose_check" CHECK ((purpose = ANY (ARRAY['BROWSE'::text, 'RETIREMENT'::text])));

ALTER TABLE "MassQueueObservation" ADD CONSTRAINT "MassQueueObservation_status_check" CHECK ((status = ANY (ARRAY['OPEN'::text, 'READY'::text, 'APPLYING'::text, 'APPLIED'::text, 'EXPIRED'::text])));

ALTER TABLE "MassQueueObservationItem" ADD CONSTRAINT "MassQueueObservationItem_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "MassQueueObservation"(id) ON DELETE CASCADE;

ALTER TABLE "MassQueueObservationPage" ADD CONSTRAINT "MassQueueObservationPage_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "MassQueueObservation"(id) ON DELETE CASCADE;

ALTER TABLE "MediaLibraryScanItem" ADD CONSTRAINT "MediaLibraryScanItem_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "MediaLibraryScanItem" ADD CONSTRAINT "MediaLibraryScanItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "MessageLibraryCommandReceipt" ADD CONSTRAINT "MessageLibraryCommandReceipt_result_bound" CHECK ((octet_length((result)::text) <= 4194304));

ALTER TABLE "MessageLibraryCommandReceipt" ADD CONSTRAINT "MessageLibraryCommandReceipt_status_check" CHECK ((status = ANY (ARRAY['COMMITTED'::text, 'ABANDONED'::text])));

ALTER TABLE "ModuleSetting" ADD CONSTRAINT "ModuleSetting_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "MoneyAttribution" ADD CONSTRAINT "MoneyAttribution_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "NotificationFactReceipt" ADD CONSTRAINT "NotificationFactReceipt_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "OfProviderRequestGateState" ADD CONSTRAINT "OfProviderRequestGateState_fairnessActivationState_check" CHECK (("fairnessActivationState" = ANY (ARRAY['DRAINING'::text, 'QUIESCING'::text, 'ACTIVE'::text])));

ALTER TABLE "OperationalControlState" ADD CONSTRAINT "OperationalControlState_revision_check" CHECK ((revision >= 0));

ALTER TABLE "Phase2DependencyState" ADD CONSTRAINT "Phase2DependencyState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "Phase2WorkBroadClaimPartitionState" ADD CONSTRAINT "Phase2WorkBroadClaimPartitionState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "Phase2WorkBroadClaimPartitionState" ADD CONSTRAINT "Phase2WorkBroadClaimPartitionState_claimShard_check" CHECK ((("claimShard" >= 0) AND ("claimShard" < 128)));

ALTER TABLE "Phase2WorkBroadClaimPartitionState" ADD CONSTRAINT "Phase2WorkBroadClaimPartitionState_outstandingCount_check" CHECK (("outstandingCount" > 0));

ALTER TABLE "Phase2WorkCoverage" ADD CONSTRAINT "Phase2WorkCoverage_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ProviderCapacityBucket" ADD CONSTRAINT "ProviderCapacityBucket_itemCount_check" CHECK (("itemCount" >= 0));

ALTER TABLE "ProviderCapacityBucket" ADD CONSTRAINT "ProviderCapacityBucket_overdueCount_check" CHECK (("overdueCount" >= 0));

ALTER TABLE "ProviderCapacityBucket" ADD CONSTRAINT "ProviderCapacityBucket_requiredCalls_check" CHECK (("requiredCalls" >= 0));

ALTER TABLE "ProviderCapacityContribution" ADD CONSTRAINT "ProviderCapacityContribution_itemCount_check" CHECK (("itemCount" >= 0));

ALTER TABLE "ProviderCapacityContribution" ADD CONSTRAINT "ProviderCapacityContribution_overdueCount_check" CHECK (("overdueCount" >= 0));

ALTER TABLE "ProviderCapacityContribution" ADD CONSTRAINT "ProviderCapacityContribution_requiredCalls_check" CHECK (("requiredCalls" >= 0));

ALTER TABLE "ProviderCapacityDebtState" ADD CONSTRAINT "ProviderCapacityDebtState_status_check" CHECK (((status)::text = ANY ((ARRAY['HEALTHY'::character varying, 'PRESSURED'::character varying, 'OVERLOADED'::character varying, 'UNKNOWN'::character varying])::text[])));

ALTER TABLE "ProviderCapacityDebtState" ADD CONSTRAINT "ProviderCapacityDebtState_topology_v1_check" CHECK (((("topologyId")::text = 'of-global'::text) AND (("topologyScope")::text = 'FLEET_GLOBAL'::text) AND ("topologyShardCount" = 1) AND ("topologyShardingAllowed" = false) AND (("controlMode")::text = ANY ((ARRAY['NORMAL'::character varying, 'OVERLOAD_PROTECTED'::character varying, 'CONSERVATIVE'::character varying])::text[])) AND ("campaignDirectoryAdmissionBudgetCalls" >= 1) AND ("campaignDirectoryGuaranteedCallsPerSweep" >= 1)));

ALTER TABLE "ProviderCapacityDirty" ADD CONSTRAINT "ProviderCapacityDirty_kind_check" CHECK ((kind = ANY (ARRAY['directory'::text, 'fan'::text, 'job'::text])));

ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_no_live_impersonation" CHECK ((("impersonatedByAdminId" IS NULL) OR ("revokedAt" IS NOT NULL)));

ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SfsTargetCandidate" ADD CONSTRAINT "SfsTargetCandidate_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SfsTargetCandidate" ADD CONSTRAINT "SfsTargetCandidate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberDirectoryMaintenanceSignal" ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberDirectoryMaintenanceSignal" ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_attempts_nonnegative" CHECK ((attempts >= 0));

ALTER TABLE "SubscriberDirectoryMaintenanceSignal" ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_creator_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberDirectoryMaintenanceSignal" ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_kind_check" CHECK (((kind)::text = ANY ((ARRAY['RECOVERY'::character varying, 'RETENTION'::character varying])::text[])));

ALTER TABLE "SubscriberDirectoryMaintenanceSignal" ADD CONSTRAINT "SubscriberDirectoryMaintenanceSignal_revision_positive" CHECK ((revision > 0));

ALTER TABLE "SubscriberDirectoryState" ADD CONSTRAINT "SubscriberDirectoryState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberDirectoryState" ADD CONSTRAINT "SubscriberDirectoryState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberScanItem" ADD CONSTRAINT "SubscriberScanItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SubscriberScanRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberScanPage" ADD CONSTRAINT "SubscriberScanPage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SubscriberScanRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberScanRun" ADD CONSTRAINT "SubscriberScanRun_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SubscriberScanRun" ADD CONSTRAINT "SubscriberScanRun_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "SystemSetting" ADD CONSTRAINT "SystemSetting_revision_positive" CHECK ((revision > 0));

ALTER TABLE "TeamActivityContribution" ADD CONSTRAINT "TeamActivityContribution_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamActivityEvent" ADD CONSTRAINT "TeamActivityEvent_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamActivityEvent" ADD CONSTRAINT "TeamActivityEvent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "TeamActivityEvent" ADD CONSTRAINT "TeamActivityEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "WorkerDevice"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "TeamActivityEvent" ADD CONSTRAINT "TeamActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "TeamCoverageSession" ADD CONSTRAINT "TeamCoverageSession_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamCoverageSession" ADD CONSTRAINT "TeamCoverageSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamCoverageSession" ADD CONSTRAINT "TeamCoverageSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamDialogSession" ADD CONSTRAINT "TeamDialogSession_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamDialogSession" ADD CONSTRAINT "TeamDialogSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamDialogSession" ADD CONSTRAINT "TeamDialogSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamHistoricalAnalyticsCoverage" ADD CONSTRAINT "TeamHistoricalAnalyticsCoverage_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMemberActivityDaily" ADD CONSTRAINT "TeamMemberActivityDaily_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMemberFunction" ADD CONSTRAINT "TeamMemberFunction_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMemberFunction" ADD CONSTRAINT "TeamMemberFunction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMoneyAttributionFact" ADD CONSTRAINT "TeamMoneyAttributionFact_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMoneyAttributionFact" ADD CONSTRAINT "TeamMoneyAttributionFact_sourceType_check" CHECK (("sourceType" = ANY (ARRAY['PPV'::text, 'TIP'::text])));

ALTER TABLE "TeamMoneyDailyRollup" ADD CONSTRAINT "TeamMoneyDailyRollup_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMoneyLifetimeRollup" ADD CONSTRAINT "TeamMoneyLifetimeRollup_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMoneyRollupContribution" ADD CONSTRAINT "TeamMoneyRollupContribution_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMoneyRollupContribution" ADD CONSTRAINT "TeamMoneyRollupContribution_sourceFactId_fkey" FOREIGN KEY ("sourceFactId") REFERENCES "TeamMoneyAttributionFact"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamMutationReceipt" ADD CONSTRAINT "TeamMutationReceipt_result_bound" CHECK ((octet_length((result)::text) <= 2097152));

ALTER TABLE "TeamMutationReceipt" ADD CONSTRAINT "TeamMutationReceipt_scope_bound" CHECK ((octet_length(("authorizationScope")::text) <= 2097152));

ALTER TABLE "TeamMutationReceipt" ADD CONSTRAINT "TeamMutationReceipt_status_check" CHECK ((status = ANY (ARRAY['COMMITTED'::text, 'ABANDONED'::text])));

ALTER TABLE "TeamObservationState" ADD CONSTRAINT "TeamObservationState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamObservationState" ADD CONSTRAINT "TeamObservationState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamPendingDialogStateCurrent" ADD CONSTRAINT "TeamPendingDialogState_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamPendingDialogStateCurrent" ADD CONSTRAINT "TeamPendingDialogState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamPpvClaimAudit" ADD CONSTRAINT "TeamPpvClaimAudit_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamPpvPurchaseLedger" ADD CONSTRAINT "TeamPpvPurchaseLedger_creatorSaleId_fkey" FOREIGN KEY ("creatorSaleId") REFERENCES "CreatorSale"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "TeamPpvPurchaseLedger" ADD CONSTRAINT "TeamPpvPurchaseLedger_financialTransactionId_fkey" FOREIGN KEY ("financialTransactionId") REFERENCES "CreatorFinancialTransaction"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "TeamProjectionCoverage" ADD CONSTRAINT "TeamProjectionCoverage_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamResponseCaseCurrent" ADD CONSTRAINT "TeamResponseCase_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamResponseCaseCurrent" ADD CONSTRAINT "TeamResponseCase_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamResponseCaseCurrent" ADD CONSTRAINT "TeamResponseCase_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamShift" ADD CONSTRAINT "TeamShift_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamShift" ADD CONSTRAINT "TeamShift_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AgencyMember"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "TeamShiftCreator" ADD CONSTRAINT "TeamShiftCreator_creatorRefId_fkey" FOREIGN KEY ("creatorRefId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "TeamShiftCreator" ADD CONSTRAINT "TeamShiftCreator_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "TeamShift"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TeamTipLedger" ADD CONSTRAINT "TeamTipLedger_creatorTipId_fkey" FOREIGN KEY ("creatorTipId") REFERENCES "CreatorTip"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_kind_check" CHECK ((kind = ANY (ARRAY['TASK'::text, 'REFERENCE'::text, 'MANUAL_REMINDER'::text, 'AUTO_REMINDER'::text, 'CANCELLATION'::text, 'REVISION_REQUEST'::text])));

ALTER TABLE "TelegramDeliveryIntent" ADD CONSTRAINT "TelegramDeliveryIntent_state_check" CHECK ((state = ANY (ARRAY['PLANNED'::text, 'CLAIMED'::text, 'COMMITTING'::text, 'CONFIRMED'::text, 'RECONCILE_REQUIRED'::text, 'CANCELLED'::text, 'FAILED_PRECOMMIT'::text])));

ALTER TABLE "TelegramInboundEvent" ADD CONSTRAINT "TelegramInboundEvent_projectionState_check" CHECK (("projectionState" = ANY (ARRAY['PENDING'::text, 'APPLIED'::text, 'SKIPPED'::text, 'REVIEW_REQUIRED'::text, 'FAILED_RETRYABLE'::text])));

ALTER TABLE "TrafficFanProjection" ADD CONSTRAINT "TrafficFanProjection_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "TrafficFanSignal" ADD CONSTRAINT "TrafficFanSignal_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "TrafficMetric" ADD CONSTRAINT "TrafficMetric_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "TrafficProjectionBackfillData" ADD CONSTRAINT "TrafficProjectionBackfillData_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "TrafficReceiptProjection" ADD CONSTRAINT "TrafficReceiptProjection_agencyId_creatorId_fkey" FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", id) ON DELETE CASCADE;

ALTER TABLE "TrafficSource" ADD CONSTRAINT "TrafficSource_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TrafficSource" ADD CONSTRAINT "TrafficSource_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TrafficSourceMember" ADD CONSTRAINT "TrafficSourceMember_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TrafficSourceMember" ADD CONSTRAINT "TrafficSourceMember_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "TrafficSourceMember" ADD CONSTRAINT "TrafficSourceMember_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrafficSource"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "VaultUnsortedSnapshot" ADD CONSTRAINT "VaultUnsortedSnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "VaultUnsortedSnapshot" ADD CONSTRAINT "VaultUnsortedSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "WorkerDevice" ADD CONSTRAINT "WorkerDevice_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "WorkerDevice" ADD CONSTRAINT "WorkerDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "WorkspaceSetting" ADD CONSTRAINT "WorkspaceSetting_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "AutomationDelivery_sfs_cleanup_current_idx" ON "AutomationDelivery"("agencyId","creatorId","id") WHERE "moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET';

CREATE INDEX "AutomationDelivery_sfs_follow_current_idx" ON "AutomationDelivery"("agencyId","creatorId","id") WHERE "moduleKey"='sfs' AND "actionType"='SFS_FOLLOW_TARGET' AND "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED');

CREATE INDEX "SfsTargetCandidate_owned_current_idx" ON "SfsTargetCandidate"("agencyId","creatorId","id") WHERE "completedAt" IS NULL AND "metadata"->>'followEffectOwnership'='OWNED';


-- Current views


CREATE VIEW "TeamOperationalPendingCurrent" AS  SELECT p.id,
    p."agencyId",
    p."creatorId",
    p."dialogId",
    p."fanId",
    p.status,
    p."episodeKey",
    p."firstIncomingEventId",
    p."lastIncomingEventId",
    p."firstIncomingMessageId",
    p."lastIncomingMessageId",
    p."firstIncomingAt",
    p."lastIncomingAt",
    p."incomingCount",
    p."firstSeenAt",
    p."firstSeenMemberId",
    p."lastSeenAt",
    p."lastSeenMemberId",
    p."ownerMemberId",
    p."ownerAssignedAt",
    p."ownerReason",
    p."replyAt",
    p."replyMessageId",
    p."repliedByMemberId",
    p."derivationVersion",
    p."createdAt",
    p."updatedAt",
    p."projectionRevision",
    p."projectionState",
    p."lastProjectionSourceId",
    p."lastAppliedEventAt",
    p."lastAppliedEventId",
        CASE
            WHEN ((m.id IS NOT NULL) AND (u.id IS NOT NULL) AND phase2_scope_allows_creator(m."assignedCreators", p."creatorId")) THEN p."ownerMemberId"
            ELSE NULL::text
        END AS "operationalOwnerMemberId"
   FROM ((("TeamPendingDialogStateCurrent" p
     JOIN "CreatorAccount" c ON (((c.id = p."creatorId") AND (c."agencyId" = p."agencyId") AND (c."deletedAt" IS NULL))))
     LEFT JOIN "AgencyMember" m ON (((m.id = p."ownerMemberId") AND (m."agencyId" = p."agencyId") AND (m."deletedAt" IS NULL) AND (m."deactivatedAt" IS NULL))))
     LEFT JOIN "User" u ON (((u.id = m."userId") AND (u."disabledAt" IS NULL))));

CREATE VIEW "CampaignReadState" AS  SELECT "creatorId",
    "agencyId",
    stage,
    cursor,
    NULL::timestamp(3) without time zone AS "completedAt",
    "valueFreshnessMs",
    "updatedAt"
   FROM "CampaignReadStateData";

CREATE VIEW "TrafficProjectionBackfill" AS  SELECT "creatorId",
    "agencyId",
    stage,
    cursor,
    NULL::timestamp(3) without time zone AS "completedAt",
    "updatedAt"
   FROM "TrafficProjectionBackfillData";

INSERT INTO "BillingReconciliationCursor" ("id","lastAgencyId","ownerToken","leaseUntil","cycle","lastCompletedAt","failureCount","lastFailedAgencyId","lastErrorCode","updatedAt") VALUES ('billing_aggregate_v1',NULL,NULL,NULL,0,NULL,0,NULL,NULL,CURRENT_TIMESTAMP);

INSERT INTO "CampaignProjectionPolicy" ("id","generation","valueFreshnessMs") VALUES ('active',2,21600000);

INSERT INTO "CampaignReadSeed" ("id","cursor","complete","valueFreshnessMs","generation") VALUES ('v1','',TRUE,21600000,2);

INSERT INTO "DomainWorkClaimTopologyState" ("id","generation","activationState","cursorAgencyId","cursorWorkClass","cursorPartitionKey","cursorActiveGeneration","cursorWorkId","backfilledPartitions","partitionsBackfilledAt","cursorMemberId","backfilledMembers","membersBackfilledAt","startedAt","activatedAt","lastError","revision","createdAt","updatedAt") VALUES ('phase3_domain_work_claim_topology_a36_v1','phase3_domain_work_claim_topology_a36_v1','ACTIVE',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,0,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','providerCapacityProjection',0,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','messageLibraryTrash',1,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','adminBillingPricing',2,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','notificationConsequences',3,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','agencyDestructiveCleanup',4,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','creatorDestructiveCleanup',5,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','providerOperationalBackfill',6,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','subscriberDirectoryMaintenance',7,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','creatorRecurringPlanning',8,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','campaignFanRefreshPromotion',9,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','dependencyFanout',10,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','customReminderWork',11,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','providerOperationalDirty',12,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','telegramConfirmedProjection',13,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','telegramInboundProjection',14,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','customExternalProofConvergence',15,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','teamMoneyReconciliation',16,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','teamReadSummary',17,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','teamPendingBackfill',18,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','teamResponseRangeRepair',19,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','analyticsPublication',20,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','trafficProjection',21,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','campaignReadProjection',22,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','financialReceiptRetention',23,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','analyticsFactPublication',24,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','fanObservationTokenRetention',25,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','providerWaiterRetention',26,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('onlinod_maintenance_v1','massObservationRetention',27,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('campaign_projection_execution_v2','CAMPAIGN_FACT',0,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('campaign_projection_execution_v2','CAMPAIGN_VALUE',1,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('campaign_projection_execution_v2','CAMPAIGN_ATTRIBUTION',2,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('campaign_projection_execution_v2','CAMPAIGN_CLOCK',3,0,NULL);

INSERT INTO "MaintenanceAdmissionClassState" ("generation","laneName","ordinal","turnCount","lastAdmittedAt") VALUES ('campaign_projection_execution_v2','CAMPAIGN_BACKFILL',4,0,NULL);

INSERT INTO "OfProviderRequestGateState" ("id","activePermitId","activeOwnerInstanceId","activeAgencyId","activeCreatorId","activeDeviceId","activeCapability","activeIntervalMs","activeGrantedAt","activeExpiresAt","nextAllowedAt","revision","lastStartedAt","lastStartedCreatorId","lastStartedDeviceId","createdAt","updatedAt","priorityCursor","backgroundCategoryCursor","fairnessGeneration","fairnessActivationState","activePriority","activeCategory","usageWindowStartedAt","usageTotalStarts","usageCriticalWriteStarts","usageInteractiveStarts","usageRealtimeStarts","usageNormalStarts","usageCampaignDirectoryStarts","usageCampaignFrontierStarts","usageFanDataStarts","usageBackgroundOtherStarts","usageUnclassifiedStarts") VALUES ('of-global',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,0,0,'phase3_provider_gate_fairness_v2_a14','ACTIVE',NULL,NULL,NULL,0,0,0,0,0,0,0,0,0,0);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('CUSTOM_COMMUNICATION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('CUSTOM_REMINDER','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('CUSTOM_SOURCE_PIPELINE','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('TELEGRAM_CONFIRMED_PROJECTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('TELEGRAM_INBOUND_PROJECTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('CUSTOM_EXTERNAL_PROJECTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('TEAM_DIALOG_PROJECTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('TEAM_RESPONSE_RANGE_REPAIR','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('TEAM_MONEY_RECONCILIATION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('TEAM_READ_SUMMARY','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('DEPENDENCY_FANOUT','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('HISTORICAL_ENUMERATION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('RETENTION','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('DESTRUCTIVE_CREATOR_CLEANUP','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('DESTRUCTIVE_AGENCY_CLEANUP','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('CREATOR_RECURRING_PLANNING','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('DEPENDENCY_WAKE','phase2_domain_work_v3_actual55','phase2_domain_work_v3_actual55',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "Phase2WorkGenerationAuthority" ("workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt") VALUES ('ADMIN_BILLING_PRICING','phase4_admin_pricing_v1','phase4_admin_pricing_v1',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "ProviderCapacityProjectionState" ("id","generation","jobKeys","revision","directoryCursor","directoryComplete","fanCursor","fanComplete","jobCursor","jobComplete","sampledAt","updatedAt") VALUES ('of-global-capacity-v1','phase6_capacity_observation_v2',ARRAY['catchup_notifications_scan','dialog_intelligence_scan','fan_data_point_refresh','fetch_campaigns','fetch_earnings','financial_transactions_scan','likes_content_discovery','sfs_target_discovery','sfs_target_scan','subscriber_directory_scan','vault_unsorted_scan']::text[],2,NULL,TRUE,NULL,TRUE,NULL,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO "SystemSetting" ("id","key","value","updatedByAdminId","createdAt","updatedAt","revision") VALUES ('phase3-campaign-causal-v1','phase3.campaignCausalObservationV1','{"active":true,"epoch":1,"writerGenerationActive":true,"claimGenerationActive":true,"writerGeneration":1}'::jsonb,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1);

INSERT INTO "SystemSetting" ("id","key","value","updatedByAdminId","createdAt","updatedAt","revision") VALUES ('commercial-policy-v1','billing.commercial.policy.v1','{"trialDays":14,"proPriceCents":5000,"elitePriceCents":15000,"growthPriceCents":3000,"starterPriceCents":2000,"outreachPriceCents":2900,"aiChatterPriceCents":10000}'::jsonb,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1);

INSERT INTO "TrafficProjectionSeed" ("id","cursor","complete") VALUES ('v2','',TRUE);


-- Triggers are installed before any application data can be written.


CREATE TRIGGER phase4_support_grant_immutable BEFORE UPDATE ON public."AdminSupportGrant" FOR EACH ROW EXECUTE FUNCTION phase4_support_grant_immutable();

CREATE TRIGGER "AdminUser_access_epoch_v1" BEFORE UPDATE ON public."AdminUser" FOR EACH ROW EXECUTE FUNCTION onlinod_admin_access_epoch_v1();

CREATE TRIGGER "Agency_billing_policy_v1" BEFORE UPDATE ON public."Agency" FOR EACH ROW EXECUTE FUNCTION onlinod_agency_billing_policy_v1();

CREATE TRIGGER "Agency_phase2_initial_coverage" AFTER INSERT ON public."Agency" FOR EACH ROW EXECUTE FUNCTION phase2_new_agency_coverage_trigger();

CREATE TRIGGER analytics_projection_restore_v1 AFTER UPDATE OF "deletedAt" ON public."Agency" FOR EACH ROW WHEN (((old."deletedAt" IS NOT NULL) AND (new."deletedAt" IS NULL))) EXECUTE FUNCTION onlinod_analytics_projection_restore_v1();

CREATE TRIGGER mass_agency_retirement_v2 BEFORE DELETE OR UPDATE ON public."Agency" FOR EACH ROW EXECUTE FUNCTION onlinod_mass_agency_retirement_v2();

CREATE TRIGGER phase2_team_writer_generation_agency_lifecycle BEFORE INSERT OR DELETE OR UPDATE OF "deletedAt" ON public."Agency" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE TRIGGER phase4_issue_agency_trial BEFORE INSERT OR UPDATE ON public."Agency" FOR EACH ROW EXECUTE FUNCTION phase4_issue_agency_trial();

CREATE CONSTRAINT TRIGGER phase4_owner_agency_insert AFTER INSERT ON public."Agency" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phase4_check_agency_owner();

CREATE CONSTRAINT TRIGGER phase4_owner_agency_restore AFTER UPDATE ON public."Agency" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old."deletedAt" IS DISTINCT FROM new."deletedAt") AND (new."deletedAt" IS NULL))) EXECUTE FUNCTION phase4_check_agency_owner();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."AgencyCreatorCatalogGenerationBoundary" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER "AgencyCreatorCatalogState_capture_generation_boundary" AFTER UPDATE OF generation ON public."AgencyCreatorCatalogState" FOR EACH ROW WHEN ((old.generation IS DISTINCT FROM new.generation)) EXECUTE FUNCTION capture_creator_catalog_generation_boundary();

CREATE TRIGGER phase2_team_writer_generation_custom_role BEFORE INSERT OR DELETE OR UPDATE ON public."AgencyCustomRole" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE TRIGGER "AgencyInvitation_phase2_creator_scope_fence" BEFORE INSERT OR UPDATE OF "assignedCreators", "agencyId" ON public."AgencyInvitation" FOR EACH ROW EXECUTE FUNCTION phase2_fence_creator_access_scope();

CREATE TRIGGER phase2_team_writer_generation_invitation BEFORE INSERT OR DELETE OR UPDATE ON public."AgencyInvitation" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE TRIGGER "AgencyMember_capture_access_epoch_boundary" AFTER UPDATE OF "accessEpoch" ON public."AgencyMember" FOR EACH ROW WHEN ((old."accessEpoch" IS DISTINCT FROM new."accessEpoch")) EXECUTE FUNCTION capture_agency_member_access_epoch_boundary();

CREATE TRIGGER "AgencyMember_phase2_creator_scope_fence" BEFORE INSERT OR UPDATE OF "assignedCreators", "agencyId" ON public."AgencyMember" FOR EACH ROW EXECUTE FUNCTION phase2_fence_creator_access_scope();

CREATE TRIGGER "AgencyMember_phase3_access_epoch_fence" BEFORE UPDATE OF "agencyId", "userId", role, "roleKey", permissions, "assignedCreators", "accessEpoch", "deletedAt", "deactivatedAt" ON public."AgencyMember" FOR EACH ROW EXECUTE FUNCTION phase3_fence_agency_member_access_epoch();

CREATE TRIGGER "AgencyMember_phase3_scope_projection_delete" AFTER DELETE ON public."AgencyMember" FOR EACH ROW EXECUTE FUNCTION phase3_refresh_member_creator_scope_trigger();

CREATE TRIGGER "AgencyMember_phase3_scope_projection_insert" AFTER INSERT ON public."AgencyMember" FOR EACH ROW EXECUTE FUNCTION phase3_refresh_member_creator_scope_trigger();

CREATE TRIGGER "AgencyMember_phase3_scope_projection_update" AFTER UPDATE OF "agencyId", "userId", role, "roleKey", permissions, "assignedCreators", "accessEpoch", "deletedAt", "deactivatedAt" ON public."AgencyMember" FOR EACH ROW EXECUTE FUNCTION phase3_refresh_member_creator_scope_trigger();

CREATE TRIGGER phase2_team_writer_generation_agency_member BEFORE INSERT OR DELETE OR UPDATE ON public."AgencyMember" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE CONSTRAINT TRIGGER phase4_owner_member_delete AFTER DELETE ON public."AgencyMember" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old."roleKey" = 'owner'::text) OR (old.role = 'OWNER'::"UserRole"))) EXECUTE FUNCTION phase4_check_member_owner();

CREATE CONSTRAINT TRIGGER phase4_owner_member_insert AFTER INSERT ON public."AgencyMember" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new."roleKey" = 'owner'::text) OR (new.role = 'OWNER'::"UserRole"))) EXECUTE FUNCTION phase4_check_member_owner();

CREATE CONSTRAINT TRIGGER phase4_owner_member_update AFTER UPDATE ON public."AgencyMember" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((old."roleKey" = 'owner'::text) OR (old.role = 'OWNER'::"UserRole") OR (new."roleKey" = 'owner'::text) OR (new.role = 'OWNER'::"UserRole")) AND ((old."agencyId" IS DISTINCT FROM new."agencyId") OR (old."userId" IS DISTINCT FROM new."userId") OR (old."roleKey" IS DISTINCT FROM new."roleKey") OR (old.role IS DISTINCT FROM new.role) OR (old."deletedAt" IS DISTINCT FROM new."deletedAt") OR (old."deactivatedAt" IS DISTINCT FROM new."deactivatedAt")))) EXECUTE FUNCTION phase4_check_member_owner();

CREATE TRIGGER trg_phase2_agency_member_physical_delete BEFORE DELETE ON public."AgencyMember" FOR EACH ROW EXECUTE FUNCTION phase2_fence_agency_member_physical_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."AgencyMemberAccessEpochBoundary" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."AgencyMemberCreatorAccessCurrent" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase3_member_creator_access_destructive_fence BEFORE INSERT OR UPDATE ON public."AgencyMemberCreatorAccessCurrent" FOR EACH ROW EXECUTE FUNCTION phase3_fence_member_creator_access_during_creator_delete();

CREATE TRIGGER phase2_team_writer_generation_role_override BEFORE INSERT OR DELETE OR UPDATE ON public."AgencyRoleOverride" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE TRIGGER phase2_team_writer_generation_subpermission_override BEFORE INSERT OR DELETE OR UPDATE ON public."AgencySubPermissionOverride" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE TRIGGER "AgencySubscription_policy_revision_v1" AFTER INSERT OR DELETE OR UPDATE ON public."AgencySubscription" FOR EACH ROW EXECUTE FUNCTION onlinod_subscription_policy_revision_v1();

CREATE TRIGGER "AgencyTelegramMtprotoAccount_phase2_topology_dependency" AFTER INSERT OR DELETE OR UPDATE OF "lifecycleState" ON public."AgencyTelegramMtprotoAccount" FOR EACH ROW EXECUTE FUNCTION phase2_account_topology_dependency_trigger();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."AnalyticsCollectionDemand" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase6_home_member_scope_claim_guard BEFORE INSERT OR UPDATE ON public."AnalyticsCollectionDemand" FOR EACH ROW EXECUTE FUNCTION phase6_home_member_scope_claim_guard();

CREATE TRIGGER analytics_batch_publication_input_v1 AFTER INSERT OR DELETE OR UPDATE ON public."AnalyticsIngestBatch" FOR EACH ROW EXECUTE FUNCTION onlinod_analytics_publication_input_clock_v1();

CREATE TRIGGER campaign_fair_ingest_guard_v1_trg BEFORE INSERT OR UPDATE ON public."AnalyticsIngestBatch" FOR EACH ROW EXECUTE FUNCTION campaign_fair_ingest_guard_v1();

CREATE TRIGGER campaign_traversal_ingest_guard_v1_trg BEFORE INSERT OR UPDATE ON public."AnalyticsIngestBatch" FOR EACH ROW EXECUTE FUNCTION campaign_traversal_ingest_guard_v1();

CREATE TRIGGER phase3_campaign_writer_generation_ingest_guard_trg BEFORE INSERT OR UPDATE ON public."AnalyticsIngestBatch" FOR EACH ROW EXECUTE FUNCTION phase3_campaign_writer_generation_guard();

CREATE TRIGGER analytics_publication_immutable_v1 BEFORE UPDATE ON public."AnalyticsPublication" FOR EACH ROW EXECUTE FUNCTION onlinod_analytics_publication_immutable_v1();

CREATE TRIGGER analytics_proof_publication_guard_v1 BEFORE INSERT OR UPDATE ON public."AnalyticsScanProof" FOR EACH ROW EXECUTE FUNCTION onlinod_analytics_proof_publication_guard_v1();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."AuthorizationSessionBoundary" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER "AutomationDelivery_custom_external_projection_debt" AFTER INSERT OR DELETE OR UPDATE OF status, "actionType", payload, result, "targetId", "messageId" ON public."AutomationDelivery" FOR EACH ROW EXECUTE FUNCTION phase2_refresh_custom_external_projection_debt();

CREATE TRIGGER "AutomationDelivery_phase3_fan_consumer_commit" BEFORE INSERT OR UPDATE OF status, "writeCommitRevision" ON public."AutomationDelivery" FOR EACH ROW EXECUTE FUNCTION phase3_fence_fan_consumer_commit();

CREATE TRIGGER mass_delivery_delete_v2 BEFORE DELETE ON public."AutomationDelivery" FOR EACH ROW EXECUTE FUNCTION onlinod_mass_delivery_delete_v2();

CREATE TRIGGER mass_delivery_mutation_v2 BEFORE INSERT OR UPDATE ON public."AutomationDelivery" FOR EACH ROW EXECUTE FUNCTION onlinod_mass_delivery_mutation_v2();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."AutomationEvent" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."AutomationTask" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."AutomationTask" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."BumpDeliveryStat" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER campaign_metric_writer_v2 BEFORE INSERT OR DELETE OR UPDATE ON public."CampaignReadMetric" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_projection_guard_v2();

CREATE TRIGGER campaign_receipt_writer_v2 BEFORE INSERT OR DELETE OR UPDATE ON public."CampaignReadReceipt" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_projection_guard_v2();

CREATE TRIGGER campaign_seed_writer_v2 BEFORE DELETE OR UPDATE ON public."CampaignReadSeed" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_projection_guard_v2();

CREATE TRIGGER campaign_state_writer_v2 BEFORE DELETE OR UPDATE ON public."CampaignReadStateData" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_projection_guard_v2();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."ContentUsageEvent" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER "CreatorAccount_analytics_publication_v1" AFTER INSERT ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION analytics_new_creator_v1();

CREATE TRIGGER "CreatorAccount_phase2_binding_dependency" AFTER UPDATE OF "telegramContact", "telegramUserId", "telegramAccountId", "customsVaultFolderId", status, "deletedAt" ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION phase2_creator_binding_dependency_trigger();

CREATE TRIGGER campaign_read_creator_v1 AFTER INSERT ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_read_capture_v1();

CREATE TRIGGER mass_creator_retirement_v2 BEFORE DELETE OR UPDATE ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION onlinod_mass_creator_retirement_v2();

CREATE TRIGGER traffic_creator_enroll_v2 AFTER INSERT ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_creator_enroll_v2();

CREATE TRIGGER trg_phase2_creator_account_release_writer BEFORE INSERT OR DELETE OR UPDATE ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION phase2_fence_creator_account_release_writer();

CREATE TRIGGER trg_phase2_creator_catalog_generation AFTER INSERT OR DELETE OR UPDATE OF "agencyId", "deletedAt" ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION phase2_bump_creator_catalog_generation();

CREATE TRIGGER trg_phase3_creator_recurring_work AFTER INSERT OR DELETE OR UPDATE OF status, "deletedAt", "agencyId" ON public."CreatorAccount" FOR EACH ROW EXECUTE FUNCTION phase3_sync_creator_recurring_work();

CREATE TRIGGER "CreatorAnalyticsDay_writer_v1" BEFORE INSERT OR UPDATE ON public."CreatorAnalyticsDay" FOR EACH ROW EXECUTE FUNCTION analytics_published_writer_v1();

CREATE TRIGGER "CreatorAnalyticsDayMember_writer_v1" BEFORE INSERT OR UPDATE ON public."CreatorAnalyticsDayMember" FOR EACH ROW EXECUTE FUNCTION analytics_published_writer_v1();

CREATE TRIGGER "CreatorAnalyticsFactPublication_guard_v1" BEFORE INSERT OR UPDATE ON public."CreatorAnalyticsFactPublication" FOR EACH ROW EXECUTE FUNCTION analytics_fact_publication_guard_v1();

CREATE TRIGGER "CreatorBillingEntitlement_revision_v1" BEFORE UPDATE ON public."CreatorBillingEntitlement" FOR EACH ROW EXECUTE FUNCTION onlinod_entitlement_revision_v1();

CREATE TRIGGER "CreatorBillingProfile_pricing_revision_v1" BEFORE UPDATE ON public."CreatorBillingProfile" FOR EACH ROW EXECUTE FUNCTION onlinod_pricing_revision_v1();

CREATE TRIGGER phase4_commercial_pricing_writer_guard BEFORE INSERT OR UPDATE ON public."CreatorBillingProfile" FOR EACH ROW EXECUTE FUNCTION phase4_commercial_pricing_writer_guard();

CREATE TRIGGER campaign_directory_facts_clock_v1_trg AFTER INSERT OR DELETE OR UPDATE OF "creatorId", "externalCampaignId", "sourceScanRunId", "sourceScanStartedAt" ON public."CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION campaign_directory_facts_clock_v1();

CREATE TRIGGER campaign_fair_cursor_guard_v1_trg BEFORE INSERT OR UPDATE ON public."CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION campaign_fair_cursor_guard_v1();

CREATE TRIGGER campaign_frontier_observation_guard_v1_trg BEFORE INSERT OR UPDATE OF "claimersVerifiedAt", "claimerVerifiedRevision", "claimersLastVerifiedRunId", "claimersObservationVersion" ON public."CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION campaign_frontier_observation_guard_v1();

CREATE TRIGGER campaign_read_directory_v1 AFTER INSERT OR DELETE OR UPDATE ON public."CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_read_capture_v1();

CREATE TRIGGER campaign_traversal_origin_guard_v1_trg BEFORE UPDATE OF "claimersTraversalRunId", "claimersTraversalStartedAt", "claimersTraversalRevision", "claimersTraversalRejectedRows" ON public."CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION campaign_traversal_origin_guard_v1();

CREATE TRIGGER traffic_campaign_capture_v2 AFTER INSERT OR UPDATE ON public."CreatorCampaign" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_canonical_capture_v2();

CREATE TRIGGER analytics_campaign_publication_guard_v1 BEFORE INSERT OR UPDATE ON public."CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION onlinod_analytics_collector_publication_guard_v1();

CREATE TRIGGER campaign_directory_count_guard_v1_trg BEFORE INSERT OR UPDATE OF "campaignDirectoryGeneration", "campaignDirectoryRequestedAt", "campaignDirectoryRevision", "campaignDirectoryCampaignCount", "campaignDirectoryCountRevision" ON public."CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION campaign_directory_count_guard_v1();

CREATE TRIGGER campaign_fair_schedule_guard_v1_trg BEFORE INSERT OR UPDATE OF "campaignFrontierPlanRunId", "campaignFrontierNextDueAt", "campaignFrontierNextEligibleAt", "campaignFrontierScheduleVersion" ON public."CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION campaign_fair_schedule_guard_v1();

CREATE TRIGGER campaign_membership_proof_guard_v1 BEFORE INSERT OR UPDATE ON public."CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_membership_proof_guard_v1();

CREATE TRIGGER campaign_plan_observation_guard_v1_trg BEFORE INSERT OR UPDATE OF "campaignFrontierPlanRunId", "campaignFrontierFreshnessStatus", "campaignFrontierNextDueAt", "campaignFrontierCompletedCount", "campaignFrontierDeferredCount", "campaignFrontierObservationVersion" ON public."CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION campaign_plan_observation_guard_v1();

CREATE TRIGGER onlinod_capacity_directory_dirty AFTER INSERT OR DELETE OR UPDATE OF id, "baselineVerifiedAt", "campaignDirectoryDiscoveryRequestedRevision", "campaignDirectoryDiscoveryCompletedRevision", "campaignDirectoryDiscoveryDueAt", "campaignDirectoryCampaignCount", "campaignDirectoryVerifiedAt", "campaignDirectoryRequestedAt" ON public."CreatorCampaignCollectionState" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_mark_dirty('directory');

CREATE TRIGGER campaign_read_member_v1 AFTER INSERT OR DELETE OR UPDATE ON public."CreatorCampaignFan" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_read_capture_v1();

CREATE TRIGGER traffic_member_capture_v2 AFTER INSERT OR UPDATE ON public."CreatorCampaignFan" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_canonical_capture_v2();

CREATE TRIGGER campaign_refresh_work_scope_v2 BEFORE INSERT OR UPDATE ON public."CreatorCampaignFanRefreshWork" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_refresh_work_scope_v2();

CREATE TRIGGER campaign_refresh_work_writer_v2 BEFORE INSERT OR UPDATE ON public."CreatorCampaignFanRefreshWork" FOR EACH STATEMENT EXECUTE FUNCTION onlinod_campaign_refresh_work_writer_v2();

CREATE TRIGGER analytics_earnings_publication_input_v1 AFTER INSERT OR DELETE OR UPDATE ON public."CreatorEarningsDaily" FOR EACH ROW EXECUTE FUNCTION onlinod_analytics_publication_input_clock_v1();

CREATE TRIGGER phase3_campaign_writer_generation_identity_guard_trg BEFORE INSERT OR UPDATE ON public."CreatorFan" FOR EACH ROW EXECUTE FUNCTION phase3_campaign_writer_generation_guard();

CREATE TRIGGER traffic_fan_delete_capture_v2 BEFORE DELETE ON public."CreatorFan" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_member_dirty_capture_v2();

CREATE TRIGGER onlinod_capacity_fan_dirty AFTER INSERT OR DELETE OR UPDATE OF id, "requestedRevision", "satisfiedRevision", "lastRequestedAt" ON public."CreatorFanRefreshDemand" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_mark_dirty('fan');

CREATE TRIGGER campaign_read_value_v1 AFTER INSERT OR DELETE OR UPDATE ON public."CreatorFanValueCurrent" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_read_capture_v1();

CREATE TRIGGER phase3_campaign_writer_generation_value_guard_trg BEFORE INSERT OR UPDATE ON public."CreatorFanValueCurrent" FOR EACH ROW EXECUTE FUNCTION phase3_campaign_writer_generation_guard();

CREATE TRIGGER traffic_value_capture_v2 AFTER INSERT OR DELETE OR UPDATE ON public."CreatorFanValueCurrent" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_member_dirty_capture_v2();

CREATE TRIGGER "CreatorFinancialCollectionState_receipt_v1" BEFORE INSERT OR UPDATE ON public."CreatorFinancialCollectionState" FOR EACH ROW EXECUTE FUNCTION financial_receipt_coverage_guard_v1();

CREATE TRIGGER analytics_financial_publication_guard_v1 BEFORE INSERT OR UPDATE ON public."CreatorFinancialCollectionState" FOR EACH ROW EXECUTE FUNCTION onlinod_analytics_collector_publication_guard_v1();

CREATE TRIGGER "CreatorFinancialTransaction_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorFinancialTransaction" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorFinancialTransaction_refresh_team_fact_v1" AFTER INSERT OR UPDATE OF "transactionStatus", "sourceUpdatedAt" ON public."CreatorFinancialTransaction" FOR EACH ROW EXECUTE FUNCTION onlinod_refresh_team_fact_from_financial_tx_v1();

CREATE TRIGGER campaign_read_financial_v1 AFTER INSERT OR DELETE OR UPDATE ON public."CreatorFinancialTransaction" FOR EACH ROW EXECUTE FUNCTION onlinod_campaign_read_capture_v1();

CREATE TRIGGER "CreatorMessagesDaily_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorMessagesDaily" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorPaidSubscription_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorPaidSubscription" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorPostComment_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorPostComment" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorPostLike_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorPostLike" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorSale_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorSale" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorSale_phase2_team_money_work" AFTER INSERT OR UPDATE OF "fanId", "externalNotificationId", "eventFingerprint", "saleType", "messageId", "amountCents", currency, "purchasedAt", "transactionStatus", "externalTransactionId", "sourceUpdatedAt" ON public."CreatorSale" FOR EACH ROW EXECUTE FUNCTION phase2_team_money_reconciliation_trigger();

CREATE TRIGGER "CreatorSale_phase5_notification_consequences" AFTER INSERT OR UPDATE ON public."CreatorSale" FOR EACH ROW EXECUTE FUNCTION phase5_notification_fact_consequences();

CREATE TRIGGER "CreatorSale_refresh_team_fact_v1" AFTER INSERT OR UPDATE OF "amountCents", currency, "purchasedAt", "transactionStatus", "sourceUpdatedAt" ON public."CreatorSale" FOR EACH ROW EXECUTE FUNCTION onlinod_refresh_team_fact_from_creator_sale_v1();

CREATE TRIGGER "CreatorSubscriptionEvent_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorSubscriptionEvent" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorSubscriptionEvent_phase5_notification_consequences" AFTER INSERT OR UPDATE ON public."CreatorSubscriptionEvent" FOR EACH ROW EXECUTE FUNCTION phase5_notification_fact_consequences();

CREATE TRIGGER traffic_receipt_capture_v2 AFTER INSERT OR DELETE OR UPDATE ON public."CreatorSubscriptionLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_receipt_capture_v2();

CREATE TRIGGER "CreatorTip_analytics_publication_v1" AFTER INSERT OR DELETE OR UPDATE ON public."CreatorTip" FOR EACH ROW EXECUTE FUNCTION analytics_capture_fact_v1();

CREATE TRIGGER "CreatorTip_phase2_team_money_work" AFTER INSERT OR UPDATE OF "fanId", "externalNotificationId", "eventFingerprint", "messageId", "amountCents", currency, "tippedAt", "transactionStatus", "externalTransactionId", "sourceUpdatedAt" ON public."CreatorTip" FOR EACH ROW EXECUTE FUNCTION phase2_team_money_reconciliation_trigger();

CREATE TRIGGER "CreatorTip_phase5_notification_consequences" AFTER INSERT OR UPDATE ON public."CreatorTip" FOR EACH ROW EXECUTE FUNCTION phase5_notification_fact_consequences();

CREATE TRIGGER "CreatorTip_refresh_team_fact_v1" AFTER INSERT OR UPDATE OF "amountCents", currency, "tippedAt", "transactionStatus", "sourceUpdatedAt" ON public."CreatorTip" FOR EACH ROW EXECUTE FUNCTION onlinod_refresh_team_fact_from_creator_tip_v1();

CREATE TRIGGER "CustomContentSubmission_phase2_domain_work" AFTER INSERT OR DELETE OR UPDATE OF "customOrderId", "bindingRevision", "reviewDecisionRevision", "telegramSourceAccountId", "telegramSourceUserId", "telegramMessageIds", "ofMediaIds", "pipelineDisposition", "reviewStatus" ON public."CustomContentSubmission" FOR EACH ROW EXECUTE FUNCTION phase2_submission_domain_work_trigger();

CREATE TRIGGER "CustomContentSubmission_provider_operational_dirty" AFTER INSERT OR DELETE OR UPDATE OF "customOrderId", "telegramSourceAccountId", "telegramSourceUserId", "telegramMessageIds", "ofMediaIds", "pipelineDisposition", "reviewStatus" ON public."CustomContentSubmission" FOR EACH ROW EXECUTE FUNCTION phase2_provider_submission_dirty_trigger();

CREATE TRIGGER "CustomOrder_phase2_domain_work" AFTER INSERT OR UPDATE OF status, type, "scheduledAt", "dueAt", "physicalStatus", "priceCents", "paidAmountCents", "fanDeliveredAt", "telegramCancellationWaivedAt", "reminderConfig" ON public."CustomOrder" FOR EACH ROW EXECUTE FUNCTION phase2_custom_order_domain_work_trigger();

CREATE TRIGGER "CustomOrder_provider_operational_delete_cleanup" AFTER DELETE ON public."CustomOrder" FOR EACH ROW EXECUTE FUNCTION phase2_provider_order_delete_cleanup_trigger();

CREATE TRIGGER "CustomOrder_provider_operational_state_dirty" BEFORE UPDATE OF status, type, "telegramCancellationWaivedAt", "telegramCancellationWaiverReason" ON public."CustomOrder" FOR EACH ROW EXECUTE FUNCTION phase2_provider_order_state_dirty_trigger();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."DeviceCommand" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE CONSTRAINT TRIGGER trg_phase3_domain_work_claim_locator_mutation_flush AFTER INSERT ON public."DomainWorkClaimLocatorMutationBatch" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phase3_flush_domain_work_claim_locator_mutations();

CREATE TRIGGER "DomainWorkItem_admin_receipt_delete_v1" BEFORE DELETE ON public."DomainWorkItem" FOR EACH ROW EXECUTE FUNCTION onlinod_admin_bulk_work_deleted_v1();

CREATE TRIGGER campaign_work_ack_v2 BEFORE UPDATE ON public."DomainWorkItem" FOR EACH ROW WHEN ((new."workClass" = ANY (ARRAY['CAMPAIGN_FACT'::text, 'CAMPAIGN_VALUE'::text, 'CAMPAIGN_ATTRIBUTION'::text, 'CAMPAIGN_CLOCK'::text, 'CAMPAIGN_BACKFILL'::text]))) EXECUTE FUNCTION onlinod_campaign_projection_ack_v2();

CREATE TRIGGER phase2_indirect_creator_residual_insert_fence BEFORE INSERT OR UPDATE ON public."DomainWorkItem" FOR EACH ROW EXECUTE FUNCTION phase2_fence_indirect_creator_residual_insert();

CREATE TRIGGER traffic_work_guard_v3 BEFORE UPDATE ON public."DomainWorkItem" FOR EACH ROW WHEN ((new."workClass" = ANY (ARRAY['TRAFFIC_FACT'::text, 'TRAFFIC_FAN'::text, 'TRAFFIC_BACKFILL'::text]))) EXECUTE FUNCTION onlinod_traffic_work_guard_v3();

CREATE TRIGGER trg_phase2_domain_work_executor_release BEFORE UPDATE OF state, "ownerToken", "claimFence" ON public."DomainWorkItem" FOR EACH ROW EXECUTE FUNCTION phase2_fence_domain_work_executor_acquire();

CREATE TRIGGER trg_phase2_enforce_domain_work_generation BEFORE INSERT OR UPDATE ON public."DomainWorkItem" FOR EACH ROW EXECUTE FUNCTION phase2_enforce_domain_work_generation();

CREATE TRIGGER trg_phase3_domain_work_claim_locators_delete AFTER DELETE ON public."DomainWorkItem" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION phase3_queue_domain_work_claim_locator_delete();

CREATE TRIGGER trg_phase3_domain_work_claim_locators_insert AFTER INSERT ON public."DomainWorkItem" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION phase3_queue_domain_work_claim_locator_insert();

CREATE TRIGGER trg_phase3_domain_work_claim_locators_update AFTER UPDATE ON public."DomainWorkItem" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION phase3_queue_domain_work_claim_locator_update();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."DomainWorkMemberScopeShardState" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."FanObservationReadLease" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."FanObservationReadLease" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."FanObservationToken" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."FanObservationToken" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER "FinancialObservedFact_writer_v1" BEFORE INSERT OR UPDATE ON public."FinancialObservedFact" FOR EACH ROW EXECUTE FUNCTION financial_receipt_writer_v1();

CREATE TRIGGER "FinancialPageReceipt_writer_v1" BEFORE INSERT OR UPDATE ON public."FinancialPageReceipt" FOR EACH ROW EXECUTE FUNCTION financial_receipt_writer_v1();

CREATE TRIGGER "FinancialReceiptRun_writer_v1" BEFORE INSERT OR UPDATE ON public."FinancialReceiptRun" FOR EACH ROW EXECUTE FUNCTION financial_receipt_writer_v1();

CREATE TRIGGER trg_phase3_hidden_status_projection AFTER INSERT OR DELETE OR UPDATE OF status ON public."HiddenOnlineUser" FOR EACH ROW EXECUTE FUNCTION phase3_project_hidden_status_to_bump();

CREATE TRIGGER "JobInstance_creator_task_activity_trg" AFTER INSERT OR UPDATE OF status, "startedAt", "claimedAt", "completedAt", "lastError", progress ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION onlinod_sync_creator_task_activity();

CREATE TRIGGER "JobInstance_financial_receipt_v1" BEFORE INSERT OR UPDATE ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION financial_receipt_job_guard_v1();

CREATE TRIGGER analytics_publishing_job_guard_v1 BEFORE UPDATE ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION onlinod_analytics_publishing_job_guard_v1();

CREATE TRIGGER campaign_bounded_claim_guard_v1_trg BEFORE INSERT OR UPDATE OF status, "leaseRevision", "claimedByDeviceId", params, continuation ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION campaign_bounded_claim_guard_v1();

CREATE TRIGGER campaign_fair_job_guard_v1_trg BEFORE INSERT OR UPDATE ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION campaign_fair_job_guard_v1();

CREATE TRIGGER campaign_traversal_job_guard_v1_trg BEFORE INSERT OR UPDATE OF status, "leaseRevision", "claimedByDeviceId", params, continuation ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION campaign_traversal_job_guard_v1();

CREATE TRIGGER onlinod_capacity_job_dirty AFTER INSERT OR DELETE OR UPDATE OF id, "jobKey", status, "scheduledAt" ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_mark_dirty('job');

CREATE TRIGGER phase3_campaign_claim_generation_guard_trg BEFORE UPDATE OF status ON public."JobInstance" FOR EACH ROW WHEN (((new."jobKey" = 'fetch_campaigns'::text) AND (new.status = 'CLAIMED'::text) AND (old.status IS DISTINCT FROM 'CLAIMED'::text))) EXECUTE FUNCTION phase3_campaign_claim_generation_guard();

CREATE TRIGGER traffic_job_retired_v2 BEFORE INSERT OR UPDATE ON public."JobInstance" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_job_retired_v2();

CREATE TRIGGER "NotificationFactReceipt_guard_v1" BEFORE UPDATE ON public."NotificationFactReceipt" FOR EACH ROW EXECUTE FUNCTION notification_fact_receipt_guard_v1();

CREATE TRIGGER onlinod_provider_gate_waiter_registration BEFORE UPDATE OF "activePermitId" ON public."OfProviderRequestGateState" FOR EACH ROW EXECUTE FUNCTION onlinod_enforce_provider_gate_waiter_registration();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."OfProviderRequestGateWaiter" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."OfProviderRequestGateWaiter" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_creator_dependency_insert_fence BEFORE INSERT OR UPDATE ON public."Phase2DependencyState" FOR EACH ROW EXECUTE FUNCTION phase2_fence_creator_dependency_insert_during_creator_delete();

CREATE TRIGGER "Phase2WorkGenerationAuthority_phase3_claim_invalidate" AFTER UPDATE OF "activeGeneration" ON public."Phase2WorkGenerationAuthority" FOR EACH ROW EXECUTE FUNCTION phase3_invalidate_domain_work_claim_generation();

CREATE TRIGGER onlinod_capacity_publication_fence BEFORE INSERT OR UPDATE ON public."ProviderCapacityDebtState" FOR EACH ROW EXECUTE FUNCTION onlinod_capacity_publication_fence();

CREATE TRIGGER phase2_indirect_creator_residual_insert_fence BEFORE INSERT OR UPDATE ON public."ProviderOperationalDebt" FOR EACH ROW EXECUTE FUNCTION phase2_fence_indirect_creator_residual_insert();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."ProviderOperationalDebt" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER "RefreshSession_capture_authorization_boundary" AFTER UPDATE OF "revokedAt" ON public."RefreshSession" FOR EACH ROW WHEN (((old."revokedAt" IS NULL) AND (new."revokedAt" IS NOT NULL))) EXECUTE FUNCTION capture_authorization_session_boundary();

CREATE TRIGGER actual60_auth_history_refresh_adoption BEFORE UPDATE OF "authorizationSessionId" ON public."RefreshSession" FOR EACH ROW WHEN (((new."authorizationSessionId" IS NOT NULL) AND (new."authorizationSessionId" IS DISTINCT FROM old."authorizationSessionId"))) EXECUTE FUNCTION actual60_require_auth_history_publisher_generation();

CREATE TRIGGER actual60_auth_history_refresh_insert BEFORE INSERT ON public."RefreshSession" FOR EACH ROW WHEN ((new."authorizationSessionId" IS NOT NULL)) EXECUTE FUNCTION actual60_require_auth_history_publisher_generation();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."RefreshSession" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase4_commercial_policy_guard BEFORE INSERT OR DELETE OR UPDATE ON public."SystemSetting" FOR EACH ROW EXECUTE FUNCTION phase4_commercial_policy_guard();

CREATE TRIGGER phase4_retention_policy_revision BEFORE INSERT OR DELETE OR UPDATE ON public."SystemSetting" FOR EACH ROW EXECUTE FUNCTION phase4_retention_policy_revision();

CREATE TRIGGER "TeamActivityEvent_phase2_dialog_work" AFTER INSERT ON public."TeamActivityEvent" FOR EACH ROW EXECUTE FUNCTION phase2_team_dialog_domain_work_trigger();

CREATE TRIGGER "TeamActivityEvent_project_historical_v2" BEFORE INSERT ON public."TeamActivityEvent" FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_activity_contribution_v2();

CREATE TRIGGER phase2_team_writer_generation_member_function BEFORE INSERT OR DELETE OR UPDATE ON public."TeamMemberFunction" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE TRIGGER "TeamMoneyAttributionFact_phase2_read_summary_work" AFTER INSERT OR UPDATE OF "memberId", "creatorId", "amountCents", currency, "occurredAt", "businessStatus", "financialStatus", "attributionActive", "classificationState", "sourceUpdatedAt" ON public."TeamMoneyAttributionFact" FOR EACH ROW EXECUTE FUNCTION phase2_team_money_read_summary_trigger();

CREATE TRIGGER "TeamPpvPurchaseLedger_project_historical_v2" BEFORE INSERT OR UPDATE ON public."TeamPpvPurchaseLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_ppv_fact_v2();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."TeamPpvPurchaseLedger" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."TeamPpvPurchaseLedger" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."TeamPpvResolveJob" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."TeamPpvResolveJob" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."TeamSentMessageLedger" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."TeamSentMessageLedger" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."TeamShiftCreator" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER "TeamTipLedger_project_historical_v2" BEFORE INSERT OR UPDATE ON public."TeamTipLedger" FOR EACH ROW EXECUTE FUNCTION onlinod_project_team_tip_fact_v2();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."TeamTipLedger" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."TeamTipLedger" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER "TelegramDeliveryIntent_phase2_domain_work" AFTER INSERT OR DELETE OR UPDATE OF "customOrderId", "accountId", kind, state, "commitStartedAt", "remoteMessageId", "remoteRecipientTelegramUserId", "remoteSentAt", "confirmedAt", "confirmationAuthority", "projectionBlockedAt", "providerBindingRetryAt", "outcomeReason" ON public."TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION phase2_intent_domain_work_trigger();

CREATE TRIGGER "TelegramDeliveryIntent_provider_operational_dirty" AFTER INSERT OR DELETE OR UPDATE OF "customOrderId", "accountId", kind, state, "commitStartedAt", "remoteMessageId", "remoteSentAt", "confirmedAt", "projectionBlockedAt", "providerBindingRetryAt", "outcomeReason" ON public."TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION phase2_provider_intent_dirty_trigger();

CREATE TRIGGER phase2_direct_creator_insert_fence BEFORE INSERT OR UPDATE ON public."TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION phase2_fence_direct_creator_insert_during_creator_delete();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER telegram_new_send_v2 BEFORE INSERT OR UPDATE ON public."TelegramDeliveryIntent" FOR EACH ROW EXECUTE FUNCTION onlinod_telegram_new_send_v2();

CREATE TRIGGER "TelegramInboundEvent_phase2_domain_work" AFTER INSERT OR UPDATE OF "submissionId" ON public."TelegramInboundEvent" FOR EACH ROW EXECUTE FUNCTION phase2_inbound_domain_work_trigger();

CREATE TRIGGER phase2_indirect_creator_residual_insert_fence BEFORE INSERT OR UPDATE ON public."TelegramInboundEvent" FOR EACH ROW EXECUTE FUNCTION phase2_fence_indirect_creator_residual_insert();

CREATE TRIGGER phase2_non_fk_tenant_insert_fence BEFORE INSERT OR UPDATE ON public."TelegramInboundEvent" FOR EACH ROW EXECUTE FUNCTION phase2_fence_non_fk_tenant_insert_during_agency_delete();

CREATE TRIGGER traffic_fan_writer_v3 BEFORE INSERT OR DELETE OR UPDATE ON public."TrafficFanProjection" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_projection_guard_v3();

CREATE TRIGGER traffic_metric_writer_v3 BEFORE INSERT OR DELETE OR UPDATE ON public."TrafficMetric" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_projection_guard_v3();

CREATE TRIGGER traffic_backfill_writer_v3 BEFORE DELETE OR UPDATE ON public."TrafficProjectionBackfillData" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_projection_guard_v3();

CREATE TRIGGER traffic_seed_writer_v3 BEFORE DELETE OR UPDATE ON public."TrafficProjectionSeed" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_projection_guard_v3();

CREATE TRIGGER traffic_receipt_writer_v3 BEFORE INSERT OR DELETE OR UPDATE ON public."TrafficReceiptProjection" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_projection_guard_v3();

CREATE TRIGGER traffic_provider_guard_v2 BEFORE INSERT OR UPDATE ON public."TrafficSource" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_provider_guard_v2();

CREATE TRIGGER traffic_source_delete_guard_v2 BEFORE DELETE ON public."TrafficSource" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_delete_guard_v2();

CREATE TRIGGER traffic_source_metrics_v2 AFTER INSERT OR UPDATE ON public."TrafficSource" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_source_metrics_v2();

CREATE TRIGGER traffic_source_writer_v3 BEFORE INSERT OR DELETE OR UPDATE ON public."TrafficSource" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_projection_guard_v3();

CREATE TRIGGER traffic_member_delete_guard_v2 BEFORE DELETE ON public."TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_delete_guard_v2();

CREATE TRIGGER traffic_member_dirty_v2 AFTER INSERT OR UPDATE ON public."TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_member_dirty_capture_v2();

CREATE TRIGGER traffic_member_provider_guard_v2 BEFORE INSERT OR UPDATE ON public."TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_provider_guard_v2();

CREATE TRIGGER traffic_member_writer_v3 BEFORE INSERT OR DELETE OR UPDATE ON public."TrafficSourceMember" FOR EACH ROW EXECUTE FUNCTION onlinod_traffic_projection_guard_v3();

CREATE TRIGGER phase2_team_writer_generation_user_disabled BEFORE DELETE OR UPDATE OF "disabledAt" ON public."User" FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

CREATE CONSTRAINT TRIGGER phase4_owner_user_disable AFTER UPDATE ON public."User" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old."disabledAt" IS DISTINCT FROM new."disabledAt") AND (new."disabledAt" IS NOT NULL))) EXECUTE FUNCTION phase4_check_user_owner();

CREATE TRIGGER "WorkspaceSetting_phase2_custom_pipeline_config" AFTER INSERT OR DELETE OR UPDATE OF key, value ON public."WorkspaceSetting" FOR EACH ROW EXECUTE FUNCTION phase2_custom_pipeline_config_dependency_trigger();


COMMIT;
