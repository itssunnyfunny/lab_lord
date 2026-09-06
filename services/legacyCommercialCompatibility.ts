import { getBillingPlan, type BillingPlanId } from "@/lib/billingPlans";
import { BillingValidationError } from "@/lib/billingErrors";
import type { BillingModelVersion, OrganizationSubscription } from "@/app/generated/prisma/client";
import type { OrganizationEntitlementProfile } from "@/services/entitlement.service";
import type { BillingState } from "@/lib/billingState";

/** Historical access/quantity/cancellation policy only. No creation, dispatch,
 * provider transport or authorization lives here. Owner: billing maintainers.
 * Retirement requires the inventory and approvals in the consolidation runbook. */
export function isHistoricalCommercialModel(version: BillingModelVersion) {
  return version === "LEGACY";
}

export function historicalEntitlementProfile(input: {
  organizationId: string; branches: number; trustedPaidThrough: Date | null;
  subscription: Pick<OrganizationSubscription,"plan"|"status"> | null;
}): OrganizationEntitlementProfile {
  const { subscription } = input;
  const selected = subscription ? getBillingPlan(subscription.plan) : null;
  const effective = input.trustedPaidThrough ? selected : getBillingPlan("BASIC");
  if (!effective) throw new Error("Subscription plan configuration is missing");
  return {
    organizationId: input.organizationId, plan: subscription?.plan as BillingPlanId | undefined ?? null,
    effectivePlan: effective.id, subscriptionStatus: subscription?.status ?? null,
    fallbackAccess: !subscription || effective.id !== selected?.id,
    entitlements: [...effective.entitlements], limits: {...effective.limits},
    usage: {branches:input.branches}, accessMode:"FULL", canWrite:true,
    accessReason: !subscription ? "Legacy Basic fallback access" : historicalBillingState(subscription.plan, input.trustedPaidThrough).reason,
    trial:null,
  };
}

export function historicalBillingState(plan: BillingPlanId | null, trustedPaidThrough: Date | null): BillingState {
  return { accessMode:"FULL", canWrite:true, effectivePlan: trustedPaidThrough ? plan ?? "BASIC" : "BASIC",
    source: trustedPaidThrough ? "PAID" : "NONE", reason: trustedPaidThrough
      ? "Provider-confirmed legacy paid period is active"
      : "Legacy Basic fallback; paid settlement evidence is unavailable" };
}

export function historicalCancellationPolicy(subscription: Pick<OrganizationSubscription,"id"|"status"|"cancelAtCycleEnd"|"currentEnd">, key?: string) {
  if (!subscription.cancelAtCycleEnd && subscription.status !== "ACTIVE") {
    throw new BillingValidationError("Only an active subscription can be cancelled at the end of its billing cycle");
  }
  return { key:key ?? `legacy-cancellation:${subscription.id}`, effectiveAt:subscription.currentEnd,
    alreadyScheduled:subscription.cancelAtCycleEnd };
}
