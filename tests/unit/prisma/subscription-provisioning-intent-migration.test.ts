import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260831160000_add_subscription_provisioning_intent",
    "migration.sql"
  ),
  "utf8"
);

const schema = readFileSync(
  path.join(process.cwd(), "prisma", "schema.prisma"),
  "utf8"
);

const billingChange = schema.slice(
  schema.indexOf("model OrganizationBillingChange {"),
  schema.indexOf("model OrganizationBillingChangeAudit {")
);

const audit = schema.slice(
  schema.indexOf("model OrganizationBillingChangeAudit {"),
  schema.indexOf("model OrganizationSubscriptionInvoice {")
);

describe("initial subscription provisioning-intent migration", () => {
  it("adds only backward-compatible intent and audit state", () => {
    expect(migration).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/imu);
    expect(migration).not.toMatch(/^\s*(?:DROP TABLE|DROP COLUMN|ALTER COLUMN)\s/imu);
    expect(migration).toContain("ALTER TYPE \"BillingOperationStatus\" ADD VALUE 'PROVISIONING'");

    for (const field of [
      "provisioningIntentVersion",
      "provisioningSourceSubscriptionId",
      "providerMutationAdmittedAt",
      "authorizedBillingModelVersion",
      "authorizedProviderStartAt",
      "authorizedProviderExpireAt",
      "authorizedTotalCount",
    ]) {
      expect(billingChange).toContain(field);
      expect(migration).toContain(`"${field}"`);
    }
  });

  it("creates a tenant-scoped, deduplicated billing-change audit ledger", () => {
    expect(audit).toContain("dedupeKey");
    expect(audit).toContain("providerSubscriptionId");
    expect(audit).toMatch(/organization\s+Organization\s+@relation/);
    expect(audit).toMatch(/change\s+OrganizationBillingChange\s+@relation/);
    expect(migration).toContain("OrganizationBillingChangeAudit_dedupeKey_key");
    expect(migration).toContain("OrganizationBillingChangeAudit_organizationId_fkey");
    expect(migration).toContain("OrganizationBillingChangeAudit_changeId_fkey");
  });

  it("does not rewrite subscriptions, student payments, or existing billing changes", () => {
    expect(migration).not.toMatch(/ALTER TABLE "OrganizationSubscription"/u);
    expect(migration).not.toMatch(/ALTER TABLE "Payment"/u);
    expect(migration).not.toMatch(/UPDATE "OrganizationBillingChange"/u);
  });
});
