import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "@/tests/setup/testDatabaseSafety";

const migration = readFileSync("prisma/migrations/20260905090000_scope_allocation_relationships/migration.sql", "utf8");

describe("allocation tenant migration on pre-change SQL fixtures", () => {
  let client: Client;
  let schema: string;
  beforeEach(async () => {
    const target = assertDisposableTestDatabaseTarget(process.env.DATABASE_URL);
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    expect((await client.query("SELECT current_database() AS name")).rows[0].name).toBe(target.databaseName);
    schema = `allocation_fixture_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    // Minimal pre-change table shape, including the actual old foreign keys.
    for (const table of ["Seat", "Shift", "Student", "MultiShift"]) {
      await client.query(`CREATE TABLE "${table}" (id text PRIMARY KEY, "branchId" text NOT NULL)`);
      await client.query(`INSERT INTO "${table}" VALUES ('a', 'branch_a'), ('b', 'branch_b')`);
    }
    await client.query(`CREATE TABLE "SeatAllocation" (
      id text PRIMARY KEY, "seatId" text NOT NULL, "studentId" text NOT NULL,
      "shiftId" text NOT NULL, "multiShiftId" text, "startDate" timestamp NOT NULL DEFAULT now(), "endDate" timestamp,
      CONSTRAINT "SeatAllocation_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"(id),
      CONSTRAINT "SeatAllocation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"(id),
      CONSTRAINT "SeatAllocation_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"(id),
      CONSTRAINT "SeatAllocation_multiShiftId_fkey" FOREIGN KEY ("multiShiftId") REFERENCES "MultiShift"(id)
    );
    INSERT INTO "SeatAllocation" (id, "seatId", "studentId", "shiftId", "multiShiftId", "endDate")
      VALUES ('active', 'a', 'a', 'a', NULL, NULL), ('historical_bundle', 'b', 'b', 'b', 'b', '2026-01-02');`);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  it("backfills active and historical rows without changing allocation history", async () => {
    const before = (await client.query('SELECT * FROM "SeatAllocation" ORDER BY id')).rows;
    await client.query(migration);
    const after = (await client.query('SELECT * FROM "SeatAllocation" ORDER BY id')).rows;
    expect(after.map(({ branchId, ...row }) => { expect(branchId).toMatch(/^branch_[ab]$/); return row; })).toEqual(before);
    await expect(client.query(`UPDATE "SeatAllocation" SET "shiftId"='b' WHERE id='active'`))
      .rejects.toMatchObject({ code: "23503" });
  });

  it("rejects inconsistent historical data and rolls back the entire migration", async () => {
    await client.query(`UPDATE "SeatAllocation" SET "shiftId"='a' WHERE id='historical_bundle'`);
    await expect(client.query(migration)).rejects.toThrow(/1 inconsistent rows require reviewed repair/);
    await client.query("ROLLBACK");
    const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='SeatAllocation'", [schema]);
    expect(columns.rows.some(row => row.column_name === "branchId")).toBe(false);
    expect((await client.query('SELECT count(*)::int AS n FROM "SeatAllocation"')).rows[0].n).toBe(2);
  });
});
