import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { LAST_ACTIVE_BRANCH_COOKIE, resolveWorkspacePath } from "@/lib/workspaceRouting";
import { UserService } from "@/services/user.service";
import { BillingExperienceService } from "@/services/billingExperience.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Open workspace",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function SmartAppRouterPage() {
  const user = await getSessionUser();
  if (!user) {
    redirect("/sign-in?redirect_url=%2Fapp");
  }

  const cookieStore = await cookies();
  const routingState = await UserService.getWorkspaceRoutingState(user.id);
  if (routingState.ownedOrganizations.length === 1) {
    const organizationId = routingState.ownedOrganizations[0].id;
    const billingExperience = await BillingExperienceService.getBillingExperience(organizationId, user.id);
    if (billingExperience.accessMode === "READ_ONLY") {
      redirect(`/org/${encodeURIComponent(organizationId)}/settings#billing`);
    }
  }
  const destination = resolveWorkspacePath({
    ...routingState,
    lastBranchId: cookieStore.get(LAST_ACTIVE_BRANCH_COOKIE)?.value,
  });

  redirect(destination);
}
