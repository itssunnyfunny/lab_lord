// analytics/payment.analytics.ts

import { prisma } from "@/lib/prisma"
import {
  daysPastDue,
  dueAsOfCutoff,
  isOverdue,
  overdueCutoff,
} from "@/lib/utils/paymentStatus"
import {
  type DateIdCursor,
  pageFromRows,
  PaginationInputError,
  parsePageLimit,
} from "@/lib/cursorPagination"
import type { Prisma } from "@/app/generated/prisma/client"
import { endOfMonth, startOfMonth } from "date-fns"

type AsOf = Date | undefined
export type AnalyticsPeriod = "month" | "all"

function resolveAsOf(asOf?: Date): Date {
  return asOf ?? new Date()
}

function resolvePeriod(period?: AnalyticsPeriod): AnalyticsPeriod {
  return period === "month" ? "month" : "all"
}

function dayEnd(date: Date): Date {
  return dueAsOfCutoff(date)
}

export async function getOpenPaymentLedger(
  branchId: string,
  asOf?: AsOf
) {
  const date = resolveAsOf(asOf)
  const dueDateEnd = dueAsOfCutoff(date)

  const rows = await prisma.payment.findMany({
    where: {
      branchId,
      status: "DUE",
      dueDate: { lte: dueDateEnd },
    },
    select: {
      id: true,
      studentId: true,
      amount: true,
      dueDate: true,
      type: true,
      student: {
        select: {
          id: true,
          name: true,
          phone: true,
        },
      },
    },
    orderBy: [
      { dueDate: "asc" },
      { id: "asc" },
    ],
  })

  const duePayments = rows.map((payment) => {
    const paymentDaysPastDue = daysPastDue(payment.dueDate, date)
    const paymentIsOverdue = isOverdue(payment.dueDate, date)

    return {
      paymentId: payment.id,
      studentId: payment.studentId,
      studentName: payment.student.name,
      phone: payment.student.phone,
      dueDate: payment.dueDate,
      amount: payment.amount,
      type: payment.type,
      daysPastDue: paymentDaysPastDue,
      daysOverdue: paymentDaysPastDue,
      isOverdue: paymentIsOverdue,
    }
  })
  const overduePayments = duePayments.filter((payment) => payment.isOverdue)

  return {
    asOf: date,
    dueCount: duePayments.length,
    dueAmount: duePayments.reduce((sum, payment) => sum + payment.amount, 0),
    overdueCount: overduePayments.length,
    overdueAmount: overduePayments.reduce((sum, payment) => sum + payment.amount, 0),
    duePayments,
    overduePayments,
  }
}

/**
 * Period-aware finance metrics for analytics UI.
 *
 * Revenue/collected respect the selected period. Due is intentionally all
 * unpaid due up to the as-of day so old dues stay visible in every view.
 */
export async function getPaymentPeriodStats(
  branchId: string,
  asOf?: AsOf,
  period?: AnalyticsPeriod
) {
  const date = resolveAsOf(asOf)
  const selectedPeriod = resolvePeriod(period)
  const periodStart = selectedPeriod === "month" ? startOfMonth(date) : undefined
  const periodEnd = selectedPeriod === "month" ? endOfMonth(date) : dayEnd(date)

  // ⚡ Bolt: Replaced memory-heavy findMany + reduce with database-level aggregate
  // Impact: Reduces memory overhead from O(N) to O(1) and eliminates payload transfer for thousands of payment records.
  const [revenueAgg, collectedAgg, openLedger] = await Promise.all([
    prisma.payment.aggregate({
      where: {
        branchId,
        status: { not: "WAIVED" },
        dueDate: selectedPeriod === "month"
          ? { gte: periodStart, lte: periodEnd }
          : { lte: periodEnd },
      },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: {
        branchId,
        status: "PAID",
        OR: selectedPeriod === "month"
          ? [
              { paidAt: { gte: periodStart, lte: periodEnd } },
              { paidAt: null, dueDate: { gte: periodStart, lte: periodEnd } },
            ]
          : [
              { paidAt: { lte: periodEnd } },
              { paidAt: null, dueDate: { lte: periodEnd } },
            ],
      },
      _sum: { amount: true },
    }),
    getOpenPaymentLedger(branchId, date),
  ])

  const revenueAmount = revenueAgg._sum.amount ?? 0
  const paidAmount = collectedAgg._sum.amount ?? 0
  const dueAmount = openLedger.dueAmount

  return {
    period: selectedPeriod,
    revenueAmount,
    paidAmount,
    dueAmount,
    collectionRate: revenueAmount > 0 ? (paidAmount / revenueAmount) * 100 : 0,
  }
}

/**
 * Snapshot of payment state for a branch.
 */
