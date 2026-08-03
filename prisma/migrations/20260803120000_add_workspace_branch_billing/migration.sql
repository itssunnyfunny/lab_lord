-- Workspace/branch-seat billing is additive and remains disabled until rollout.
CREATE TYPE "BillingModelVersion" AS ENUM ('LEGACY', 'WORKSPACE_V2');
CREATE TYPE "OwnerTrialSource" AS ENUM ('ONBOARDING', 'MIGRATION');
CREATE TYPE "OwnerTrialStatus" AS ENUM ('AVAILABLE', 'ACTIVE', 'EXPIRED', 'REVOKED');
CREATE TYPE "BranchBillingStatus" AS ENUM ('ACTIVE', 'PENDING_ACTIVATION', 'REMOVAL_SCHEDULED', 'ARCHIVED');
CREATE TYPE "ProviderPaymentMethod" AS ENUM ('CARD', 'UPI', 'EMANDATE', 'UNKNOWN');
CREATE TYPE "BillingChangeType" AS ENUM ('TRIAL_SUBSCRIPTION_UPDATE', 'PLAN_UPGRADE', 'PLAN_DOWNGRADE', 'QUANTITY_INCREASE', 'BRANCH_REMOVAL', 'BRANCH_REACTIVATION', 'CANCELLATION', 'LEGACY_TRANSITION');
CREATE TYPE "BillingChangeStatus" AS ENUM ('QUEUED', 'PROCESSING', 'AWAITING_PAYMENT', 'SCHEDULED', 'APPLIED', 'UNDONE', 'FAILED', 'SUPERSEDED');
CREATE TYPE "BillingOfferDiscountType" AS ENUM ('FLAT', 'PERCENTAGE');
CREATE TYPE "BillingOfferDurationType" AS ENUM ('SINGLE_USE', 'LIMITED_CYCLES');
CREATE TYPE "OrganizationOfferGrantStatus" AS ENUM ('ELIGIBLE', 'RESERVED', 'REDEEMED', 'EXPIRED', 'REVOKED');

ALTER TABLE "Organization"
  ADD COLUMN "billingModelVersion" "BillingModelVersion" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "billingMutationSequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billingMutationLeaseToken" TEXT,
  ADD COLUMN "billingMutationLeaseUntil" TIMESTAMP(3);

ALTER TABLE "Branch"
  ADD COLUMN "billingStatus" "BranchBillingStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "billingActivatedAt" TIMESTAMP(3),
  ADD COLUMN "billingArchivedAt" TIMESTAMP(3);

UPDATE "Branch" SET "billingActivatedAt" = "createdAt" WHERE "billingActivatedAt" IS NULL;

ALTER TABLE "SaasRazorpayPlan"
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
DROP INDEX "SaasRazorpayPlan_plan_key";
CREATE UNIQUE INDEX "SaasRazorpayPlan_plan_razorpayPlanId_key" ON "SaasRazorpayPlan"("plan", "razorpayPlanId");
CREATE INDEX "SaasRazorpayPlan_plan_active_idx" ON "SaasRazorpayPlan"("plan", "active");

CREATE TABLE "OwnerTrialGrant" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "organizationId" TEXT,
  "source" "OwnerTrialSource" NOT NULL,
  "status" "OwnerTrialStatus" NOT NULL DEFAULT 'AVAILABLE',
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "trialStartedAt" TIMESTAMP(3),
  "trialEndsAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "OwnerTrialGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerTrialGrant_ownerId_key" ON "OwnerTrialGrant"("ownerId");
CREATE UNIQUE INDEX "OwnerTrialGrant_organizationId_key" ON "OwnerTrialGrant"("organizationId");
CREATE INDEX "OwnerTrialGrant_status_idx" ON "OwnerTrialGrant"("status");
CREATE INDEX "OwnerTrialGrant_trialEndsAt_idx" ON "OwnerTrialGrant"("trialEndsAt");

CREATE TABLE "BillingOffer" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "plan" "SaasPlan" NOT NULL,
  "razorpayOfferId" TEXT NOT NULL,
  "discountType" "BillingOfferDiscountType" NOT NULL,
  "discountValue" INTEGER NOT NULL,
  "durationType" "BillingOfferDurationType" NOT NULL,
  "durationCycles" INTEGER NOT NULL DEFAULT 1,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "validFrom" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "isCompositeStack" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingOffer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillingOffer_razorpayOfferId_key" ON "BillingOffer"("razorpayOfferId");
CREATE INDEX "BillingOffer_plan_active_idx" ON "BillingOffer"("plan", "active");

ALTER TABLE "OrganizationSubscription"
  ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "providerStartAt" TIMESTAMP(3),
  ADD COLUMN "authorizationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "providerPaymentMethod" "ProviderPaymentMethod" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "paidThrough" TIMESTAMP(3),
  ADD COLUMN "lastConfirmedInvoiceId" TEXT,
  ADD COLUMN "lastConfirmedPaymentId" TEXT,
  ADD COLUMN "lastPaymentConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "authorizationLapsedAt" TIMESTAMP(3),
  ADD COLUMN "billingOfferId" TEXT,
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "OrganizationSubscription_authPaymentId_key" ON "OrganizationSubscription"("authPaymentId");

