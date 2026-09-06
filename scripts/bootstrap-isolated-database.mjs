import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Deliberately independent of dotenv and the sample-data seed. No fallback URL.
const value = process.env.BOOTSTRAP_DATABASE_URL;
const confirmation = process.env.BOOTSTRAP_DATABASE_CONFIRM;
async function main() {
  if (!value) throw new Error("BOOTSTRAP_DATABASE_URL must be explicitly supplied");
  const target = new URL(value);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(target.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
    || !name.includes("test") || confirmation !== name) {
    throw new Error("Bootstrap requires a confirmed, disposable loopback test database");
  }
  const client = new Client({ connectionString: value });
  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== name) throw new Error("Connected database identity differs");
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (tables.rows.length) {
      // Repeatable only for this bootstrap's empty application database; never seed/reset existing data.
      for (const { tablename } of tables.rows) {
        if (["_prisma_migrations", "BillingDatabaseIdentity"].includes(tablename)) continue;
        const result = await client.query(`SELECT count(*)::int AS count FROM "${tablename.replaceAll('"', '""')}"`);
        if (result.rows[0].count !== 0) throw new Error("Bootstrap refuses a database containing application records");
      }
    }
    const cli = "node_modules/prisma/build/index.js";
    const result = spawnSync(process.execPath, [cli, "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: value, DIRECT_URL: value, ACCELERATE_URL: "" }, encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("Migration deploy failed; inspect the isolated database migration ledger");
    const expected = readdirSync("prisma/migrations", { withFileTypes: true }).filter(e => e.isDirectory()).length;
    const applied = await client.query('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
    if (applied.rows[0].count !== expected) throw new Error("Migration count differs from maintained chain");
    const config = await client.query('SELECT count(*)::int AS count FROM "BillingDatabaseIdentity" WHERE id = 1 AND identity IS NOT NULL');
    if (config.rows[0].count !== 1) throw new Error("Required database billing identity is absent");
    const invalid = await client.query("SELECT count(*)::int AS count FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated");
    if (invalid.rows[0].count !== 0) throw new Error("Unvalidated constraints remain");
    console.log(`Bootstrap verified: ${expected} migrations, required billing identity, validated constraints, no sample/customer/provider records.`);
  } finally { await client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[database URL redacted]") : "Bootstrap failed"); process.exitCode = 1; });