export async function getPaymentStats(
  branchId: string,
  asOf?: AsOf
) {
  const date = resolveAsOf(asOf)
  const dateEnd = dueAsOfCutoff(date)

  // ⚡ Bolt: Replaced memory-heavy findMany + reduce with database-level aggregate and count
  // Impact: Reduces memory overhead from O(N) to O(1) and eliminates payload transfer for thousands of payment records.
  const [openLedger, paidAgg] = await Promise.all([
    getOpenPaymentLedger(branchId, date),
    prisma.payment.aggregate({
      where: {
        branchId,
        status: "PAID",
        OR: [
          { paidAt: { lte: dateEnd } },
          { paidAt: null, dueDate: { lte: dateEnd } },
        ],
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ])

  const paidAmount = paidAgg._sum.amount ?? 0

  return {
    dueCount: openLedger.dueCount,
    paidCount: paidAgg._count._all,
    overdueCount: openLedger.overdueCount,
    dueAmount: openLedger.dueAmount,
    paidAmount,
    overdueAmount: openLedger.overdueAmount,
  }
}

/**
 * List of students who are due as of a date.
 * Structured for AI and UI.
 */
export async function getDueStudents(
  branchId: string,
  asOf?: AsOf
) {
  const ledger = await getOpenPaymentLedger(branchId, asOf)

  return ledger.duePayments.map((payment) => ({
    studentId: payment.studentId,
    dueDate: payment.dueDate,
    amount: payment.amount,
    daysOverdue: payment.daysPastDue,
    isOverdue: payment.isOverdue,
  }))
}

/**
 * Detailed list of overdue payments for manual follow-up.
 */
export async function getOverduePayments(
  branchId: string,
  asOf?: AsOf
) {
  const page = await getOverduePaymentsPage(branchId, { asOf, all: true })

  return {
    count: page.total,
    payments: page.items,
  }
}

export type OverduePaymentPageOptions = {
  asOf?: AsOf
  cursor?: DateIdCursor | null
  limit?: number
  all?: boolean
}

/**
 * Stable, bounded overdue queue for browser/API consumers.
 * Analytics and AI callers use getOverduePayments(), which explicitly requests
 * the complete queue so aggregate counts and generated drafts are never clipped.
 */
export async function getOverduePaymentsPage(
  branchId: string,
  options: OverduePaymentPageOptions = {}
) {
  if (options.all && options.cursor) {
    throw new PaginationInputError("all cannot be combined with cursor")
  }

  const date = resolveAsOf(options.asOf)
  const limit = parsePageLimit(
    options.limit == null ? undefined : String(options.limit)
  )
  const baseWhere: Prisma.PaymentWhereInput = {
    branchId,
    status: "DUE",
    dueDate: { lt: overdueCutoff(date) },
  }
  const cursor = options.cursor ?? null
  const where: Prisma.PaymentWhereInput = cursor
    ? {
        ...baseWhere,
        OR: [
          { dueDate: { gt: cursor.sort } },
          { dueDate: cursor.sort, id: { gt: cursor.id } },
        ],
      }
    : baseWhere

  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      select: {
        id: true,
        studentId: true,
        dueDate: true,
        amount: true,
        student: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
      orderBy: [
        { dueDate: "asc" },
        { id: "asc" },
      ],
      ...(options.all ? {} : { take: limit + 1 }),
    }),
    prisma.payment.count({ where: baseWhere }),
  ])

  const page = options.all
    ? { items: rows, nextCursor: null, total }
    : pageFromRows(rows, limit, total, row => ({ sort: row.dueDate, id: row.id }))

  return {
    ...page,
    items: page.items.map(payment => ({
      paymentId: payment.id,
      studentId: payment.studentId,
      studentName: payment.student.name,
      phone: payment.student.phone,
      dueDate: payment.dueDate,
      amount: payment.amount,
      daysOverdue: daysPastDue(payment.dueDate, date),
    })),
  }
}

/**
 * AI-ready snapshot including summary and buckets.
 */
export async function getPaymentSnapshot(
  branchId: string,
  asOf?: AsOf
) {
  const date = resolveAsOf(asOf)
  const [stats, ledger] = await Promise.all([
    getPaymentStats(branchId, date),
    getOpenPaymentLedger(branchId, date)
  ])

  const buckets = new Map<number, number>()
  for (const payment of ledger.overduePayments) {
    const days = payment.daysOverdue
    buckets.set(days, (buckets.get(days) || 0) + 1)
  }

  const overdueBuckets = Array.from(buckets.entries()).map(([days, count]) => ({
    days,
    count
  })).sort((a, b) => b.days - a.days)

  return {
    branchId,
    summary: {
      totalDue: stats.dueAmount,
      totalPaid: stats.paidAmount,
      totalOverdue: stats.overdueCount
    },
    overdueBuckets,
    asOf: date,
  }
}
