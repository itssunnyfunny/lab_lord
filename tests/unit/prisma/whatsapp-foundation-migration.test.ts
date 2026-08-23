import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260822120000_whatsapp_communication_foundation",
    "migration.sql"
  ),
  "utf8"
);

const schema = readFileSync(
  path.join(process.cwd(), "prisma", "schema.prisma"),
  "utf8"
);

const foundationTables = [
  "WhatsAppSender",
  "WhatsAppConnectionIntent",
  "BranchWhatsAppSettings",
  "WhatsAppTemplate",
  "WhatsAppConsent",
  "WhatsAppConsentEvent",
  "WhatsAppMessage",
  "WhatsAppMessageEvent",
  "WhatsAppWebhookReceipt",
  "WhatsAppAuditEvent",
] as const;

describe("WhatsApp communication foundation migration", () => {
  it("is an additive empty-table expansion with no data rewrite or backfill", () => {
    for (const table of foundationTables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(schema).toContain(`model ${table} {`);
    }

    expect(migration).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\s/imu);
    expect(migration).not.toMatch(/^\s*(?:DROP TABLE|DROP COLUMN|TRUNCATE)\s/imu);
    expect(migration).toContain('"enabled" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"(?:BranchWhatsAppSettings|WhatsAppConsent|WhatsAppMessage|WhatsAppSender)"/iu);
  });

  it("adds every communication permission without rewriting existing overrides", () => {
    for (const action of ["VIEW_WHATSAPP", "SEND_WHATSAPP", "MANAGE_WHATSAPP"]) {
      expect(migration).toContain(
        `ALTER TYPE "StaffPermissionAction" ADD VALUE IF NOT EXISTS '${action}'`
      );
      expect(schema).toContain(action);
    }
    expect(migration).not.toMatch(/UPDATE\s+"StaffPermissionOverride"/iu);
  });

  it("creates provider identity, replay, lease, consent, template, and outbox constraints", () => {
    expect(migration).toContain("WhatsAppSender_provider_providerMode_phoneNumberId_key");
    expect(migration).toContain("WhatsAppConnectionIntent_stateHash_key");
    expect(migration).toContain("WhatsAppConnectionIntent_leaseToken_key");
    expect(migration).toContain("WhatsAppTemplate_senderId_providerTemplateId_key");
    expect(migration).toContain("WhatsAppTemplate_senderId_name_language_key");
    expect(migration).toContain("WhatsAppConsent_senderId_phoneE164_consentType_key");
    expect(migration).toContain("WhatsAppMessage_dedupeKey_key");
    expect(migration).toContain("WhatsAppMessage_providerMessageId_key");
    expect(migration).toContain("WhatsAppMessage_leaseToken_key");
    expect(migration).toContain("WhatsAppMessageEvent_eventKey_key");
    expect(migration).toContain("WhatsAppWebhookReceipt_dedupeKey_key");
  });

  it("preserves history with explicit restrictive and set-null relations", () => {
    expect(migration).toMatch(/WhatsAppSender_organizationId_fkey[\s\S]*?ON DELETE RESTRICT/);
    expect(migration).toMatch(/BranchWhatsAppSettings_senderId_fkey[\s\S]*?ON DELETE SET NULL/);
    expect(migration).toMatch(/WhatsAppMessage_studentId_fkey[\s\S]*?ON DELETE SET NULL/);
    expect(migration).toMatch(/WhatsAppMessage_paymentId_fkey[\s\S]*?ON DELETE RESTRICT/);
    expect(migration).toMatch(/WhatsAppMessage_paymentResolutionEventId_fkey[\s\S]*?ON DELETE RESTRICT/);
    expect(migration).toMatch(/WhatsAppConsentEvent_actorUserId_fkey[\s\S]*?ON DELETE SET NULL/);
    expect(migration).toMatch(/WhatsAppAuditEvent_actorUserId_fkey[\s\S]*?ON DELETE SET NULL/);
  });

  it("stores trusted consent snapshots and no provider credential columns", () => {
    const senderModel = schema.slice(
      schema.indexOf("model WhatsAppSender {"),
      schema.indexOf("model WhatsAppConnectionIntent {")
    );
    const consentEventModel = schema.slice(
      schema.indexOf("model WhatsAppConsentEvent {"),
      schema.indexOf("model WhatsAppMessage {")
    );

    expect(consentEventModel).toContain("phoneE164");
    expect(consentEventModel).toContain("consentType");
    expect(senderModel).not.toMatch(/accessToken|oauthCode|appSecret|verifyToken|pin\s/i);
  });

  it("leaves PR1 payment identity and immutable resolution evidence intact", () => {
    expect(schema).toContain(
      '@@unique([studentId, type, periodStart], map: "Payment_studentId_type_periodStart_key")'
    );
    expect(schema).toContain("model PaymentResolutionEvent {");
    expect(migration).not.toMatch(/ALTER TABLE\s+"Payment"/iu);
    expect(migration).not.toMatch(/ALTER TABLE\s+"PaymentResolutionEvent"/iu);
  });
});
