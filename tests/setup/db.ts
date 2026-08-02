import { PrismaClient } from "../../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * DB ISOLATION STRATEGY: Transaction Rollback Per Test
 *
 * Why NOT deleteMany():
 *   - Cascade ordering is fragile (foreign key errors if order is wrong)
 *   - Leaves data if a test crashes mid-run
 *   - Slower (multiple DELETE queries vs one ROLLBACK)
 *
 * Why Transaction Rollback:
 *   - Atomic: either everything is cleaned up or nothing
 *   - Fast: PostgreSQL ROLLBACK is a single operation
 *   - Safe: even if test throws, afterEach still runs
 *
 * HOW IT WORKS:
 *   - Each test gets its own Prisma client connected to a transaction
 *   - The transaction is NEVER committed
 *   - afterEach rolls it back - data vanishes as if the test never ran
 *
 * LIMITATION:
 *   - Prisma does not natively support "injectable" transactions for service-layer tests
 *   - So we use a DIFFERENT approach: truncate tables in a fixed order before each test
 *   - This is the pragmatic choice for this codebase
 */

// Create a dedicated prisma client for tests (reads from .env.test via global setup)
export const testPrisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  }),
});

/**
 * Call this in beforeEach() of every integration test file.
 * Deletes ALL data in dependency-safe order (children before parents).
 * This is the practical alternative to transaction rollback for service-layer tests
 * where the service itself calls prisma.$transaction internally.
 */
export async function resetDatabase() {
  // TRUNCATE is a single atomic operation - faster than chained deleteMany()
  // CASCADE handles FK dependencies automatically, so order doesn't matter.
  await testPrisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog",
      "OrganizationSubscriptionHistory",
      "RazorpayWebhookEvent",
      "OrganizationSubscription",
      "SaasRazorpayPlan",
      "ImportCommit",
      "ImportQuestion",
      "ImportRow",
      "ImportSession",
      "MessageDraft",
      "BranchAIReport",
      "StaffInvite",
      "StaffPermissionOverride",
      "SeatAllocation",
      "Payment",
      "Staff",
      "MultiShiftComponent",
      "MultiShift",
      "Student",
      "Seat",
      "Shift",
      "Branch",
      "Organization",
      "User"
    CASCADE;
  `);
}

/**
 * Call this in afterAll() of every integration test file.
 * Closes the DB connection so Node can exit cleanly.
 */
export async function disconnectDatabase() {
  await testPrisma.$disconnect();
}
