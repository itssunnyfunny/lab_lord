import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingBanner, getBillingBannerActionLabel } from "@/components/billing/BillingBanner";
import { BILLING_PAYMENT_ACTION, type BillingExperience } from "@/types/billingExperience";

describe("BillingBanner action labels", () => {
  it("keeps legacy recovery actions payment-method neutral", () => {
    expect(getBillingBannerActionLabel({
      paymentAction: BILLING_PAYMENT_ACTION.UPDATE_PAYMENT_METHOD,
      selectedPostTrialPlan: "STANDARD",
    })).toBe("Update payment method");
  });

  it("keeps authorization focused on the selected plan", () => {
    expect(getBillingBannerActionLabel({
      paymentAction: BILLING_PAYMENT_ACTION.AUTHORIZE_PAYMENT_METHOD,
      selectedPostTrialPlan: "BASIC",
    })).toBe("Authorize Basic");
  });

  it("gives warning messages an accessible urgency-first hierarchy", () => {
    const experience = {
      organizationId: "org_warning",
      accessMode: "WARNING",
      effectivePlan: "BASIC",
      selectedPostTrialPlan: "BASIC",
      providerStatus: "PENDING",
      customerState: "PAYMENT_RETRYING",
      customerMessage: "Your renewal needs attention.",
      trialEndsAt: null,
      trialDaysRemaining: null,
      paidThrough: "2026-08-12T00:00:00.000Z",
      confirmedQuantity: 1,
      projectedQuantity: 1,
      currentUnitAmount: 299,
      currentMonthlyTotal: 299,
      projectedUnitAmount: 299,
      projectedMonthlyTotal: 299,
      authorizationStatus: "AUTHORIZED",
      planFeeDueToday: 0,
      nextChargeAt: null,
      paymentAction: "CONTINUE_CHECKOUT",
      entitlements: [],
      latestOperation: null,
      activeOperation: null,
      scheduledChanges: [],
      branch: null,
      viewer: { isOwner: true, canManageBilling: true },
    } satisfies BillingExperience;

    const html = renderToStaticMarkup(createElement(BillingBanner, { experience }));

    expect(html).toContain('role="status"');
    expect(html).toContain("Billing action required");
    expect(html).toContain("Your renewal needs attention.");
    expect(html.indexOf("Billing action required")).toBeLessThan(html.indexOf("Your renewal needs attention."));
    expect(html).toContain("Manage billing");
  });
});
