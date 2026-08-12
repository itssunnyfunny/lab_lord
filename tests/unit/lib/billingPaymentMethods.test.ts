import { describe, expect, it } from "vitest";
import {
  getProviderPaymentMethodLabel,
  isSupportedRecurringPaymentMethod,
} from "@/lib/billingPaymentMethods";

describe("billing payment methods", () => {
  it("uses customer-facing recurring method labels", () => {
    expect(getProviderPaymentMethodLabel("CARD")).toBe("Card");
    expect(getProviderPaymentMethodLabel("upi")).toBe("UPI AutoPay");
    expect(getProviderPaymentMethodLabel("EMANDATE")).toBe("eMandate");
    expect(getProviderPaymentMethodLabel("netbanking")).toBe("Payment method");
  });

  it("accepts only supported recurring provider values", () => {
    expect(isSupportedRecurringPaymentMethod("CARD")).toBe(true);
    expect(isSupportedRecurringPaymentMethod("UPI")).toBe(true);
    expect(isSupportedRecurringPaymentMethod("EMANDATE")).toBe(true);
    expect(isSupportedRecurringPaymentMethod("UNKNOWN")).toBe(false);
  });
});
