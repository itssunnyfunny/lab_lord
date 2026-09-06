import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { disconnectDatabase, testPrisma } from "@/tests/setup/db";
import inventory from "@/prisma/relationship-coverage.json";

describe("complete tenant relationship inventory", () => {
  afterAll(disconnectDatabase);
  it("matches every owning schema relation and its validated installed PostgreSQL foreign key", async () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const relations = [];
    for (const [, model, body] of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
      for (const line of body.split("\n")) {
        const m = line.match(/^\s*(\w+)\s+(\w+)(\?)?\s+@relation\(.*fields: \[([^\]]+)\], references: \[([^\]]+)\]/);
        if (!m) continue;
        relations.push({ model, field: m[1], parent: m[2], fields: m[4].split(",").map(s => s.trim()), references: m[5].split(",").map(s => s.trim()), nullable: Boolean(m[3]) });
      }
    }
    expect(relations).toEqual(inventory);
    const installed = await testPrisma.$queryRaw<Array<{ model: string; parent: string; fields: string[]; references: string[]; validated: boolean }>>`
      SELECT child.relname AS model, parent.relname AS parent, c.convalidated AS validated,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS fields,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS references
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
      WHERE c.contype='f' AND c.connamespace='public'::regnamespace
    `;
    for (const { model, parent, fields, references } of inventory) {
      expect(installed, `${model}(${fields})`).toContainEqual({ model, parent, fields, references, validated: true });
    }
  });
});
