export type BillingPlanId = "BASIC" | "PRO" | "AGENT_CONTROL" | "CUSTOM";

export type BillingPlan = {
  id: BillingPlanId;
  name: string;
  shortName: string;
  amount: number | null;
  currency: "INR";
  period: "monthly";
  interval: 1;
  active: boolean;
  featured?: boolean;
  comingSoon?: boolean;
  custom?: boolean;
  description: string;
  features: string[];
};

export const BILLING_PLANS: BillingPlan[] = [
  {
    id: "BASIC",
    name: "Lab Lords Basic",
    shortName: "Basic",
    amount: 399,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: true,
    description: "For one focused workspace getting the lab operations online.",
    features: [
      "Core branch and seat management",
      "Student profiles and due tracking",
      "Payment ledger and audit history",
      "Owner workspace settings",
    ],
  },
  {
    id: "PRO",
    name: "Lab Lords Pro",
    shortName: "Pro",
    amount: 599,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: true,
    featured: true,
    description: "For growing labs that need stronger operations and staff controls.",
    features: [
      "Everything in Basic",
      "Multi-branch operating view",
      "Staff roles and permission controls",
      "Advanced analytics and follow-up workflows",
    ],
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
    comingSoon: true,
    description: "AI agent control, deeper automations, and custom command surfaces.",
    features: [
      "Everything in Pro",
      "Agent control panel",
      "Custom automation policies",
      "Priority rollout access",
    ],
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
    custom: true,
    description: "For larger teams that need custom onboarding, controls, or contracts.",
    features: [
      "Custom limits and onboarding",
      "Dedicated success support",
      "Security and workflow reviews",
      "Tailored agent and reporting roadmap",
    ],
  },
];

export function getBillingPlan(planId: string): BillingPlan | null {
  return BILLING_PLANS.find(plan => plan.id === planId) ?? null;
}

export function getActiveBillingPlan(planId: string): BillingPlan {
  const plan = getBillingPlan(planId);
  if (!plan) throw new Error("Unknown subscription plan");
  if (!plan.active || plan.amount == null) throw new Error(`${plan.shortName} is not available for checkout yet`);
  return plan;
}

export function publicBillingPlans() {
  return BILLING_PLANS.map(plan => ({
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
    features: plan.features,
  }));
}
