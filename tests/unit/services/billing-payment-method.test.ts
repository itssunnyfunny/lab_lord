import { describe, expect, it } from "vitest";

import {
  isSupportedProviderPaymentMethod,
  normalizeProviderPaymentMethod,
} from "@/services/billingPaymentMethod.service";

describe("billing payment methods", () => {
  it.each([
    ["card", "CARD"],
    [" CARD ", "CARD"],
    ["upi", "UPI"],
    ["emandate", "EMANDATE"],
    ["netbanking", "EMANDATE"],
  ] as const)("normalizes %s as %s", (providerValue, expected) => {
    expect(normalizeProviderPaymentMethod(providerValue)).toBe(expected);
  });

  it.each([null, undefined, "", "wallet", "bank_transfer"])(
    "fails closed for an unrecognized provider value (%s)",
    providerValue => {
      const method = normalizeProviderPaymentMethod(providerValue);

      expect(method).toBe("UNKNOWN");
      expect(isSupportedProviderPaymentMethod(method)).toBe(false);
    }
  );

  it.each(["CARD", "UPI", "EMANDATE"] as const)(
    "accepts %s as a supported recurring method",
    method => {
      expect(isSupportedProviderPaymentMethod(method)).toBe(true);
    }
  );
});
