import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260831120000_add_razorpay_webhook_claim",
    "migration.sql"
  ),
  "utf8"
);

const schema = readFileSync(
  path.join(process.cwd(), "prisma", "schema.prisma"),
  "utf8"
);

const receipt = schema.slice(
  schema.indexOf("model RazorpayWebhookEvent {"),
  schema.indexOf("enum AuditAction {")
);

describe("Razorpay webhook processing-claim migration", () => {
  it("adds only backward-compatible receipt claim state", () => {
    expect(migration).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/imu);
    expect(migration).not.toMatch(/^\s*(?:DROP TABLE|DROP COLUMN|ALTER COLUMN)\s/imu);
    expect(migration).toMatch(
      /ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0/
    );

    for (const field of [
      "processingToken",
      "processingStartedAt",
      "processingLeaseUntil",
      "attemptCount",
    ]) {
      expect(receipt).toContain(field);
      expect(migration).toContain(`"${field}"`);
    }
  });

  it("makes tokens unique and expired claims operationally discoverable", () => {
    expect(receipt).toMatch(/processingToken\s+String\?\s+@unique/);
    expect(receipt).toMatch(/attemptCount\s+Int\s+@default\(0\)/);
    expect(migration).toContain("RazorpayWebhookEvent_processingToken_key");
    expect(migration).toContain(
      "RazorpayWebhookEvent_processedAt_processingLeaseUntil_idx"
    );
  });

  it("does not alter unrelated subscription or student-payment tables", () => {
    expect(migration).not.toMatch(/ALTER TABLE "OrganizationSubscription"/u);
    expect(migration).not.toMatch(/ALTER TABLE "OrganizationBillingChange"/u);
    expect(migration).not.toMatch(/ALTER TABLE "Payment"/u);
  });
});
