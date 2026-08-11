import { describe, expect, it } from "vitest";
import { legacyUnsupportedMethodCancellationDisposition } from "@/services/legacyUnsupportedMethodAudit.service";
import type { RazorpaySubscription } from "@/lib/razorpay";

function provider(overrides: Partial<RazorpaySubscription> = {}): RazorpaySubscription {
  return {
    id: "sub_upi",
    entity: "subscription",
    plan_id: "plan_basic",
    status: "active",
    total_count: 120,
    quantity: 1,
    payment_method: "upi",
    ...overrides,
  };
}

describe("legacy unsupported-method cancellation audit", () => {
  it("supersedes only a provider-verified usable recurring method", () => {
    expect(legacyUnsupportedMethodCancellationDisposition({
      expectedProviderSubscriptionId: "sub_upi",
      localPaymentMethod: "UPI",
      providerSubscription: provider(),
    })).toBe("SUPERSEDE");
    expect(legacyUnsupportedMethodCancellationDisposition({
      expectedProviderSubscriptionId: "sub_upi",
      localPaymentMethod: "EMANDATE",
      providerSubscription: provider({ payment_method: "netbanking" }),
    })).toBe("SUPERSEDE");
  });

  it("keeps already-terminal subscriptions and flags identity ambiguity", () => {
    expect(legacyUnsupportedMethodCancellationDisposition({
      expectedProviderSubscriptionId: "sub_upi",
      localPaymentMethod: "UPI",
      providerSubscription: provider({ status: "cancelled" }),
    })).toBe("KEEP");
    expect(legacyUnsupportedMethodCancellationDisposition({
      expectedProviderSubscriptionId: "sub_other",
      localPaymentMethod: "UPI",
      providerSubscription: provider(),
    })).toBe("MANUAL_REVIEW");
  });

  it("does not revive an unknown method", () => {
    expect(legacyUnsupportedMethodCancellationDisposition({
      expectedProviderSubscriptionId: "sub_upi",
      localPaymentMethod: "UNKNOWN",
      providerSubscription: provider({ payment_method: "wallet" }),
    })).toBe("MANUAL_REVIEW");
  });
});
