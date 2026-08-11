import { describe, expect, it } from "vitest";
import { getPaymentOutcomeCopy } from "@/components/billing/PaymentOutcomeDialog";

describe("PaymentOutcomeDialog copy", () => {
  it("keeps authorization declines payment-method neutral", () => {
    const copy = getPaymentOutcomeCopy("DECLINED");

    expect(copy.title).toBe("The payment authorization was declined");
    expect(copy.body).toContain("No billing change was applied");
    expect(copy.nextStep).toContain("supported recurring payment method");
    expect(copy.retryLabel).toBe("Try another payment method");
  });

  it("describes recovery as mandate reauthorization rather than a card update", () => {
    const copy = getPaymentOutcomeCopy("ABANDONED", "RECOVERY");
    const serialized = `${copy.title} ${copy.body} ${copy.nextStep} ${copy.retryLabel}`.toLowerCase();

    expect(serialized).toContain("payment method");
    expect(serialized).toContain("mandate");
    expect(serialized).not.toContain("card");
  });

  it("tells users not to create a duplicate authorization while provider confirmation is pending", () => {
    const copy = getPaymentOutcomeCopy("AWAITING_PROVIDER_CONFIRMATION");

    expect(copy.title).toBe("Waiting for Razorpay confirmation");
    expect(copy.nextStep).toContain("Do not start another authorization");
  });
});
