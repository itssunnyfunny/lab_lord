import { AnalyticsAccessService } from "@/services/analyticsAccess.service"
import type { AnalyticsPeriod } from "@/analytics/payment.analytics"
import { getSessionUser } from "@/lib/auth"
import { StaffService } from "@/services/staff.service"
import { NextResponse } from "next/server"

export async function GET(
    request: Request,
    { params }: { params: Promise<{ branchId: string }> }
) {
    const user = await getSessionUser()
    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const { branchId } = await params;
        await StaffService.authorize(user.id, branchId, "analytics")

        const url = new URL(request.url);
        const periodParam = url.searchParams.get("period");
        const period: AnalyticsPeriod = periodParam === "month" ? "month" : "all";

        const { health, finance } = await AnalyticsAccessService.branchSnapshot(user.id, branchId, period)

        // Transform to match BranchSnapshot interface in lib/api/analytics.ts
        const totalSeats = health.seats.occupancySnapshot.totalShiftCapacity;
        const assignedSeats = health.seats.occupancySnapshot.totalUsedSlots;
        const totalStudents = health.students.status.active + health.students.status.inactive;

        // Calculate financial metrics
        const paidAmount = finance.paidAmount;
        const dueAmount = finance.dueAmount;
        const monthlyRevenue = finance.revenueAmount;
        const collectionRate = finance.collectionRate;

        const snapshot = {
            period,
            totalStudents,
            activeStudents: health.students.status.active,
            assignedSeats,
            totalSeats,
            // Replace legacy AI occupancyRate with deterministic SeatService percent
            occupancyRate: health.seats.occupancySnapshot.totalOccupancyPercent,
            monthlyRevenue,
            dueAmount,
            paidAmount,
            collectionRate,
            seatDetails: {
                totalUsedSlots: health.seats.occupancySnapshot.totalUsedSlots,
                totalShiftCapacity: health.seats.occupancySnapshot.totalShiftCapacity,
                shifts: health.seats.occupancySnapshot.shifts
            }
        };

        return NextResponse.json(snapshot)
    } catch (error) {
        if (error instanceof Error && error.message.includes("Unauthorized")) {
            return NextResponse.json({ error: error.message }, { status: 403 })
        }
        if (error instanceof Error && error.message.includes("Branch not found")) {
            return NextResponse.json({ error: error.message }, { status: 404 })
        }
        console.error("Error fetching branch snapshot:", error)
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        )
    }
}
