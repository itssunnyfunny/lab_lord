import type { Prisma } from "@/app/generated/prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getWhatsAppDailyReportMetrics } from "@/analytics/whatsapp-report.analytics";

const mocks = {
  organization: vi.fn(),
  branches: vi.fn(),
  paymentResolutionEvents: vi.fn(),
  paymentAggregate: vi.fn(),
  studentCount: vi.fn(),
  allocationGroupBy: vi.fn(),
  messageCount: vi.fn(),
};

function transaction() {
  return {
    organization: { findUnique: mocks.organization },
    branch: { findMany: mocks.branches },
    paymentResolutionEvent: { findMany: mocks.paymentResolutionEvents },
    payment: { aggregate: mocks.paymentAggregate },
    student: { count: mocks.studentCount },
    seatAllocation: { groupBy: mocks.allocationGroupBy },
    whatsAppMessage: { count: mocks.messageCount },
  } as unknown as Prisma.TransactionClient;
}

describe("WhatsApp daily-report analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organization.mockResolvedValue({
      id: "org_1",
      name: "Lab Lords",
      timezone: "Asia/Kolkata",
    });
    mocks.branches.mockResolvedValue([{
      id: "branch_1",
      name: "Central",
      _count: { seats: 20 },
      shifts: [{ id: "shift_1" }, { id: "shift_2" }],
    }]);
    mocks.paymentResolutionEvents.mockResolvedValue([]);
    mocks.paymentAggregate
      .mockResolvedValueOnce({ _count: { _all: 3 }, _sum: { amount: 12_000 } })
      .mockResolvedValueOnce({ _count: { _all: 5 }, _sum: { amount: 7_500 } })
      .mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { amount: 3_000 } });
    mocks.studentCount.mockResolvedValueOnce(2).mockResolvedValueOnce(50);
    mocks.allocationGroupBy.mockResolvedValue([
      { shiftId: "shift_1", _count: { _all: 25 } },
      { shiftId: "shift_2", _count: { _all: 7 } },
    ]);
    mocks.messageCount
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
  });

  it("uses one explicit metrics as-of timestamp for every temporal query and label", async () => {
    const cutoff = new Date("2026-08-23T15:30:00.000Z");
    const metricsAsOfAt = new Date("2026-08-23T15:45:00.000Z");
    const result = await getWhatsAppDailyReportMetrics(transaction(), {
      scope: "BRANCH",
      organizationId: "org_1",
      branchId: "branch_1",
      localReportDate: "2026-08-23",
      scheduledCutoffAt: cutoff,
      metricsAsOfAt,
    });
    expect(result).toMatchObject({
      branchName: "Central",
      localReportDate: "2026-08-23",
      metricsAsOfAt: metricsAsOfAt.toISOString(),
      asOfLocalTime: "21:15",
      usedShiftSlots: 27,
      totalShiftCapacity: 40,
      paymentsRecordedTodayCount: 3,
      whatsAppUnknownToday: 0,
    });
    expect(mocks.paymentAggregate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        status: "PAID",
        resolutionEvents: { none: {} },
        paidAt: {
          gte: new Date("2026-08-22T18:30:00.000Z"),
          lte: metricsAsOfAt,
        },
        createdAt: { lte: metricsAsOfAt },
      }),
    }));
    expect(mocks.paymentResolutionEvents).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        occurredAt: {
          gte: new Date("2026-08-22T18:30:00.000Z"),
          lte: metricsAsOfAt,
        },
        paidAt: {
          gte: new Date("2026-08-22T18:30:00.000Z"),
          lte: metricsAsOfAt,
        },
      }),
    }));
    expect(mocks.paymentAggregate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        status: "DUE",
        createdAt: { lte: metricsAsOfAt },
        dueDate: { lte: new Date("2026-08-23T18:29:59.999Z") },
      }),
    }));
    expect(mocks.studentCount).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        createdAt: {
          gte: new Date("2026-08-22T18:30:00.000Z"),
          lte: metricsAsOfAt,
        },
      }),
    });
    expect(mocks.studentCount).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({ createdAt: { lte: metricsAsOfAt } }),
    });
    expect(mocks.allocationGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        startDate: { lte: metricsAsOfAt },
        OR: [{ endDate: null }, { endDate: { gt: metricsAsOfAt } }],
      }),
    }));
    expect(mocks.messageCount).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        acceptedAt: {
          gte: new Date("2026-08-22T18:30:00.000Z"),
          lte: metricsAsOfAt,
        },
      }),
    });
    expect(JSON.stringify(result)).not.toMatch(/studentName|phoneE164|seatLabel/);
  });

  it("rejects a cutoff that is outside the requested local date", async () => {
    await expect(getWhatsAppDailyReportMetrics(transaction(), {
      scope: "BRANCH",
      organizationId: "org_1",
      branchId: "branch_1",
      localReportDate: "2026-08-22",
      scheduledCutoffAt: new Date("2026-08-23T15:30:00.000Z"),
      metricsAsOfAt: new Date("2026-08-23T15:45:00.000Z"),
    })).rejects.toThrow("REPORT_CUTOFF_SCOPE_MISMATCH");
    expect(mocks.paymentAggregate).not.toHaveBeenCalled();
  });

  it("rejects metrics as-of timestamps before the cutoff or outside the report day", async () => {
    const cutoff = new Date("2026-08-23T15:30:00.000Z");
    await expect(getWhatsAppDailyReportMetrics(transaction(), {
      scope: "BRANCH",
      organizationId: "org_1",
      branchId: "branch_1",
      localReportDate: "2026-08-23",
      scheduledCutoffAt: cutoff,
      metricsAsOfAt: new Date("2026-08-23T15:29:59.999Z"),
    })).rejects.toThrow("REPORT_METRICS_AS_OF_SCOPE_MISMATCH");
    await expect(getWhatsAppDailyReportMetrics(transaction(), {
      scope: "BRANCH",
      organizationId: "org_1",
      branchId: "branch_1",
      localReportDate: "2026-08-23",
      scheduledCutoffAt: cutoff,
      metricsAsOfAt: new Date("2026-08-23T18:30:00.000Z"),
    })).rejects.toThrow("REPORT_METRICS_AS_OF_SCOPE_MISMATCH");
    expect(mocks.paymentAggregate).not.toHaveBeenCalled();
  });

  it("applies payment corrections between the scheduled cutoff and metrics as-of", async () => {
    const cutoff = new Date("2026-08-23T15:30:00.000Z");
    const metricsAsOfAt = new Date("2026-08-23T15:45:00.000Z");
    mocks.paymentResolutionEvents.mockResolvedValue([
      {
        id: "event_paid_before_cutoff",
        paymentId: "payment_paid_at_cutoff",
        fromStatus: "DUE",
        toStatus: "PAID",
        amount: 4_000,
        paidAt: new Date("2026-08-23T14:00:00.000Z"),
        occurredAt: new Date("2026-08-23T14:00:00.000Z"),
      },
      {
        id: "event_post_cutoff_waiver",
        paymentId: "payment_paid_at_cutoff",
        fromStatus: "PAID",
        toStatus: "WAIVED",
        amount: 4_000,
        paidAt: new Date("2026-08-23T14:00:00.000Z"),
        occurredAt: new Date("2026-08-23T15:45:00.000Z"),
      },
      {
        id: "event_legacy_post_cutoff_waiver",
        paymentId: "legacy_payment_paid_at_cutoff",
        fromStatus: "PAID",
        toStatus: "WAIVED",
        amount: 2_000,
        paidAt: new Date("2026-08-23T13:00:00.000Z"),
        occurredAt: new Date("2026-08-23T15:40:00.000Z"),
      },
    ]);
    mocks.paymentAggregate
      .mockReset()
      .mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { amount: null } })
      .mockResolvedValueOnce({ _count: { _all: 5 }, _sum: { amount: 7_500 } })
      .mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { amount: 3_000 } });

    const result = await getWhatsAppDailyReportMetrics(transaction(), {
      scope: "BRANCH",
      organizationId: "org_1",
      branchId: "branch_1",
      localReportDate: "2026-08-23",
      scheduledCutoffAt: cutoff,
      metricsAsOfAt,
    });

    expect(result).toMatchObject({
      metricsAsOfAt: metricsAsOfAt.toISOString(),
      asOfLocalTime: "21:15",
      paymentsRecordedTodayCount: 0,
      paymentsRecordedTodayAmount: 0,
    });
    expect(mocks.paymentResolutionEvents).toHaveBeenCalledWith({
      where: {
        branchId: { in: ["branch_1"] },
        occurredAt: {
          gte: new Date("2026-08-22T18:30:00.000Z"),
          lte: metricsAsOfAt,
        },
        paidAt: {
          gte: new Date("2026-08-22T18:30:00.000Z"),
          lte: metricsAsOfAt,
        },
      },
      select: {
        id: true,
        paymentId: true,
        fromStatus: true,
        toStatus: true,
        amount: true,
        paidAt: true,
        occurredAt: true,
      },
      orderBy: [
        { paymentId: "asc" },
        { occurredAt: "asc" },
        { id: "asc" },
      ],
    });
  });
});
