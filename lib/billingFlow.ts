import type { CheckoutBillingPlanId } from "@/lib/billingPlans";

export function getBillingOnboardingPath(planId: CheckoutBillingPlanId) {
  return `/onboarding?billingPlan=${planId}`;
}

export function getBillingSignUpPath(planId: CheckoutBillingPlanId) {
  return `/sign-up?redirect_url=${encodeURIComponent(getBillingOnboardingPath(planId))}`;
}

export function getOrganizationBillingPath(
  organizationId: string,
  planId: CheckoutBillingPlanId,
  returnPath?: string
) {
  const query = new URLSearchParams({ billingPlan: planId });
  if (returnPath?.startsWith("/") && !returnPath.startsWith("//")) query.set("returnTo", returnPath);
  return `/org/${encodeURIComponent(organizationId)}/settings?${query.toString()}#billing`;
}
