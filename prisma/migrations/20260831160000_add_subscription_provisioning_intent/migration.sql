-- Add a distinct pre-Checkout state so an initial subscription create can be
-- admitted durably before crossing the Razorpay mutation boundary.
ALTER TYPE "BillingOperationStatus" ADD VALUE 'PROVISIONING';

-- The existing billing-change row already owns the organization, operation,
-- provider mode, plan, quantity, offer, and commercial snapshot. These fields
-- add only the missing immutable provisioning coordinates and call admission.
ALTER TABLE "OrganizationBillingChange"
ADD COLUMN "provisioningIntentVersion" INTEGER,
ADD COLUMN "provisioningSourceSubscriptionId" TEXT,
ADD COLUMN "providerMutationAdmittedAt" TIMESTAMP(3),
ADD COLUMN "authorizedBillingModelVersion" "BillingModelVersion",
ADD COLUMN "authorizedProviderStartAt" TIMESTAMP(3),
ADD COLUMN "authorizedProviderExpireAt" TIMESTAMP(3),
ADD COLUMN "authorizedTotalCount" INTEGER;

-- Pre-subscription manual-review outcomes cannot use subscription history, so
-- retain a small tenant-scoped, deduplicated audit ledger on the operation.
CREATE TABLE "OrganizationBillingChangeAudit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "failureCode" TEXT,
    "providerSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationBillingChangeAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationBillingChangeAudit_dedupeKey_key"
ON "OrganizationBillingChangeAudit"("dedupeKey");

CREATE INDEX "OrganizationBillingChangeAudit_organizationId_createdAt_idx"
ON "OrganizationBillingChangeAudit"("organizationId", "createdAt");

CREATE INDEX "OrganizationBillingChangeAudit_changeId_createdAt_idx"
ON "OrganizationBillingChangeAudit"("changeId", "createdAt");

ALTER TABLE "OrganizationBillingChangeAudit"
ADD CONSTRAINT "OrganizationBillingChangeAudit_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganizationBillingChangeAudit"
ADD CONSTRAINT "OrganizationBillingChangeAudit_changeId_fkey"
FOREIGN KEY ("changeId") REFERENCES "OrganizationBillingChange"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
