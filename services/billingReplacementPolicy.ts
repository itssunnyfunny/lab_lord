const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const REPLACEMENT_SAFE_CYCLE_LEAD_DAYS = 7;
export const REPLACEMENT_SAFE_CYCLE_LEAD_MS = REPLACEMENT_SAFE_CYCLE_LEAD_DAYS * DAY_MS;
export const REPLACEMENT_UNDO_CUTOFF_HOURS = 72;
export const REPLACEMENT_UNDO_CUTOFF_MS = REPLACEMENT_UNDO_CUTOFF_HOURS * HOUR_MS;
export const REPLACEMENT_CHARGE_GRACE_DAYS = 3;
export const REPLACEMENT_CHARGE_GRACE_MS = REPLACEMENT_CHARGE_GRACE_DAYS * DAY_MS;

export const REPLACEMENT_MUTATION_TYPES = [
  "PAYMENT_METHOD_REPLACEMENT",
  "TRIAL_SUBSCRIPTION_UPDATE",
  "PLAN_UPGRADE",
  "PLAN_DOWNGRADE",
  "QUANTITY_INCREASE",
  "BRANCH_REMOVAL",
  "BRANCH_REACTIVATION",
] as const;

export type ReplacementMutationType = typeof REPLACEMENT_MUTATION_TYPES[number];
export type ReplacementPaymentMethod = "CARD" | "UPI" | "EMANDATE";

export type ReplacementEligibilityInput = {
  sourcePaymentMethod: string | null | undefined;
  mutationType: string;
};

export type ReplacementTargetInput = {
  providerPlanId: string | null | undefined;
  providerQuantity: number | null | undefined;
  targetPlanId: string;
  targetQuantity: number;
};

export type ReplacementAuthorizationReadinessInput = ReplacementTargetInput & {
  providerStatus: string | null | undefined;
  paymentMethod: string | null | undefined;
};

export type ReplacementPromotionReadinessInput = ReplacementAuthorizationReadinessInput & {
  sourceStatus: string | null | undefined;
  confirmedPaidPeriod: boolean;
};

function assertValidDate(value: Date, name: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
}

/**
 * Adds calendar months in UTC while preserving the original day-of-month when
 * possible. A month-end anchor is clamped to the destination month's end.
 */
export function addCalendarMonthsUtc(anchor: Date, months: number) {
  assertValidDate(anchor, "anchor");
  if (!Number.isInteger(months)) {
    throw new RangeError("months must be an integer");
  }

  const result = new Date(anchor.getTime());
  const anchorDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const destinationMonthEnd = new Date(result.getTime());
  destinationMonthEnd.setUTCMonth(destinationMonthEnd.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(anchorDay, destinationMonthEnd.getUTCDate()));
  return result;
}

/** Returns the first billing boundary with at least the configured lead time. */
export function getSafeReplacementCycleBoundary(input: {
  now: Date;
  currentCycleEnd: Date;
  intervalMonths: number;
}) {
  assertValidDate(input.now, "now");
  assertValidDate(input.currentCycleEnd, "currentCycleEnd");
  if (!Number.isInteger(input.intervalMonths) || input.intervalMonths < 1) {
    throw new RangeError("intervalMonths must be a positive integer");
  }

  const earliestSafeStart = input.now.getTime() + REPLACEMENT_SAFE_CYCLE_LEAD_MS;
  let elapsedMonths = 0;
  let boundary = new Date(input.currentCycleEnd.getTime());

  while (boundary.getTime() < earliestSafeStart) {
    elapsedMonths += input.intervalMonths;
    // Always advance from the original boundary so a clamped February date
    // does not make a January 31 billing anchor drift to the 28th forever.
    boundary = addCalendarMonthsUtc(input.currentCycleEnd, elapsedMonths);
  }

  return boundary;
}

export function getReplacementUndoCutoffAt(safeCycleBoundary: Date) {
  assertValidDate(safeCycleBoundary, "safeCycleBoundary");
  return new Date(safeCycleBoundary.getTime() - REPLACEMENT_UNDO_CUTOFF_MS);
}

export function getReplacementChargeGraceEndsAt(safeCycleBoundary: Date) {
  assertValidDate(safeCycleBoundary, "safeCycleBoundary");
  return new Date(safeCycleBoundary.getTime() + REPLACEMENT_CHARGE_GRACE_MS);
}

export function normalizeReplacementPaymentMethod(
  value: string | null | undefined
): ReplacementPaymentMethod | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "CARD") return "CARD";
  if (normalized === "UPI") return "UPI";
  if (normalized === "EMANDATE" || normalized === "NETBANKING") return "EMANDATE";
  return null;
}

export function isSupportedRecurringPaymentMethod(value: string | null | undefined) {
  return normalizeReplacementPaymentMethod(value) != null;
}

/**
 * Card subscriptions use Razorpay's native update API. UPI AutoPay and
 * eMandate subscriptions require a newly authorized replacement subscription.
 */
export function isReplacementMutationEligible(input: ReplacementEligibilityInput) {
  const sourceMethod = normalizeReplacementPaymentMethod(input.sourcePaymentMethod);
  if (!REPLACEMENT_MUTATION_TYPES.includes(input.mutationType as ReplacementMutationType)) {
    return false;
  }
  if (input.mutationType === "PAYMENT_METHOD_REPLACEMENT") {
    return sourceMethod != null;
  }
  return sourceMethod === "UPI" || sourceMethod === "EMANDATE";
}

export function replacementTargetMatches(input: ReplacementTargetInput) {
  return typeof input.providerPlanId === "string"
    && input.providerPlanId.length > 0
    && input.targetPlanId.length > 0
    && input.providerPlanId === input.targetPlanId
    && Number.isInteger(input.providerQuantity)
    && input.providerQuantity === input.targetQuantity
    && Number.isInteger(input.targetQuantity)
    && input.targetQuantity > 0;
}

/**
 * An API-fetched candidate may grant replacement access only after Razorpay
 * confirms authorization and the provider target exactly matches local intent.
 */
export function isReplacementAuthorizationReady(input: ReplacementAuthorizationReadinessInput) {
  const status = input.providerStatus?.trim().toUpperCase();
  return (status === "AUTHENTICATED" || status === "ACTIVE")
    && isSupportedRecurringPaymentMethod(input.paymentMethod)
    && replacementTargetMatches(input);
}

/**
 * Promotion additionally requires an active candidate, an ended source, and
 * proof of a paid provider period. Authorization alone is deliberately not
 * enough to replace the canonical subscription.
 */
export function isReplacementPromotionReady(input: ReplacementPromotionReadinessInput) {
  const providerStatus = input.providerStatus?.trim().toUpperCase();
  const sourceStatus = input.sourceStatus?.trim().toUpperCase();
  return providerStatus === "ACTIVE"
    && (sourceStatus === "CANCELLED" || sourceStatus === "COMPLETED" || sourceStatus === "EXPIRED")
    && input.confirmedPaidPeriod
    && isSupportedRecurringPaymentMethod(input.paymentMethod)
    && replacementTargetMatches(input);
}
