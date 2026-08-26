-- PR4 is an additive, flag-off-by-default expansion. It intentionally creates
-- no settings, subscriptions, consent, snapshots, notices, messages, incidents,
-- safety state, or job evidence for existing tenants. The one UPDATE below
-- conservatively marks any legacy SUBMITTING message as provider-call admitted
-- so a stale row can become UNKNOWN but can never be retried as unadmitted.

ALTER TYPE "StaffPermissionAction"
  ADD VALUE IF NOT EXISTS 'RECEIVE_WHATSAPP_REPORTS';

ALTER TYPE "WhatsAppManagedTemplateKey"
  ADD VALUE IF NOT EXISTS 'DAILY_BRANCH_REPORT';
ALTER TYPE "WhatsAppManagedTemplateKey"
  ADD VALUE IF NOT EXISTS 'DAILY_ORGANIZATION_REPORT';
ALTER TYPE "WhatsAppManagedTemplateKey"
  ADD VALUE IF NOT EXISTS 'BRANCH_CLOSED_NOTICE';
ALTER TYPE "WhatsAppManagedTemplateKey"
  ADD VALUE IF NOT EXISTS 'BRANCH_HOURS_CHANGED_NOTICE';
ALTER TYPE "WhatsAppManagedTemplateKey"
  ADD VALUE IF NOT EXISTS 'BRANCH_MAINTENANCE_NOTICE';

ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_SETTINGS_CHANGED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_SUBSCRIPTION_CREATED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_CONFIRMATION_ISSUED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_SUBSCRIPTION_CONFIRMED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_SUBSCRIPTION_PAUSED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_SUBSCRIPTION_REVOKED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_SUBSCRIPTION_STALE';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'REPORT_QUEUED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'SERVICE_NOTICE_QUEUED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'SERVICE_NOTICE_CANCELLED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'SENDER_PAUSED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'SENDER_RESUMED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'INCIDENT_ACKNOWLEDGED';
ALTER TYPE "WhatsAppAuditAction"
  ADD VALUE IF NOT EXISTS 'HEALTH_RECONCILED';

CREATE TYPE "WhatsAppReportScope" AS ENUM (
  'BRANCH',
  'ORGANIZATION'
);

CREATE TYPE "WhatsAppReportSubscriptionStatus" AS ENUM (
  'PENDING_CONFIRMATION',
  'ACTIVE',
  'PAUSED',
  'REVOKED',
  'STALE',
  'EXPIRED'
);

CREATE TYPE "WhatsAppServiceNoticeType" AS ENUM (
  'BRANCH_CLOSED',
  'HOURS_CHANGED',
  'MAINTENANCE_WINDOW'
);

CREATE TYPE "WhatsAppServiceNoticeReason" AS ENUM (
  'PUBLIC_HOLIDAY',
  'LOCAL_HOLIDAY',
  'MAINTENANCE',
  'EMERGENCY',
  'ADMINISTRATIVE'
);

CREATE TYPE "WhatsAppServiceNoticeStatus" AS ENUM (
  'QUEUED',
  'PARTIAL',
  'COMPLETED',
  'CANCELLED',
  'FAILED'
);

CREATE TYPE "WhatsAppOperationalIncidentType" AS ENUM (
  'UNKNOWN_DELIVERY',
  'SENDER_RESTRICTED',
  'TEMPLATE_UNAVAILABLE',
  'WEBHOOK_STALE',
  'PLANNER_STALE',
  'DISPATCH_BACKLOG',
  'RATE_CARD_EXPIRED',
  'REPORT_FAILURE',
  'CIRCUIT_BREAKER_OPEN'
);

CREATE TYPE "WhatsAppOperationalIncidentStatus" AS ENUM (
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED'
);

CREATE TYPE "WhatsAppOperationalIncidentSeverity" AS ENUM (
  'INFO',
  'WARNING',
  'CRITICAL'
);

CREATE TYPE "WhatsAppJobType" AS ENUM (
  'COLLECTION_PLANNER',
  'DISPATCHER',
  'REPORT_PLANNER',
  'HEALTH_RECONCILIATION',
  'MAINTENANCE'
);

CREATE TYPE "WhatsAppJobRunStatus" AS ENUM (
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'HELD'
);

CREATE TYPE "WhatsAppSenderPauseReason" AS ENUM (
  'AMBIGUOUS_OUTCOME_BURST',
  'DEFINITE_FAILURE_BURST',
  'PROVIDER_RESTRICTED',
  'RATE_CARD_EXPIRED',
  'OWNER_PAUSED',
  'OPERATOR_PAUSED'
);

