import { config } from "dotenv";
import path from "path";

/**
 * Vitest GlobalSetup — runs ONCE before all test files.
 * Loads .env.test so DATABASE_URL points to the test database.
 * This must run before any module that imports prisma.
 */
export async function setup() {
  const explicitTestDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (explicitTestDatabaseUrl) {
    process.env.DATABASE_URL = explicitTestDatabaseUrl;
  } else {
    config({
      path: path.resolve(process.cwd(), ".env.test"),
      override: true, // override any existing DATABASE_URL
    });
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "❌ Tests require DATABASE_URL. Check your explicit test target or .env.test file."
    );
  }

  const parsedDatabaseUrl = new URL(process.env.DATABASE_URL);
  const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, "");
  const isPostgres = ["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol);

  // ❌ SAFETY GUARD: inspect the database name, not a coincidental `test`
  // substring in a username, password, hostname, query, or schema parameter.
  if (!isPostgres || !databaseName.toLowerCase().includes("test")) {
    throw new Error(
      "❌ Tests must use a PostgreSQL database whose database name contains 'test'.\n" +
      "   Check your explicit test target or .env.test file."
    );
  }

  if (
    explicitTestDatabaseUrl &&
    process.env.TEST_DATABASE_RESET_CONFIRM !== databaseName
  ) {
    throw new Error(
      "Explicit TEST_DATABASE_URL requires TEST_DATABASE_RESET_CONFIRM to exactly match its database name."
    );
  }

  // Provider-backed billing is deliberately mode-explicit. Integration tests
  // use isolated Test Mode records and may replace this key per test.
  process.env.RAZORPAY_MODE ??= "TEST";
  process.env.RAZORPAY_KEY_ID ??= "rzp_test_vitest";
  process.env.RAZORPAY_KEY_SECRET ??= "vitest-secret";

  console.log(
    "✅ Test environment loaded. DB:",
    `${parsedDatabaseUrl.hostname}:${parsedDatabaseUrl.port || "5432"}/${databaseName}`
  );
}

export async function teardown() {
  // Nothing to do — prisma connection auto-closes
}
