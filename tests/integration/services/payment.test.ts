import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { PaymentService } from "@/services/payment.service";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import {
  createTestWorld,
  createStudent,
  createPayment,
  createStaff,
  createUser,
  createOrg,
  createBranch,
} from "@/tests/factories";
import { freezeTime, advanceMonths, restoreTime } from "@/tests/setup/time";
import { addMonths, format } from "date-fns";

/**
 * INTEGRATION TESTS: PaymentService
 *
 * Uses REAL test database.
 * Time is FROZEN to 2026-01-01 by default.
 *
 * Key behaviors under test:
 * 1. generateDuePayments — idempotency (running twice doesn't duplicate)
 * 2. generateDuePayments — catch-up (generates multiple months if behind)
 * 3. listPayments — DUE filter includes overdue
 * 4. listPayments — PAID filter is strict to the month
 * 5. markPaymentAsPaid — updates status + clears MessageDrafts
 * 6. markPaymentAsWaived — updates status
 */

describe("PaymentService Integration", () => {
  beforeAll(() => freezeTime());
  afterAll(async () => {
    restoreTime();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  // ─── generateDuePaymentsForBranch ─────────────────────────────────────────

  describe("generateDuePaymentsForBranch", () => {
    it("generates 1 payment for a student joined 1 month ago (time advanced by 1 month)", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      // Student joined on BASE date
      await createStudent({ branchId: branch.id, joinedAt: BASE, monthlyFee: 1500 });

      // Advance time by 1 month so payment is now due
      advanceMonths(1, BASE); // now = 2026-02-01

      const result = await PaymentService.generateDuePaymentsForBranch(user.id, branch.id, addMonths(BASE, 1));
      expect(result.generatedCount).toBe(1);
      expect(result.totalStudents).toBe(1);
    });

    it("is idempotent — running twice does not create duplicate payments", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      await createStudent({ branchId: branch.id, joinedAt: BASE });

      const asOf = addMonths(BASE, 1);
      await PaymentService.generateDuePaymentsForBranch(user.id, branch.id, asOf);
      await PaymentService.generateDuePaymentsForBranch(user.id, branch.id, asOf);

      const payments = await testPrisma.payment.findMany({ where: { branchId: branch.id } });
      // Only 1 payment should exist even though we called it twice
      expect(payments.filter(p => p.type === "MONTHLY")).toHaveLength(1);
    });

    it("catch-up: generates multiple payments if not run for several months", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      await createStudent({ branchId: branch.id, joinedAt: BASE });

      // Fast-forward 4 months
      const asOf = addMonths(BASE, 4);
      const result = await PaymentService.generateDuePaymentsForBranch(user.id, branch.id, asOf);
      expect(result.generatedCount).toBe(4);
    });

    it("generates the next monthly due even when the previous monthly due is still unpaid", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });

      await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: addMonths(BASE, 1),
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "DUE",
      });

      const result = await PaymentService.generateDuePaymentsForBranch(user.id, branch.id, addMonths(BASE, 2));
      const monthlyPayments = await testPrisma.payment.findMany({
        where: { branchId: branch.id, studentId: student.id, type: "MONTHLY" },
        orderBy: { dueDate: "asc" },
      });

      expect(result.generatedCount).toBe(1);
      expect(monthlyPayments.map(payment => payment.status)).toEqual(["DUE", "DUE"]);
      expect(monthlyPayments.map(payment => format(payment.dueDate, "yyyy-MM-dd"))).toEqual([
        format(addMonths(BASE, 1), "yyyy-MM-dd"),
        format(addMonths(BASE, 2), "yyyy-MM-dd"),
      ]);
    });

    it("does not generate payments for INACTIVE students", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });

      // Deactivate student
      await testPrisma.student.update({ where: { id: student.id }, data: { status: "INACTIVE" } });

      const result = await PaymentService.generateDuePaymentsForBranch(user.id, branch.id, addMonths(BASE, 2));
      expect(result.generatedCount).toBe(0);
      expect(result.totalStudents).toBe(0);
    });

    it("throws Unauthorized for non-owner", async () => {
      const { branch } = await createTestWorld();
      await expect(
        PaymentService.generateDuePaymentsForBranch("wrong_user", branch.id)
      ).rejects.toThrow("Unauthorized");
    });

    it("rejects STAFF role users from generating payments", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });

      await expect(
        PaymentService.generateDuePaymentsForBranch(staffUser.id, branch.id)
      ).rejects.toThrow(/Unauthorized/i);
    });

    it("rejects payment generation for a read-only branch", async () => {
      const owner = await createUser();
      const organization = await createOrg({
        ownerId: owner.id,
        billingModelVersion: "WORKSPACE_V2",
      });
      const branch = await createBranch({ organizationId: organization.id });

      await expect(
        PaymentService.generateDuePaymentsForBranch(owner.id, branch.id)
      ).rejects.toThrow("paid subscription is required");
    });

    it("allows an authorized manager on a writable branch", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { branch } = await createTestWorld();
      const manager = await createUser();
      await createStaff({ userId: manager.id, branchId: branch.id, role: "MANAGER" });
      await createStudent({ branchId: branch.id, joinedAt: BASE });

      const result = await PaymentService.generateDuePaymentsForBranch(
        manager.id,
        branch.id,
        addMonths(BASE, 1)
      );

      expect(result.generatedCount).toBe(1);
    });

    it("ensures branch payments without requiring a user id", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { branch } = await createTestWorld();
      await createStudent({ branchId: branch.id, joinedAt: BASE });

      const result = await PaymentService.ensureDuePaymentsForBranch(branch.id, addMonths(BASE, 2));

      expect(result.generatedCount).toBe(2);
      expect(result.totalStudents).toBe(1);
      expect(result.updatedBranchIds).toEqual([branch.id]);
    });

    it("cron generation covers active students across branches and skips inactive students", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const first = await createTestWorld();
      const second = await createTestWorld();
      const inactive = await createStudent({ branchId: first.branch.id, joinedAt: BASE });

      await createStudent({ branchId: first.branch.id, joinedAt: BASE });
      await createStudent({ branchId: second.branch.id, joinedAt: BASE });
      await testPrisma.student.update({
        where: { id: inactive.id },
        data: { status: "INACTIVE" },
      });

      const result = await PaymentService.generateDuePaymentsForAllActiveStudents(addMonths(BASE, 1));

      expect(result.generatedCount).toBe(2);
      expect(result.totalStudents).toBe(2);
      expect(new Set(result.updatedBranchIds)).toEqual(new Set([first.branch.id, second.branch.id]));
    });

    it("cron generation is idempotent when re-run", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { branch } = await createTestWorld();
      await createStudent({ branchId: branch.id, joinedAt: BASE });

      await PaymentService.generateDuePaymentsForAllActiveStudents(addMonths(BASE, 1));
      const secondRun = await PaymentService.generateDuePaymentsForAllActiveStudents(addMonths(BASE, 1));

      const payments = await testPrisma.payment.findMany({ where: { branchId: branch.id } });
      expect(payments.filter(p => p.type === "MONTHLY")).toHaveLength(1);
      expect(secondRun.generatedCount).toBe(0);
    });

    it("handles concurrent branch ensures without duplicating payments", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { branch } = await createTestWorld();
      await createStudent({ branchId: branch.id, joinedAt: BASE });

      const results = await Promise.all([
        PaymentService.ensureDuePaymentsForBranch(branch.id, addMonths(BASE, 1)),
        PaymentService.ensureDuePaymentsForBranch(branch.id, addMonths(BASE, 1)),
      ]);

      const payments = await testPrisma.payment.findMany({ where: { branchId: branch.id } });
      expect(payments.filter(p => p.type === "MONTHLY")).toHaveLength(1);
      expect(results.reduce((sum, result) => sum + result.generatedCount, 0)).toBe(1);
    });
  });

  // ─── listPayments ─────────────────────────────────────────────────────────

  describe("listPayments", () => {
    it("DUE filter includes overdue payments (older than current month)", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });

      // Create an overdue payment (from 2 months ago)
      await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,  // January — asking for February but this should show
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "DUE",
      });

      const february = addMonths(BASE, 1);
      const results = await PaymentService.listPayments(user.id, branch.id, "DUE", february);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(p => p.status === "DUE")).toBe(true);
    });

    it("PAID filter is strict — only shows payments in the requested month", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });

      // Create a PAID payment for January
      await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "PAID",
      });

      // Ask for February PAID — should return nothing
      const february = addMonths(BASE, 1);
      const results = await PaymentService.listPayments(user.id, branch.id, "PAID", february);
      expect(results).toHaveLength(0);
    });

    it("WAIVED filter is strict like paid payments", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const januaryWaiver = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "WAIVED",
      });
      const februaryWaiver = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: addMonths(BASE, 1),
        periodStart: addMonths(BASE, 1),
        periodEnd: addMonths(BASE, 2),
        status: "WAIVED",
      });

      const results = await PaymentService.listPayments(user.id, branch.id, "WAIVED", addMonths(BASE, 1));

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(februaryWaiver.id);
      expect(results[0].id).not.toBe(januaryWaiver.id);
    });

    it("monthly mixed view includes waived history records", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const waiver = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "WAIVED",
      });

      const results = await PaymentService.listPayments(user.id, branch.id, undefined, BASE);

      expect(results.some(payment => payment.id === waiver.id)).toBe(true);
    });

    it("allows STAFF role users to view branch payments", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "DUE",
      });

      const results = await PaymentService.listPayments(staffUser.id, branch.id);

      expect(results).toHaveLength(1);
    });
  });

  // ─── markPaymentAsPaid ────────────────────────────────────────────────────

  describe("markPaymentAsPaid", () => {
    it("updates payment status to PAID", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
      });

      await PaymentService.markPaymentAsPaid(user.id, payment.id);

      const updated = await testPrisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated?.status).toBe("PAID");
      expect(updated?.paidAt).not.toBeNull();
    });

    it("is idempotent — marking PAID twice does not throw", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
      });

      await PaymentService.markPaymentAsPaid(user.id, payment.id);
      await expect(PaymentService.markPaymentAsPaid(user.id, payment.id)).resolves.not.toThrow();
    });

    it("deletes FOLLOW_UP_OVERDUE_PAYMENTS message drafts when paid", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
      });

      // Plant a message draft that should be deleted
      await testPrisma.messageDraft.create({
        data: {
          branchId: branch.id,
          studentId: student.id,
          action: "FOLLOW_UP_OVERDUE_PAYMENTS",
          message: "Dear student, your payment is overdue.",
        },
      });

      await PaymentService.markPaymentAsPaid(user.id, payment.id);

      const drafts = await testPrisma.messageDraft.findMany({
        where: { studentId: student.id, action: "FOLLOW_UP_OVERDUE_PAYMENTS" },
      });
      expect(drafts).toHaveLength(0);
    });

    it("records paymentMethod CASH with null referenceId", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
      });

      await PaymentService.markPaymentAsPaid(user.id, payment.id, "CASH");

      const updated = await testPrisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated?.paymentMethod).toBe("CASH");
      expect(updated?.referenceId).toBeNull();
    });

    it("records paymentMethod UPI with txn referenceId", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
      });

      await PaymentService.markPaymentAsPaid(user.id, payment.id, "UPI", "TXN123ABC");

      const updated = await testPrisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated?.paymentMethod).toBe("UPI");
      expect(updated?.referenceId).toBe("TXN123ABC");
    });

    it("backward-compat — omitting method leaves paymentMethod null", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
      });

      await PaymentService.markPaymentAsPaid(user.id, payment.id);

      const updated = await testPrisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated?.paymentMethod).toBeNull();
      expect(updated?.referenceId).toBeNull();
    });

    it("allows STAFF role users to mark payments paid", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
      });

      await PaymentService.markPaymentAsPaid(staffUser.id, payment.id, "CASH");

      const updated = await testPrisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated?.status).toBe("PAID");
      expect(updated?.paymentMethod).toBe("CASH");
    });
  });


  // ─── markPaymentAsWaived ──────────────────────────────────────────────────

  describe("markPaymentAsWaived", () => {
    it("happy path — status becomes WAIVED", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "DUE",
      });

      await PaymentService.markPaymentAsWaived(user.id, payment.id);

      const updated = await testPrisma.payment.findUnique({ where: { id: payment.id } });
      const auditLog = await testPrisma.auditLog.findFirst({ where: { paymentId: payment.id } });
      expect(updated?.status).toBe("WAIVED");
      expect(auditLog?.action).toBe("PAYMENT_WAIVED");
      expect(auditLog?.details).toMatchObject({
        from: "DUE",
        to: "WAIVED",
        amount: 1000,
      });
    });

    it("is idempotent — marking WAIVED twice does not throw", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "DUE",
      });

      await PaymentService.markPaymentAsWaived(user.id, payment.id);
      await expect(PaymentService.markPaymentAsWaived(user.id, payment.id)).resolves.not.toThrow();
    });

    it("rejects STAFF role users from waiving payments", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "DUE",
      });

      await expect(
        PaymentService.markPaymentAsWaived(staffUser.id, payment.id)
      ).rejects.toThrow(/Unauthorized/i);
    });
  });

  // ─── listPayments — default (no-status) filter ───────────────────────────

  describe("listPayments — default filter excludes WAIVED", () => {
    it("calling without status arg returns DUE but not WAIVED payments", async () => {
      const BASE = new Date("2026-01-01T00:00:00.000Z");
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, joinedAt: BASE });

      // Create one DUE + one WAIVED payment
      await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: BASE,
        periodStart: BASE,
        periodEnd: addMonths(BASE, 1),
        status: "DUE",
      });
      await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: addMonths(BASE, 1),
        periodStart: addMonths(BASE, 1),
        periodEnd: addMonths(BASE, 2),
        status: "WAIVED",
      });

      // Call without status argument — default clause: { status: { not: "WAIVED" } }
      const results = await PaymentService.listPayments(user.id, branch.id);
      expect(results.every(p => p.status !== "WAIVED")).toBe(true);
      expect(results.some(p => p.status === "DUE")).toBe(true);
    });
  });
});