ALTER TABLE "WhatsAppSender"
  ADD COLUMN "lastWebhookReceivedAt" TIMESTAMP(3),
  ADD COLUMN "healthLeaseToken" TEXT,
  ADD COLUMN "healthLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "providerRegistrationStatus" TEXT,
  ADD COLUMN "providerRestrictionCode" TEXT;

CREATE TABLE "WhatsAppReportSubscription" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "scope" "WhatsAppReportScope" NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "consentId" TEXT,
  "phoneE164" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "sendTimeLocal" TEXT NOT NULL DEFAULT '21:00',
  "status" "WhatsAppReportSubscriptionStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
  "confirmationCodeHash" TEXT,
  "confirmationExpiresAt" TIMESTAMP(3),
  "confirmationAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "confirmationIssuedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "staleAt" TIMESTAMP(3),
  "plannerLeaseToken" TEXT,
  "plannerLeaseUntil" TIMESTAMP(3),
  "lastPlannedAt" TIMESTAMP(3),
  "lastPlannedLocalDate" TEXT,
  "lastPlannerErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppReportSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrganizationWhatsAppReportSettings" (
  "organizationId" TEXT NOT NULL,
  "senderId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "monthlyBudgetMinor" INTEGER,
  "configurationRevision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrganizationWhatsAppReportSettings_pkey" PRIMARY KEY ("organizationId")
);

CREATE TABLE "WhatsAppDailyReportSnapshot" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "scope" "WhatsAppReportScope" NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "localReportDate" TEXT NOT NULL,
  "timeZone" TEXT NOT NULL,
  "scheduledCutoffAt" TIMESTAMP(3) NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  "metricsVersion" INTEGER NOT NULL,
  "metrics" JSONB NOT NULL,
  "metricsHash" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppDailyReportSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppServiceNotice" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "type" "WhatsAppServiceNoticeType" NOT NULL,
  "reason" "WhatsAppServiceNoticeReason" NOT NULL,
  "localEffectiveDate" TEXT NOT NULL,
  "effectiveStartAt" TIMESTAMP(3),
  "effectiveEndAt" TIMESTAMP(3),
  "resumeAt" TIMESTAMP(3),
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "status" "WhatsAppServiceNoticeStatus" NOT NULL DEFAULT 'QUEUED',
  "eligibleRecipientCount" INTEGER NOT NULL DEFAULT 0,
  "queuedMessageCount" INTEGER NOT NULL DEFAULT 0,
  "suppressedCount" INTEGER NOT NULL DEFAULT 0,
  "estimatedCostMicros" BIGINT NOT NULL DEFAULT 0,
  "rateCardVersion" TEXT,
  "queuedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppServiceNotice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppSenderSafetyState" (
  "senderId" TEXT NOT NULL,
  "pausedAt" TIMESTAMP(3),
  "pauseRequestedAt" TIMESTAMP(3),
  "pauseReason" "WhatsAppSenderPauseReason",
  "pausedByUserId" TEXT,
  "pauseRevision" INTEGER NOT NULL DEFAULT 0,
  "ambiguousWindowStartedAt" TIMESTAMP(3),
  "ambiguousOutcomeCount" INTEGER NOT NULL DEFAULT 0,
  "failureWindowStartedAt" TIMESTAMP(3),
  "definiteFailureCount" INTEGER NOT NULL DEFAULT 0,
  "lastAcceptedAt" TIMESTAMP(3),
  "lastDeliveredAt" TIMESTAMP(3),
  "lastHealthCheckAt" TIMESTAMP(3),
  "lastHealthyAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppSenderSafetyState_pkey" PRIMARY KEY ("senderId")
);

