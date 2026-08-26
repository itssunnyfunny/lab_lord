import type { Prisma } from "@/app/generated/prisma/client";
import {
  type WhatsAppBranchReportMetrics,
  WhatsAppBranchReportMetricsSchema,
  type WhatsAppOrganizationReportMetrics,
  WhatsAppOrganizationReportMetricsSchema,
} from "@/lib/whatsappReportMetrics";
import {
  addWhatsAppLocalDays,
  getWhatsAppLocalDateTimeParts,
  type LocalDateParts,
  whatsappLocalDateKey,
  whatsappLocalDateTimeToUtc,
} from "@/lib/whatsappSchedule";
import { OVERDUE_GRACE_DAYS } from "@/lib/utils/paymentStatus";

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type WhatsAppReportAnalyticsInput = Readonly<{
  scope: "BRANCH" | "ORGANIZATION";
  organizationId: string;
  branchId?: string | null;
  localReportDate: string;
  scheduledCutoffAt: Date;
}>;

function parseLocalDate(value: string): LocalDateParts {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) throw new Error("REPORT_LOCAL_DATE_INVALID");
  const result = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const roundTrip = new Date(Date.UTC(result.year, result.month - 1, result.day, 12));
  if (
    roundTrip.getUTCFullYear() !== result.year
    || roundTrip.getUTCMonth() + 1 !== result.month
    || roundTrip.getUTCDate() !== result.day
  ) {
    throw new Error("REPORT_LOCAL_DATE_INVALID");
  }
  return result;
}

function localDayStart(localDate: LocalDateParts, timeZone: string) {
  return whatsappLocalDateTimeToUtc({ date: localDate, hour: 0, minute: 0, timeZone });
}

function localDayEnd(localDate: LocalDateParts, timeZone: string) {
  return new Date(localDayStart(addWhatsAppLocalDays(localDate, 1), timeZone).getTime() - 1);
}

function messageScopeWhere(input: WhatsAppReportAnalyticsInput) {
  return input.scope === "BRANCH"
    ? { organizationId: input.organizationId, branchId: input.branchId! }
    : { organizationId: input.organizationId };
}

type PaymentResolutionEvidence = Readonly<{
  id: string;
  paymentId: string;
  fromStatus: string;
  toStatus: string;
  amount: number;
  paidAt: Date | null;
  occurredAt: Date;
}>;

function compareResolutionEvidence(
  left: PaymentResolutionEvidence,
  right: PaymentResolutionEvidence
) {
  const occurredAtDifference = left.occurredAt.getTime() - right.occurredAt.getTime();
  return occurredAtDifference !== 0
    ? occurredAtDifference
    : left.id.localeCompare(right.id);
}

function paidResolutionTotalsAtCutoff(
  events: readonly PaymentResolutionEvidence[],
  dayStart: Date,
  scheduledCutoffAt: Date
) {
  const evidenceByPayment = new Map<string, {
    latestAtOrBefore: PaymentResolutionEvidence | null;
    earliestAfter: PaymentResolutionEvidence | null;
  }>();
  for (const event of events) {
    const evidence = evidenceByPayment.get(event.paymentId) ?? {
      latestAtOrBefore: null,
      earliestAfter: null,
    };
    if (event.occurredAt.getTime() <= scheduledCutoffAt.getTime()) {
      if (
        !evidence.latestAtOrBefore
        || compareResolutionEvidence(event, evidence.latestAtOrBefore) > 0
      ) {
        evidence.latestAtOrBefore = event;
      }
    } else if (
      !evidence.earliestAfter
      || compareResolutionEvidence(event, evidence.earliestAfter) < 0
    ) {
      evidence.earliestAfter = event;
    }
    evidenceByPayment.set(event.paymentId, evidence);
  }

  let count = 0;
  let amount = 0;
  for (const evidence of evidenceByPayment.values()) {
    const event = evidence.latestAtOrBefore ?? evidence.earliestAfter;
    if (!event) continue;

    // A pre-cutoff event's after-state is authoritative at the cutoff. When a
    // legacy paid payment has no pre-cutoff ledger row, the first later
    // correction's immutable before-state proves what was true at the cutoff.
    const statusAtCutoff = evidence.latestAtOrBefore
      ? event.toStatus
      : event.fromStatus;
    if (
      statusAtCutoff === "PAID"
      && event.paidAt
      && event.paidAt.getTime() >= dayStart.getTime()
      && event.paidAt.getTime() <= scheduledCutoffAt.getTime()
    ) {
      count += 1;
      amount += event.amount;
    }
  }
  return { count, amount };
}

