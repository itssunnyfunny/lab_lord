-- PR3 requires an empty PR2 outbox so that required trusted snapshots are never
-- fabricated for historical rows. Stop before changing the schema if that
-- deployment precondition is not true.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WhatsAppMessage" LIMIT 1) THEN
    RAISE EXCEPTION 'WhatsApp PR3 migration requires an empty WhatsAppMessage table; inspect existing rows before retrying';
  END IF;
END $$;

CREATE TYPE "StudentEnrollmentSource" AS ENUM (
  'LEGACY',
  'MANUAL',
  'IMPORT'
);

CREATE TYPE "WhatsAppManagedTemplateKey" AS ENUM (
  'WELCOME_GENERAL',
  'WELCOME_ALLOCATED',
  'FEE_RENEWAL_POLITE',
  'FEE_RENEWAL_FRIENDLY',
  'PAST_DUE_POLITE',
  'PAST_DUE_FIRM',
  'MULTI_STUDENT_COLLECTION_SUMMARY',
  'PAYMENT_CONFIRMATION',
  'PAYMENT_CORRECTION'
);

CREATE TYPE "WhatsAppManagedTemplateProvisioningStatus" AS ENUM (
  'PENDING',
  'CREATING',
  'WAITING_APPROVAL',
  'READY',
  'REJECTED',
  'FAILED',
  'UNKNOWN'
);

CREATE TYPE "WhatsAppAutomationStage" AS ENUM (
  'WELCOME',
  'FEE_DUE_MINUS_7',
  'FEE_DUE_MINUS_3',
  'FEE_DUE_MINUS_1',
  'FEE_DUE_TODAY',
  'PAST_DUE_PLUS_1',
  'PAST_DUE_PLUS_3',
  'PAST_DUE_PLUS_7',
  'PAYMENT_CONFIRMATION',
  'PAYMENT_CORRECTION'
);

CREATE TYPE "WhatsAppMessageTrigger" AS ENUM (
  'MANUAL',
  'AUTOMATION'
);

CREATE TYPE "WhatsAppBudgetState" AS ENUM (
  'NONE',
  'RESERVED',
  'COMMITTED',
  'RELEASED'
);

CREATE TYPE "WhatsAppMessageEventSource" AS ENUM (
  'PROVIDER_RESPONSE',
  'PROVIDER_WEBHOOK',
  'SYSTEM'
);

CREATE TYPE "WhatsAppRecipientRelationship" AS ENUM (
  'SELF',
  'GUARDIAN',
  'OTHER'
);

CREATE TYPE "WhatsAppStudentRecipientStatus" AS ENUM (
  'ACTIVE',
  'STALE',
  'DISABLED'
);

CREATE TYPE "WhatsAppManualSendRequestStatus" AS ENUM (
  'PROCESSING',
  'QUEUED',
  'PARTIAL',
  'COMPLETED',
  'FAILED'
);

ALTER TYPE "WhatsAppMessagePurpose"
  ADD VALUE IF NOT EXISTS 'PAYMENT_CORRECTION';

ALTER TYPE "WhatsAppWebhookReceiptStatus"
  ADD VALUE IF NOT EXISTS 'PROCESSING';

ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'MANAGED_TEMPLATE_INSTALL_STARTED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'MANAGED_TEMPLATE_INSTALL_COMPLETED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'MANAGED_TEMPLATE_INSTALL_FAILED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'RECIPIENT_ASSOCIATED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'RECIPIENT_MARKED_STALE';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'RECIPIENT_DISABLED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'BULK_OPERATIONAL_CONSENT_RECORDED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'BRANCH_DELIVERY_ENABLED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'BRANCH_DELIVERY_DISABLED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'AUTOMATION_SETTINGS_CHANGED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'AUTOMATION_ENABLED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'AUTOMATION_DISABLED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'MANUAL_SEND_QUEUED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'MANUAL_SEND_REPLAYED';

ALTER TABLE "Student"
  ADD COLUMN "enrollmentSource" "StudentEnrollmentSource" NOT NULL DEFAULT 'LEGACY';

