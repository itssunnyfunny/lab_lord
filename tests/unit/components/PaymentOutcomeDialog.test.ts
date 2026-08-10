import { describe, expect, it } from "vitest";
import { getPaymentOutcomeCopy } from "@/components/billing/PaymentOutcomeDialog";

describe("PaymentOutcomeDialog copy", () => {
  it("keeps authorization declines payment-method neutral", () => {
    const copy = getPaymentOutcomeCopy("DECLINED");

    expect(copy.title).toBe("The payment authorization was declined");
    expect(copy.body).toContain("supported recurring payment method");
    expect(copy.retryLabel).toBe("Try another payment method");
  });

  it("describes recovery as mandate reauthorization rather than a card update", () => {
    const copy = getPaymentOutcomeCopy("ABANDONED", "RECOVERY");
    const serialized = `${copy.title} ${copy.body} ${copy.retryLabel}`.toLowerCase();

    expect(serialized).toContain("payment method");
    expect(serialized).toContain("mandate");
    expect(serialized).not.toContain("card");
  });
});
