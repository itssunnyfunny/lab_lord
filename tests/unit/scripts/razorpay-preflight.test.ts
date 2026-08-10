import { describe, expect, it } from "vitest";
import {
  buildIsolatedPreflightEnvironment,
  databaseFingerprint,
  fetchRazorpayMethods,
  loadPreflightEnvironment,
  parsePreflightArguments,
  REQUIRED_MULTI_METHOD_WEBHOOK_EVENTS,
  summarizeRecurringMethods,
  validateRecurringMethods,
  validatePreflightEnvironment,
} from "@/scripts/razorpay-preflight";

function productionEnvironment(): Record<string, string | undefined> {
  return {
    RAZORPAY_MODE: "LIVE",
    RAZORPAY_KEY_ID: "rzp_live_example",
    RAZORPAY_KEY_SECRET: "secret",
    RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
    RAZORPAY_BILLING_WRITES_ENABLED: "false",
    WORKSPACE_BRANCH_BILLING_V2_ENABLED: "false",
    VERCEL_ENV: "production",
    DATABASE_URL: "postgresql://user:password@db.example.test:5432/lablords",
    CRON_SECRET: "cron-secret",
    NEXT_PUBLIC_BUSINESS_ADDRESS: "123 Example Street, Bengaluru, Karnataka 560001",
    NEXT_PUBLIC_SITE_URL: "https://lablords.in",
    NEXT_PUBLIC_SUPPORT_EMAIL: "support@lablords.in",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_example",
    CLERK_SECRET_KEY: "sk_live_example",
  };
}

describe("Razorpay preflight arguments", () => {
  it("is read-only and rejects cleanup or apply flags", () => {
    expect(() => parsePreflightArguments(["--target=production", "--apply"]))
      .toThrow(/read-only/);
    expect(() => parsePreflightArguments(["--target=production", "--cleanup=plans"]))
      .toThrow(/read-only/);
  });

  it("defaults Preview switches on and Production switches off", () => {
    expect(parsePreflightArguments(["--target=preview"])).toMatchObject({
      expectedBillingWrites: "enabled",
      expectedV2: "enabled",
      expectedMultiMethodSubscriptions: "disabled",
    });
    expect(parsePreflightArguments(["--target=production"])).toMatchObject({
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "disabled",
    });
  });

  it("requires explicit operator evidence before expecting multi-method Checkout", () => {
    expect(() => parsePreflightArguments([
      "--target=preview",
      "--expect-multi-method-subscriptions=enabled",
    ])).toThrow(/explicit Dashboard\/Test confirmations/);

    expect(parsePreflightArguments([
      "--target=preview",
      "--expect-multi-method-subscriptions=enabled",
      "--confirm-subscription-settings",
      "--confirm-upi-intent",
      "--confirm-upi-qr",
      "--confirm-webhook-events",
      "--confirm-amount-eligibility",
    ])).toMatchObject({
      expectedMultiMethodSubscriptions: "enabled",
      confirmations: {
        subscriptionSettings: true,
        upiIntent: true,
        upiQr: true,
        webhookEvents: true,
        amountEligibility: true,
      },
    });
  });

  it("accepts one explicit Production canary and rejects it for Preview", () => {
    expect(parsePreflightArguments([
      "--target=production",
      "--expect-canary-org-id=org_canary",
    ])).toMatchObject({ expectedCanaryOrganizationId: "org_canary" });

    expect(() => parsePreflightArguments([
      "--target=preview",
      "--expect-canary-org-id=org_canary",
    ])).toThrow(/Production/);
  });
});

describe("Razorpay preflight environment", () => {
  it("accepts an isolated, held Production configuration", () => {
    expect(validatePreflightEnvironment("production", productionEnvironment(), {
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "disabled",
    })).toEqual([]);
  });

  it("rejects cross-mode keys, public keys, placeholders, and an enabled hold", () => {
    const environment = productionEnvironment();
    environment.RAZORPAY_KEY_ID = "rzp_test_wrong_mode";
    environment.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_live_public";
    environment.NEXT_PUBLIC_BUSINESS_ADDRESS = "Business address available on request";
    environment.RAZORPAY_BILLING_WRITES_ENABLED = "true";

    expect(validatePreflightEnvironment("production", environment, {
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "disabled",
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("does not match production Razorpay mode"),
      expect.stringContaining("must be removed"),
      expect.stringContaining("KYC-matching address"),
      expect.stringContaining("RAZORPAY_BILLING_WRITES_ENABLED"),
    ]));
  });

  it("requires a held Production canary allowlist to be empty or explicitly expected", () => {
    const environment = productionEnvironment();
    environment.RAZORPAY_LIVE_CANARY_ORG_IDS = "org_canary";

    expect(validatePreflightEnvironment("production", environment, {
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "disabled",
    })).toContainEqual(expect.stringContaining("must be empty"));

    expect(validatePreflightEnvironment("production", environment, {
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "disabled",
      expectedCanaryOrganizationId: "org_canary",
    })).toEqual([]);

    environment.RAZORPAY_LIVE_CANARY_ORG_IDS = "org_canary,org_unreviewed";
    expect(validatePreflightEnvironment("production", environment, {
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "disabled",
      expectedCanaryOrganizationId: "org_canary",
    })).toContainEqual(expect.stringContaining("exactly the explicitly expected"));
  });

  it("treats an absent multi-method flag as safely disabled and rejects drift", () => {
    const environment = productionEnvironment();
    expect(validatePreflightEnvironment("production", environment, {
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "enabled",
    })).toContainEqual(expect.stringContaining("must be true"));

    environment.RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED = "sometimes";
    expect(validatePreflightEnvironment("production", environment, {
      expectedBillingWrites: "disabled",
      expectedV2: "disabled",
      expectedMultiMethodSubscriptions: "disabled",
    })).toContainEqual(expect.stringContaining("must be true or false"));
  });
});