CREATE TABLE "WhatsAppOperationalIncident" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "senderId" TEXT,
  "messageId" TEXT,
  "type" "WhatsAppOperationalIncidentType" NOT NULL,
  "severity" "WhatsAppOperationalIncidentSeverity" NOT NULL,
  "status" "WhatsAppOperationalIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "dedupeKey" TEXT NOT NULL,
  "safeCode" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedByUserId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionCode" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WhatsAppOperationalIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhatsAppJobRun" (
  "id" TEXT NOT NULL,
  "jobType" "WhatsAppJobType" NOT NULL,
  "invocationId" TEXT NOT NULL,
  "providerMode" "WhatsAppProviderMode",
  "status" "WhatsAppJobRunStatus" NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "counts" JSONB NOT NULL,
  "safeErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppJobRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WhatsAppMessage"
  ADD COLUMN "reportSubscriptionId" TEXT,
  ADD COLUMN "dailyReportSnapshotId" TEXT,
  ADD COLUMN "serviceNoticeId" TEXT,
  ADD COLUMN "providerCallAdmittedAt" TIMESTAMP(3);

UPDATE "WhatsAppMessage"
SET "providerCallAdmittedAt" = COALESCE(
  "submissionStartedAt",
  "claimedAt",
  "updatedAt"
)
WHERE "status" = 'SUBMITTING'::"WhatsAppMessageStatus"
  AND "providerCallAdmittedAt" IS NULL;

CREATE UNIQUE INDEX "WhatsAppSender_healthLeaseToken_key"
  ON "WhatsAppSender"("healthLeaseToken");
CREATE INDEX "WhatsAppSender_status_healthLeaseUntil_lastHealthCheckAt_idx"
  ON "WhatsAppSender"("status", "healthLeaseUntil", "lastHealthCheckAt");

CREATE UNIQUE INDEX "WhatsAppReportSubscription_confirmationCodeHash_key"
  ON "WhatsAppReportSubscription"("confirmationCodeHash");
CREATE UNIQUE INDEX "WhatsAppReportSubscription_plannerLeaseToken_key"
  ON "WhatsAppReportSubscription"("plannerLeaseToken");
CREATE UNIQUE INDEX "WhatsAppReportSubscription_senderId_userId_scope_scopeKey_key"
  ON "WhatsAppReportSubscription"("senderId", "userId", "scope", "scopeKey");
CREATE INDEX "WhatsAppReportSubscription_status_plannerLeaseUntil_sendTimeLocal_idx"
  ON "WhatsAppReportSubscription"("status", "plannerLeaseUntil", "sendTimeLocal");
CREATE INDEX "WhatsAppReportSubscription_organizationId_scope_status_idx"
  ON "WhatsAppReportSubscription"("organizationId", "scope", "status");
CREATE INDEX "WhatsAppReportSubscription_branchId_status_idx"
  ON "WhatsAppReportSubscription"("branchId", "status");
CREATE INDEX "WhatsAppReportSubscription_senderId_phoneE164_status_idx"
  ON "WhatsAppReportSubscription"("senderId", "phoneE164", "status");
CREATE INDEX "WhatsAppReportSubscription_userId_status_idx"
  ON "WhatsAppReportSubscription"("userId", "status");

CREATE INDEX "OrganizationWhatsAppReportSettings_senderId_idx"
  ON "OrganizationWhatsAppReportSettings"("senderId");
CREATE INDEX "OrganizationWhatsAppReportSettings_enabled_senderId_idx"
  ON "OrganizationWhatsAppReportSettings"("enabled", "senderId");

CREATE UNIQUE INDEX "WhatsAppDailyReportSnapshot_scope_scopeKey_localReportDate_metricsVersion_key"
  ON "WhatsAppDailyReportSnapshot"("scope", "scopeKey", "localReportDate", "metricsVersion");
CREATE INDEX "WhatsAppDailyReportSnapshot_organizationId_localReportDate_idx"
  ON "WhatsAppDailyReportSnapshot"("organizationId", "localReportDate");
CREATE INDEX "WhatsAppDailyReportSnapshot_branchId_localReportDate_idx"
  ON "WhatsAppDailyReportSnapshot"("branchId", "localReportDate");
CREATE INDEX "WhatsAppDailyReportSnapshot_generatedAt_idx"
  ON "WhatsAppDailyReportSnapshot"("generatedAt");

CREATE UNIQUE INDEX "WhatsAppServiceNotice_branchId_idempotencyKey_key"
  ON "WhatsAppServiceNotice"("branchId", "idempotencyKey");
CREATE INDEX "WhatsAppServiceNotice_branchId_createdAt_idx"
  ON "WhatsAppServiceNotice"("branchId", "createdAt");
CREATE INDEX "WhatsAppServiceNotice_branchId_status_scheduledFor_idx"
  ON "WhatsAppServiceNotice"("branchId", "status", "scheduledFor");
CREATE INDEX "WhatsAppServiceNotice_senderId_status_idx"
  ON "WhatsAppServiceNotice"("senderId", "status");

CREATE UNIQUE INDEX "WhatsAppOperationalIncident_dedupeKey_key"
  ON "WhatsAppOperationalIncident"("dedupeKey");
CREATE INDEX "WhatsAppOperationalIncident_organizationId_status_severity_idx"
  ON "WhatsAppOperationalIncident"("organizationId", "status", "severity");
CREATE INDEX "WhatsAppOperationalIncident_branchId_status_severity_idx"
  ON "WhatsAppOperationalIncident"("branchId", "status", "severity");
CREATE INDEX "WhatsAppOperationalIncident_senderId_status_idx"
  ON "WhatsAppOperationalIncident"("senderId", "status");
CREATE INDEX "WhatsAppOperationalIncident_messageId_idx"
  ON "WhatsAppOperationalIncident"("messageId");
CREATE INDEX "WhatsAppOperationalIncident_lastSeenAt_idx"
  ON "WhatsAppOperationalIncident"("lastSeenAt");

CREATE UNIQUE INDEX "WhatsAppJobRun_invocationId_key"
  ON "WhatsAppJobRun"("invocationId");
CREATE INDEX "WhatsAppJobRun_jobType_startedAt_idx"
  ON "WhatsAppJobRun"("jobType", "startedAt");
CREATE INDEX "WhatsAppJobRun_status_startedAt_idx"
  ON "WhatsAppJobRun"("status", "startedAt");

CREATE INDEX "WhatsAppMessage_reportSubscriptionId_createdAt_idx"
  ON "WhatsAppMessage"("reportSubscriptionId", "createdAt");
CREATE INDEX "WhatsAppMessage_dailyReportSnapshotId_idx"
  ON "WhatsAppMessage"("dailyReportSnapshotId");
CREATE INDEX "WhatsAppMessage_serviceNoticeId_createdAt_idx"
  ON "WhatsAppMessage"("serviceNoticeId", "createdAt");
CREATE INDEX "WhatsAppMessage_organizationId_branchId_purpose_budgetMonth_budgetState_idx"
  ON "WhatsAppMessage"("organizationId", "branchId", "purpose", "budgetMonth", "budgetState");
CREATE INDEX "WhatsAppMessage_senderId_status_providerCallAdmittedAt_idx"
  ON "WhatsAppMessage"("senderId", "status", "providerCallAdmittedAt");

ALTER TABLE "WhatsAppReportSubscription"
  ADD CONSTRAINT "WhatsAppReportSubscription_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppReportSubscription"
  ADD CONSTRAINT "WhatsAppReportSubscription_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppReportSubscription"
  ADD CONSTRAINT "WhatsAppReportSubscription_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppReportSubscription"
  ADD CONSTRAINT "WhatsAppReportSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppReportSubscription"
  ADD CONSTRAINT "WhatsAppReportSubscription_consentId_fkey"
  FOREIGN KEY ("consentId") REFERENCES "WhatsAppConsent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrganizationWhatsAppReportSettings"
  ADD CONSTRAINT "OrganizationWhatsAppReportSettings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationWhatsAppReportSettings"
  ADD CONSTRAINT "OrganizationWhatsAppReportSettings_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppDailyReportSnapshot"
  ADD CONSTRAINT "WhatsAppDailyReportSnapshot_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppDailyReportSnapshot"
  ADD CONSTRAINT "WhatsAppDailyReportSnapshot_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppServiceNotice"
  ADD CONSTRAINT "WhatsAppServiceNotice_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppServiceNotice"
  ADD CONSTRAINT "WhatsAppServiceNotice_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppServiceNotice"
  ADD CONSTRAINT "WhatsAppServiceNotice_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppServiceNotice"
  ADD CONSTRAINT "WhatsAppServiceNotice_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsAppSenderSafetyState"
  ADD CONSTRAINT "WhatsAppSenderSafetyState_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppSenderSafetyState"
  ADD CONSTRAINT "WhatsAppSenderSafetyState_pausedByUserId_fkey"
  FOREIGN KEY ("pausedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppOperationalIncident"
  ADD CONSTRAINT "WhatsAppOperationalIncident_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident"
  ADD CONSTRAINT "WhatsAppOperationalIncident_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident"
  ADD CONSTRAINT "WhatsAppOperationalIncident_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident"
  ADD CONSTRAINT "WhatsAppOperationalIncident_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "WhatsAppMessage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident"
  ADD CONSTRAINT "WhatsAppOperationalIncident_acknowledgedByUserId_fkey"
  FOREIGN KEY ("acknowledgedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_reportSubscriptionId_fkey"
  FOREIGN KEY ("reportSubscriptionId") REFERENCES "WhatsAppReportSubscription"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_dailyReportSnapshotId_fkey"
  FOREIGN KEY ("dailyReportSnapshotId") REFERENCES "WhatsAppDailyReportSnapshot"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage"
  ADD CONSTRAINT "WhatsAppMessage_serviceNoticeId_fkey"
  FOREIGN KEY ("serviceNoticeId") REFERENCES "WhatsAppServiceNotice"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
