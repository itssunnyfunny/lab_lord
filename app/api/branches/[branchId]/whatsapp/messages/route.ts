import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { decodeDateIdCursor, PaginationInputError, parsePageLimit } from "@/lib/cursorPagination";
import { whatsAppErrorResponse } from "@/lib/whatsappHttp";
import { whatsAppRateLimitResponse } from "@/lib/whatsappRoute";
import { WhatsAppMessageService } from "@/services/whatsappMessage.service";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ branchId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const limited = whatsAppRateLimitResponse(request, "messages:history", `${user.id}:${branchId}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (limited) return limited;
    return NextResponse.json(await WhatsAppMessageService.history({
      actorUserId: user.id,
      branchId,
      cursor: decodeDateIdCursor(request.nextUrl.searchParams.get("cursor")),
      limit: parsePageLimit(request.nextUrl.searchParams.get("limit")),
    }));
  } catch (error) {
    if (error instanceof PaginationInputError) {
      return NextResponse.json({ error: "Invalid pagination request" }, { status: 400 });
    }
    return whatsAppErrorResponse(error);
  }
}
