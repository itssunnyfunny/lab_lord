import { config } from "dotenv";
import path from "path";
import { assertDisposableTestDatabaseTarget } from "./testDatabaseSafety";

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

  const target = assertDisposableTestDatabaseTarget(
    process.env.DATABASE_URL,
    process.env
  );

  // Provider-backed billing is deliberately mode-explicit. Integration tests
  // use isolated Test Mode records and may replace this key per test.
  process.env.RAZORPAY_MODE ??= "TEST";
  process.env.RAZORPAY_KEY_ID ??= "rzp_test_vitest";
  process.env.RAZORPAY_KEY_SECRET ??= "vitest-secret";

  console.log(
    "✅ Test environment loaded. DB:",
    target.sanitizedIdentity
  );
}

export async function teardown() {
  // Nothing to do — prisma connection auto-closes
}