ALTER TABLE "BranchWhatsAppSettings"
  ADD COLUMN "sendTimeLocal" TEXT NOT NULL DEFAULT '10:00',
  ADD COLUMN "dailyAutomaticMessageLimit" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "maxAutomaticCollectionMessagesPerCycle" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "automationEnabledAt" TIMESTAMP(3),
  ADD COLUMN "automationEnabledByUserId" TEXT,
  ADD COLUMN "configurationRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "plannerLeaseToken" TEXT,
  ADD COLUMN "plannerLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastPlannedAt" TIMESTAMP(3),
  ADD COLUMN "plannerRecipientCursorPhoneE164" TEXT,
  ADD COLUMN "plannerCorrectionCursorAt" TIMESTAMP(3),
  ADD COLUMN "plannerCorrectionCursorId" TEXT,
  ADD COLUMN "plannerPaidCursorAt" TIMESTAMP(3),
  ADD COLUMN "plannerPaidCursorId" TEXT,
  ADD COLUMN "lastPlannerErrorCode" TEXT;

ALTER TABLE "WhatsAppConsent"
  ADD COLUMN "policyVersion" TEXT;

ALTER TABLE "WhatsAppConsentEvent"
  ADD COLUMN "policyVersion" TEXT;

CREATE TABLE "WhatsAppStudentRecipient" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "consentId" TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "relationship" "WhatsAppRecipientRelationship" NOT NULL,
  "status" "WhatsAppStudentRecipientStatus" NOT NULL DEFAULT 'ACTIVE',
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  "staleAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppStudentRecipient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppManagedTemplateProvisioning" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "managedKey" "WhatsAppManagedTemplateKey" NOT NULL,
  "language" TEXT NOT NULL,
  "catalogVersion" INTEGER NOT NULL,
  "catalogHash" TEXT NOT NULL,
  "providerTemplateName" TEXT NOT NULL,
  "providerTemplateId" TEXT,
  "status" "WhatsAppManagedTemplateProvisioningStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppManagedTemplateProvisioning_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppTemplateBinding" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "provisioningId" TEXT NOT NULL,
  "managedKey" "WhatsAppManagedTemplateKey" NOT NULL,
  "language" TEXT NOT NULL,
  "catalogVersion" INTEGER NOT NULL,
  "catalogHash" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppTemplateBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppAutomationRule" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "stage" "WhatsAppAutomationStage" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppAutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppManualSendRequest" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "WhatsAppManualSendRequestStatus" NOT NULL DEFAULT 'PROCESSING',
  "selectedPaymentCount" INTEGER NOT NULL DEFAULT 0,
  "eligibleRecipientCount" INTEGER NOT NULL DEFAULT 0,
  "queuedMessageCount" INTEGER NOT NULL DEFAULT 0,
  "suppressedCount" INTEGER NOT NULL DEFAULT 0,
  "estimatedCostMicros" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "WhatsAppManualSendRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WhatsAppMessage"
  ADD COLUMN "templateBindingId" TEXT,
  ADD COLUMN "manualSendRequestId" TEXT,
  ADD COLUMN "trigger" "WhatsAppMessageTrigger" NOT NULL,
  ADD COLUMN "automationStage" "WhatsAppAutomationStage",
  ADD COLUMN "managedTemplateKey" "WhatsAppManagedTemplateKey",
  ADD COLUMN "catalogVersion" INTEGER,
  ADD COLUMN "catalogHash" TEXT,
  ADD COLUMN "frequencyKey" TEXT,
  ADD COLUMN "settingsRevision" INTEGER,
  ADD COLUMN "sourceFingerprint" TEXT NOT NULL,
  ADD COLUMN "providerRecipientWaId" TEXT,
  ADD COLUMN "providerPricingCategory" TEXT,
  ADD COLUMN "providerBillable" BOOLEAN,
  ADD COLUMN "providerStatusTimestamp" TIMESTAMP(3),
  ADD COLUMN "budgetMonth" TEXT,
  ADD COLUMN "budgetState" "WhatsAppBudgetState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "rateCardVersion" TEXT,
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "submissionStartedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "sentAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "readAt" TIMESTAMP(3),
  ADD COLUMN "failedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "suppressedAt" TIMESTAMP(3),
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ALTER COLUMN "estimatedCostMicros" TYPE BIGINT,
  ALTER COLUMN "actualCostMicros" TYPE BIGINT;

CREATE TABLE "WhatsAppMessagePayment" (
  "messageId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppMessagePayment_pkey" PRIMARY KEY ("messageId", "paymentId")
);

