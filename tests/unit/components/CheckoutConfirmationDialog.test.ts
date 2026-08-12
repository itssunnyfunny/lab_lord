import { describe, expect, it } from "vitest";
import { getCheckoutPaymentMethodCopy } from "@/components/billing/CheckoutConfirmationDialog";

describe("CheckoutConfirmationDialog payment method guidance", () => {
  it("presents all provider-managed recurring methods without promising eligibility", () => {
    const copy = getCheckoutPaymentMethodCopy(true);

    expect(copy.heading).toBe("Choose securely in Razorpay");
    expect(copy.methods).toEqual(["Card", "UPI AutoPay", "eMandate"]);
    expect(copy.description).toContain("eligible");
    expect(copy.description).toContain("Razorpay Checkout");
  });

  it("is explicit when the workspace is still card-only", () => {
    const copy = getCheckoutPaymentMethodCopy(false);

    expect(copy.methods).toEqual(["Card"]);
    expect(copy.description).toContain("currently enabled for this workspace");
    expect(copy.description).toContain("only in Razorpay Checkout");
  });
});
