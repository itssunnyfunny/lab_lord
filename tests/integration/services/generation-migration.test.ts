import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "@/tests/setup/testDatabaseSafety";

const migration = readFileSync("prisma/migrations/20260905143000_fence_ai_and_inbound_messages/migration.sql", "utf8");
describe("generation migration pre-change fixtures", () => {
  let client: Client, schema: string;
  beforeEach(async () => {
    const target = assertDisposableTestDatabaseTarget(process.env.DATABASE_URL);
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    expect((await client.query("SELECT current_database() AS name")).rows[0].name).toBe(target.databaseName);
    schema = `generation_fixture_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE "Branch" (id text PRIMARY KEY);
      CREATE TABLE "WhatsAppSender" (id text PRIMARY KEY);
      CREATE TABLE "MessageDraft" (id text PRIMARY KEY, "branchId" text NOT NULL, "studentId" text, action text, language text, message text);
      INSERT INTO "MessageDraft" VALUES ('one', 'branch', 'student', 'overdue', 'en', 'Preserved');`);
  });
  afterEach(async () => { await client.query("ROLLBACK"); await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end(); });
  it("preserves existing drafts and prevents duplicate logical publication", async () => {
    await client.query(migration);
    expect((await client.query('SELECT message FROM "MessageDraft"')).rows[0].message).toBe("Preserved");
    await expect(client.query(`INSERT INTO "MessageDraft" VALUES ('two', 'branch', 'student', 'overdue', 'en', 'Duplicate')`))
      .rejects.toMatchObject({ code: "23505" });
  });
  it("blocks duplicates without guessing which historical draft to delete", async () => {
    await client.query(`INSERT INTO "MessageDraft" VALUES ('two', 'branch', 'student', 'overdue', 'en', 'Other history')`);
    await expect(client.query(migration)).rejects.toThrow("reviewed resolution");
    await client.query("ROLLBACK");
    expect((await client.query('SELECT COUNT(*)::int AS count FROM "MessageDraft"')).rows[0].count).toBe(2);
    expect((await client.query(`SELECT to_regclass('"BranchGenerationLease"') AS name`)).rows[0].name).toBeNull();
  });
});
