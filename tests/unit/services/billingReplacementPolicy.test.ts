import { describe, expect, it } from "vitest";

import {
  REPLACEMENT_CHARGE_GRACE_DAYS,
  REPLACEMENT_CHARGE_GRACE_MS,
  REPLACEMENT_SAFE_CYCLE_LEAD_DAYS,
  REPLACEMENT_SAFE_CYCLE_LEAD_MS,
  REPLACEMENT_UNDO_CUTOFF_HOURS,
  REPLACEMENT_UNDO_CUTOFF_MS,
  addCalendarMonthsUtc,
  getReplacementChargeGraceEndsAt,
  getReplacementUndoCutoffAt,
  getSafeReplacementCycleBoundary,
  isReplacementAuthorizationReady,
  isReplacementMutationEligible,
  isReplacementPromotionReady,
  isSupportedRecurringPaymentMethod,
  normalizeReplacementPaymentMethod,
  replacementTargetMatches,
} from "@/services/billingReplacementPolicy";

describe("billing replacement policy", () => {
  it("publishes the agreed lead, cutoff, and charge-grace durations", () => {
    expect(REPLACEMENT_SAFE_CYCLE_LEAD_DAYS).toBe(7);
    expect(REPLACEMENT_SAFE_CYCLE_LEAD_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(REPLACEMENT_UNDO_CUTOFF_HOURS).toBe(72);
    expect(REPLACEMENT_UNDO_CUTOFF_MS).toBe(72 * 60 * 60 * 1000);
    expect(REPLACEMENT_CHARGE_GRACE_DAYS).toBe(3);
    expect(REPLACEMENT_CHARGE_GRACE_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("keeps the current boundary when it has exactly seven days of lead time", () => {
    const currentCycleEnd = new Date("2026-09-08T10:30:00.000Z");
    const boundary = getSafeReplacementCycleBoundary({
      now: new Date("2026-09-01T10:30:00.000Z"),
      currentCycleEnd,
      intervalMonths: 1,
    });

    expect(boundary).toEqual(currentCycleEnd);
    expect(boundary).not.toBe(currentCycleEnd);
  });

  it("advances to the next calendar boundary when the current one is too close", () => {
    expect(getSafeReplacementCycleBoundary({
      now: new Date("2026-08-27T00:00:00.000Z"),
      currentCycleEnd: new Date("2026-08-31T00:00:00.000Z"),
      intervalMonths: 1,
    })).toEqual(new Date("2026-09-30T00:00:00.000Z"));
  });

  it("preserves the original month-end anchor across multiple advances", () => {
    const anchor = new Date("2026-01-31T18:45:12.345Z");

    expect(addCalendarMonthsUtc(anchor, 1)).toEqual(new Date("2026-02-28T18:45:12.345Z"));
    expect(addCalendarMonthsUtc(anchor, 2)).toEqual(new Date("2026-03-31T18:45:12.345Z"));
    expect(getSafeReplacementCycleBoundary({
      now: new Date("2026-03-01T00:00:00.000Z"),
      currentCycleEnd: anchor,
      intervalMonths: 1,
    })).toEqual(new Date("2026-03-31T18:45:12.345Z"));
  });

  it("honors multi-month billing intervals", () => {
    expect(getSafeReplacementCycleBoundary({
      now: new Date("2026-02-01T00:00:00.000Z"),
      currentCycleEnd: new Date("2026-01-31T00:00:00.000Z"),
      intervalMonths: 3,
    })).toEqual(new Date("2026-04-30T00:00:00.000Z"));
  });

  it("derives the undo cutoff and delayed-charge grace from the safe boundary", () => {
    const boundary = new Date("2026-10-31T12:00:00.000Z");

    expect(getReplacementUndoCutoffAt(boundary)).toEqual(new Date("2026-10-28T12:00:00.000Z"));
    expect(getReplacementChargeGraceEndsAt(boundary)).toEqual(new Date("2026-11-03T12:00:00.000Z"));
  });

  it("rejects invalid dates and billing intervals", () => {
    expect(() => addCalendarMonthsUtc(new Date("invalid"), 1)).toThrow("anchor must be a valid Date");
    expect(() => addCalendarMonthsUtc(new Date(), 1.5)).toThrow("months must be an integer");
    expect(() => getSafeReplacementCycleBoundary({
      now: new Date("2026-08-01T00:00:00.000Z"),
      currentCycleEnd: new Date("2026-08-31T00:00:00.000Z"),
      intervalMonths: 0,
    })).toThrow("intervalMonths must be a positive integer");
  });

  it("normalizes all supported recurring methods, including the netbanking eMandate alias", () => {
    expect(normalizeReplacementPaymentMethod(" card ")).toBe("CARD");
    expect(normalizeReplacementPaymentMethod("upi")).toBe("UPI");
    expect(normalizeReplacementPaymentMethod("emandate")).toBe("EMANDATE");
    expect(normalizeReplacementPaymentMethod("netbanking")).toBe("EMANDATE");
    expect(normalizeReplacementPaymentMethod("wallet")).toBeNull();
    expect(isSupportedRecurringPaymentMethod("CARD")).toBe(true);
    expect(isSupportedRecurringPaymentMethod("unknown")).toBe(false);
  });

  it("requires replacement only for supported UPI/eMandate plan and quantity mutations", () => {
    for (const mutationType of [
      "TRIAL_SUBSCRIPTION_UPDATE",
      "PLAN_UPGRADE",
      "PLAN_DOWNGRADE",
      "QUANTITY_INCREASE",
      "BRANCH_REMOVAL",
      "BRANCH_REACTIVATION",
    ]) {
      expect(isReplacementMutationEligible({ sourcePaymentMethod: "UPI", mutationType })).toBe(true);
      expect(isReplacementMutationEligible({ sourcePaymentMethod: "emandate", mutationType })).toBe(true);
      expect(isReplacementMutationEligible({ sourcePaymentMethod: "CARD", mutationType })).toBe(false);
    }

    expect(isReplacementMutationEligible({
      sourcePaymentMethod: "UPI",
      mutationType: "CANCELLATION",
    })).toBe(false);
    expect(isReplacementMutationEligible({
      sourcePaymentMethod: "UNKNOWN",
      mutationType: "PLAN_UPGRADE",
    })).toBe(false);
  });

  it("uses a replacement for proactive method switching from any supported mandate", () => {
    expect(isReplacementMutationEligible({
      sourcePaymentMethod: "CARD",
      mutationType: "PAYMENT_METHOD_REPLACEMENT",
    })).toBe(true);
    expect(isReplacementMutationEligible({
      sourcePaymentMethod: "UPI",
      mutationType: "PAYMENT_METHOD_REPLACEMENT",
    })).toBe(true);
    expect(isReplacementMutationEligible({
      sourcePaymentMethod: "UNKNOWN",
      mutationType: "PAYMENT_METHOD_REPLACEMENT",
    })).toBe(false);
  });

  it("matches provider plan and quantity exactly", () => {
    expect(replacementTargetMatches({
      providerPlanId: "plan_standard",
      providerQuantity: 3,
      targetPlanId: "plan_standard",
      targetQuantity: 3,
    })).toBe(true);
    expect(replacementTargetMatches({
      providerPlanId: "plan_basic",
      providerQuantity: 3,
      targetPlanId: "plan_standard",
      targetQuantity: 3,
    })).toBe(false);
    expect(replacementTargetMatches({
      providerPlanId: "plan_standard",
      providerQuantity: 2,
      targetPlanId: "plan_standard",
      targetQuantity: 3,
    })).toBe(false);
    expect(replacementTargetMatches({
      providerPlanId: "",
      providerQuantity: 3,
      targetPlanId: "",
      targetQuantity: 3,
    })).toBe(false);
  });

  it("treats exact authenticated or active candidates as authorization-ready", () => {
    const target = {
      providerPlanId: "plan_standard",
      providerQuantity: 2,
      targetPlanId: "plan_standard",
      targetQuantity: 2,
    };

    expect(isReplacementAuthorizationReady({
      ...target,
      providerStatus: "authenticated",
      paymentMethod: "upi",
    })).toBe(true);
    // A customer may select card while reauthorizing a non-card source.
    expect(isReplacementAuthorizationReady({
      ...target,
      providerStatus: "ACTIVE",
      paymentMethod: "CARD",
    })).toBe(true);
    expect(isReplacementAuthorizationReady({
      ...target,
      providerStatus: "PAUSED",
      paymentMethod: "UPI",
    })).toBe(false);
    expect(isReplacementAuthorizationReady({
      ...target,
      providerQuantity: 1,
      providerStatus: "ACTIVE",
      paymentMethod: "EMANDATE",
    })).toBe(false);
    expect(isReplacementAuthorizationReady({
      ...target,
      providerStatus: "ACTIVE",
      paymentMethod: "wallet",
    })).toBe(false);
  });

  it("promotes only an exact active, paid candidate after the source has ended", () => {
    const ready = {
      providerPlanId: "plan_standard",
      providerQuantity: 2,
      targetPlanId: "plan_standard",
      targetQuantity: 2,
      providerStatus: "ACTIVE",
      paymentMethod: "EMANDATE",
      sourceStatus: "CANCELLED",
      confirmedPaidPeriod: true,
    };

    expect(isReplacementPromotionReady(ready)).toBe(true);
    expect(isReplacementPromotionReady({ ...ready, sourceStatus: "EXPIRED" })).toBe(true);
    expect(isReplacementPromotionReady({ ...ready, providerStatus: "AUTHENTICATED" })).toBe(false);
    expect(isReplacementPromotionReady({ ...ready, sourceStatus: "ACTIVE" })).toBe(false);
    expect(isReplacementPromotionReady({ ...ready, confirmedPaidPeriod: false })).toBe(false);
    expect(isReplacementPromotionReady({ ...ready, providerQuantity: 1 })).toBe(false);
  });
});
