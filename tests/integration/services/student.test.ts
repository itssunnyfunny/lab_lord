import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { StudentService } from "@/services/student.service";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import { createTestWorld, createStudent, createAllocation, createShift, createSeat, createStaff, createUser, createPayment } from "@/tests/factories";
import type { DueResolution } from "@/types";

describe("StudentService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  describe("createStudent", () => {
    it("creates student with ACTIVE status", async () => {
      const { user, branch } = await createTestWorld();
      const student = await StudentService.createStudent(user.id, branch.id, {
        name: "Riya Sharma",
        phone: "9876543210",
        monthlyFee: 1200,
      });
      expect(student.status).toBe("ACTIVE");
      expect(student.name).toBe("Riya Sharma");
    });

    it("allows STAFF role users to create students in their branch", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });

      const student = await StudentService.createStudent(staffUser.id, branch.id, {
        name: "Desk Staff Student",
        phone: "9876543210",
        monthlyFee: 1200,
      });

      expect(student.name).toBe("Desk Staff Student");
    });

    it("rejects duplicate student name and phone inside the same branch", async () => {
      const { user, branch } = await createTestWorld();

      await StudentService.createStudent(user.id, branch.id, {
        name: "Riya Sharma",
        phone: "9876543210",
      });

      await expect(
        StudentService.createStudent(user.id, branch.id, {
          name: "  riya   sharma  ",
          phone: "09876543210",
        })
      ).rejects.toThrow(/name and phone number already exists/i);
    });

    it("allows matching only one student identity field inside the same branch", async () => {
      const { user, branch } = await createTestWorld();

      await StudentService.createStudent(user.id, branch.id, {
        name: "Riya Sharma",
        phone: "9876543210",
      });
      const sameName = await StudentService.createStudent(user.id, branch.id, {
        name: "Riya Sharma",
        phone: "9876543211",
      });
      const samePhone = await StudentService.createStudent(user.id, branch.id, {
        name: "Priya Sharma",
        phone: "9876543210",
      });

      expect(sameName.id).not.toBe(samePhone.id);
    });

    it("allows the same student name and phone in a different branch", async () => {
      const { user, branch } = await createTestWorld();
      const otherBranch = await testPrisma.branch.create({
        data: {
          organizationId: branch.organizationId,
          name: "Second Branch",
        },
      });

      const first = await StudentService.createStudent(user.id, branch.id, {
        name: "Riya Sharma",
        phone: "9876543210",
      });
      const second = await StudentService.createStudent(user.id, otherBranch.id, {
        name: "Riya Sharma",
        phone: "9876543210",
      });

      expect(first.branchId).toBe(branch.id);
      expect(second.branchId).toBe(otherBranch.id);
    });

    it("creates admission payment if admissionFee > 0", async () => {
      const { user, branch } = await createTestWorld();
      const student = await StudentService.createStudent(user.id, branch.id, {
        name: "Paid Student",
        phone: "9876543210",
        admissionFee: 500,
        monthlyFee: 1000,
      });
      const payment = await testPrisma.payment.findFirst({
        where: { studentId: student.id, type: "ADMISSION" },
      });
      expect(payment).not.toBeNull();
      expect(payment?.amount).toBe(500);
    });

    it("does NOT create admission payment if admissionFee is 0", async () => {
      const { user, branch } = await createTestWorld();
      const student = await StudentService.createStudent(user.id, branch.id, {
        name: "Free Student",
        phone: "9876543210",
        admissionFee: 0,
        monthlyFee: 1000,
      });
      const payment = await testPrisma.payment.findFirst({
        where: { studentId: student.id, type: "ADMISSION" },
      });
      expect(payment).toBeNull();
    });

    it("uses branch defaults for monthly and admission fees", async () => {
      const { user, branch } = await createTestWorld({
        defaultFee: 1800,
        defaultAdmissionFee: 700,
      });

      const student = await StudentService.createStudent(user.id, branch.id, {
        name: "Default Fee Student",
        phone: "9876543210",
      });

      expect(student.monthlyFee).toBe(1800);
      const admission = await testPrisma.payment.findFirst({
        where: { studentId: student.id, type: "ADMISSION" },
      });
      expect(admission?.amount).toBe(700);
    });

    it("assigns seat+shift if seatId and shiftIds are provided", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student = await StudentService.createStudent(user.id, branch.id, {
        name: "Seated Student",
        phone: "9876543210",
        monthlyFee: 1000,
        seatId: seat.id,
        shiftIds: [shift.id],
      });
      const alloc = await testPrisma.seatAllocation.findFirst({
        where: { studentId: student.id, endDate: null },
      });
      expect(alloc).not.toBeNull();
      expect(alloc?.seatId).toBe(seat.id);
    });

    it("uses the linked shift price as monthlyFee when requested", async () => {
      const { user, branch, shift } = await createTestWorld();
      await testPrisma.shift.update({
        where: { id: shift.id },
        data: { price: 1400 },
      });

      const student = await StudentService.createStudent(user.id, branch.id, {
        name: "Linked Fee Student",
        phone: "9876543210",
        monthlyFee: 999,
        feeLinkedShiftId: shift.id,
      });

      expect(student.monthlyFee).toBe(1400);
      expect(student.feeLinkedShiftId).toBe(shift.id);
      expect(student.feeLinkedMultiShiftId).toBeNull();
    });

    it("rejects invalid profile, fee, and fee-link inputs", async () => {
      const { user, branch, shift } = await createTestWorld();
      const otherShift = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });

      await expect(
        StudentService.createStudent(user.id, branch.id, { name: "   " })
      ).rejects.toThrow(/required/i);

      await expect(
        StudentService.createStudent(user.id, branch.id, { name: "Missing Phone" })
      ).rejects.toThrow(/phone number is required/i);

      await expect(
        StudentService.createStudent(user.id, branch.id, {
          name: "Bad Phone",
          phone: "phone!",
        })
      ).rejects.toThrow(/phone/i);

      await expect(
        StudentService.createStudent(user.id, branch.id, {
          name: "Bad Phone Type",
          phone: 9876543210 as unknown as string,
        })
      ).rejects.toThrow(/phone/i);

      await expect(
        StudentService.createStudent(user.id, branch.id, {
          name: "Bad Fee",
          phone: "9876543210",
          monthlyFee: -1,
        })
      ).rejects.toThrow(/whole number|at least/i);

      await expect(
        StudentService.createStudent(user.id, branch.id, {
          name: "Bad Fee Type",
          phone: "9876543210",
          monthlyFee: false as unknown as number,
        })
      ).rejects.toThrow(/whole number/i);

      await expect(
        StudentService.createStudent(user.id, branch.id, {
          name: "Bad Link Type",
          phone: "9876543210",
          feeLinkedShiftId: 123 as unknown as string,
        })
      ).rejects.toThrow(/linked shift/i);

      await expect(
        StudentService.createStudent(user.id, branch.id, {
          name: "Conflicting Links",
          phone: "9876543210",
          feeLinkedShiftId: shift.id,
          feeLinkedMultiShiftId: otherShift.id,
        })
      ).rejects.toThrow(/either a shift or a multi-shift/i);
    });
  });

  describe("updateStudentProfile", () => {
    it("rejects updates that duplicate another student name and phone in the same branch", async () => {
      const { user, branch } = await createTestWorld();
      const first = await StudentService.createStudent(user.id, branch.id, {
        name: "Aarav Rao",
        phone: "9876543210",
      });
      const second = await StudentService.createStudent(user.id, branch.id, {
        name: "Bharat Rao",
        phone: "9876543211",
      });

      await expect(
        StudentService.updateStudentProfile(user.id, second.id, {
          name: "  aarav   rao  ",
          phone: "09876543210",
        })
      ).rejects.toThrow(/name and phone number already exists/i);

      const unchanged = await testPrisma.student.findUnique({ where: { id: second.id } });
      expect(first.id).not.toBe(second.id);
      expect(unchanged?.name).toBe("Bharat Rao");
      expect(unchanged?.phone).toBe("+91 98765 43211");
    });
  });

  describe("updateStudentStatus → INACTIVE", () => {
    it("ends all active seat allocations", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      const alloc = await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: shift.id });

      await StudentService.updateStudentStatus(user.id, student.id, "INACTIVE");

      const updated = await testPrisma.seatAllocation.findUnique({ where: { id: alloc.id } });
      expect(updated?.endDate).not.toBeNull();
    });

    it("dueResolution=PAID marks DUE payments as PAID", async () => {
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      const createdPayment = await testPrisma.payment.create({
        data: {
          branchId: branch.id,
          studentId: student.id,
          amount: 1000,
          status: "DUE",
          type: "MONTHLY",
          dueDate: new Date(),
          periodStart: new Date(),
          periodEnd: new Date(),
        },
      });

      await StudentService.updateStudentStatus(user.id, student.id, "INACTIVE", "PAID");

      const payment = await testPrisma.payment.findFirst({ where: { studentId: student.id } });
      const auditLog = await testPrisma.auditLog.findFirst({ where: { paymentId: createdPayment.id } });
      expect(payment?.status).toBe("PAID");
      expect(auditLog?.action).toBe("PAYMENT_MARKED_PAID");
      expect(auditLog?.details).toMatchObject({
        from: "DUE",
        to: "PAID",
        amount: 1000,
        method: null,
        referenceId: null,
      });
    });

    it("dueResolution=KEEP leaves DUE payments untouched", async () => {
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      await testPrisma.payment.create({
        data: {
          branchId: branch.id,
          studentId: student.id,
          amount: 1000,
          status: "DUE",
          type: "MONTHLY",
          dueDate: new Date(),
          periodStart: new Date(),
          periodEnd: new Date(),
        },
      });

      await StudentService.updateStudentStatus(user.id, student.id, "INACTIVE", "KEEP");

      const payment = await testPrisma.payment.findFirst({ where: { studentId: student.id } });
      expect(payment?.status).toBe("DUE");
    });

    it("dueResolution=WAIVED marks DUE payments as WAIVED", async () => {
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      const createdPayment = await testPrisma.payment.create({
        data: {
          branchId: branch.id,
          studentId: student.id,
          amount: 1000,
          status: "DUE",
          type: "MONTHLY",
          dueDate: new Date(),
          periodStart: new Date(),
          periodEnd: new Date(),
        },
      });

      await StudentService.updateStudentStatus(user.id, student.id, "INACTIVE", "WAIVED");

      const payment = await testPrisma.payment.findFirst({ where: { studentId: student.id } });
      const auditLog = await testPrisma.auditLog.findFirst({ where: { paymentId: createdPayment.id } });
      expect(payment?.status).toBe("WAIVED");
      expect(auditLog?.action).toBe("PAYMENT_WAIVED");
      expect(auditLog?.details).toMatchObject({
        from: "DUE",
        to: "WAIVED",
        amount: 1000,
      });
    });

    it("rejects an invalid dueResolution without payment or audit mutations", async () => {
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: new Date(),
        periodStart: new Date(),
        periodEnd: new Date(),
      });

      await expect(
        StudentService.updateStudentStatus(
          user.id,
          student.id,
          "INACTIVE",
          "FORGED" as DueResolution
        )
      ).rejects.toThrow("Invalid due resolution");

      await expect(
        testPrisma.student.findUnique({ where: { id: student.id } })
      ).resolves.toMatchObject({ status: "ACTIVE" });
      await expect(
        testPrisma.payment.findUnique({ where: { id: payment.id } })
      ).resolves.toMatchObject({ status: "DUE" });
      await expect(
        testPrisma.auditLog.count({ where: { paymentId: payment.id } })
      ).resolves.toBe(0);
    });

    it("re-activation: INACTIVE → ACTIVE flips status back to ACTIVE", async () => {
      const { user, branch } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id });

      // First deactivate
      await StudentService.updateStudentStatus(user.id, student.id, "INACTIVE");

      // Then re-activate
      await StudentService.updateStudentStatus(user.id, student.id, "ACTIVE");

      const refreshed = await testPrisma.student.findUnique({ where: { id: student.id } });
      expect(refreshed?.status).toBe("ACTIVE");
    });
  });

  // ─── getStudentsByBranch ──────────────────────────────────────────────────

    it("rejects STAFF users from waiving dues while deactivating a student", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      const student = await createStudent({ branchId: branch.id });
      const payment = await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: new Date(),
        periodStart: new Date(),
        periodEnd: new Date(),
      });

      await expect(
        StudentService.updateStudentStatus(staffUser.id, student.id, "INACTIVE", "WAIVED")
      ).rejects.toThrow("waive_payments");

      const unchangedPayment = await testPrisma.payment.findUnique({ where: { id: payment.id } });
      const unchangedStudent = await testPrisma.student.findUnique({ where: { id: student.id } });
      const auditCount = await testPrisma.auditLog.count({ where: { paymentId: payment.id } });
      expect(unchangedPayment?.status).toBe("DUE");
      expect(unchangedStudent?.status).toBe("ACTIVE");
      expect(auditCount).toBe(0);
    });

  describe("getStudentsByBranch", () => {
    it("allows STAFF role users to list students in their branch", async () => {
      const { branch } = await createTestWorld();
      const staffUser = await createUser();
      await createStaff({ userId: staffUser.id, branchId: branch.id, role: "STAFF" });
      await createStudent({ branchId: branch.id, name: "Visible Student" });

      const results = await StudentService.getStudentsByBranch(staffUser.id, branch.id);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Visible Student");
    });

    it("includes active seat and shift details for student rows", async () => {
      const { user, branch, seat, shift } = await createTestWorld();
      const student = await createStudent({ branchId: branch.id, name: "Allocated Student" });
      await createAllocation({ seatId: seat.id, studentId: student.id, shiftId: shift.id });

      const results = await StudentService.getStudentsByBranch(user.id, branch.id);
      const row = results.find(result => result.id === student.id);

      expect(row?.seatAllocations).toHaveLength(1);
      expect(row?.seatAllocations[0].seat.label).toBe(seat.label);
      expect(row?.seatAllocations[0].shift.name).toBe(shift.name);
    });

    it("shiftId filter returns only students with active allocation in that shift", async () => {
      const { user, branch, shift, seat } = await createTestWorld({ shiftStart: "06:00", shiftEnd: "11:59" });

      // Create two students; allocate one in morning, one in evening
      const studentMorning = await createStudent({ branchId: branch.id, name: "Morning Student" });
      const studentEvening = await createStudent({ branchId: branch.id, name: "Evening Student" });

      const eveningShift = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const seat2 = await createSeat({ branchId: branch.id, label: "S2" });

      await createAllocation({ seatId: seat.id, studentId: studentMorning.id, shiftId: shift.id });
      await createAllocation({ seatId: seat2.id, studentId: studentEvening.id, shiftId: eveningShift.id });

      // Filter by morning shift — should return only the morning student
      const results = await StudentService.getStudentsByBranch(user.id, branch.id, { shiftId: shift.id });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Morning Student");
    });

    it("multiShiftId filter returns only students allocated through that exact bundle", async () => {
      const { user, branch, shift: morning, seat } = await createTestWorld({
        shiftStart: "06:00",
        shiftEnd: "10:00",
      });
      const evening = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "16:00",
        endTime: "20:00",
      });
      const fullDay = await testPrisma.multiShift.create({
        data: {
          branchId: branch.id,
          name: "Full Day",
          components: {
            create: [
              { shiftId: morning.id, order: 0 },
              { shiftId: evening.id, order: 1 },
            ],
          },
        },
      });
      const bundleStudent = await createStudent({ branchId: branch.id, name: "Bundle Student" });
      const morningOnlyStudent = await createStudent({ branchId: branch.id, name: "Morning Only" });
      const morningOnlySeat = await createSeat({ branchId: branch.id, label: "M1" });

      await testPrisma.seatAllocation.createMany({
        data: [
          { seatId: seat.id, studentId: bundleStudent.id, shiftId: morning.id, multiShiftId: fullDay.id },
          { seatId: seat.id, studentId: bundleStudent.id, shiftId: evening.id, multiShiftId: fullDay.id },
          { seatId: morningOnlySeat.id, studentId: morningOnlyStudent.id, shiftId: morning.id },
        ],
      });

      const results = await StudentService.getStudentsByBranch(user.id, branch.id, {
        multiShiftId: fullDay.id,
      });

      expect(results.map(student => student.name)).toEqual(["Bundle Student"]);
    });
  });
});
