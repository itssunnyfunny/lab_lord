-- Razorpay Test and Live entities exist in isolated provider namespaces. Keep
-- the mode explicit on every provider-backed billing record; never infer old
-- rows from the credentials used by a later deployment.
CREATE TYPE "RazorpayMode" AS ENUM ('TEST', 'LIVE');
CREATE TYPE "RazorpayPlanProvisioningStatus" AS ENUM ('PENDING', 'PROVISIONING', 'READY', 'FAILED');

ALTER TYPE "BillingChangeType" ADD VALUE IF NOT EXISTS 'UNSUPPORTED_METHOD_CANCELLATION';

ALTER TABLE "SaasRazorpayPlan"
  ADD COLUMN "providerMode" "RazorpayMode",
  ADD COLUMN "catalogKey" TEXT,
  ADD COLUMN "lastProviderVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "BillingOffer"
  ADD COLUMN "providerMode" "RazorpayMode";

ALTER TABLE "OrganizationSubscription"
  ADD COLUMN "providerMode" "RazorpayMode";

-- The Live Razorpay account was audited before this migration and contained no
-- plans or subscriptions, so every pre-existing provider reference is a Test
-- Mode reference. This is a one-time data migration, not a column default.
UPDATE "SaasRazorpayPlan"
SET
  "providerMode" = 'TEST'::"RazorpayMode",
  "catalogKey" = 'razorpay-plan:v1:TEST:'
    || "plan"::TEXT || ':'
    || UPPER("currency") || ':'
    || "amountSubunits"::TEXT || ':'
    || LOWER("period") || ':'
    || "interval"::TEXT;

UPDATE "BillingOffer"
SET "providerMode" = 'TEST'::"RazorpayMode";

UPDATE "OrganizationSubscription"
SET "providerMode" = 'TEST'::"RazorpayMode";

ALTER TABLE "SaasRazorpayPlan"
  ALTER COLUMN "providerMode" SET NOT NULL,
  ALTER COLUMN "catalogKey" SET NOT NULL;

ALTER TABLE "BillingOffer"
  ALTER COLUMN "providerMode" SET NOT NULL;

ALTER TABLE "OrganizationSubscription"
  ALTER COLUMN "providerMode" SET NOT NULL;

-- Preserve the newest active mapping when older deployments left more than
-- one active price for the same Test/Live mode and SaaS plan. Historic rows
-- remain readable but inactive.
WITH "rankedActivePlans" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "providerMode", "plan"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS "activeRank"
  FROM "SaasRazorpayPlan"
  WHERE "active" = TRUE
)
UPDATE "SaasRazorpayPlan" AS "planMapping"
SET "active" = FALSE
FROM "rankedActivePlans"
WHERE "planMapping"."id" = "rankedActivePlans"."id"
  AND "rankedActivePlans"."activeRank" > 1;

DROP INDEX "SaasRazorpayPlan_plan_active_idx";
DROP INDEX "BillingOffer_plan_active_idx";
DROP INDEX "OrganizationSubscription_status_idx";
DROP INDEX "OrganizationSubscription_plan_idx";

CREATE INDEX "SaasRazorpayPlan_providerMode_plan_active_idx"
  ON "SaasRazorpayPlan"("providerMode", "plan", "active");
CREATE INDEX "SaasRazorpayPlan_providerMode_catalogKey_idx"
  ON "SaasRazorpayPlan"("providerMode", "catalogKey");
CREATE INDEX "SaasRazorpayPlan_providerMode_razorpayPlanId_idx"
  ON "SaasRazorpayPlan"("providerMode", "razorpayPlanId");
CREATE UNIQUE INDEX "SaasRazorpayPlan_one_active_per_mode_plan_key"
  ON "SaasRazorpayPlan"("providerMode", "plan")
  WHERE "active" = TRUE;
CREATE INDEX "BillingOffer_providerMode_plan_active_idx"
  ON "BillingOffer"("providerMode", "plan", "active");
CREATE INDEX "BillingOffer_providerMode_razorpayOfferId_idx"
  ON "BillingOffer"("providerMode", "razorpayOfferId");
CREATE INDEX "OrganizationSubscription_providerMode_status_idx"
  ON "OrganizationSubscription"("providerMode", "status");
CREATE INDEX "OrganizationSubscription_providerMode_plan_idx"
  ON "OrganizationSubscription"("providerMode", "plan");
CREATE INDEX "OrganizationSubscription_providerMode_razorpaySubscriptionId_idx"
  ON "OrganizationSubscription"("providerMode", "razorpaySubscriptionId");

CREATE TABLE "RazorpayPlanProvisioning" (
  "id" TEXT NOT NULL,
  "catalogKey" TEXT NOT NULL,
  "providerMode" "RazorpayMode" NOT NULL,
  "plan" "SaasPlan" NOT NULL,
  "amount" INTEGER NOT NULL,
  "amountSubunits" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "interval" INTEGER NOT NULL,
  "status" "RazorpayPlanProvisioningStatus" NOT NULL DEFAULT 'PENDING',
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "razorpayPlanId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RazorpayPlanProvisioning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RazorpayPlanProvisioning_catalogKey_key"
  ON "RazorpayPlanProvisioning"("catalogKey");
CREATE INDEX "RazorpayPlanProvisioning_providerMode_plan_status_idx"
  ON "RazorpayPlanProvisioning"("providerMode", "plan", "status");
CREATE INDEX "RazorpayPlanProvisioning_status_leaseUntil_idx"
  ON "RazorpayPlanProvisioning"("status", "leaseUntil");

-- This singleton is the database identity used by the rollout preflight.
-- Because it lives inside the database, pooled/direct/Accelerate aliases for
-- the same database cannot masquerade as isolated environments.
CREATE TABLE "BillingDatabaseIdentity" (
  "id" INTEGER NOT NULL,
  "identity" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BillingDatabaseIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingDatabaseIdentity_singleton_check" CHECK ("id" = 1)
);

CREATE UNIQUE INDEX "BillingDatabaseIdentity_identity_key"
  ON "BillingDatabaseIdentity"("identity");

INSERT INTO "BillingDatabaseIdentity" ("id", "identity")
VALUES (
  1,
  md5(
    random()::TEXT
    || clock_timestamp()::TEXT
    || pg_backend_pid()::TEXT
    || current_database()
  )::UUID
);

-- Prisma supplies updatedAt on every subsequent create/update. The temporary
-- default only makes the historical backfill possible.
ALTER TABLE "SaasRazorpayPlan" ALTER COLUMN "updatedAt" DROP DEFAULT;
