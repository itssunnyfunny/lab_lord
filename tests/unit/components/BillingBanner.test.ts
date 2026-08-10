import { describe, expect, it } from "vitest";
import { getBillingBannerActionLabel } from "@/components/billing/BillingBanner";
import { BILLING_PAYMENT_ACTION } from "@/types/billingExperience";

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
});
