-- CreateEnum
CREATE TYPE "SaasSubscriptionHistorySource" AS ENUM ('CHECKOUT', 'VERIFICATION', 'WEBHOOK', 'CUSTOMER_CANCELLATION', 'SYSTEM');

-- AlterTable
ALTER TABLE "OrganizationSubscription"
ADD COLUMN "cancelAtCycleEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cancellationRequestedAt" TIMESTAMP(3),
ADD COLUMN "cancellationScheduledAt" TIMESTAMP(3),
ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrganizationSubscriptionHistory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "organizationSubscriptionId" TEXT,
    "razorpaySubscriptionId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "plan" "SaasPlan" NOT NULL,
    "fromStatus" "SaasSubscriptionStatus",
    "toStatus" "SaasSubscriptionStatus" NOT NULL,
    "source" "SaasSubscriptionHistorySource" NOT NULL,
    "event" TEXT,
    "amountSubunits" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationSubscriptionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationSubscriptionHistory_organizationId_createdAt_idx"
ON "OrganizationSubscriptionHistory"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizationSubscriptionHistory_organizationSubscriptionId_createdAt_idx"
ON "OrganizationSubscriptionHistory"("organizationSubscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizationSubscriptionHistory_razorpaySubscriptionId_idx"
ON "OrganizationSubscriptionHistory"("razorpaySubscriptionId");

-- AddForeignKey
ALTER TABLE "OrganizationSubscriptionHistory"
ADD CONSTRAINT "OrganizationSubscriptionHistory_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSubscriptionHistory"
ADD CONSTRAINT "OrganizationSubscriptionHistory_organizationSubscriptionId_fkey"
FOREIGN KEY ("organizationSubscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
