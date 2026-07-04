// analytics/student.analytics.ts

import { prisma } from "@/lib/prisma"

type AsOf = Date | undefined

function resolveAsOf(asOf?: Date): Date {
  return asOf ?? new Date()
}

/**
 * Active vs inactive students snapshot
 */
export async function getStudentStatusSnapshot(
  branchId: string,
  asOf?: AsOf
) {
  // `asOf` kept for future-proofing (trend-ready)
  resolveAsOf(asOf)

  const [active, inactive] = await Promise.all([
    prisma.student.count({
      where: {
        branchId,
        status: "ACTIVE",
      },
    }),
    prisma.student.count({
      where: {
        branchId,
        status: "INACTIVE",
      },
    }),
  ])

  return {
    active,
    inactive,
    total: active + inactive,
  }
}

/**
 * Seating snapshot for ACTIVE students
 * Answers: how many active students are seated vs not seated
 */
export async function getStudentSeatingSnapshot(
  branchId: string,
  asOf?: AsOf
) {
  const date = resolveAsOf(asOf)

  // Count ACTIVE students
  const activeStudents = await prisma.student.count({
    where: {
      branchId,
      status: "ACTIVE",
    },
  })

  if (activeStudents === 0) {
    return {
      seated: 0,
      notSeated: 0,
      activeStudents: 0,
    }
  }

  // Active seat allocations as of date
  const seated = await prisma.student.count({
    where: {
      branchId,
      status: "ACTIVE",
      seatAllocations: {
        some: {
          startDate: { lte: date },
          OR: [
            { endDate: null },
            { endDate: { gt: date } },
          ],
        },
      },
    },
  })
  const notSeated = Math.max(0, activeStudents - seated)

  return {
    seated,
    notSeated,
    activeStudents,
  }
}
