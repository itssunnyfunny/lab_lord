CREATE TYPE "BillingOperationStatus" AS ENUM (
  'CHECKOUT_OPEN',
  'VERIFYING',
  'AWAITING_PROVIDER_CONFIRMATION',
  'APPLIED',
  'DECLINED',
  'ABANDONED',
  'FAILED',
  'SCHEDULED'
);

ALTER TYPE "BillingChangeType" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_AUTHORIZATION' BEFORE 'TRIAL_SUBSCRIPTION_UPDATE';

ALTER TABLE "OrganizationBillingChange"
  ADD COLUMN "operationStatus" "BillingOperationStatus" NOT NULL DEFAULT 'AWAITING_PROVIDER_CONFIRMATION',
  ADD COLUMN "returnPath" TEXT,
  ADD COLUMN "confirmationDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "failureCategory" TEXT,
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "checkoutOpenedAt" TIMESTAMP(3),
  ADD COLUMN "verificationStartedAt" TIMESTAMP(3),
  ADD COLUMN "providerConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "abandonedAt" TIMESTAMP(3),
  ADD COLUMN "declinedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedAt" TIMESTAMP(3);

UPDATE "OrganizationBillingChange"
SET "operationStatus" = CASE
  WHEN "status" = 'APPLIED' THEN 'APPLIED'::"BillingOperationStatus"
  WHEN "status" = 'SCHEDULED' THEN 'SCHEDULED'::"BillingOperationStatus"
  WHEN "status" = 'FAILED' THEN 'FAILED'::"BillingOperationStatus"
  WHEN "status" IN ('UNDONE', 'SUPERSEDED') THEN 'ABANDONED'::"BillingOperationStatus"
  ELSE 'AWAITING_PROVIDER_CONFIRMATION'::"BillingOperationStatus"
END;

CREATE INDEX "OrganizationBillingChange_organizationId_operationStatus_sequence_idx"
  ON "OrganizationBillingChange"("organizationId", "operationStatus", "sequence");
