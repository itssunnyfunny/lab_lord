import { describe, expect, it, vi, afterEach } from "vitest";
import {
  getRazorpayKeyId,
  getRazorpayPlanCatalogClient,
  hmacSha256Hex,
  parseRazorpayKeyMode,
  RazorpayConfigurationError,
  resolveRazorpayMode,
  toRazorpaySubunits,
  verifyRazorpayPaymentSignature,
  verifyRazorpaySubscriptionSignature,
  verifyRazorpayWebhookSignature,
} from "@/lib/razorpay";

describe("razorpay security helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("converts INR major units to paise", () => {
    expect(toRazorpaySubunits(1200, "INR")).toBe(120000);
  });

  it("accepts local test key aliases", () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_TEST_KEY_ID", "");
    vi.stubEnv("TEST_API_KEY", "");
    vi.stubEnv("Test_API_Key", "rzp_test_alias");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    vi.stubEnv("RAZORPAY_TEST_KEY_SECRET", "");
    vi.stubEnv("TEST_KEY_SECRET", "");
    vi.stubEnv("Test_Key_Secret", "secret");
    const signature = hmacSha256Hex("pay_456|sub_123", "secret");

    expect(getRazorpayKeyId()).toBe("rzp_test_alias");
    expect(verifyRazorpaySubscriptionSignature({
      subscriptionId: "sub_123",
      paymentId: "pay_456",
      signature,
    })).toBe(true);
  });

  it("accepts the public checkout Key ID without exposing the Key Secret", () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", "rzp_test_public_alias");

    expect(getRazorpayKeyId()).toBe("rzp_test_public_alias");
  });

  it("requires the server-only key and rejects deployed aliases on Vercel", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", "rzp_test_public_only");
    expect(() => getRazorpayKeyId()).toThrow("RAZORPAY_KEY_ID must be configured as a server-only variable");

    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_server");
    expect(() => getRazorpayKeyId()).toThrow("NEXT_PUBLIC_RAZORPAY_KEY_ID is not supported");

    vi.stubEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", "rzp_test_server");
    expect(() => getRazorpayKeyId()).toThrow("NEXT_PUBLIC_RAZORPAY_KEY_ID is not supported");

    vi.stubEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID", "");
    expect(getRazorpayKeyId()).toBe("rzp_test_server");
  });

  it("derives Test and Live provider modes only from valid Razorpay key prefixes", () => {
    expect(parseRazorpayKeyMode("rzp_test_example")).toBe("TEST");
    expect(parseRazorpayKeyMode("rzp_live_example")).toBe("LIVE");
    expect(() => parseRazorpayKeyMode("plan_example")).toThrow(RazorpayConfigurationError);
  });

  it("requires an explicit mode matching both the key and Vercel environment", () => {
    expect(resolveRazorpayMode({
      RAZORPAY_MODE: "TEST",
      RAZORPAY_KEY_ID: "rzp_test_example",
      VERCEL_ENV: "preview",
    })).toBe("TEST");
    expect(resolveRazorpayMode({
      RAZORPAY_MODE: "LIVE",
      RAZORPAY_KEY_ID: "rzp_live_example",
      VERCEL_ENV: "production",
    })).toBe("LIVE");

    expect(() => resolveRazorpayMode({
      RAZORPAY_KEY_ID: "rzp_test_example",
      VERCEL_ENV: "preview",
    })).toThrow("RAZORPAY_MODE must be explicitly set");
    expect(() => resolveRazorpayMode({
      RAZORPAY_MODE: "LIVE",
      RAZORPAY_KEY_ID: "rzp_test_example",
      VERCEL_ENV: "production",
    })).toThrow("does not match");
    expect(() => resolveRazorpayMode({
      RAZORPAY_MODE: "TEST",
      RAZORPAY_KEY_ID: "rzp_test_example",
      VERCEL_ENV: "production",
    })).toThrow("Vercel Production requires RAZORPAY_MODE=LIVE");
    expect(() => resolveRazorpayMode({
      RAZORPAY_MODE: "LIVE",
      RAZORPAY_KEY_ID: "rzp_live_example",
      VERCEL_ENV: "preview",
    })).toThrow("Vercel preview requires RAZORPAY_MODE=TEST");
  });

  it("classifies provider responses so only a confirmed 404 is reprovisionable", async () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_example");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { description: "missing" } }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    )));

    await expect(getRazorpayPlanCatalogClient().fetchPlan("plan_missing"))
      .rejects.toMatchObject({ kind: "NOT_FOUND", status: 404 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { description: "bad key" } }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    )));
    await expect(getRazorpayPlanCatalogClient().fetchPlan("plan_private"))
      .rejects.toMatchObject({ kind: "AUTHENTICATION", status: 401 });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(getRazorpayPlanCatalogClient().fetchPlan("plan_network"))
      .rejects.toMatchObject({ kind: "NETWORK", status: null });
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
