import type { BillingPlanId } from "@/lib/billingPlans";

export type BillingAccessMode = "FULL" | "WARNING" | "READ_ONLY";

export type BillingStateInput = {
  now: Date;
  trial?: {
    status: "AVAILABLE" | "ACTIVE" | "EXPIRED" | "REVOKED";
    endsAt: Date | null;
  } | null;
  subscription?: {
    status: string;
    plan: BillingPlanId;
    paidThrough: Date | null;
  } | null;
};

export type BillingState = {
  accessMode: BillingAccessMode;
  canWrite: boolean;
  effectivePlan: BillingPlanId | null;
  source: "TRIAL" | "PAID" | "PAYMENT_RETRY" | "NONE";
  reason: string;
};

export function deriveWorkspaceBillingState(input: BillingStateInput): BillingState {
  const activeTrial = input.trial?.status === "ACTIVE"
    && input.trial.endsAt != null
    && input.trial.endsAt > input.now;

  if (activeTrial) {
    return {
      accessMode: "FULL",
      canWrite: true,
      effectivePlan: "PRO",
      source: "TRIAL",
      reason: "Standard trial is active",
    };
  }

  const subscription = input.subscription;
  if (!subscription) {
    return {
      accessMode: "READ_ONLY",
      canWrite: false,
      effectivePlan: null,
      source: "NONE",
      reason: "A paid subscription is required",
    };
  }

  if (subscription.status === "PENDING") {
    return {
      accessMode: "WARNING",
      canWrite: true,
      effectivePlan: subscription.plan,
      source: "PAYMENT_RETRY",
      reason: "Payment is being retried",
    };
  }

  const paidPeriodActive = subscription.paidThrough != null
    && subscription.paidThrough > input.now;
  if (paidPeriodActive) {
    return {
      accessMode: "FULL",
      canWrite: true,
      effectivePlan: subscription.plan,
      source: "PAID",
      reason: "Provider-confirmed paid period is active",
    };
  }

  const reason = subscription.status === "HALTED"
    ? "Payment retries are exhausted"
    : subscription.status === "ACTIVE"
      ? "Payment confirmation is still required"
      : "The paid access period has ended";

  return {
    accessMode: "READ_ONLY",
    canWrite: false,
    effectivePlan: subscription.plan,
    source: "NONE",
    reason,
  };
}