ALTER TABLE "WhatsAppMessageEvent"
  ALTER COLUMN "messageId" DROP NOT NULL,
  ADD COLUMN "senderId" TEXT NOT NULL,
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "source" "WhatsAppMessageEventSource" NOT NULL,
  ADD COLUMN "providerRecipientWaId" TEXT,
  ADD COLUMN "providerBillable" BOOLEAN,
  ADD COLUMN "providerPricingCategory" TEXT,
  ADD COLUMN "safeErrorCode" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "WhatsAppWebhookReceipt"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "BranchWhatsAppSettings_plannerLeaseToken_key"
  ON "BranchWhatsAppSettings"("plannerLeaseToken");
CREATE INDEX "BranchWhatsAppSettings_enabled_automationEnabledAt_plannerLeaseUntil_idx"
  ON "BranchWhatsAppSettings"("enabled", "automationEnabledAt", "plannerLeaseUntil");

CREATE UNIQUE INDEX "WhatsAppStudentRecipient_studentId_senderId_key"
  ON "WhatsAppStudentRecipient"("studentId", "senderId");
CREATE INDEX "WhatsAppStudentRecipient_branchId_status_idx"
  ON "WhatsAppStudentRecipient"("branchId", "status");
CREATE INDEX "WhatsAppStudentRecipient_senderId_phoneE164_status_idx"
  ON "WhatsAppStudentRecipient"("senderId", "phoneE164", "status");
CREATE INDEX "WhatsAppStudentRecipient_consentId_idx"
  ON "WhatsAppStudentRecipient"("consentId");

CREATE UNIQUE INDEX "WhatsAppManagedTemplateProvisioning_senderId_managedKey_language_catalogVersion_key"
  ON "WhatsAppManagedTemplateProvisioning"("senderId", "managedKey", "language", "catalogVersion");
CREATE UNIQUE INDEX "WhatsAppManagedTemplateProvisioning_senderId_providerTemplateName_key"
  ON "WhatsAppManagedTemplateProvisioning"("senderId", "providerTemplateName");
CREATE UNIQUE INDEX "WhatsAppManagedTemplateProvisioning_leaseToken_key"
  ON "WhatsAppManagedTemplateProvisioning"("leaseToken");
CREATE INDEX "WhatsAppManagedTemplateProvisioning_senderId_status_idx"
  ON "WhatsAppManagedTemplateProvisioning"("senderId", "status");

CREATE UNIQUE INDEX "WhatsAppTemplateBinding_templateId_key"
  ON "WhatsAppTemplateBinding"("templateId");
CREATE UNIQUE INDEX "WhatsAppTemplateBinding_provisioningId_key"
  ON "WhatsAppTemplateBinding"("provisioningId");
CREATE UNIQUE INDEX "WhatsAppTemplateBinding_senderId_managedKey_language_key"
  ON "WhatsAppTemplateBinding"("senderId", "managedKey", "language");
CREATE INDEX "WhatsAppTemplateBinding_senderId_active_idx"
  ON "WhatsAppTemplateBinding"("senderId", "active");

CREATE UNIQUE INDEX "WhatsAppAutomationRule_branchId_stage_key"
  ON "WhatsAppAutomationRule"("branchId", "stage");
CREATE INDEX "WhatsAppAutomationRule_organizationId_enabled_idx"
  ON "WhatsAppAutomationRule"("organizationId", "enabled");
CREATE INDEX "WhatsAppAutomationRule_branchId_enabled_idx"
  ON "WhatsAppAutomationRule"("branchId", "enabled");

CREATE UNIQUE INDEX "WhatsAppManualSendRequest_branchId_idempotencyKey_key"
  ON "WhatsAppManualSendRequest"("branchId", "idempotencyKey");
CREATE INDEX "WhatsAppManualSendRequest_branchId_createdAt_idx"
  ON "WhatsAppManualSendRequest"("branchId", "createdAt");
CREATE INDEX "WhatsAppManualSendRequest_actorUserId_createdAt_idx"
  ON "WhatsAppManualSendRequest"("actorUserId", "createdAt");

CREATE UNIQUE INDEX "WhatsAppMessage_frequencyKey_key"
  ON "WhatsAppMessage"("frequencyKey");
