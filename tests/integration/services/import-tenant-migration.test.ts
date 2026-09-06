import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "@/tests/setup/testDatabaseSafety";
import contracts from "@/prisma/import-relationship-contracts.json";

const migration = readFileSync("prisma/migrations/20260905180000_scope_import_and_collection_relationships/migration.sql", "utf8");
const q = (s: string) => `"${s}"`;
describe("import and grouped collection tenant migration", () => {
  let client: Client, schema: string;
  beforeEach(async () => {
    const target = assertDisposableTestDatabaseTarget(process.env.DATABASE_URL);
    client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
    expect((await client.query("SELECT current_database() name")).rows[0].name).toBe(target.databaseName);
    schema = `import_tenant_${randomUUID().replaceAll("-", "")}`;
    const fields: Record<string, string[]> = {
      ImportSession: ["branchId"], ImportRow: ["importSessionId"], ImportRowEvaluation: ["importRowId"],
      ImportPlan: ["importSessionId"], ImportRun: ["branchId", "importSessionId", "importPlanId"],
      ImportRunItem: ["importRunId", "importRowId", "evaluationId"],
      WhatsAppMessage: ["branchId"], Payment: ["branchId"], WhatsAppMessagePayment: ["messageId", "paymentId"],
      ImportQuestion: ["importSessionId", "rowId"],
    };
    // One batch avoids hundreds of connection round trips on resource-limited hosts.
    let sql = `CREATE SCHEMA ${q(schema)}; SET search_path TO ${q(schema)};`;
    for (const [table, columns] of Object.entries(fields)) {
      sql += `CREATE TABLE ${q(table)} (id text PRIMARY KEY,${columns.map(c => `${q(c)} text`).join(",")});`;
      for (const variant of ["a", "b"]) sql += `INSERT INTO ${q(table)} VALUES ('${variant}',${columns.map(c => `'${c === "branchId" ? "branch_" : ""}${variant}'`).join(",")});`;
    }
    for (const c of contracts) sql += `ALTER TABLE ${q(c.model)} ADD CONSTRAINT ${q(`${c.model}_${c.foreign}_fkey`)} FOREIGN KEY (${q(c.foreign)}) REFERENCES ${q(c.parent)}(id);`;
    for (const table of ["Payment", "WhatsAppMessage"]) sql += `ALTER TABLE ${q(table)} ADD UNIQUE(id,"branchId");`;
    await client.query(sql);
  });
  afterEach(async () => { await client.query("ROLLBACK"); await client.query(`DROP SCHEMA ${q(schema)} CASCADE`); await client.end(); });

  it("backfills agreed scopes, rejects every mixed parent and retains detached history", async () => {
    await client.query(migration);
    for (const c of contracts) {
      expect((await client.query(`SELECT "branchId" FROM ${q(c.model)} WHERE id='a'`)).rows[0].branchId).toBe("branch_a");
      await expect(client.query(`UPDATE ${q(c.model)} SET ${q(c.foreign)}='b' WHERE id='a'`)).rejects.toMatchObject({ code: "23503" });
      const installed = await client.query("SELECT convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname=$1", [c.constraint]);
      expect(installed.rows).toEqual([{ convalidated: true }]);
    }
    await expect(client.query(`UPDATE "ImportQuestion" SET "rowId"='b' WHERE id='a'`)).rejects.toMatchObject({ code: "23503" });
    await client.query(`DELETE FROM "ImportSession" WHERE id='a'`);
    expect((await client.query(`SELECT "branchId","importSessionId","importPlanId" FROM "ImportRun" WHERE id='a'`)).rows)
      .toEqual([{ branchId: "branch_a", importSessionId: null, importPlanId: null }]);
    expect((await client.query(`SELECT "branchId","importRowId","evaluationId" FROM "ImportRunItem" WHERE id='a'`)).rows)
      .toEqual([{ branchId: "branch_a", importRowId: null, evaluationId: null }]);
  });
  it.each([
    ["ImportRun", "importSessionId"], ["ImportRun", "importPlanId"],
    ["ImportRunItem", "importRowId"], ["ImportRunItem", "evaluationId"],
    ["WhatsAppMessagePayment", "paymentId"], ["ImportQuestion", "rowId"],
  ])("blocks inconsistent %s.%s and rolls back", async (table, field) => {
    await client.query(`UPDATE ${q(table)} SET ${q(field)}='b' WHERE id='a'`);
    await expect(client.query(migration)).rejects.toThrow(/inconsistent references require reviewed repair/);
    await client.query("ROLLBACK");
    expect((await client.query(`SELECT COUNT(*)::int n FROM ${q(table)}`)).rows[0].n).toBe(2);
    expect((await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='ImportRow' AND column_name='branchId'`, [schema])).rows).toEqual([]);
  });
});
