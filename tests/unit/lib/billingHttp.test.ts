import { describe, expect, it } from "vitest";
import { BillingWritesDisabledError } from "@/lib/billingFeature";
import { billingHttpStatus } from "@/lib/billingHttp";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
  BillingResourceNotFoundError,
  BillingValidationError,
} from "@/lib/billingErrors";
import { OrganizationAccessNotFoundError } from "@/lib/organizationErrors";
import { RazorpayApiError, RazorpayConfigurationError } from "@/lib/razorpay";

describe("billingHttpStatus", () => {
  it("returns conflict while another replacement is open", () => {
    expect(billingHttpStatus(new BillingChangeInProgressError("change_existing"))).toBe(409);
    expect(billingHttpStatus(new BillingManualReviewRequiredError("change_manual"))).toBe(409);
  });

  it("maps held and misconfigured billing to a retryable service response", () => {
    expect(billingHttpStatus(new BillingWritesDisabledError())).toBe(503);
    expect(billingHttpStatus(new RazorpayConfigurationError("mode mismatch"))).toBe(503);
  });

  it("maps provider failures without treating them as customer validation errors", () => {
    expect(billingHttpStatus(new RazorpayApiError("provider unavailable", {
      status: 503,
      kind: "PROVIDER",
    }))).toBe(502);
  });

  it("maps typed tenant-safe lookup and validation failures", () => {
    expect(billingHttpStatus(new OrganizationAccessNotFoundError())).toBe(404);
    expect(billingHttpStatus(new BillingResourceNotFoundError("Subscription not found"))).toBe(404);
    expect(billingHttpStatus(new BillingValidationError("Invalid request"))).toBe(400);
  });

  it("does not infer HTTP status from arbitrary error messages", () => {
    expect(billingHttpStatus(new Error("Unauthorized"), 500)).toBe(500);
    expect(billingHttpStatus(new Error("Subscription not found"), 500)).toBe(500);
    expect(billingHttpStatus(
      new Error("Subscription provider mode TEST cannot be used in LIVE mode"),
      500
    )).toBe(500);
  });
});
