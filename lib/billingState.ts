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
  authorizedReplacement?: {
    plan: BillingPlanId;
    accessGrantedAt: Date | null;
    accessRevokedAt: Date | null;
    graceEndsAt: Date | null;
  } | null;
};

function applyAuthorizedReplacement(
  state: BillingState,
  replacement: BillingStateInput["authorizedReplacement"],
  now: Date
): BillingState {
  if (!replacement?.accessGrantedAt
    || replacement.accessGrantedAt > now
    || replacement.accessRevokedAt) return state;
  if (state.accessMode === "FULL" || state.accessMode === "WARNING") {
    return {
      ...state,
      effectivePlan: replacement.plan,
      reason: "A replacement mandate is authorized for the next billing cycle",
    };
  }
  if (replacement.graceEndsAt && replacement.graceEndsAt > now) {
    return {
      accessMode: "WARNING",
      canWrite: true,
      effectivePlan: replacement.plan,
      source: "PAYMENT_RETRY",
      reason: "The replacement mandate charge is awaiting bank confirmation",
    };
  }
  return state;
}

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
    return applyAuthorizedReplacement({
      accessMode: "FULL",
      canWrite: true,
      effectivePlan: "PRO",
      source: "TRIAL",
      reason: "Standard trial is active",
    }, input.authorizedReplacement, input.now);
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

  const paidPeriodActive = subscription.paidThrough != null
    && subscription.paidThrough > input.now;

  if ((subscription.status === "PENDING" || subscription.status === "PAUSED")
    && paidPeriodActive) {
    return applyAuthorizedReplacement({
      accessMode: "WARNING",
      canWrite: true,
      effectivePlan: subscription.plan,
      source: "PAYMENT_RETRY",
      reason: subscription.status === "PAUSED"
        ? "The recurring mandate is paused"
        : "Payment is being retried",
    }, input.authorizedReplacement, input.now);
  }

  if (paidPeriodActive) {
    return applyAuthorizedReplacement({
      accessMode: "FULL",
      canWrite: true,
      effectivePlan: subscription.plan,
      source: "PAID",
      reason: "Provider-confirmed paid period is active",
    }, input.authorizedReplacement, input.now);
  }

  const reason = subscription.status === "HALTED"
    ? "Payment retries are exhausted"
    : subscription.status === "ACTIVE"
      ? "Payment confirmation is still required"
      : "The paid access period has ended";

  return applyAuthorizedReplacement({
    accessMode: "READ_ONLY",
    canWrite: false,
    effectivePlan: subscription.plan,
    source: "NONE",
    reason,
  }, input.authorizedReplacement, input.now);
}
