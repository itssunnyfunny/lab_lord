import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BranchService } from "@/services/branch.service";
import { BillingChangeInProgressError } from "@/lib/billingErrors";
import { billingHttpStatus } from "@/lib/billingHttp";
import { BillingService } from "@/services/billing.service";

type Context = { params: Promise<{ branchId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Idempotency-Key is required" }, { status: 400 });
    }
    const result = await BranchService.reactivateArchivedBranch(user.id, branchId, idempotencyKey);
    const checkout = result.action === "CHECKOUT_REQUIRED"
      ? (await BillingService.getBillingOperation(
          user.id,
          result.change.organizationId,
          result.change.id
        )).checkout
      : undefined;
    return NextResponse.json({ ...result, ...(checkout ? { checkout } : {}) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reactivate branch";
    return NextResponse.json(
      error instanceof BillingChangeInProgressError
        ? { error: message, code: error.code, existingChangeId: error.existingChangeId }
        : { error: message },
      { status: billingHttpStatus(error) }
    );
  }
}
