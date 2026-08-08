import { describe, expect, it } from "vitest";
import { BillingWritesDisabledError } from "@/lib/billingFeature";
import { billingHttpStatus } from "@/lib/billingHttp";
import { RazorpayApiError, RazorpayConfigurationError } from "@/lib/razorpay";

describe("billingHttpStatus", () => {
  it("maps held and misconfigured billing to a retryable service response", () => {
    expect(billingHttpStatus(new BillingWritesDisabledError())).toBe(503);
    expect(billingHttpStatus(new RazorpayConfigurationError("mode mismatch"))).toBe(503);
    expect(billingHttpStatus(new Error("Subscription provider mode TEST cannot be used in LIVE mode"))).toBe(503);
  });

  it("maps provider failures without treating them as customer validation errors", () => {
    expect(billingHttpStatus(new RazorpayApiError("provider unavailable", {
      status: 503,
      kind: "PROVIDER",
    }))).toBe(502);
  });

  it("preserves authorization, lookup, and validation semantics", () => {
    expect(billingHttpStatus(new Error("Unauthorized"))).toBe(403);
    expect(billingHttpStatus(new Error("Subscription not found"))).toBe(404);
    expect(billingHttpStatus(new Error("Invalid request"))).toBe(400);
  });
});