CREATE INDEX "WhatsAppMessage_status_availableAt_scheduledFor_idx"
  ON "WhatsAppMessage"("status", "availableAt", "scheduledFor");
CREATE INDEX "WhatsAppMessage_branchId_budgetMonth_budgetState_idx"
  ON "WhatsAppMessage"("branchId", "budgetMonth", "budgetState");
CREATE INDEX "WhatsAppMessage_branchId_trigger_automationStage_scheduledFor_idx"
  ON "WhatsAppMessage"("branchId", "trigger", "automationStage", "scheduledFor");
CREATE INDEX "WhatsAppMessage_senderId_recipientPhoneE164_localScheduleDate_idx"
  ON "WhatsAppMessage"("senderId", "recipientPhoneE164", "localScheduleDate");
CREATE INDEX "WhatsAppMessage_manualSendRequestId_createdAt_idx"
  ON "WhatsAppMessage"("manualSendRequestId", "createdAt");

CREATE INDEX "WhatsAppMessagePayment_paymentId_idx"
  ON "WhatsAppMessagePayment"("paymentId");

CREATE INDEX "WhatsAppMessageEvent_providerMessageId_providerTimestamp_id_idx"
  ON "WhatsAppMessageEvent"("providerMessageId", "providerTimestamp", "id");
CREATE INDEX "WhatsAppMessageEvent_senderId_expiresAt_idx"
  ON "WhatsAppMessageEvent"("senderId", "expiresAt");

CREATE UNIQUE INDEX "WhatsAppWebhookReceipt_leaseToken_key"
  ON "WhatsAppWebhookReceipt"("leaseToken");
CREATE INDEX "WhatsAppWebhookReceipt_status_leaseUntil_receivedAt_idx"
  ON "WhatsAppWebhookReceipt"("status", "leaseUntil", "receivedAt");

ALTER TABLE "BranchWhatsAppSettings"
  ADD CONSTRAINT "BranchWhatsAppSettings_automationEnabledByUserId_fkey"
  FOREIGN KEY ("automationEnabledByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppStudentRecipient"
  ADD CONSTRAINT "WhatsAppStudentRecipient_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient"
  ADD CONSTRAINT "WhatsAppStudentRecipient_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient"
  ADD CONSTRAINT "WhatsAppStudentRecipient_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient"
  ADD CONSTRAINT "WhatsAppStudentRecipient_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient"
  ADD CONSTRAINT "WhatsAppStudentRecipient_consentId_fkey"
  FOREIGN KEY ("consentId") REFERENCES "WhatsAppConsent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient"
  ADD CONSTRAINT "WhatsAppStudentRecipient_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppManagedTemplateProvisioning"
  ADD CONSTRAINT "WhatsAppManagedTemplateProvisioning_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppTemplateBinding"
  ADD CONSTRAINT "WhatsAppTemplateBinding_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppTemplateBinding"
  ADD CONSTRAINT "WhatsAppTemplateBinding_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "WhatsAppTemplate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppTemplateBinding"
  ADD CONSTRAINT "WhatsAppTemplateBinding_provisioningId_fkey"
  FOREIGN KEY ("provisioningId") REFERENCES "WhatsAppManagedTemplateProvisioning"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppAutomationRule"
  ADD CONSTRAINT "WhatsAppAutomationRule_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAutomationRule"
  ADD CONSTRAINT "WhatsAppAutomationRule_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppManualSendRequest"
  ADD CONSTRAINT "WhatsAppManualSendRequest_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppManualSendRequest"
  ADD CONSTRAINT "WhatsAppManualSendRequest_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppManualSendRequest"
  ADD CONSTRAINT "WhatsAppManualSendRequest_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_templateBindingId_fkey"
  FOREIGN KEY ("templateBindingId") REFERENCES "WhatsAppTemplateBinding"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_manualSendRequestId_fkey"
  FOREIGN KEY ("manualSendRequestId") REFERENCES "WhatsAppManualSendRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppMessagePayment"
  ADD CONSTRAINT "WhatsAppMessagePayment_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "WhatsAppMessage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessagePayment"
  ADD CONSTRAINT "WhatsAppMessagePayment_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppMessageEvent"
  ADD CONSTRAINT "WhatsAppMessageEvent_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