async function getPaymentsRecordedThroughCutoff(
  tx: Prisma.TransactionClient,
  input: {
    branchIds: readonly string[];
    dayStart: Date;
    scheduledCutoffAt: Date;
  }
) {
  const [resolutionEvents, legacyPayments] = await Promise.all([
    input.branchIds.length === 0
      ? Promise.resolve([])
      : tx.paymentResolutionEvent.findMany({
          where: {
            branchId: { in: [...input.branchIds] },
            // A payment's first PAID transition uses the same instant for
            // occurredAt and paidAt, and every correction follows it. Starting
            // at the report day therefore retains all evidence that can affect
            // this cutoff while keeping the catch-up query on the
            // (branchId, occurredAt, id) ledger index.
            occurredAt: { gte: input.dayStart },
            paidAt: { gte: input.dayStart, lte: input.scheduledCutoffAt },
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
        }),
    tx.payment.aggregate({
      where: {
        branchId: { in: [...input.branchIds] },
        status: "PAID",
        createdAt: { lte: input.scheduledCutoffAt },
        paidAt: { gte: input.dayStart, lte: input.scheduledCutoffAt },
        // Historical resolutions predate the append-only ledger. They remain
        // compatible only while no later resolution event can prove otherwise.
        resolutionEvents: { none: {} },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);
  const ledgerTotals = paidResolutionTotalsAtCutoff(
    resolutionEvents,
    input.dayStart,
    input.scheduledCutoffAt
  );
  return {
    count: ledgerTotals.count + legacyPayments._count._all,
    amount: ledgerTotals.amount + (legacyPayments._sum.amount ?? 0),
  };
}

/**
 * Produces aggregate-only WhatsApp daily-report metrics inside the caller's
 * transaction. The caller is responsible for using RepeatableRead or stronger.
 */
export async function getWhatsAppDailyReportMetrics(
  tx: Prisma.TransactionClient,
  input: WhatsAppReportAnalyticsInput
): Promise<WhatsAppBranchReportMetrics | WhatsAppOrganizationReportMetrics> {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.organizationId)
    || (input.scope === "BRANCH" && !/^[A-Za-z0-9_-]{1,128}$/.test(input.branchId ?? ""))
    || (input.scope === "ORGANIZATION" && input.branchId != null)
    || Number.isNaN(input.scheduledCutoffAt.getTime())
  ) {
    throw new Error("REPORT_SCOPE_INVALID");
  }
  const localDate = parseLocalDate(input.localReportDate);
  const organization = await tx.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true, name: true, timezone: true },
  });
  if (!organization) throw new Error("REPORT_SCOPE_NOT_FOUND");
  if (whatsappLocalDateKey(input.scheduledCutoffAt, organization.timezone) !== input.localReportDate) {
    throw new Error("REPORT_CUTOFF_SCOPE_MISMATCH");
  }

  const branches = await tx.branch.findMany({
    where: input.scope === "BRANCH"
      ? { id: input.branchId!, organizationId: input.organizationId }
      : { organizationId: input.organizationId },
    select: {
      id: true,
      name: true,
      _count: { select: { seats: true } },
      shifts: {
        where: { status: "ACTIVE" },
        select: { id: true },
      },
    },
    orderBy: { id: "asc" },
  });
  if (input.scope === "BRANCH" && branches.length !== 1) {
    throw new Error("REPORT_SCOPE_NOT_FOUND");
  }

  const branchIds = branches.map(branch => branch.id);
  const branchWhere = { branchId: { in: branchIds } } as const;
  const dayStart = localDayStart(localDate, organization.timezone);
  const dayEnd = localDayEnd(localDate, organization.timezone);
  const overdueBefore = localDayStart(
    addWhatsAppLocalDays(localDate, -OVERDUE_GRACE_DAYS),
    organization.timezone
  );
  const messageWhere = messageScopeWhere(input);

  // Payment outcomes are reconstructed at the labelled cutoff from immutable
  // resolution evidence. Student status, active seats/shifts, allocations, and
  // open/overdue debt intentionally remain current canonical facts (while
  // excluding records that did not yet exist or apply by the cutoff).

  const [
    paymentsRecorded,
    newStudentsToday,
    activeStudents,
    openDues,
    overdue,
    allocationsByShift,
    whatsAppAcceptedToday,
    whatsAppDeliveredToday,
    whatsAppFailedToday,
    whatsAppUnknownToday,
  ] = await Promise.all([
    getPaymentsRecordedThroughCutoff(tx, {
      branchIds,
      dayStart,
      scheduledCutoffAt: input.scheduledCutoffAt,
    }),
    tx.student.count({
      where: {
        ...branchWhere,
        createdAt: { gte: dayStart, lte: input.scheduledCutoffAt },
      },
    }),
    tx.student.count({
      where: {
        ...branchWhere,
        status: "ACTIVE",
        createdAt: { lte: input.scheduledCutoffAt },
      },
    }),
    tx.payment.aggregate({
      where: {
        ...branchWhere,
        status: "DUE",
        createdAt: { lte: input.scheduledCutoffAt },
        dueDate: { lte: dayEnd },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    tx.payment.aggregate({
      where: {
        ...branchWhere,
        status: "DUE",
        createdAt: { lte: input.scheduledCutoffAt },
        dueDate: { lt: overdueBefore },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    branchIds.length === 0
      ? Promise.resolve([])
      : tx.seatAllocation.groupBy({
          by: ["shiftId"],
          where: {
            seat: { branchId: { in: branchIds } },
            student: {
              branchId: { in: branchIds },
              status: "ACTIVE",
              createdAt: { lte: input.scheduledCutoffAt },
            },
            startDate: { lte: input.scheduledCutoffAt },
            OR: [
              { endDate: null },
              { endDate: { gt: input.scheduledCutoffAt } },
            ],
          },
          _count: { _all: true },
          orderBy: { shiftId: "asc" },
        }),
    tx.whatsAppMessage.count({
      where: {
        ...messageWhere,
        acceptedAt: { gte: dayStart, lte: input.scheduledCutoffAt },
      },
    }),
    tx.whatsAppMessage.count({
      where: {
        ...messageWhere,
        deliveredAt: { gte: dayStart, lte: input.scheduledCutoffAt },
      },
    }),
    tx.whatsAppMessage.count({
      where: {
        ...messageWhere,
        failedAt: { gte: dayStart, lte: input.scheduledCutoffAt },
      },
    }),
    tx.whatsAppMessage.count({
      where: {
        ...messageWhere,
        status: "UNKNOWN",
        submissionStartedAt: { gte: dayStart, lte: input.scheduledCutoffAt },
      },
    }),
  ]);

  const capacityByShift = new Map<string, number>();
  let totalShiftCapacity = 0;
  for (const branch of branches) {
    for (const shift of branch.shifts) {
      capacityByShift.set(shift.id, branch._count.seats);
      totalShiftCapacity += branch._count.seats;
    }
  }
  let usedShiftSlots = 0;
  for (const row of allocationsByShift) {
    const capacity = capacityByShift.get(row.shiftId);
    if (capacity !== undefined) usedShiftSlots += Math.min(capacity, row._count._all);
  }

  const time = getWhatsAppLocalDateTimeParts(
    input.scheduledCutoffAt,
    organization.timezone
  );
  const common = {
    localReportDate: input.localReportDate,
    asOfLocalTime: `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`,
    paymentsRecordedTodayCount: paymentsRecorded.count,
    paymentsRecordedTodayAmount: paymentsRecorded.amount,
    newStudentsToday,
    activeStudents,
    usedShiftSlots,
    totalShiftCapacity,
    openDueCount: openDues._count._all,
    openDueAmount: openDues._sum.amount ?? 0,
    overdueCount: overdue._count._all,
    overdueAmount: overdue._sum.amount ?? 0,
    whatsAppAcceptedToday,
    whatsAppDeliveredToday,
    whatsAppFailedToday,
    whatsAppUnknownToday,
  };

  return input.scope === "BRANCH"
    ? WhatsAppBranchReportMetricsSchema.parse({
        branchName: branches[0]!.name,
        ...common,
      })
    : WhatsAppOrganizationReportMetricsSchema.parse({
        organizationName: organization.name,
        branchCount: branches.length,
        ...common,
      });
}
