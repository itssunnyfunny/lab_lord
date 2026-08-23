ALTER TYPE "StaffPermissionAction" ADD VALUE IF NOT EXISTS 'VIEW_WHATSAPP';
ALTER TYPE "StaffPermissionAction" ADD VALUE IF NOT EXISTS 'SEND_WHATSAPP';
ALTER TYPE "StaffPermissionAction" ADD VALUE IF NOT EXISTS 'MANAGE_WHATSAPP';

CREATE TYPE "WhatsAppProvider" AS ENUM (
  'META_CLOUD'
);

CREATE TYPE "WhatsAppProviderMode" AS ENUM (
  'TEST',
  'LIVE'
);

CREATE TYPE "WhatsAppSenderStatus" AS ENUM (
  'PENDING',
  'NEEDS_REGISTRATION',
  'ACTIVE',
  'RESTRICTED',
  'DISCONNECTED',
  'ERROR'
);

CREATE TYPE "WhatsAppConnectionIntentStatus" AS ENUM (
  'CREATED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TYPE "WhatsAppTemplateCategory" AS ENUM (
  'AUTHENTICATION',
  'MARKETING',
  'UTILITY',
  'UNKNOWN'
);

CREATE TYPE "WhatsAppTemplateProviderStatus" AS ENUM (
  'APPROVED',
  'PENDING',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'UNKNOWN'
);

CREATE TYPE "WhatsAppConsentType" AS ENUM (
  'OPERATIONAL',
  'MARKETING',
  'OWNER_REPORT'
);

CREATE TYPE "WhatsAppConsentStatus" AS ENUM (
  'UNKNOWN',
  'OPTED_IN',
  'OPTED_OUT'
);

CREATE TYPE "WhatsAppConsentSource" AS ENUM (
  'IN_PERSON',
  'REGISTRATION_FORM',
  'IMPORT_ATTESTATION',
  'WHATSAPP_REPLY',
  'OWNER_CONFIGURATION',
  'SYSTEM'
);

CREATE TYPE "WhatsAppMessagePurpose" AS ENUM (
  'MANUAL_REMINDER',
  'WELCOME',
  'FEE_RENEWAL',
  'PAST_DUE',
  'PAYMENT_CONFIRMATION',
  'DAILY_BRANCH_REPORT',
  'DAILY_ORGANIZATION_REPORT',
  'SERVICE_NOTICE'
);

CREATE TYPE "WhatsAppMessageStatus" AS ENUM (
  'SCHEDULED',
  'CLAIMED',
  'SUBMITTING',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'CANCELLED',
  'SUPPRESSED',
  'UNKNOWN'
);

CREATE TYPE "WhatsAppWebhookReceiptStatus" AS ENUM (
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED'
);

CREATE TYPE "WhatsAppAuditAction" AS ENUM (
  'CONNECTION_STARTED',
  'CONNECTION_COMPLETED',
  'CONNECTION_FAILED',
  'PHONE_REGISTERED',
  'WEBHOOK_SUBSCRIBED',
  'TEMPLATES_SYNCED',
  'BRANCH_ASSIGNED',
  'BRANCH_UNASSIGNED',
  'LOCAL_DISCONNECTED',
  'CONSENT_CHANGED'
);

CREATE TABLE "WhatsAppSender" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "provider" "WhatsAppProvider" NOT NULL,
  "providerMode" "WhatsAppProviderMode" NOT NULL,
  "providerBusinessId" TEXT,
  "wabaId" TEXT NOT NULL,
  "phoneNumberId" TEXT NOT NULL,
  "displayPhoneNumber" TEXT NOT NULL,
  "verifiedName" TEXT,
  "qualityRating" TEXT,
  "accountMode" TEXT,
  "status" "WhatsAppSenderStatus" NOT NULL DEFAULT 'PENDING',
  "phoneRegisteredAt" TIMESTAMP(3),
  "webhookSubscribedAt" TIMESTAMP(3),
  "connectedByUserId" TEXT,
  "connectedAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "lastTemplateSyncAt" TIMESTAMP(3),
  "lastHealthCheckAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppSender_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppConnectionIntent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "providerMode" "WhatsAppProviderMode" NOT NULL,
  "stateHash" TEXT NOT NULL,
  "status" "WhatsAppConnectionIntentStatus" NOT NULL DEFAULT 'CREATED',
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "providerBusinessId" TEXT,
  "wabaId" TEXT,
  "phoneNumberId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppConnectionIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BranchWhatsAppSettings" (
  "branchId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "senderId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
  "defaultTone" TEXT NOT NULL DEFAULT 'polite',
  "monthlyBudgetMinor" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BranchWhatsAppSettings_pkey" PRIMARY KEY ("branchId")
);

