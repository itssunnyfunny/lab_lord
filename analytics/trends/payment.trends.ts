import { assertTrendRange } from "./range"
// analytics/trends/payment.trends.ts

import { AnalyticsPeriod, getPaymentPeriodStats } from "../payment.analytics"

type TrendInterval = "DAY"

function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export async function getPaymentTrend(
  branchId: string,
  from: Date,
  to: Date,
  interval: TrendInterval = "DAY",
  period: AnalyticsPeriod = "all"
) {
  void interval

  assertTrendRange(from, to)

  const points: {
    asOf: Date
    revenueAmount: number
    dueAmount: number
    paidAmount: number
  }[] = []

  let cursor = new Date(from)

  while (cursor <= to) {
    const snapshot = await getPaymentPeriodStats(branchId, cursor, period)

    points.push({
      asOf: new Date(cursor),
      revenueAmount: snapshot.revenueAmount,
      dueAmount: snapshot.dueAmount,
      paidAmount: snapshot.paidAmount,
    })

    cursor = addDays(cursor, 1)
  }

  return points
}
