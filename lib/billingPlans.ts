export type BillingPlanId = "BASIC" | "PRO" | "AGENT_CONTROL" | "CUSTOM";
export type CheckoutBillingPlanId = "BASIC" | "PRO";

export const BILLING_ENTITLEMENTS = [
  "STAFF_MANAGEMENT",
  "ADVANCED_ANALYTICS",
  "AI_ACCESS",
  "WHATSAPP_AUTOMATION",
] as const;

export type BillingEntitlement = typeof BILLING_ENTITLEMENTS[number];

export const BILLING_CAPABILITIES = [
  { id: "STUDENT_RECORDS_IMPORT", label: "Student records and spreadsheet import", standardOnly: false },
  { id: "SEATS_SHIFTS_ALLOCATIONS", label: "Seats, shifts and allocations", standardOnly: false },
  { id: "PAYMENTS_DUES_AUDIT", label: "Payments, dues and audit history", standardOnly: false },
  { id: "MULTIPLE_BRANCHES", label: "Multiple branches, each billed separately", standardOnly: false },
  { id: "STAFF_CONTROLS", label: "Staff invitations, roles and permission controls", standardOnly: true },
  { id: "ADVANCED_ANALYTICS", label: "Branch and cross-branch advanced analytics", standardOnly: true },
  { id: "AI_ASSISTANCE", label: "AI reports and message drafting", standardOnly: true },
] as const;

export type BillingCapabilityId = typeof BILLING_CAPABILITIES[number]["id"];

export type PublicBillingCapability = {
  id: BillingCapabilityId;
  label: string;
  included: boolean;
};

export type BillingPlanLimits = {
  maxBranches: number | null;
};

export type BillingPlan = {
  id: BillingPlanId;
  name: string;
  shortName: string;
  amount: number | null;
  currency: "INR";
  period: "monthly";
  interval: 1;
  active: boolean;
  visible: boolean;
  featured?: boolean;
  comingSoon?: boolean;
  custom?: boolean;
  description: string;
  features: string[];
  entitlements: BillingEntitlement[];
  limits: BillingPlanLimits;
};

export const BILLING_PLANS: BillingPlan[] = [
  {
    id: "BASIC",
    name: "Lab Lords Basic",
    shortName: "Basic",
    amount: 299,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: true,
    visible: true,
    description: "Core operations billed per active branch.",
    features: [
      "Student records and spreadsheet import",
      "Seats, shifts and allocations",
      "Payments, dues and audit history",
      "Multiple branches, each billed separately",
    ],
    entitlements: [],
    limits: { maxBranches: null },
  },
  {
    id: "PRO",
    name: "Lab Lords Standard",
    shortName: "Standard",
    amount: 499,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: true,
    visible: true,
    featured: true,
    description: "For growing teams that need staff controls, analytics, and AI assistance.",
    features: [
      "Student records and spreadsheet import",
      "Seats, shifts and allocations",
      "Payments, dues and audit history",
      "Multiple branches, each billed separately",
      "Staff invitations, roles and permission controls",
      "Branch and cross-branch advanced analytics",
      "AI reports and message drafting",
    ],
    entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS", "WHATSAPP_AUTOMATION"],
    limits: { maxBranches: null },
  },
  {
    id: "AGENT_CONTROL",
    name: "Agent Control",
    shortName: "Agent Control",
    amount: 999,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: false,
    visible: false,
    comingSoon: true,
    description: "AI agent control, deeper automations, and custom command surfaces.",
    features: [
      "Everything in Pro",
      "Agent control panel",
      "Custom automation policies",
      "Priority rollout access",
    ],
    entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS", "WHATSAPP_AUTOMATION"],
    limits: { maxBranches: null },
  },
  {
    id: "CUSTOM",
    name: "Custom",
    shortName: "Custom",
    amount: null,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: false,
    visible: false,
    custom: true,
    description: "For larger teams that need custom onboarding, controls, or contracts.",
    features: [
      "Custom limits and onboarding",
      "Dedicated success support",
      "Security and workflow reviews",
      "Tailored agent and reporting roadmap",
    ],
    entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS", "WHATSAPP_AUTOMATION"],
    limits: { maxBranches: null },
  },
];

export function getBillingPlan(planId: string): BillingPlan | null {
  return BILLING_PLANS.find(plan => plan.id === planId) ?? null;
}

export function isBillingPlanId(planId: string | null | undefined): planId is BillingPlanId {
  return typeof planId === "string" && BILLING_PLANS.some(plan => plan.id === planId);
}

export function isCheckoutBillingPlanId(
  planId: string | null | undefined
): planId is CheckoutBillingPlanId {
  const plan = typeof planId === "string" ? getBillingPlan(planId) : null;
  return Boolean(plan?.visible && plan.active && plan.amount != null);
}

export function getActiveBillingPlan(planId: string): BillingPlan {
  const plan = getBillingPlan(planId);
  if (!plan) throw new Error("Unknown subscription plan");
  if (!plan.visible || !plan.active || plan.amount == null) {
    throw new Error(`${plan.shortName} is not available for checkout yet`);
  }
  return plan;
}

export function publicBillingPlans() {
  return BILLING_PLANS.filter(
    (plan): plan is BillingPlan & { id: CheckoutBillingPlanId } => plan.visible
  ).map(plan => ({
    id: plan.id,
    name: plan.name,
    shortName: plan.shortName,
    amount: plan.amount,
    currency: plan.currency,
    period: plan.period,
    interval: plan.interval,
    active: plan.active,
    featured: Boolean(plan.featured),
    comingSoon: Boolean(plan.comingSoon),
    custom: Boolean(plan.custom),
    description: plan.description,
    capabilities: BILLING_CAPABILITIES.map(capability => ({
      id: capability.id,
      label: capability.label,
      included: !capability.standardOnly || plan.id === "PRO",
    } satisfies PublicBillingCapability)),
    // Internal rollout entitlements must not advertise unfinished capabilities.
    entitlements: plan.entitlements.filter(
      entitlement => entitlement !== "WHATSAPP_AUTOMATION"
    ),
    limits: plan.limits,
  }));
}
