import type { BillingEntitlement } from "@/lib/billingPlans";
import type { StaffAction } from "@/types";

export type BillingFeatureKey =
  | "ORG_ANALYTICS"
  | "BRANCH_ANALYTICS"
  | "STAFF_CONTROLS"
  | "AI_REPORTS"
  | "AI_MESSAGES";

export type FeaturePolicy = {
  label: string;
  benefit: string;
  entitlement: BillingEntitlement;
  permission?: StaffAction;
};

export const BILLING_FEATURE_POLICIES: Record<BillingFeatureKey, FeaturePolicy> = {
  ORG_ANALYTICS: {
    label: "Global Analytics",
    benefit: "Compare performance, collections and capacity across every branch.",
    entitlement: "ADVANCED_ANALYTICS",
  },
  BRANCH_ANALYTICS: {
    label: "Analytics",
    benefit: "Track collection, utilization and student trends for this branch.",
    entitlement: "ADVANCED_ANALYTICS",
    permission: "analytics",
  },
  STAFF_CONTROLS: {
    label: "Staff",
    benefit: "Invite managers and control staff permissions across your workspace.",
    entitlement: "STAFF_MANAGEMENT",
    permission: "manage_branch",
  },
  AI_REPORTS: {
    label: "AI Reports",
    benefit: "Generate concise management reports from live branch data.",
    entitlement: "AI_ACCESS",
    permission: "analytics",
  },
  AI_MESSAGES: {
    label: "AI Messages",
    benefit: "Draft contextual payment and follow-up messages faster.",
    entitlement: "AI_ACCESS",
    permission: "analytics",
  },
};

export function hasFeatureEntitlement(
  entitlements: readonly BillingEntitlement[],
  feature: BillingFeatureKey
) {
  return entitlements.includes(BILLING_FEATURE_POLICIES[feature].entitlement);
}
