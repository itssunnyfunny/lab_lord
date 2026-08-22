import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260822090000_payment_type_identity_and_resolution_events",
    "migration.sql"
  ),
  "utf8"
);

const schema = readFileSync(
  path.join(process.cwd(), "prisma", "schema.prisma"),
  "utf8"
);

const runbook = readFileSync(
  path.join(process.cwd(), "docs", "production-runbook.md"),
  "utf8"
);

describe("payment identity and resolution-event migration", () => {
  it("creates the typed payment identity before dropping the old unique index", () => {
    const createTyped = migration.indexOf(
      'CREATE UNIQUE INDEX "Payment_studentId_type_periodStart_key"'
    );
    const dropUntyped = migration.indexOf(
      'DROP INDEX "Payment_studentId_periodStart_key"'
    );

    expect(createTyped).toBeGreaterThanOrEqual(0);
    expect(dropUntyped).toBeGreaterThan(createTyped);
    expect(schema).toContain(
      '@@unique([studentId, type, periodStart], map: "Payment_studentId_type_periodStart_key")'
    );
  });

  it("creates a restrictive append-only event relation without fabricating history", () => {
    expect(migration).toContain('CREATE TABLE "PaymentResolutionEvent"');
    expect(migration).toContain('CONSTRAINT "PaymentResolutionEvent_paymentId_fkey"');
    expect(migration).toContain('CONSTRAINT "PaymentResolutionEvent_branchId_fkey"');
    expect(migration).toContain('CONSTRAINT "PaymentResolutionEvent_actorUserId_fkey"');
    expect(migration).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
    expect(migration).toContain("ON DELETE SET NULL ON UPDATE CASCADE");
    expect(migration).toContain(
      '"PaymentResolutionEvent"("paymentId", "occurredAt", "id")'
    );
    expect(migration).toContain(
      '"PaymentResolutionEvent"("branchId", "occurredAt", "id")'
    );
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"PaymentResolutionEvent"/i);
  });

  it("documents duplicate preflight, post-migration checks, and rollback boundary", () => {
    expect(runbook).toContain('GROUP BY "studentId", "type", "periodStart"');
    expect(runbook).toContain('COUNT(DISTINCT "type") AS type_count');
    expect(runbook).toContain('Payment_studentId_type_periodStart_key');
    expect(runbook).toContain('SELECT COUNT(*) FROM "PaymentResolutionEvent";');
    expect(runbook).toContain("Rollback has a data-dependent boundary");
  });
});