CREATE TABLE "OrganizationOfferGrant" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "billingOfferId" TEXT NOT NULL,
  "status" "OrganizationOfferGrantStatus" NOT NULL DEFAULT 'ELIGIBLE',
  "eligibleFrom" TIMESTAMP(3),
  "eligibleUntil" TIMESTAMP(3),
  "reservedAt" TIMESTAMP(3),
  "redeemedAt" TIMESTAMP(3),
  "subscriptionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationOfferGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationOfferGrant_organizationId_billingOfferId_key" ON "OrganizationOfferGrant"("organizationId", "billingOfferId");
CREATE INDEX "OrganizationOfferGrant_organizationId_status_idx" ON "OrganizationOfferGrant"("organizationId", "status");

CREATE TABLE "OrganizationBillingChange" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "organizationSubscriptionId" TEXT,
  "branchId" TEXT,
  "sequence" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "type" "BillingChangeType" NOT NULL,
  "status" "BillingChangeStatus" NOT NULL DEFAULT 'QUEUED',
  "fromPlan" "SaasPlan",
  "toPlan" "SaasPlan",
  "fromQuantity" INTEGER,
  "toQuantity" INTEGER,
  "effectiveAt" TIMESTAMP(3),
  "undoCutoffAt" TIMESTAMP(3),
  "providerInvoiceId" TEXT,
  "providerPaymentId" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processingStartedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "undoneAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationBillingChange_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationBillingChange_idempotencyKey_key" ON "OrganizationBillingChange"("idempotencyKey");
CREATE UNIQUE INDEX "OrganizationBillingChange_organizationId_sequence_key" ON "OrganizationBillingChange"("organizationId", "sequence");
CREATE INDEX "OrganizationBillingChange_organizationId_status_sequence_idx" ON "OrganizationBillingChange"("organizationId", "status", "sequence");
CREATE INDEX "OrganizationBillingChange_undoCutoffAt_status_idx" ON "OrganizationBillingChange"("undoCutoffAt", "status");

CREATE TABLE "OrganizationSubscriptionInvoice" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "organizationSubscriptionId" TEXT,
  "razorpayInvoiceId" TEXT NOT NULL,
  "razorpayPaymentId" TEXT,
  "status" TEXT NOT NULL,
  "amountSubunits" INTEGER NOT NULL,
  "amountPaidSubunits" INTEGER NOT NULL DEFAULT 0,
  "amountDueSubunits" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "paymentMethod" "ProviderPaymentMethod" NOT NULL DEFAULT 'UNKNOWN',
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "issuedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationSubscriptionInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationSubscriptionInvoice_razorpayInvoiceId_key" ON "OrganizationSubscriptionInvoice"("razorpayInvoiceId");
CREATE UNIQUE INDEX "OrganizationSubscriptionInvoice_razorpayPaymentId_key" ON "OrganizationSubscriptionInvoice"("razorpayPaymentId");
CREATE INDEX "OrganizationSubscriptionInvoice_organizationId_createdAt_idx" ON "OrganizationSubscriptionInvoice"("organizationId", "createdAt");
CREATE INDEX "OrganizationSubscriptionInvoice_organizationSubscriptionId_createdAt_idx" ON "OrganizationSubscriptionInvoice"("organizationSubscriptionId", "createdAt");

ALTER TABLE "OrganizationSubscriptionHistory"
  ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "unitAmountSubunits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalAmountSubunits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "paidThrough" TIMESTAMP(3),
  ADD COLUMN "dedupeKey" TEXT;
UPDATE "OrganizationSubscriptionHistory"
SET "unitAmountSubunits" = "amountSubunits", "totalAmountSubunits" = "amountSubunits";
CREATE UNIQUE INDEX "OrganizationSubscriptionHistory_dedupeKey_key" ON "OrganizationSubscriptionHistory"("dedupeKey");

ALTER TABLE "OwnerTrialGrant" ADD CONSTRAINT "OwnerTrialGrant_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerTrialGrant" ADD CONSTRAINT "OwnerTrialGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_billingOfferId_fkey" FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationOfferGrant" ADD CONSTRAINT "OrganizationOfferGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationOfferGrant" ADD CONSTRAINT "OrganizationOfferGrant_billingOfferId_fkey" FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationBillingChange" ADD CONSTRAINT "OrganizationBillingChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationBillingChange" ADD CONSTRAINT "OrganizationBillingChange_organizationSubscriptionId_fkey" FOREIGN KEY ("organizationSubscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationBillingChange" ADD CONSTRAINT "OrganizationBillingChange_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscriptionInvoice" ADD CONSTRAINT "OrganizationSubscriptionInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscriptionInvoice" ADD CONSTRAINT "OrganizationSubscriptionInvoice_organizationSubscriptionId_fkey" FOREIGN KEY ("organizationSubscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
