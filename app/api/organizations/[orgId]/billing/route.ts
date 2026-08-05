import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BillingService } from "@/services/billing.service";

function errorStatus(message: string) {
  if (message.includes("not found")) return 404;
  if (message.includes("Unauthorized")) return 403;
  return 500;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { orgId } = await context.params;
    const result = await BillingService.listPlansForOrganization(user.id, orgId);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
