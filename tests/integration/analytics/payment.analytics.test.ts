import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMonths } from "date-fns";
import {
  getOverduePayments,
  getPaymentPeriodStats,
  getPaymentSnapshot,
  getPaymentStats,
} from "@/analytics/payment.analytics";
import { getOrganizationHealthSnapshot, getOrgSnapshot } from "@/analytics/org.analytics";
import { getSeatUtilizationTrend } from "@/analytics/trends/seat.trends";
import { GET as getBranchSnapshot } from "@/app/api/analytics/branch/[branchId]/snapshot/route";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import {
  createAllocation,
  createBranch,
  createOrg,
  createPayment,
  createSeat,
  createSaasSubscription,
  createShift,
  createStudent,
  createTestWorld,
  createUser,
} from "@/tests/factories";

const authMock = vi.hoisted(() => ({
  sessionUser: null as { id: string; email?: string } | null,
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: vi.fn(() => Promise.resolve(authMock.sessionUser)),
}));

describe("Analytics corrections", () => {
  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    authMock.sessionUser = null;
  });

  describe("getPaymentPeriodStats", () => {
    it("separates monthly revenue, monthly collected, and all due correctly", async () => {
      const asOf = new Date("2026-03-15T12:00:00.000Z");
      const { branch } = await createTestWorld();
      const students = await Promise.all([
        createStudent({ branchId: branch.id, name: "A" }),
        createStudent({ branchId: branch.id, name: "B" }),
        createStudent({ branchId: branch.id, name: "C" }),
        createStudent({ branchId: branch.id, name: "D" }),
        createStudent({ branchId: branch.id, name: "E" }),
        createStudent({ branchId: branch.id, name: "F" }),
      ]);

      await createPayment({
        branchId: branch.id,
        studentId: students[0].id,
        dueDate: new Date("2026-01-10T00:00:00.000Z"),
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        amount: 100,
        status: "DUE",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[1].id,
        dueDate: new Date("2026-03-10T00:00:00.000Z"),
        periodStart: new Date("2026-03-01T00:00:00.000Z"),
        periodEnd: new Date("2026-03-31T00:00:00.000Z"),
        amount: 200,
        status: "DUE",
      });

      const paidInMarch = await createPayment({
        branchId: branch.id,
        studentId: students[2].id,
        dueDate: new Date("2026-02-10T00:00:00.000Z"),
        periodStart: new Date("2026-02-01T00:00:00.000Z"),
        periodEnd: new Date("2026-02-28T00:00:00.000Z"),
        amount: 400,
        status: "PAID",
      });
      await testPrisma.payment.update({
        where: { id: paidInMarch.id },
        data: { paidAt: new Date("2026-03-05T00:00:00.000Z") },
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[3].id,
        dueDate: new Date("2026-03-12T00:00:00.000Z"),
        periodStart: new Date("2026-03-01T00:00:00.000Z"),
        periodEnd: new Date("2026-03-31T00:00:00.000Z"),
        amount: 500,
        status: "PAID",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[4].id,
        dueDate: new Date("2026-04-10T00:00:00.000Z"),
        periodStart: new Date("2026-04-01T00:00:00.000Z"),
        periodEnd: new Date("2026-04-30T00:00:00.000Z"),
        amount: 900,
        status: "DUE",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[5].id,
        dueDate: new Date("2026-03-14T00:00:00.000Z"),
        periodStart: new Date("2026-03-01T00:00:00.000Z"),
        periodEnd: new Date("2026-03-31T00:00:00.000Z"),
        amount: 1000,
        status: "WAIVED",
      });

      const monthly = await getPaymentPeriodStats(branch.id, asOf, "month");
      const allTime = await getPaymentPeriodStats(branch.id, asOf, "all");

      expect(monthly.revenueAmount).toBe(700);
      expect(monthly.paidAmount).toBe(900);
      expect(monthly.dueAmount).toBe(300);

      expect(allTime.revenueAmount).toBe(1200);
      expect(allTime.paidAmount).toBe(900);
      expect(allTime.dueAmount).toBe(monthly.dueAmount);
    });
  });

  describe("canonical due and overdue payment counts", () => {
    it("keeps analytics, overdue list, and AI payment snapshot on the same ledger", async () => {
      const asOf = new Date(2026, 4, 9, 12, 0);
      const { branch } = await createTestWorld();
      const students = await Promise.all([
        createStudent({ branchId: branch.id, name: "Overdue monthly" }),
        createStudent({ branchId: branch.id, name: "Grace monthly" }),
        createStudent({ branchId: branch.id, name: "Admission due" }),
        createStudent({ branchId: branch.id, name: "Future monthly" }),
        createStudent({ branchId: branch.id, name: "Paid monthly" }),
        createStudent({ branchId: branch.id, name: "Waived monthly" }),
      ]);

      await createPayment({
        branchId: branch.id,
        studentId: students[0].id,
        dueDate: new Date(2026, 4, 1, 23, 59),
        periodStart: new Date(2026, 3, 1),
        periodEnd: new Date(2026, 4, 1),
        amount: 100,
        status: "DUE",
        type: "MONTHLY",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[1].id,
        dueDate: new Date(2026, 4, 2),
        periodStart: new Date(2026, 3, 2),
        periodEnd: new Date(2026, 4, 2),
        amount: 200,
        status: "DUE",
        type: "MONTHLY",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[2].id,
        dueDate: new Date(2026, 3, 1),
        periodStart: new Date(2026, 3, 1),
        periodEnd: new Date(2026, 3, 1),
        amount: 300,
        status: "DUE",
        type: "ADMISSION",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[3].id,
        dueDate: new Date(2026, 4, 10),
        periodStart: new Date(2026, 4, 10),
        periodEnd: new Date(2026, 5, 10),
        amount: 400,
        status: "DUE",
        type: "MONTHLY",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[4].id,
        dueDate: new Date(2026, 4, 1),
        periodStart: new Date(2026, 3, 1),
        periodEnd: new Date(2026, 4, 1),
        amount: 500,
        status: "PAID",
        type: "MONTHLY",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[5].id,
        dueDate: new Date(2026, 3, 1),
        periodStart: new Date(2026, 2, 1),
        periodEnd: new Date(2026, 3, 1),
        amount: 600,
        status: "WAIVED",
        type: "MONTHLY",
      });

      const [stats, overdue, snapshot, periodStats] = await Promise.all([
        getPaymentStats(branch.id, asOf),
        getOverduePayments(branch.id, asOf),
        getPaymentSnapshot(branch.id, asOf),
        getPaymentPeriodStats(branch.id, asOf, "month"),
      ]);

      expect(stats.dueCount).toBe(3);
      expect(stats.dueAmount).toBe(600);
      expect(stats.overdueCount).toBe(2);
      expect(stats.overdueAmount).toBe(400);
      expect(periodStats.dueAmount).toBe(stats.dueAmount);

      expect(overdue.count).toBe(stats.overdueCount);
      expect(overdue.payments).toHaveLength(stats.overdueCount);
      expect(overdue.payments.map(payment => payment.studentId)).toEqual([students[2].id, students[0].id]);

      expect(snapshot.summary.totalDue).toBe(stats.dueAmount);
      expect(snapshot.summary.totalOverdue).toBe(stats.overdueCount);
      expect(snapshot.overdueBuckets).toEqual([{ days: 38, count: 1 }, { days: 8, count: 1 }]);
    });

    it("uses overdue counts, not due counts, in organization AI snapshots", async () => {
      const asOf = new Date(2026, 4, 9, 12, 0);
      const { org, branch } = await createTestWorld();
      const students = await Promise.all([
        createStudent({ branchId: branch.id, name: "Overdue" }),
        createStudent({ branchId: branch.id, name: "Due in grace" }),
      ]);

      await createPayment({
        branchId: branch.id,
        studentId: students[0].id,
        dueDate: new Date(2026, 4, 1),
        periodStart: new Date(2026, 3, 1),
        periodEnd: new Date(2026, 4, 1),
        amount: 100,
        status: "DUE",
        type: "MONTHLY",
      });

      await createPayment({
        branchId: branch.id,
        studentId: students[1].id,
        dueDate: new Date(2026, 4, 2),
        periodStart: new Date(2026, 3, 2),
        periodEnd: new Date(2026, 4, 2),
        amount: 100,
        status: "DUE",
        type: "MONTHLY",
      });

      const snapshot = await getOrgSnapshot(org.id, asOf);

      expect(snapshot.branches[0].overduePayments).toBe(1);
      expect(snapshot.totals.totalOverduePayments).toBe(1);
    });
  });

  describe("getSeatUtilizationTrend", () => {
    it("uses shift-slot occupancy instead of distinct-seat occupancy", async () => {
      const asOf = new Date("2026-06-01T00:00:00.000Z");
      const { branch, shift, seat } = await createTestWorld();
      const secondShift = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      await createSeat({ branchId: branch.id, label: "S2" });

      const firstStudent = await createStudent({ branchId: branch.id, name: "A", joinedAt: addMonths(asOf, -1) });
      const secondStudent = await createStudent({ branchId: branch.id, name: "B", joinedAt: addMonths(asOf, -1) });

      await createAllocation({ seatId: seat.id, studentId: firstStudent.id, shiftId: shift.id, startDate: asOf });
      await createAllocation({ seatId: seat.id, studentId: secondStudent.id, shiftId: secondShift.id, startDate: asOf });

      const trend = await getSeatUtilizationTrend(branch.id, asOf, asOf);

      expect(trend).toHaveLength(1);
      expect(trend[0].utilizationRatio).toBe(0.5);
    });
  });

  describe("getOrganizationHealthSnapshot", () => {
    it("rolls up seat utilization from slots instead of distinct physical seats", async () => {
      const asOf = new Date("2026-06-01T00:00:00.000Z");
      const { org, branch, shift, seat } = await createTestWorld();
      const secondShift = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const secondSeat = await createSeat({ branchId: branch.id, label: "S2" });

      const students = await Promise.all([
        createStudent({ branchId: branch.id, name: "A", joinedAt: addMonths(asOf, -1) }),
        createStudent({ branchId: branch.id, name: "B", joinedAt: addMonths(asOf, -1) }),
        createStudent({ branchId: branch.id, name: "C", joinedAt: addMonths(asOf, -1) }),
      ]);

      await createAllocation({ seatId: seat.id, studentId: students[0].id, shiftId: shift.id, startDate: asOf });
      await createAllocation({ seatId: seat.id, studentId: students[1].id, shiftId: secondShift.id, startDate: asOf });
      await createAllocation({ seatId: secondSeat.id, studentId: students[2].id, shiftId: shift.id, startDate: asOf });

      const snapshot = await getOrganizationHealthSnapshot(org.id, asOf);

      expect(snapshot.seats.totalSeats).toBe(4);
      expect(snapshot.seats.occupiedSeats).toBe(3);
      expect(snapshot.seats.utilizationRatio).toBe(0.75);
      expect(snapshot.branches[0].snapshot.seats.overall.utilizationRatio).toBe(0.75);

      const aiSnapshot = await getOrgSnapshot(org.id, asOf);
      expect(aiSnapshot.branches[0].seatUtilizationPercent).toBe(75);
      expect(aiSnapshot.totals.totalSeats).toBe(2);
    });
  });

  describe("branch analytics route authorization", () => {
    it("rejects users without analytics access", async () => {
      const { branch } = await createTestWorld();
      const stranger = await createUser();
      authMock.sessionUser = { id: stranger.id, email: stranger.email };

      const response = await getBranchSnapshot(
        new Request(`http://localhost/api/analytics/branch/${branch.id}/snapshot?period=month`),
        { params: Promise.resolve({ branchId: branch.id }) }
      );

      expect(response.status).toBe(403);
    });

    it("returns slot-based utilization counts for branch cards", async () => {
      const asOf = new Date("2026-06-01T00:00:00.000Z");
      const { user, branch, shift, seat } = await createTestWorld();
      await createSaasSubscription({ organizationId: branch.organizationId, plan: "PRO" });
      authMock.sessionUser = { id: user.id, email: user.email };
      const secondShift = await createShift({
        branchId: branch.id,
        name: "Evening",
        startTime: "17:00",
        endTime: "22:00",
      });
      const secondSeat = await createSeat({ branchId: branch.id, label: "S2" });

      const students = await Promise.all([
        createStudent({ branchId: branch.id, name: "A", joinedAt: addMonths(asOf, -1) }),
        createStudent({ branchId: branch.id, name: "B", joinedAt: addMonths(asOf, -1) }),
        createStudent({ branchId: branch.id, name: "C", joinedAt: addMonths(asOf, -1) }),
      ]);

      await createAllocation({ seatId: seat.id, studentId: students[0].id, shiftId: shift.id });
      await createAllocation({ seatId: seat.id, studentId: students[1].id, shiftId: secondShift.id });
      await createAllocation({ seatId: secondSeat.id, studentId: students[2].id, shiftId: shift.id });

      const response = await getBranchSnapshot(
        new Request(`http://localhost/api/analytics/branch/${branch.id}/snapshot?period=month`),
        { params: Promise.resolve({ branchId: branch.id }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.assignedSeats).toBe(3);
      expect(body.totalSeats).toBe(4);
      expect(body.occupancyRate).toBe(75);
      expect(body.seatDetails.totalUsedSlots).toBe(3);
      expect(body.seatDetails.totalShiftCapacity).toBe(4);
    });

    it("accepts period=month for authorized owners", async () => {
      const user = await createUser();
      authMock.sessionUser = { id: user.id, email: user.email };
      const org = await createOrg({ ownerId: user.id });
      await createSaasSubscription({ organizationId: org.id, plan: "PRO" });
      const branch = await createBranch({ organizationId: org.id });
      await createShift({ branchId: branch.id });
      await createSeat({ branchId: branch.id });
      const student = await createStudent({ branchId: branch.id });
      await createPayment({
        branchId: branch.id,
        studentId: student.id,
        dueDate: new Date(),
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        periodEnd: new Date("2026-01-31T00:00:00.000Z"),
        amount: 250,
      });

      const response = await getBranchSnapshot(
        new Request(`http://localhost/api/analytics/branch/${branch.id}/snapshot?period=month`),
        { params: Promise.resolve({ branchId: branch.id }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.period).toBe("month");
    });
  });
});
