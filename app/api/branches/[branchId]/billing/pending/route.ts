import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { BranchService } from "@/services/branch.service";
import { billingHttpStatus } from "@/lib/billingHttp";
import { BillingService } from "@/services/billing.service";

type Context = { params: Promise<{ branchId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const result = await BranchService.retryPendingActivation(user.id, branchId);
    const operation = result.action === "CHECKOUT_REQUIRED"
      ? await BillingService.retryBillingOperation(
          user.id,
          result.change.organizationId,
          result.change.id
        )
      : null;
    const checkout = operation && "checkout" in operation ? operation.checkout : undefined;
    return NextResponse.json({ ...result, ...(checkout ? { checkout } : {}) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to retry branch activation";
    return NextResponse.json(
      { error: message },
      { status: billingHttpStatus(error) }
    );
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    return NextResponse.json(await BranchService.discardPendingActivation(user.id, branchId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to discard pending branch";
    return NextResponse.json({ error: message }, { status: billingHttpStatus(error) });
  }
}
