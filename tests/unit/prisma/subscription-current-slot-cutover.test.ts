import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260810153000_cut_over_subscription_current_slot",
    "migration.sql"
  ),
  "utf8"
);

describe("subscription current-slot cutover migration", () => {
  it("heals expansion-window rows before dropping ownership uniqueness", () => {
    const heal = migration.indexOf('SET "currentOrganizationId" = "organizationId"');
    const preflight = migration.indexOf("current-slot cutover preflight failed");
    const dropUnique = migration.indexOf('DROP INDEX "OrganizationSubscription_organizationId_key"');

    expect(heal).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(heal);
    expect(dropUnique).toBeGreaterThan(preflight);
  });

  it("refuses to cut over while a pending slot already exists", () => {
    expect(migration).toContain('OR "pendingReplacementOrganizationId" IS NOT NULL');
  });
});
