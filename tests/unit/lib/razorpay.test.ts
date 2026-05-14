import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getRazorpayKeyId,
  hmacSha256Hex,
  toRazorpaySubunits,
  verifyRazorpayPaymentSignature,
  verifyRazorpaySubscriptionSignature,
  verifyRazorpayWebhookSignature,
} from "@/lib/razorpay";

describe("razorpay security helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("converts INR major units to paise", () => {
    expect(toRazorpaySubunits(1200, "INR")).toBe(120000);
  });

  it("accepts local test key aliases", () => {
    vi.stubEnv("Test_API_Key", "rzp_test_alias");
    vi.stubEnv("Test_Key_Secret", "secret");
    const signature = hmacSha256Hex("pay_456|sub_123", "secret");

    expect(getRazorpayKeyId()).toBe("rzp_test_alias");
    expect(verifyRazorpaySubscriptionSignature({
      subscriptionId: "sub_123",
      paymentId: "pay_456",
      signature,
    })).toBe(true);
  });

  it("verifies order checkout signatures with orderId|paymentId", () => {
    vi.stubEnv("RAZORPAY_KEY_SECRET", "secret");
    const signature = hmacSha256Hex("order_123|pay_456", "secret");

    expect(verifyRazorpayPaymentSignature({
      orderId: "order_123",
      paymentId: "pay_456",
      signature,
    })).toBe(true);

    expect(verifyRazorpayPaymentSignature({
      orderId: "order_123",
      paymentId: "pay_bad",
      signature,
    })).toBe(false);
  });

  it("verifies subscription checkout signatures with paymentId|subscriptionId", () => {
    vi.stubEnv("RAZORPAY_KEY_SECRET", "secret");
    const signature = hmacSha256Hex("pay_456|sub_123", "secret");

    expect(verifyRazorpaySubscriptionSignature({
      subscriptionId: "sub_123",
      paymentId: "pay_456",
      signature,
    })).toBe(true);
  });

  it("verifies webhook signatures against the raw body", () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "webhook_secret");
    const body = JSON.stringify({ event: "payment.captured" });
    const signature = hmacSha256Hex(body, "webhook_secret");

    expect(verifyRazorpayWebhookSignature(body, signature)).toBe(true);
    expect(verifyRazorpayWebhookSignature(JSON.stringify({ event: "payment.failed" }), signature)).toBe(false);
  });
});
