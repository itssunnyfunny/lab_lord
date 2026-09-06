import { afterEach, describe, expect, it } from "vitest";
import {
  areRazorpayBillingWritesEnabled,
  areRazorpayMultiMethodSubscriptionsEnabled,
  assertRazorpayBillingWritesEnabled,
  BillingWritesDisabledError,
  getRazorpayCheckoutMethodAvailability,
  isWorkspaceBillingEnabled,
  RAZORPAY_BILLING_WRITES_FLAG,
  RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_FLAG,
  WORKSPACE_BILLING_FLAG,
} from "@/lib/billingFeature";

const original = process.env[WORKSPACE_BILLING_FLAG];
const originalBillingWrites = process.env[RAZORPAY_BILLING_WRITES_FLAG];
const originalMultiMethod = process.env[RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_FLAG];
const originalCanaries = process.env.RAZORPAY_LIVE_CANARY_ORG_IDS;
const originalRazorpayMode = process.env.RAZORPAY_MODE;
const originalRazorpayKeyId = process.env.RAZORPAY_KEY_ID;
const originalVercelEnvironment = process.env.VERCEL_ENV;

afterEach(() => {
  if (original === undefined) delete process.env[WORKSPACE_BILLING_FLAG];
  else process.env[WORKSPACE_BILLING_FLAG] = original;
  if (originalBillingWrites === undefined) delete process.env[RAZORPAY_BILLING_WRITES_FLAG];
  else process.env[RAZORPAY_BILLING_WRITES_FLAG] = originalBillingWrites;
  if (originalMultiMethod === undefined) delete process.env[RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_FLAG];
  else process.env[RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_FLAG] = originalMultiMethod;
  if (originalCanaries === undefined) delete process.env.RAZORPAY_LIVE_CANARY_ORG_IDS;
  else process.env.RAZORPAY_LIVE_CANARY_ORG_IDS = originalCanaries;
  if (originalRazorpayMode === undefined) delete process.env.RAZORPAY_MODE;
  else process.env.RAZORPAY_MODE = originalRazorpayMode;
  if (originalRazorpayKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
  else process.env.RAZORPAY_KEY_ID = originalRazorpayKeyId;
  if (originalVercelEnvironment === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnvironment;
});

describe("Razorpay billing write hold", () => {
  it("fails closed when explicitly disabled", () => {
    process.env[RAZORPAY_BILLING_WRITES_FLAG] = "false";
    expect(areRazorpayBillingWritesEnabled("org_regular")).toBe(false);
    expect(() => assertRazorpayBillingWritesEnabled("org_regular"))
      .toThrow(BillingWritesDisabledError);
  });

  it("allows an explicit canary organization while global writes are disabled", () => {
    process.env[RAZORPAY_BILLING_WRITES_FLAG] = "false";
    process.env.RAZORPAY_LIVE_CANARY_ORG_IDS = "org_first, org_canary";
    process.env.RAZORPAY_MODE = "LIVE";
    process.env.RAZORPAY_KEY_ID = "rzp_live_canary";
    process.env.VERCEL_ENV = "production";
    expect(areRazorpayBillingWritesEnabled("org_canary")).toBe(true);
    expect(areRazorpayBillingWritesEnabled("org_regular")).toBe(false);
  });

  it("does not let a canary allowlist bypass the hold outside Live Production", () => {
    process.env[RAZORPAY_BILLING_WRITES_FLAG] = "false";
    process.env.RAZORPAY_LIVE_CANARY_ORG_IDS = "org_canary";
    process.env.RAZORPAY_MODE = "TEST";
    process.env.RAZORPAY_KEY_ID = "rzp_test_canary";
    process.env.VERCEL_ENV = "preview";

    expect(areRazorpayBillingWritesEnabled("org_canary")).toBe(false);
  });

  it("allows all organizations only when the server flag is true", () => {
    process.env[RAZORPAY_BILLING_WRITES_FLAG] = "true";
    expect(areRazorpayBillingWritesEnabled("org_regular")).toBe(true);
  });
});

describe("workspace billing feature flag", () => {
  it("is disabled by default", () => {
    delete process.env[WORKSPACE_BILLING_FLAG];
    expect(isWorkspaceBillingEnabled()).toBe(false);
  });

});

describe("Razorpay multi-method subscriptions feature flag", () => {
  it("is disabled by default", () => {
    delete process.env[RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_FLAG];
    expect(areRazorpayMultiMethodSubscriptionsEnabled()).toBe(false);
    expect(getRazorpayCheckoutMethodAvailability()).toEqual({
      mode: "CARD_ONLY",
      potentialMethods: ["CARD"],
      providerControlsVisibility: false,
    });
  });

  it("is enabled only by an explicit true value", () => {
    process.env[RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_FLAG] = " TRUE ";
    expect(areRazorpayMultiMethodSubscriptionsEnabled()).toBe(true);
    expect(getRazorpayCheckoutMethodAvailability()).toEqual({
      mode: "PROVIDER_MANAGED",
      potentialMethods: ["CARD", "UPI", "EMANDATE"],
      providerControlsVisibility: true,
    });

    process.env[RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_FLAG] = "false";
    expect(areRazorpayMultiMethodSubscriptionsEnabled()).toBe(false);
  });
});
