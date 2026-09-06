
import { NextRequest, NextResponse } from "next/server"
import { AnalyticsAccessService } from "@/services/analyticsAccess.service"
import { getSessionUser } from "@/lib/auth"
import { PaymentService } from "@/services/payment.service"
import {
    decodeDateIdCursor,
    PaginationInputError,
    parsePageLimit,
} from "@/lib/cursorPagination"

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ branchId: string }> }
) {
    try {
        const { branchId } = await params
        const user = await getSessionUser()
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        await PaymentService.assertBranchAccess(user.id, branchId, "view_payments")
        const allParam = req.nextUrl.searchParams.get("all")
        if (allParam !== null && allParam !== "true" && allParam !== "false") {
            throw new PaginationInputError("all must be true or false")
        }
        const all = allParam === "true"
        if (all && (req.nextUrl.searchParams.has("cursor") || req.nextUrl.searchParams.has("limit"))) {
            throw new PaginationInputError("all cannot be combined with cursor or limit")
        }

        const cursor = all
            ? null
            : decodeDateIdCursor(req.nextUrl.searchParams.get("cursor"))
        const limit = all
            ? undefined
            : parsePageLimit(req.nextUrl.searchParams.get("limit"))
        const result = await AnalyticsAccessService.overduePayments(user.id, branchId, { cursor, limit, all })

        return NextResponse.json(result)
    } catch (error) {
        console.error("Failed to fetch overdue payments", error)
        const message = error instanceof Error ? error.message : "Failed to fetch overdue payments"
        const status = error instanceof PaginationInputError
            ? 400
            : message.includes("Unauthorized")
                ? 403
                : 500
        return NextResponse.json(
            { error: message },
            { status }
        )
    }
}
