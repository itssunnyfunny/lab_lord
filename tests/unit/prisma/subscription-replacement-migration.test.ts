import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260810150000_add_subscription_replacement_foundation",
    "migration.sql"
  ),
  "utf8"
);

describe("subscription replacement foundation migration", () => {
  it("backfills the current slot before enforcing slot uniqueness", () => {
    const addColumn = migration.indexOf('ADD COLUMN "currentOrganizationId"');
    const backfill = migration.indexOf('SET "currentOrganizationId" = "organizationId"');
    const uniqueIndex = migration.indexOf('OrganizationSubscription_currentOrganizationId_key');

    expect(addColumn).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(addColumn);
    expect(uniqueIndex).toBeGreaterThan(backfill);
  });

  it("adds ownership, lineage, and one-candidate database constraints", () => {
    expect(migration).toContain('OrganizationSubscription_slot_owner_check');
    expect(migration).toContain('OrganizationSubscription_pendingReplacementOrganizationId_key');
    expect(migration).toContain('OrganizationSubscription_replacesSubscriptionId_fkey');
    expect(migration).toContain('OrganizationBillingChange_replacementSubscriptionId_key');
    expect(migration).toContain('OrganizationBillingChange_replacementSubscriptionId_fkey');
  });

  it("adds the paused, replacement, and courtesy-access state", () => {
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'PAUSED'");
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'PAYMENT_METHOD_REPLACEMENT'");
    expect(migration).toContain('ADD COLUMN "accessGrantedAt"');
    expect(migration).toContain('ADD COLUMN "accessRevokedAt"');
    expect(migration).toContain('ADD COLUMN "accessGraceEndsAt"');
  });
});
