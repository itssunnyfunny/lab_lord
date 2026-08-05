import { describe, expect, it } from "vitest";
import {
  getActiveBillingPlan,
  getBillingPlan,
  isCheckoutBillingPlanId,
  publicBillingPlans,
} from "@/lib/billingPlans";

describe("billing plan catalog", () => {
  it("publishes only Basic and Standard at the approved prices", () => {
    expect(publicBillingPlans().map(plan => ({
      id: plan.id,
      shortName: plan.shortName,
      amount: plan.amount,
    }))).toEqual([
      { id: "BASIC", shortName: "Basic", amount: 299 },
      { id: "PRO", shortName: "Standard", amount: 499 },
    ]);
  });

  it("keeps legacy plans readable but unavailable for checkout", () => {
    expect(getBillingPlan("AGENT_CONTROL")?.visible).toBe(false);
    expect(getBillingPlan("CUSTOM")?.visible).toBe(false);
    expect(isCheckoutBillingPlanId("AGENT_CONTROL")).toBe(false);
    expect(() => getActiveBillingPlan("AGENT_CONTROL")).toThrow("not available");
  });

  it("assigns AI only to Standard among public plans", () => {
    expect(getActiveBillingPlan("BASIC").entitlements).not.toContain("AI_ACCESS");
    expect(getActiveBillingPlan("PRO").entitlements).toContain("AI_ACCESS");
  });
});
