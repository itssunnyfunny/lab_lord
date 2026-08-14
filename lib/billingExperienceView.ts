import type {
  BillingExperience,
  BillingExperienceView,
  BranchBillingExperience,
} from "@/types/billingExperience";

export function isFullBillingExperience(
  experience: BillingExperienceView
): experience is BillingExperience {
  return "providerStatus" in experience;
}

export function toBranchAccessBillingExperience(
  experience: BillingExperience,
  isOwner: boolean
): BillingExperienceView {
  if (isOwner) return experience;

  const projected: BranchBillingExperience = {
    organizationId: experience.organizationId,
    accessMode: experience.accessMode,
    effectivePlan: experience.effectivePlan,
    customerState: experience.customerState,
    customerMessage: experience.customerMessage,
    trialEndsAt: experience.trialEndsAt,
    entitlements: [...experience.entitlements],
    hasActiveOperation: experience.activeOperation != null,
    branch: experience.branch
      ? { id: experience.branch.id, billingStatus: experience.branch.billingStatus }
      : null,
    viewer: { isOwner: false, canManageBilling: false },
  };
  return projected;
}

export function toClientBillingExperience(
  experience: BillingExperienceView
): BillingExperience {
  if (isFullBillingExperience(experience)) return experience;

  return {
    ...experience,
    selectedPostTrialPlan: null,
    providerStatus: null,
    trialDaysRemaining: null,
    paidThrough: null,
    confirmedQuantity: 0,
    projectedQuantity: 0,
    currentUnitAmount: 0,
    currentMonthlyTotal: 0,
    projectedUnitAmount: 0,
    projectedMonthlyTotal: 0,
    authorizationStatus: "NOT_AUTHORIZED",
    planFeeDueToday: 0,
    nextChargeAt: null,
    paymentAction: "NONE",
    latestOperation: null,
    activeOperation: null,
    scheduledChanges: [],
    branch: experience.branch ? { ...experience.branch, name: "" } : null,
  };
}
