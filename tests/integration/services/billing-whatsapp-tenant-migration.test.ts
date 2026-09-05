import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseTarget } from "@/tests/setup/testDatabaseSafety";
import contract from "@/prisma/tenant-relationship-contracts.json";

const migration = readFileSync("prisma/migrations/20260905173000_scope_billing_and_whatsapp_relationships/migration.sql", "utf8");
const q = (name: string) => `"${name}"`;
const id = (table: string, variant: string) => `${table === "Branch" ? "branch" : table === "WhatsAppSender" ? "sender" : "row"}_${variant}`;
const scopes = (variant: string) => ({ organizationId: `org_${variant === "c" ? "a" : variant}`, branchId: `branch_${variant}`, senderId: `sender_${variant}` });

describe("billing and WhatsApp tenant migration", () => {
  let client: Client, schema: string;
  const columns = new Map<string, Set<string>>();
  for (const c of contract.contracts) {
    for (const table of [c.model, c.parent]) if (!columns.has(table)) columns.set(table, new Set(["id"]));
    columns.get(c.model)!.add(c.foreign).add(c.scope);
    columns.get(c.parent)!.add(c.scope);
  }
  for (const [table, , check] of contract.checks) {
    for (const field of check.matchAll(/"(\w+)"/g)) columns.get(table)!.add(field[1]);
  }
  beforeEach(async () => {
    const target = assertDisposableTestDatabaseTarget(process.env.DATABASE_URL);
    client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
    expect((await client.query("SELECT current_database() AS name")).rows[0].name).toBe(target.databaseName);
    schema = `billing_tenant_fixture_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${q(schema)}; SET search_path TO ${q(schema)}`);
    for (const [table, fields] of columns) {
      await client.query(`CREATE TABLE ${q(table)} (${[...fields].map(f => `${q(f)} text${f === "id" ? " PRIMARY KEY" : ""}`).join(",")})`);
      for (const variant of ["a", "b", "c"]) {
        const values: Record<string, string | null> = Object.fromEntries([...fields].map(f => [f, null]));
        Object.assign(values, Object.fromEntries(Object.entries(scopes(variant)).filter(([field]) => fields.has(field))));
        values.id = id(table, variant);
        for (const c of contract.contracts.filter(c => c.model === table)) values[c.foreign] = id(c.parent, variant);
        if (table === "OrganizationSubscription") values.currentOrganizationId = values.organizationId;
        await client.query(`INSERT INTO ${q(table)} (${[...fields].map(q)}) VALUES (${[...fields].map((_, i) => `$${i + 1}`)})`, [...fields].map(f => values[f]));
      }
    }
    for (const c of contract.contracts.filter(c => c.replace)) {
      await client.query(`ALTER TABLE ${q(c.model)} ADD CONSTRAINT ${q(c.replace!)} FOREIGN KEY (${q(c.foreign)}) REFERENCES ${q(c.parent)}(id)`);
    }
    // Scoped keys installed by the earlier operational/allocation migrations.
    for (const table of ["Student", "Payment"]) await client.query(`ALTER TABLE ${q(table)} ADD UNIQUE(id,"branchId")`);
  });
  afterEach(async () => { await client.query("ROLLBACK"); await client.query(`DROP SCHEMA ${q(schema)} CASCADE`); await client.end(); });

  it("preserves history and rejects every declared mixed-parent relationship", async () => {
    const before = new Map<string, unknown[]>();
    for (const table of columns.keys()) before.set(table, (await client.query(`SELECT * FROM ${q(table)} ORDER BY id`)).rows);
    await client.query(migration);
    for (const table of columns.keys()) expect((await client.query(`SELECT * FROM ${q(table)} ORDER BY id`)).rows).toEqual(before.get(table));
    for (const c of contract.contracts) {
      const variant = c.scope === "organizationId" ? "b" : "c";
      await expect(client.query(`UPDATE ${q(c.model)} SET ${q(c.foreign)}=$1 WHERE id=$2`, [id(c.parent, variant), id(c.model, "a")]))
        .rejects.toMatchObject({ code: "23503" });
      const installed = await client.query(`SELECT convalidated, pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE connamespace=$1::regnamespace AND conname=$2`, [schema, c.constraint]);
      expect(installed.rows).toHaveLength(1);
      expect(installed.rows[0].convalidated).toBe(true);
      expect(installed.rows[0].definition).toContain(c.scope);
    }
  });

  it("verifies the real migrated database carries every declared scoped key and scoped null action", async () => {
    for (const c of contract.contracts) {
      const result = await client.query(`SELECT convalidated, pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE connamespace='public'::regnamespace AND conname=$1`, [c.constraint]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].convalidated).toBe(true);
      const definition = result.rows[0].definition.replaceAll('"', '');
      expect(definition).toContain(`FOREIGN KEY (${c.foreign}, ${c.scope})`);
      expect(definition).toContain(`REFERENCES public.${c.parent}(id, ${c.scope})`);
      if (c.deletion === "SetNull") expect(definition).toContain(`SET NULL (${c.foreign})`);
    }
    for (const [, constraint] of contract.checks) {
      expect((await client.query(`SELECT convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname=$1`, [constraint])).rows)
        .toEqual([{ convalidated: true }]);
    }
  });

  it.each(["OrganizationBillingChange", "OrganizationSubscriptionInvoice", "OrganizationSubscriptionHistory", "WhatsAppStudentRecipient", "WhatsAppMessage", "WhatsAppTemplateBinding", "WhatsAppConsentEvent"])(
    "blocks pre-change foreign references in %s without altering history", async table => {
      const c = contract.contracts.find(c => c.model === table)!;
      await client.query(`UPDATE ${q(c.model)} SET ${q(c.foreign)}=$1 WHERE id=$2`, [id(c.parent, "b"), id(c.model, "a")]);
      await expect(client.query(migration)).rejects.toThrow(/inconsistent references require reviewed repair/);
      await client.query("ROLLBACK");
      expect((await client.query(`SELECT count(*)::int n FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname=$2`, [schema, c.constraint])).rows[0].n).toBe(0);
      expect((await client.query(`SELECT COUNT(*)::int n FROM ${q(c.model)}`)).rows[0].n).toBe(3);
    });
});
