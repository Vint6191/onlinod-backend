ALTER TABLE "BillingOrder" ADD COLUMN "reconciliationState" JSONB;
ALTER TABLE "BillingPaymentAttempt"
  ADD COLUMN "settlementState" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "settledCents" BIGINT NOT NULL DEFAULT 0 CHECK ("settledCents" >= 0),
  ADD COLUMN "settlementBasis" TEXT,
  ADD COLUMN "settlementEvidence" JSONB,
  ADD COLUMN "settledAt" TIMESTAMP(3),
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "actuallyPaidAtFiat" DECIMAL(30,12),
  ADD COLUMN "walletCreditTransactionId" TEXT,
  ADD COLUMN "providerUpdatedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "BillingPaymentAttempt_walletCreditTransactionId_key" ON "BillingPaymentAttempt"("walletCreditTransactionId");

-- Preserve existing balances. A single historical attempt can own an old
-- order-level credit; multiple candidates must not be guessed or credited twice.
WITH candidates AS (
  SELECT p."orderId",min(p.id) AS id,count(*) AS n
  FROM "BillingPaymentAttempt" p GROUP BY p."orderId"
)
UPDATE "BillingPaymentAttempt" p SET
  "settlementState"=CASE WHEN refund.id IS NOT NULL THEN 'REFUNDED' ELSE 'LEGACY_CREDITED' END,
  "settledCents"=credit."amountCents", "settledAt"=credit."createdAt", "walletCreditTransactionId"=credit.id,
  "settlementBasis"='LEGACY_ORDER_CREDIT',
  "settlementEvidence"=jsonb_build_object('legacy',true,'actuallyPaid',p."actuallyPaid"::text,'payCurrency',lower(p."payCurrency")),
  "reversedAt"=refund."createdAt"
FROM candidates c JOIN "BillingOrder" o ON o.id=c."orderId"
JOIN "BillingWalletTransaction" credit ON credit."idempotencyKey"='topup:'||o.id AND credit.type='TOP_UP'
  AND credit."orderId"=o.id AND credit."agencyId"=o."agencyId" AND credit."testMode"=o."testMode" AND credit."amountCents"=o."amountCents" AND credit."amountCents">0 AND credit.currency=o.currency
JOIN "AgencyBillingWallet" wallet ON wallet.id=credit."walletId" AND wallet."agencyId"=o."agencyId" AND wallet."testMode"=o."testMode" AND wallet.currency=o.currency
LEFT JOIN "BillingWalletTransaction" refund ON refund."idempotencyKey"='topup-refund:'||o.id AND refund.type='TOP_UP_REFUND'
  AND refund."orderId"=o.id AND refund."agencyId"=o."agencyId" AND refund."testMode"=o."testMode"
  AND refund."walletId"=credit."walletId" AND refund.currency=credit.currency AND refund."amountCents"=-credit."amountCents"
WHERE c.n=1 AND p.id=c.id AND p."providerStatus" IN ('finished','refunded')
  AND (refund.id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM "BillingWalletTransaction" disputed WHERE disputed."idempotencyKey"='topup-refund:'||o.id));
UPDATE "BillingPaymentAttempt" p SET "settlementState"='REVIEW_REQUIRED',
  "settlementEvidence"=jsonb_build_object('reason','LEGACY_PAYMENT_BINDING_REVIEW_REQUIRED')
WHERE EXISTS(SELECT 1 FROM "BillingWalletTransaction" w WHERE w."idempotencyKey"='topup:'||p."orderId")
  AND NOT EXISTS(SELECT 1 FROM "BillingPaymentAttempt" bound WHERE bound."orderId"=p."orderId" AND bound."walletCreditTransactionId" IS NOT NULL);
UPDATE "BillingOrder" o SET "reconciliationState"=jsonb_build_object('reviewRequired',true,'reason','LEGACY_PAYMENT_BINDING_REVIEW_REQUIRED')
WHERE EXISTS(SELECT 1 FROM "BillingWalletTransaction" w WHERE w."idempotencyKey"='topup:'||o.id)
  AND NOT EXISTS(SELECT 1 FROM "BillingPaymentAttempt" bound WHERE bound."orderId"=o.id AND bound."walletCreditTransactionId" IS NOT NULL);

CREATE FUNCTION nod_billing_payment_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."orderId",NEW.provider,NEW."testMode",NEW."providerPaymentId") IS DISTINCT FROM ROW(OLD."orderId",OLD.provider,OLD."testMode",OLD."providerPaymentId") THEN
    RAISE EXCEPTION 'BILLING_PAYMENT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NEW."settledCents" < OLD."settledCents" OR (OLD."reversedAt" IS NOT NULL AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt") THEN
    RAISE EXCEPTION 'BILLING_PAYMENT_SETTLEMENT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nod_billing_payment_identity_immutable BEFORE UPDATE ON "BillingPaymentAttempt"
  FOR EACH ROW EXECUTE FUNCTION nod_billing_payment_identity_immutable();
