import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260823120000_whatsapp_template_delivery_and_collections",
    "migration.sql"
  ),
  "utf8"
);

const schema = readFileSync(
  path.join(process.cwd(), "prisma", "schema.prisma"),
  "utf8"
);

const databaseReset = readFileSync(
  path.join(process.cwd(), "tests", "setup", "db.ts"),
  "utf8"
);

const model = (name: string, nextName: string) =>
  schema.slice(
    schema.indexOf(`model ${name} {`),
    schema.indexOf(`model ${nextName} {`)
  );

describe("WhatsApp template delivery and collections migration", () => {
  it("is an inert additive expansion guarded by an empty-outbox preflight", () => {
    expect(migration).toMatch(
      /IF EXISTS \(SELECT 1 FROM "WhatsAppMessage" LIMIT 1\)[\s\S]*?RAISE EXCEPTION/
    );
    expect(migration).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/imu);
    expect(migration).not.toMatch(/^\s*(?:DROP TABLE|DROP COLUMN)\s/imu);
    expect(migration).toContain(
      'ADD COLUMN "enrollmentSource" "StudentEnrollmentSource" NOT NULL DEFAULT \'LEGACY\''
    );
    expect(migration).toContain('"enabled" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"WhatsApp/iu);
    expect(migration).not.toMatch(
      /ALTER TABLE "BranchWhatsAppSettings"[\s\S]*?ALTER COLUMN "enabled"/iu
    );
  });

  it("adds every PR3 enum and the safe processing and audit values", () => {
    for (const enumName of [
      "StudentEnrollmentSource",
      "WhatsAppManagedTemplateKey",
      "WhatsAppManagedTemplateProvisioningStatus",
      "WhatsAppAutomationStage",
      "WhatsAppMessageTrigger",
      "WhatsAppBudgetState",
      "WhatsAppMessageEventSource",
      "WhatsAppRecipientRelationship",
      "WhatsAppStudentRecipientStatus",
      "WhatsAppManualSendRequestStatus",
    ]) {
      expect(schema).toContain(`enum ${enumName} {`);
      expect(migration).toContain(`CREATE TYPE "${enumName}" AS ENUM`);
    }

    expect(migration).toContain(
      'ALTER TYPE "WhatsAppWebhookReceiptStatus"\n  ADD VALUE IF NOT EXISTS \'PROCESSING\''
    );
    expect(migration).toContain(
      'ALTER TYPE "WhatsAppMessagePurpose"\n  ADD VALUE IF NOT EXISTS \'PAYMENT_CORRECTION\''
    );

    for (const action of [
      "MANAGED_TEMPLATE_INSTALL_STARTED",
      "MANAGED_TEMPLATE_INSTALL_COMPLETED",
      "MANAGED_TEMPLATE_INSTALL_FAILED",
      "RECIPIENT_ASSOCIATED",
      "RECIPIENT_MARKED_STALE",
      "RECIPIENT_DISABLED",
      "BULK_OPERATIONAL_CONSENT_RECORDED",
      "BRANCH_DELIVERY_ENABLED",
      "BRANCH_DELIVERY_DISABLED",
      "AUTOMATION_SETTINGS_CHANGED",
      "AUTOMATION_ENABLED",
      "AUTOMATION_DISABLED",
      "MANUAL_SEND_QUEUED",
      "MANUAL_SEND_REPLAYED",
    ]) {
      expect(schema).toContain(action);
      expect(migration).toContain(`ADD VALUE IF NOT EXISTS '${action}'`);
    }
  });

  it("creates recipient, provisioning, binding, rule, request, and payment-source models", () => {
    for (const table of [
      "WhatsAppStudentRecipient",
      "WhatsAppManagedTemplateProvisioning",
      "WhatsAppTemplateBinding",
      "WhatsAppAutomationRule",
      "WhatsAppManualSendRequest",
      "WhatsAppMessagePayment",
    ]) {
      expect(schema).toContain(`model ${table} {`);
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }

    expect(migration).toContain(
      "WhatsAppStudentRecipient_studentId_senderId_key"
    );
    expect(migration).toContain(
      "WhatsAppManagedTemplateProvisioning_senderId_managedKey_language_catalogVersion_key"
    );
    expect(migration).toContain(
      "WhatsAppManagedTemplateProvisioning_leaseToken_key"
    );
    expect(migration).toContain(
      "WhatsAppTemplateBinding_senderId_managedKey_language_key"
    );
    expect(migration).toContain("WhatsAppAutomationRule_branchId_stage_key");
    expect(migration).toContain(
      "WhatsAppManualSendRequest_branchId_idempotencyKey_key"
    );
    expect(migration).toContain(
      'PRIMARY KEY ("messageId", "paymentId")'
    );
    expect(schema).toContain(
      "paymentSources           WhatsAppMessagePayment[]"
    );
    expect(schema).toContain(
      "whatsAppMessageSources WhatsAppMessagePayment[]"
    );
  });

  it("adds settings, consent evidence, catalogue snapshots, lifecycle, budget, and frequency fields", () => {
    const settings = model("BranchWhatsAppSettings", "WhatsAppTemplate");
    const consent = model("WhatsAppConsent", "WhatsAppConsentEvent");
    const message = model("WhatsAppMessage", "WhatsAppMessagePayment");

    for (const field of [
      "sendTimeLocal",
      "dailyAutomaticMessageLimit",
      "maxAutomaticCollectionMessagesPerCycle",
      "automationEnabledAt",
      "automationEnabledByUserId",
      "configurationRevision",
      "plannerLeaseToken",
      "plannerLeaseUntil",
      "lastPlannedAt",
      "plannerRecipientCursorPhoneE164",
      "plannerCorrectionCursorAt",
      "plannerCorrectionCursorId",
      "plannerPaidCursorAt",
      "plannerPaidCursorId",
      "lastPlannerErrorCode",
    ]) {
      expect(settings).toContain(field);
    }
    expect(consent).toContain("policyVersion");

    for (const field of [
      "manualSendRequestId",
      "templateBindingId",
      "trigger",
      "automationStage",
      "managedTemplateKey",
      "catalogVersion",
      "catalogHash",
      "settingsRevision",
      "sourceFingerprint",
      "frequencyKey",
      "budgetMonth",
      "budgetState",
      "rateCardVersion",
      "availableAt",
      "submissionStartedAt",
      "providerRecipientWaId",
      "providerPricingCategory",
      "providerBillable",
      "providerStatusTimestamp",
    ]) {
      expect(message).toContain(field);
    }

    for (const timestamp of [
      "claimedAt",
      "acceptedAt",
      "sentAt",
      "deliveredAt",
      "readAt",
      "failedAt",
      "cancelledAt",
      "suppressedAt",
      "lastAttemptAt",
    ]) {
      expect(message).toContain(timestamp);
    }

    expect(message).toMatch(/estimatedCostMicros\s+BigInt\?/);
    expect(message).toMatch(/actualCostMicros\s+BigInt\?/);
    expect(migration).toMatch(
      /ALTER COLUMN "estimatedCostMicros" TYPE BIGINT/
    );
    expect(migration).toMatch(/ALTER COLUMN "actualCostMicros" TYPE BIGINT/);
    expect(migration).toContain(
      "WhatsAppMessage_branchId_budgetMonth_budgetState_idx"
    );
    expect(migration).toContain(
      "WhatsAppMessage_senderId_recipientPhoneE164_localScheduleDate_idx"
    );
    expect(migration).toContain("WhatsAppMessage_frequencyKey_key");
  });

  it("supports bounded orphan events and reclaimable webhook receipts", () => {
    const event = model("WhatsAppMessageEvent", "WhatsAppWebhookReceipt");
    const receipt = model("WhatsAppWebhookReceipt", "WhatsAppAuditEvent");

    expect(event).toMatch(/messageId\s+String\?/);
    for (const field of [
      "senderId",
      "providerMessageId",
      "source",
      "providerRecipientWaId",
      "providerBillable",
      "providerPricingCategory",
      "safeErrorCode",
      "expiresAt",
    ]) {
      expect(event).toContain(field);
    }
    expect(migration).toContain(
      "WhatsAppMessageEvent_providerMessageId_providerTimestamp_id_idx"
    );
    expect(migration).toContain("WhatsAppMessageEvent_senderId_expiresAt_idx");

    for (const field of [
      "attemptCount",
      "leaseToken",
      "leaseUntil",
      "lastAttemptAt",
    ]) {
      expect(receipt).toContain(field);
    }
    expect(migration).toContain("WhatsAppWebhookReceipt_leaseToken_key");
    expect(migration).toContain(
      "WhatsAppWebhookReceipt_status_leaseUntil_receivedAt_idx"
    );
  });

  it("preserves nullable PR2 compatibility links and immutable payment history", () => {
    const message = model("WhatsAppMessage", "WhatsAppMessagePayment");

    expect(message).toMatch(/branchId\s+String\?/);
    expect(message).toMatch(/paymentId\s+String\?/);
    expect(schema).toContain(
      '@@unique([studentId, type, periodStart], map: "Payment_studentId_type_periodStart_key")'
    );
    expect(migration).not.toMatch(/ALTER TABLE\s+"Payment"/iu);
    expect(migration).not.toMatch(/ALTER TABLE\s+"PaymentResolutionEvent"/iu);
    expect(migration).not.toMatch(/DROP CONSTRAINT/iu);
  });

  it("reconfirms the exact live test database before listing every new table for truncation", () => {
    const confirmationOffset = databaseReset.indexOf(
      "await confirmExactDisposableDatabaseIdentity()"
    );
    const truncateOffset = databaseReset.indexOf("TRUNCATE TABLE");

    expect(confirmationOffset).toBeGreaterThan(-1);
    expect(confirmationOffset).toBeLessThan(truncateOffset);
    expect(databaseReset).toContain("SELECT current_database()");
    expect(databaseReset).toContain(
      "connectedDatabaseName !== expectedDatabaseName"
    );

    for (const table of [
      "WhatsAppStudentRecipient",
      "WhatsAppManagedTemplateProvisioning",
      "WhatsAppTemplateBinding",
      "WhatsAppAutomationRule",
      "WhatsAppManualSendRequest",
      "WhatsAppMessagePayment",
    ]) {
      expect(databaseReset).toContain(`"${table}"`);
    }
  });
});