describe("Razorpay recurring method capabilities", () => {
  const response = {
    card: true,
    upi: { enabled: true, intent: true, qr: true },
    netbanking: { BANK_C: true },
    recurring: {
      card: { NETWORK_A: true, NETWORK_B: true },
      upi: { app_catalog: { APP_A: true } },
      emandate: {
        BANK_A: ["netbanking", "debit_card"],
        BANK_B: ["aadhaar"],
      },
    },
  };

  it("summarizes the dynamic response without a compiled bank or app list", () => {
    const summary = summarizeRecurringMethods(response);

    expect(summary).toEqual({
      accountMethods: { card: true, upi: true, netbanking: true },
      recurring: {
        card: { enabled: true, supportedEntryCount: 2 },
        upi: { enabled: true, supportedEntryCount: 1 },
        emandate: {
          enabled: true,
          supportedBankCount: 2,
          authenticationTypeCount: 3,
        },
      },
      checkoutSignals: { upiIntent: true, upiQr: true },
    });
    expect(validateRecurringMethods(summary, true)).toEqual([]);
  });

  it("fails closed when required recurring capabilities disappear", () => {
    const summary = summarizeRecurringMethods({
      card: true,
      upi: false,
      recurring: { card: { NETWORK_A: true }, emandate: {} },
    });

    expect(validateRecurringMethods(summary, true)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPI capability"),
      expect.stringContaining("eMandate banks"),
    ]));
    expect(validateRecurringMethods(summary, false)).toEqual([]);
  });

  it("calls Methods API with only the public key ID", async () => {
    let authorization = "";
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(fetchRazorpayMethods("rzp_test_example", fetchMock)).resolves.toEqual(response);
    expect(Buffer.from(authorization.replace("Basic ", ""), "base64").toString("utf8"))
      .toBe("rzp_test_example:");
  });

  it("keeps pause and resume in the rollout webhook contract", () => {
    expect(REQUIRED_MULTI_METHOD_WEBHOOK_EVENTS).toEqual(expect.arrayContaining([
      "subscription.paused",
      "subscription.resumed",
      "subscription.cancelled",
    ]));
  });
});

describe("database fingerprint", () => {
  it("depends only on the database-resident identity, not a connection alias", () => {
    const first = databaseFingerprint("018f4f4d-4f89-7db1-98d7-aad5dd3f32d1");
    const second = databaseFingerprint("018f4f4d-4f89-7db1-98d7-aad5dd3f32d1");

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("018f4f4d");
  });

  it("changes for a separate Preview database", () => {
    const production = databaseFingerprint("018f4f4d-4f89-7db1-98d7-aad5dd3f32d1");
    const preview = databaseFingerprint("018f4f4d-5a2c-78de-aed3-bb757d2e91ae");

    expect(preview).not.toBe(production);
  });
});

describe("preflight environment loading", () => {
  it("never inherits an ambient Accelerate endpoint for the target database", () => {
    expect(buildIsolatedPreflightEnvironment(
      { DATABASE_URL: "postgresql://preview.example.test/lablords" },
      {
        VERCEL_ENV: "preview",
        ACCELERATE_URL: "prisma://production.example.test/",
      }
    )).toEqual({
      DATABASE_URL: "postgresql://preview.example.test/lablords",
      VERCEL_ENV: "preview",
    });
  });

  it("never inherits an ambient multi-method rollout switch", () => {
    expect(buildIsolatedPreflightEnvironment(
      { DATABASE_URL: "postgresql://preview.example.test/lablords" },
      {
        VERCEL_ENV: "preview",
        RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED: "true",
      }
    )).toEqual({
      DATABASE_URL: "postgresql://preview.example.test/lablords",
      VERCEL_ENV: "preview",
    });
  });

  it("fails when the requested environment file cannot be loaded", () => {
    expect(() => loadPreflightEnvironment(
      "__missing_preflight_environment__/does-not-exist.env",
      { VERCEL_ENV: "preview" }
    )).toThrow(/Unable to load/);
  });
});
