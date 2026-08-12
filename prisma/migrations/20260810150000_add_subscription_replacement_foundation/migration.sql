ALTER TYPE "SaasSubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED' AFTER 'PENDING';
ALTER TYPE "BillingChangeType" ADD VALUE IF NOT EXISTS 'PAYMENT_METHOD_REPLACEMENT' AFTER 'SUBSCRIPTION_AUTHORIZATION';

ALTER TABLE "OrganizationSubscription"
  ADD COLUMN "currentOrganizationId" TEXT,
  ADD COLUMN "pendingReplacementOrganizationId" TEXT,
  ADD COLUMN "replacesSubscriptionId" TEXT;

UPDATE "OrganizationSubscription"
SET "currentOrganizationId" = "organizationId";

CREATE UNIQUE INDEX "OrganizationSubscription_currentOrganizationId_key"
  ON "OrganizationSubscription"("currentOrganizationId");

CREATE UNIQUE INDEX "OrganizationSubscription_pendingReplacementOrganizationId_key"
  ON "OrganizationSubscription"("pendingReplacementOrganizationId");

CREATE INDEX "OrganizationSubscription_organizationId_createdAt_idx"
  ON "OrganizationSubscription"("organizationId", "createdAt");

CREATE INDEX "OrganizationSubscription_replacesSubscriptionId_idx"
  ON "OrganizationSubscription"("replacesSubscriptionId");

ALTER TABLE "OrganizationSubscription"
  ADD CONSTRAINT "OrganizationSubscription_currentOrganizationId_fkey"
  FOREIGN KEY ("currentOrganizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrganizationSubscription"
  ADD CONSTRAINT "OrganizationSubscription_pendingReplacementOrganizationId_fkey"
  FOREIGN KEY ("pendingReplacementOrganizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrganizationSubscription"
  ADD CONSTRAINT "OrganizationSubscription_replacesSubscriptionId_fkey"
  FOREIGN KEY ("replacesSubscriptionId") REFERENCES "OrganizationSubscription"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrganizationSubscription"
  ADD CONSTRAINT "OrganizationSubscription_slot_owner_check"
  CHECK (
    ("currentOrganizationId" IS NULL OR "currentOrganizationId" = "organizationId")
    AND (
      "pendingReplacementOrganizationId" IS NULL
      OR "pendingReplacementOrganizationId" = "organizationId"
    )
    AND NOT (
      "currentOrganizationId" IS NOT NULL
      AND "pendingReplacementOrganizationId" IS NOT NULL
    )
    AND (
      "pendingReplacementOrganizationId" IS NULL
      OR "replacesSubscriptionId" IS NOT NULL
    )
  );

ALTER TABLE "OrganizationBillingChange"
  ADD COLUMN "replacementSubscriptionId" TEXT,
  ADD COLUMN "accessGrantedAt" TIMESTAMP(3),
  ADD COLUMN "accessRevokedAt" TIMESTAMP(3),
  ADD COLUMN "accessGraceEndsAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "OrganizationBillingChange_replacementSubscriptionId_key"
  ON "OrganizationBillingChange"("replacementSubscriptionId");

ALTER TABLE "OrganizationBillingChange"
  ADD CONSTRAINT "OrganizationBillingChange_replacementSubscriptionId_fkey"
  FOREIGN KEY ("replacementSubscriptionId") REFERENCES "OrganizationSubscription"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
