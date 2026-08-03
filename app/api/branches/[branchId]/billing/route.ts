import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { StaffService } from "@/services/staff.service";
import { EntitlementService } from "@/services/entitlement.service";

export async function GET(_request: Request, context: { params: Promise<{ branchId: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { branchId } = await context.params;
    const access = await StaffService.getBranchAccess(user.id, branchId);
    const [branch, profile] = await Promise.all([
      prisma.branch.findUnique({ where: { id: branchId }, select: { billingStatus: true } }),
      EntitlementService.getOrganizationProfile(access.organizationId),
    ]);
    if (!branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 });
    return NextResponse.json({
      organizationId: access.organizationId,
      branchStatus: branch.billingStatus,
      inheritedPlan: profile.effectivePlan,
      subscriptionStatus: profile.subscriptionStatus,
      accessMode: profile.accessMode,
      billingUrl: `/org/${access.organizationId}/settings#billing`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load branch billing";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : 400 });
  }
}
