-- CreateEnum
CREATE TYPE "SaasPlan" AS ENUM ('BASIC', 'PRO', 'AGENT_CONTROL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SaasSubscriptionStatus" AS ENUM ('CREATED', 'AUTHENTICATED', 'ACTIVE', 'PENDING', 'HALTED', 'CANCELLED', 'COMPLETED', 'EXPIRED');

-- CreateTable
CREATE TABLE "SaasRazorpayPlan" (
    "id" TEXT NOT NULL,
    "plan" "SaasPlan" NOT NULL,
    "amount" INTEGER NOT NULL,
    "amountSubunits" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "period" TEXT NOT NULL DEFAULT 'monthly',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "razorpayPlanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasRazorpayPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "plan" "SaasPlan" NOT NULL,
    "amount" INTEGER NOT NULL,
    "amountSubunits" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "period" TEXT NOT NULL DEFAULT 'monthly',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "totalCount" INTEGER NOT NULL,
    "razorpayPlanId" TEXT NOT NULL,
    "razorpaySubscriptionId" TEXT NOT NULL,
    "razorpayCustomerId" TEXT,
    "status" "SaasSubscriptionStatus" NOT NULL DEFAULT 'CREATED',
    "authPaymentId" TEXT,
    "currentStart" TIMESTAMP(3),
    "currentEnd" TIMESTAMP(3),
    "chargeAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RazorpayWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "organizationId" TEXT,
    "organizationSubscriptionId" TEXT,
    "razorpayPaymentId" TEXT,
    "razorpaySubscriptionId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,

    CONSTRAINT "RazorpayWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaasRazorpayPlan_plan_key" ON "SaasRazorpayPlan"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "SaasRazorpayPlan_razorpayPlanId_key" ON "SaasRazorpayPlan"("razorpayPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSubscription_organizationId_key" ON "OrganizationSubscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSubscription_razorpaySubscriptionId_key" ON "OrganizationSubscription"("razorpaySubscriptionId");

-- CreateIndex
CREATE INDEX "OrganizationSubscription_status_idx" ON "OrganizationSubscription"("status");

-- CreateIndex
CREATE INDEX "OrganizationSubscription_plan_idx" ON "OrganizationSubscription"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "RazorpayWebhookEvent_eventId_key" ON "RazorpayWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "RazorpayWebhookEvent_organizationId_idx" ON "RazorpayWebhookEvent"("organizationId");

-- CreateIndex
CREATE INDEX "RazorpayWebhookEvent_organizationSubscriptionId_idx" ON "RazorpayWebhookEvent"("organizationSubscriptionId");

-- CreateIndex
CREATE INDEX "RazorpayWebhookEvent_razorpayPaymentId_idx" ON "RazorpayWebhookEvent"("razorpayPaymentId");

-- CreateIndex
CREATE INDEX "RazorpayWebhookEvent_razorpaySubscriptionId_idx" ON "RazorpayWebhookEvent"("razorpaySubscriptionId");

-- AddForeignKey
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RazorpayWebhookEvent" ADD CONSTRAINT "RazorpayWebhookEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RazorpayWebhookEvent" ADD CONSTRAINT "RazorpayWebhookEvent_organizationSubscriptionId_fkey" FOREIGN KEY ("organizationSubscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
