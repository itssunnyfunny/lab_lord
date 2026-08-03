import type { CheckoutBillingPlanId } from "@/lib/billingPlans";

export function getBillingOnboardingPath(planId: CheckoutBillingPlanId) {
  return `/onboarding?billingPlan=${planId}`;
}

export function getBillingSignUpPath(planId: CheckoutBillingPlanId) {
  return `/sign-up?redirect_url=${encodeURIComponent(getBillingOnboardingPath(planId))}`;
}

export function getOrganizationBillingPath(
  organizationId: string,
  planId: CheckoutBillingPlanId
) {
  return `/org/${encodeURIComponent(organizationId)}/settings?billingPlan=${planId}#billing`;
}

