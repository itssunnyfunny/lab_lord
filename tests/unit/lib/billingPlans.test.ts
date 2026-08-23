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

  it("gates WhatsApp internally without advertising unfinished delivery", () => {
    expect(getActiveBillingPlan("BASIC").entitlements).not.toContain("WHATSAPP_AUTOMATION");
    expect(getActiveBillingPlan("PRO").entitlements).toContain("WHATSAPP_AUTOMATION");
    expect(getBillingPlan("AGENT_CONTROL")?.entitlements).toContain("WHATSAPP_AUTOMATION");
    expect(getBillingPlan("CUSTOM")?.entitlements).toContain("WHATSAPP_AUTOMATION");
    expect(JSON.stringify(publicBillingPlans())).not.toContain("WHATSAPP_AUTOMATION");
    expect(JSON.stringify(publicBillingPlans())).not.toContain("WhatsApp");
  });

  it("publishes the exact shared capability matrix in a stable order", () => {
    const [basic, standard] = publicBillingPlans();
    const labels = [
      "Student records and spreadsheet import",
      "Seats, shifts and allocations",
      "Payments, dues and audit history",
      "Multiple branches, each billed separately",
      "Staff invitations, roles and permission controls",
      "Branch and cross-branch advanced analytics",
      "AI reports and message drafting",
    ];

    expect(basic.capabilities.map(capability => capability.label)).toEqual(labels);
    expect(standard.capabilities.map(capability => capability.label)).toEqual(labels);
    expect(basic.capabilities.map(capability => capability.included)).toEqual([
      true, true, true, true, false, false, false,
    ]);
    expect(standard.capabilities.every(capability => capability.included)).toBe(true);
  });
});