CREATE TABLE "WhatsAppTemplate" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "providerTemplateId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "category" "WhatsAppTemplateCategory" NOT NULL,
  "providerStatus" "WhatsAppTemplateProviderStatus" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "components" JSONB NOT NULL,
  "componentHash" TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL,
  "staleAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppConsent" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "consentType" "WhatsAppConsentType" NOT NULL,
  "status" "WhatsAppConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
  "source" "WhatsAppConsentSource" NOT NULL,
  "grantedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "recordedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppConsent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppConsentEvent" (
  "id" TEXT NOT NULL,
  "consentId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "consentType" "WhatsAppConsentType" NOT NULL,
  "actorUserId" TEXT,
  "previousStatus" "WhatsAppConsentStatus" NOT NULL,
  "nextStatus" "WhatsAppConsentStatus" NOT NULL,
  "source" "WhatsAppConsentSource" NOT NULL,
  "details" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppConsentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppMessage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "senderId" TEXT NOT NULL,
  "studentId" TEXT,
  "paymentId" TEXT,
  "paymentResolutionEventId" TEXT,
  "templateId" TEXT,
  "createdByUserId" TEXT,
  "recipientPhoneE164" TEXT NOT NULL,
  "purpose" "WhatsAppMessagePurpose" NOT NULL,
  "templateVersion" INTEGER,
  "templateVariables" JSONB NOT NULL,
  "renderedPreview" TEXT,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "localScheduleDate" TIMESTAMP(3),
  "status" "WhatsAppMessageStatus" NOT NULL DEFAULT 'SCHEDULED',
  "dedupeKey" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "estimatedCostMicros" INTEGER,
  "actualCostMicros" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "failureCode" TEXT,
  "safeFailureMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppMessageEvent" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "status" "WhatsAppMessageStatus" NOT NULL,
  "providerTimestamp" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payloadHash" TEXT NOT NULL,

  CONSTRAINT "WhatsAppMessageEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppWebhookReceipt" (
  "id" TEXT NOT NULL,
  "providerMode" "WhatsAppProviderMode" NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "signatureVersion" TEXT NOT NULL,
  "organizationId" TEXT,
  "senderId" TEXT,
  "wabaId" TEXT,
  "phoneNumberId" TEXT,
  "eventType" TEXT,
  "status" "WhatsAppWebhookReceiptStatus" NOT NULL DEFAULT 'RECEIVED',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "failureCode" TEXT,

  CONSTRAINT "WhatsAppWebhookReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppAuditEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "senderId" TEXT,
  "actorUserId" TEXT,
  "action" "WhatsAppAuditAction" NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppSender_provider_providerMode_phoneNumberId_key"
  ON "WhatsAppSender"("provider", "providerMode", "phoneNumberId");
CREATE INDEX "WhatsAppSender_organizationId_status_idx"
  ON "WhatsAppSender"("organizationId", "status");
CREATE INDEX "WhatsAppSender_provider_providerMode_wabaId_idx"
  ON "WhatsAppSender"("provider", "providerMode", "wabaId");

CREATE UNIQUE INDEX "WhatsAppConnectionIntent_stateHash_key"
  ON "WhatsAppConnectionIntent"("stateHash");
CREATE UNIQUE INDEX "WhatsAppConnectionIntent_leaseToken_key"
  ON "WhatsAppConnectionIntent"("leaseToken");
CREATE INDEX "WhatsAppConnectionIntent_organizationId_status_expiresAt_idx"
  ON "WhatsAppConnectionIntent"("organizationId", "status", "expiresAt");
CREATE INDEX "WhatsAppConnectionIntent_actorUserId_status_expiresAt_idx"
  ON "WhatsAppConnectionIntent"("actorUserId", "status", "expiresAt");

CREATE INDEX "BranchWhatsAppSettings_organizationId_idx"
  ON "BranchWhatsAppSettings"("organizationId");
CREATE INDEX "BranchWhatsAppSettings_senderId_idx"
  ON "BranchWhatsAppSettings"("senderId");

CREATE UNIQUE INDEX "WhatsAppTemplate_senderId_providerTemplateId_key"
  ON "WhatsAppTemplate"("senderId", "providerTemplateId");
CREATE UNIQUE INDEX "WhatsAppTemplate_senderId_name_language_key"
  ON "WhatsAppTemplate"("senderId", "name", "language");
CREATE INDEX "WhatsAppTemplate_senderId_category_providerStatus_idx"
  ON "WhatsAppTemplate"("senderId", "category", "providerStatus");

CREATE UNIQUE INDEX "WhatsAppConsent_senderId_phoneE164_consentType_key"
  ON "WhatsAppConsent"("senderId", "phoneE164", "consentType");

CREATE INDEX "WhatsAppConsentEvent_consentId_occurredAt_id_idx"
  ON "WhatsAppConsentEvent"("consentId", "occurredAt", "id");
CREATE INDEX "WhatsAppConsentEvent_senderId_occurredAt_id_idx"
  ON "WhatsAppConsentEvent"("senderId", "occurredAt", "id");

CREATE UNIQUE INDEX "WhatsAppMessage_dedupeKey_key"
  ON "WhatsAppMessage"("dedupeKey");
CREATE UNIQUE INDEX "WhatsAppMessage_providerMessageId_key"
  ON "WhatsAppMessage"("providerMessageId");
CREATE UNIQUE INDEX "WhatsAppMessage_leaseToken_key"
  ON "WhatsAppMessage"("leaseToken");
CREATE INDEX "WhatsAppMessage_organizationId_createdAt_idx"
  ON "WhatsAppMessage"("organizationId", "createdAt");
CREATE INDEX "WhatsAppMessage_branchId_createdAt_idx"
  ON "WhatsAppMessage"("branchId", "createdAt");
CREATE INDEX "WhatsAppMessage_senderId_status_scheduledFor_idx"
  ON "WhatsAppMessage"("senderId", "status", "scheduledFor");
CREATE INDEX "WhatsAppMessage_studentId_createdAt_idx"
  ON "WhatsAppMessage"("studentId", "createdAt");
CREATE INDEX "WhatsAppMessage_paymentId_createdAt_idx"
  ON "WhatsAppMessage"("paymentId", "createdAt");
CREATE INDEX "WhatsAppMessage_paymentResolutionEventId_createdAt_idx"
  ON "WhatsAppMessage"("paymentResolutionEventId", "createdAt");

CREATE UNIQUE INDEX "WhatsAppMessageEvent_eventKey_key"
  ON "WhatsAppMessageEvent"("eventKey");
CREATE INDEX "WhatsAppMessageEvent_messageId_providerTimestamp_id_idx"
  ON "WhatsAppMessageEvent"("messageId", "providerTimestamp", "id");

CREATE UNIQUE INDEX "WhatsAppWebhookReceipt_dedupeKey_key"
  ON "WhatsAppWebhookReceipt"("dedupeKey");
CREATE INDEX "WhatsAppWebhookReceipt_providerMode_receivedAt_idx"
  ON "WhatsAppWebhookReceipt"("providerMode", "receivedAt");
CREATE INDEX "WhatsAppWebhookReceipt_senderId_receivedAt_idx"
  ON "WhatsAppWebhookReceipt"("senderId", "receivedAt");
CREATE INDEX "WhatsAppWebhookReceipt_wabaId_receivedAt_idx"
  ON "WhatsAppWebhookReceipt"("wabaId", "receivedAt");
CREATE INDEX "WhatsAppWebhookReceipt_phoneNumberId_receivedAt_idx"
  ON "WhatsAppWebhookReceipt"("phoneNumberId", "receivedAt");

CREATE INDEX "WhatsAppAuditEvent_organizationId_createdAt_id_idx"
  ON "WhatsAppAuditEvent"("organizationId", "createdAt", "id");
CREATE INDEX "WhatsAppAuditEvent_branchId_createdAt_id_idx"
  ON "WhatsAppAuditEvent"("branchId", "createdAt", "id");
CREATE INDEX "WhatsAppAuditEvent_senderId_createdAt_id_idx"
  ON "WhatsAppAuditEvent"("senderId", "createdAt", "id");

ALTER TABLE "WhatsAppSender"
  ADD CONSTRAINT "WhatsAppSender_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppSender"
  ADD CONSTRAINT "WhatsAppSender_connectedByUserId_fkey"
  FOREIGN KEY ("connectedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppConnectionIntent"
  ADD CONSTRAINT "WhatsAppConnectionIntent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppConnectionIntent"
  ADD CONSTRAINT "WhatsAppConnectionIntent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BranchWhatsAppSettings"
  ADD CONSTRAINT "BranchWhatsAppSettings_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BranchWhatsAppSettings"
  ADD CONSTRAINT "BranchWhatsAppSettings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BranchWhatsAppSettings"
  ADD CONSTRAINT "BranchWhatsAppSettings_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppTemplate"
  ADD CONSTRAINT "WhatsAppTemplate_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppConsent"
  ADD CONSTRAINT "WhatsAppConsent_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppConsent"
  ADD CONSTRAINT "WhatsAppConsent_recordedByUserId_fkey"
  FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppConsentEvent"
  ADD CONSTRAINT "WhatsAppConsentEvent_consentId_fkey"
  FOREIGN KEY ("consentId") REFERENCES "WhatsAppConsent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppConsentEvent"
  ADD CONSTRAINT "WhatsAppConsentEvent_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppConsentEvent"
  ADD CONSTRAINT "WhatsAppConsentEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_paymentResolutionEventId_fkey"
  FOREIGN KEY ("paymentResolutionEventId") REFERENCES "PaymentResolutionEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "WhatsAppTemplate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppMessageEvent"
  ADD CONSTRAINT "WhatsAppMessageEvent_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "WhatsAppMessage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppWebhookReceipt"
  ADD CONSTRAINT "WhatsAppWebhookReceipt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppWebhookReceipt"
  ADD CONSTRAINT "WhatsAppWebhookReceipt_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppAuditEvent"
  ADD CONSTRAINT "WhatsAppAuditEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAuditEvent"
  ADD CONSTRAINT "WhatsAppAuditEvent_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAuditEvent"
  ADD CONSTRAINT "WhatsAppAuditEvent_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAuditEvent"
  ADD CONSTRAINT "WhatsAppAuditEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
