import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260824120000_whatsapp_reports_notices_and_hardening",
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

describe("WhatsApp reports, notices, and hardening migration", () => {
  it("is additive and limits DML to the conservative legacy-admission backfill", () => {
    expect(migration).not.toMatch(/^\s*(?:INSERT|DELETE|TRUNCATE)\s/imu);
    expect(migration.match(/^\s*UPDATE\s+/gimu)).toHaveLength(1);
    expect(
      Array.from(migration.matchAll(/^\s*UPDATE\s+"([^"]+)"/gimu), match => match[1])
    ).toEqual(["WhatsAppMessage"]);
    expect(migration).not.toMatch(/^\s*(?:DROP TABLE|DROP COLUMN|DROP TYPE)\s/imu);
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+"enabled"/iu);
    expect(migration).toContain('"enabled" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"WhatsApp/iu);
    expect(migration).not.toMatch(/ALTER TABLE\s+"(?:Payment|PaymentResolutionEvent|Student)"/iu);
  });

  it("adds every PR4 enum and only appends existing enum values", () => {
    for (const enumName of [
      "WhatsAppReportScope",
      "WhatsAppReportSubscriptionStatus",
      "WhatsAppServiceNoticeType",
      "WhatsAppServiceNoticeReason",
      "WhatsAppServiceNoticeStatus",
      "WhatsAppOperationalIncidentType",
      "WhatsAppOperationalIncidentStatus",
      "WhatsAppOperationalIncidentSeverity",
      "WhatsAppJobType",
      "WhatsAppJobRunStatus",
      "WhatsAppSenderPauseReason",
    ]) {
      expect(schema).toContain(`enum ${enumName} {`);
      expect(migration).toContain(`CREATE TYPE "${enumName}" AS ENUM`);
    }
    expect(migration).toContain("'RECEIVE_WHATSAPP_REPORTS'");
    for (const key of [
      "DAILY_BRANCH_REPORT",
      "DAILY_ORGANIZATION_REPORT",
      "BRANCH_CLOSED_NOTICE",
      "BRANCH_HOURS_CHANGED_NOTICE",
      "BRANCH_MAINTENANCE_NOTICE",
    ]) expect(migration).toContain(`ADD VALUE IF NOT EXISTS '${key}'`);
  });

  it("creates all evidence models with the required uniqueness and lookup indexes", () => {
    for (const table of [
      "WhatsAppReportSubscription",
      "OrganizationWhatsAppReportSettings",
      "WhatsAppDailyReportSnapshot",
      "WhatsAppServiceNotice",
      "WhatsAppSenderSafetyState",
      "WhatsAppOperationalIncident",
      "WhatsAppJobRun",
    ]) {
      expect(schema).toContain(`model ${table} {`);
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(databaseReset).toContain(`"${table}"`);
    }
    for (const index of [
      "WhatsAppReportSubscription_senderId_userId_scope_scopeKey_key",
      "WhatsAppReportSubscription_confirmationCodeHash_key",
      "WhatsAppReportSubscription_plannerLeaseToken_key",
      "WhatsAppReportSnapshot_scope_date_cutoff_version_key",
      "WhatsAppServiceNotice_branchId_idempotencyKey_key",
      "WhatsAppOperationalIncident_dedupeKey_key",
      "WhatsAppJobRun_invocationId_key",
    ]) expect(migration).toContain(index);
  });

  it("keys report snapshots by scheduled cutoff and stores an explicit metrics as-of", () => {
    expect(schema).toContain("metricsAsOfAt     DateTime");
    expect(schema).toContain(
      '@@unique([scope, scopeKey, localReportDate, scheduledCutoffAt, metricsVersion], map: "WhatsAppReportSnapshot_scope_date_cutoff_version_key")'
    );
    expect(migration).toContain('"metricsAsOfAt" TIMESTAMP(3) NOT NULL');
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "WhatsAppReportSnapshot_scope_date_cutoff_version_key"\s+ON "WhatsAppDailyReportSnapshot"\(\s*"scope",\s*"scopeKey",\s*"localReportDate",\s*"scheduledCutoffAt",\s*"metricsVersion"\s*\);/u
    );
    expect(migration).not.toContain(
      "WhatsAppDailyReportSnapshot_scope_scopeKey_localReportDate_metricsVersion_key"
    );
  });

  it("extends the single outbox and sender health projection without rewriting history", () => {
    for (const column of [
      "reportSubscriptionId",
      "dailyReportSnapshotId",
      "serviceNoticeId",
    ]) {
      expect(migration).toContain(`ADD COLUMN "${column}" TEXT`);
      expect(schema).toContain(column);
    }
    expect(migration).toContain('ADD COLUMN "providerCallAdmittedAt" TIMESTAMP(3)');
    expect(migration).toMatch(
      /UPDATE\s+"WhatsAppMessage"\s+SET\s+"providerCallAdmittedAt"\s*=\s*COALESCE\(\s*"submissionStartedAt",\s*"claimedAt",\s*"updatedAt"\s*\)\s+WHERE\s+"status"\s*=\s*'SUBMITTING'::"WhatsAppMessageStatus"\s+AND\s+"providerCallAdmittedAt"\s+IS\s+NULL;/iu
    );
    expect(migration).toContain('"pauseRequestedAt" TIMESTAMP(3)');
    expect(schema).toContain("providerCallAdmittedAt");
    expect(schema).toContain("pauseRequestedAt");
    for (const column of [
      "lastWebhookReceivedAt",
      "healthLeaseToken",
      "healthLeaseUntil",
      "providerRegistrationStatus",
      "providerRestrictionCode",
    ]) {
      expect(migration).toContain(`ADD COLUMN "${column}"`);
      expect(schema).toContain(column);
    }
    expect(migration).toContain(
      "WhatsAppMessage_organizationId_branchId_purpose_budgetMonth_budgetState_idx"
    );
    expect(migration).toContain(
      "WhatsAppMessage_senderId_status_providerCallAdmittedAt_idx"
    );
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+"(?:status|providerMessageId|budgetState)"/iu);
  });

  it("retains exact destructive-test identity verification before truncation", () => {
    expect(databaseReset.indexOf("await confirmExactDisposableDatabaseIdentity()"))
      .toBeLessThan(databaseReset.indexOf("TRUNCATE TABLE"));
    expect(databaseReset).toContain("SELECT current_database()");
    expect(databaseReset).toContain("connectedDatabaseName !== target.databaseName");
  });
});
