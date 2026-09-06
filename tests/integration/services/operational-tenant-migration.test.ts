import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "@/tests/setup/testDatabaseSafety";

const migration = readFileSync("prisma/migrations/20260905170000_scope_operational_relationships/migration.sql", "utf8");
describe("operational tenant migration fixtures", () => {
  let client: Client, schema: string;
  beforeEach(async () => {
    const target = assertDisposableTestDatabaseTarget(process.env.DATABASE_URL);
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    expect((await client.query("SELECT current_database() AS name")).rows[0].name).toBe(target.databaseName);
    schema = `operational_fixture_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    for (const table of ["Shift", "MultiShift", "Student"]) {
      await client.query(`CREATE TABLE "${table}" (id text PRIMARY KEY, "branchId" text NOT NULL, UNIQUE(id,"branchId"));
        INSERT INTO "${table}" VALUES ('a','branch_a'),('b','branch_b');`);
    }
    await client.query(`ALTER TABLE "Student" ADD "feeLinkedShiftId" text, ADD "feeLinkedMultiShiftId" text;
      UPDATE "Student" SET "feeLinkedShiftId"=id, "feeLinkedMultiShiftId"=id;
      CREATE TABLE "MultiShiftComponent" (id text PRIMARY KEY, "multiShiftId" text NOT NULL, "shiftId" text NOT NULL,
        CONSTRAINT "MultiShiftComponent_multiShiftId_fkey" FOREIGN KEY("multiShiftId") REFERENCES "MultiShift"(id),
        CONSTRAINT "MultiShiftComponent_shiftId_fkey" FOREIGN KEY("shiftId") REFERENCES "Shift"(id));
      INSERT INTO "MultiShiftComponent" VALUES ('c','a','a');
      CREATE TABLE "Payment" (id text PRIMARY KEY, "branchId" text NOT NULL, "studentId" text NOT NULL,
        CONSTRAINT "Payment_studentId_fkey" FOREIGN KEY("studentId") REFERENCES "Student"(id));
      INSERT INTO "Payment" VALUES ('p','branch_a','a');
      CREATE TABLE "PaymentResolutionEvent" (id text PRIMARY KEY, "branchId" text NOT NULL, "paymentId" text NOT NULL,
        CONSTRAINT "PaymentResolutionEvent_paymentId_fkey" FOREIGN KEY("paymentId") REFERENCES "Payment"(id));
      INSERT INTO "PaymentResolutionEvent" VALUES ('event','branch_a','p');
      CREATE TABLE "AuditLog" (id text PRIMARY KEY, "branchId" text NOT NULL, "paymentId" text NOT NULL);
      INSERT INTO "AuditLog" VALUES ('audit','branch_a','p');
      CREATE TABLE "MessageDraft" (id text PRIMARY KEY, "branchId" text NOT NULL, "studentId" text, message text,
        CONSTRAINT "MessageDraft_studentId_fkey" FOREIGN KEY("studentId") REFERENCES "Student"(id) ON DELETE SET NULL);
      INSERT INTO "MessageDraft" VALUES ('draft','branch_a','a','Preserved'),('history','branch_a',NULL,'Historical');`);
  });
  afterEach(async () => { await client.query("ROLLBACK"); await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end(); });
  it("preserves valid history and derives component branch only after proving agreement", async () => {
    const drafts = (await client.query('SELECT * FROM "MessageDraft" ORDER BY id')).rows;
    await client.query(migration);
    expect((await client.query('SELECT * FROM "MessageDraft" ORDER BY id')).rows).toEqual(drafts);
    expect((await client.query('SELECT * FROM "MultiShiftComponent"')).rows[0]).toMatchObject({ branchId: "branch_a", shiftId: "a" });
    await expect(client.query(`UPDATE "Payment" SET "studentId"='b'`)).rejects.toMatchObject({ code: "23503" });
  });
  it.each([
    'UPDATE "Payment" SET "branchId"=\'branch_b\'',
    'UPDATE "PaymentResolutionEvent" SET "branchId"=\'branch_b\'',
    'UPDATE "AuditLog" SET "branchId"=\'branch_b\'',
    'UPDATE "MessageDraft" SET "branchId"=\'branch_b\' WHERE id=\'draft\'',
    'UPDATE "Student" SET "feeLinkedShiftId"=\'b\' WHERE id=\'a\'',
    'UPDATE "Student" SET "feeLinkedMultiShiftId"=\'b\' WHERE id=\'a\'',
    'UPDATE "MultiShiftComponent" SET "shiftId"=\'b\'',
  ])("blocks inconsistent pre-change references: %s", async corrupt => {
    await client.query(corrupt);
    const expectedReferences = corrupt.startsWith('UPDATE "Payment" ') ? 3 : 1;
    await expect(client.query(migration)).rejects.toThrow(`${expectedReferences} inconsistent references require reviewed repair`);
    await client.query("ROLLBACK");
    expect((await client.query(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_schema=$1
      AND table_name='MultiShiftComponent' AND column_name='branchId'`, [schema])).rows[0].n).toBe(0);
    expect((await client.query('SELECT COUNT(*)::int n FROM "MessageDraft"')).rows[0].n).toBe(2);
  });
});
