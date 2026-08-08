import { getSessionUser } from "@/lib/auth";
import { PaymentService } from "@/services/payment.service";
import { PaymentStatus } from "@/app/generated/prisma/enums";
import { NextResponse } from "next/server";
import {
    decodeDateIdCursor,
    PaginationInputError,
    parsePageLimit,
} from "@/lib/cursorPagination";

export async function GET(
    req: Request,
    { params }: { params: Promise<{ branchId: string }> }
) {
    try {
        const session = await getSessionUser();
        if (!session?.id) {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const statusParam = searchParams.get("status");
        const monthParam = searchParams.get("month"); // YYYY-MM

        let status: PaymentStatus | undefined;
        if (statusParam) {
            if (!Object.values(PaymentStatus).includes(statusParam as PaymentStatus)) {
                return NextResponse.json({ error: "Invalid payment status" }, { status: 400 });
            }
            status = statusParam as PaymentStatus;
        }

        let month: Date | undefined;
        if (monthParam) {
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
                return NextResponse.json({ error: "month must use YYYY-MM" }, { status: 400 });
            }
            month = new Date(`${monthParam}-01T12:00:00.000Z`);
        }
        const allParam = searchParams.get("all");
        if (allParam !== null && allParam !== "true" && allParam !== "false") {
            throw new PaginationInputError("all must be true or false");
        }
        const all = allParam === "true";
        const cursorValue = searchParams.get("cursor");
        const limitValue = searchParams.get("limit");
        if (all && (searchParams.has("cursor") || searchParams.has("limit"))) {
            throw new PaginationInputError("all cannot be combined with cursor or limit");
        }
        const limit = all ? undefined : parsePageLimit(limitValue);
        const cursor = all ? null : decodeDateIdCursor(cursorValue);

        const { branchId } = await params;

        if (all) {
            const items = await PaymentService.listPayments(session.id, branchId, status, month);
            return NextResponse.json({ items, nextCursor: null, total: items.length });
        }

        const page = await PaymentService.listPayments(
            session.id,
            branchId,
            status,
            month,
            { limit: limit!, cursor }
        );
        return NextResponse.json(page);
    } catch (error) {
        if (error instanceof PaginationInputError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof Error && error.message.includes("Unauthorized")) {
            return NextResponse.json({ error: error.message }, { status: 403 });
        }
        console.error("[PAYMENTS_GET]", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
