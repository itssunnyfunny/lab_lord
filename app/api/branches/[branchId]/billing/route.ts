import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { StaffService } from "@/services/staff.service";
import { BillingExperienceService } from "@/services/billingExperience.service";

export async function GET(_request: Request, context: { params: Promise<{ branchId: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const access = await StaffService.getBranchAccess(user.id, branchId);
    const experience = await BillingExperienceService.getForBranch(branchId, user.id);
    if (!experience.branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 });
    return NextResponse.json({
      organizationId: access.organizationId,
      branchStatus: experience.branch.billingStatus,
      inheritedPlan: experience.effectivePlan === "STANDARD_TRIAL" ? "Standard trial" : experience.effectivePlan === "STANDARD" ? "Standard" : experience.effectivePlan === "BASIC" ? "Basic" : "No active plan",
      billingState: experience.customerMessage,
      accessMode: experience.accessMode,
      billingUrl: `/org/${access.organizationId}/settings#billing`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load branch billing";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : 400 });
  }
}
