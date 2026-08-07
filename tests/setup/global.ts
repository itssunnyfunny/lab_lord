import { config } from "dotenv";
import path from "path";

/**
 * Vitest GlobalSetup — runs ONCE before all test files.
 * Loads .env.test so DATABASE_URL points to the test database.
 * This must run before any module that imports prisma.
 */
export async function setup() {
  config({
    path: path.resolve(process.cwd(), ".env.test"),
    override: true, // override any existing DATABASE_URL
  });

  // ❌ SAFETY GUARD: abort if not pointing at a test database
  if (!process.env.DATABASE_URL?.includes("test")) {
    throw new Error(
      "❌ Tests must use a TEST database! DATABASE_URL does not contain 'test'.\n" +
      "   Check your .env.test file."
    );
  }

  // Provider-backed billing is deliberately mode-explicit. Integration tests
  // use isolated Test Mode records and may replace this key per test.
  process.env.RAZORPAY_MODE ??= "TEST";
  process.env.RAZORPAY_KEY_ID ??= "rzp_test_vitest";
  process.env.RAZORPAY_KEY_SECRET ??= "vitest-secret";

  console.log("✅ Test environment loaded. DB:", process.env.DATABASE_URL?.split("@")[1]);
}

export async function teardown() {
  // Nothing to do — prisma connection auto-closes
}
