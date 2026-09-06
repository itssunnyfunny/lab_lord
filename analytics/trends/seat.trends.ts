import { assertTrendRange } from "./range"
// analytics/trends/seat.trends.ts

import { getSeatOccupancySnapshot } from "../seat.analytics"

export async function getSeatUtilizationTrend(
  branchId: string,
  from: Date,
  to: Date
) {
  assertTrendRange(from, to)

  const points: {
    asOf: Date
    utilizationRatio: number
  }[] = []

  const cursor = new Date(from)

  while (cursor <= to) {
    const snapshot = await getSeatOccupancySnapshot(branchId, cursor)

    points.push({
      asOf: new Date(cursor),
      utilizationRatio: snapshot.totalOccupancyPercent / 100,
    })

    cursor.setDate(cursor.getDate() + 1)
  }

  return points
}
