import { describe, expect, it } from "vitest";
import {
  resolveTrustedPaidThrough,
  type BillingPaidEvidenceSubscription,
} from "@/services/billingPaidEvidence.service";

const now = new Date("2026-08-15T12:00:00.000Z");
const periodStart = new Date("2026-08-01T00:00:00.000Z");
const periodEnd = new Date("2026-09-01T00:00:00.000Z");
const paidAt = new Date("2026-08-01T00:01:00.000Z");
const confirmedAt = new Date("2026-08-01T00:02:00.000Z");

function exactIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "change_1",
    organizationId: "org_1",
    organizationSubscriptionId: "subscription_1",
    replacementSubscriptionId: null,
    status: "APPLIED",
    operationStatus: "APPLIED",
    failureCategory: null,
    failureCode: null,
    appliedAt: confirmedAt,
    providerConfirmedAt: confirmedAt,
    toPlan: "PRO",
    toQuantity: 2,
    commercialIntentVersion: 1,
    commercialIntentCapturedAt: new Date("2026-07-31T00:00:00.000Z"),
    authorizedProviderMode: "TEST",
    authorizedSourceRazorpaySubscriptionId: "sub_1",
    authorizedRazorpaySubscriptionId: "sub_1",
    authorizedSourceRazorpayPlanId: "plan_old",
    authorizedRazorpayPlanId: "plan_pro",
    authorizedPlan: "PRO",
    authorizedQuantity: 2,
    authorizedRazorpayOfferId: null,
    authorizedUnitAmountSubunits: 49900,
    authorizedGrossAmountSubunits: 99800,
    authorizedExpectedAmountSubunits: 99800,
    authorizedOfferValidThroughPaidCount: null,
    authorizedCurrency: "INR",
    authorizedPeriod: "monthly",
    authorizedInterval: 1,
    ...overrides,
  };
}

function exactInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "invoice_row_1",
    organizationId: "org_1",
    organizationSubscriptionId: "subscription_1",
    razorpayInvoiceId: "invoice_1",
    razorpayPaymentId: "payment_1",
    status: "paid",
    amountSubunits: 99800,
    amountPaidSubunits: 99800,
    amountDueSubunits: 0,
    currency: "INR",
    commercialEvidenceVersion: 1,
    commercialIntentChangeId: "change_1",
    providerMode: "TEST",
    razorpaySubscriptionId: "sub_1",
    razorpayPlanId: "plan_pro",
    providerQuantity: 2,
    razorpayOfferId: null,
    paymentAmountSubunits: 99800,
    paymentCurrency: "INR",
    paymentStatus: "captured",
    paymentCaptured: true,
    evidenceConfirmedAt: confirmedAt,
    evidenceFailureCode: null,
    periodStart,
    periodEnd,
    paidAt,
    createdAt: confirmedAt,
    commercialIntentChange: exactIntent(),
    ...overrides,
  };
}

function exactSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "subscription_1",
    organizationId: "org_1",
    providerMode: "TEST",
    plan: "PRO",
    amountSubunits: 49900,
    currency: "INR",
    period: "monthly",
    interval: 1,
    quantity: 2,
    razorpayPlanId: "plan_pro",
    razorpaySubscriptionId: "sub_1",
    status: "ACTIVE",
    paidThrough: periodEnd,
    lastConfirmedInvoiceId: "invoice_1",
    lastConfirmedPaymentId: "payment_1",
    lastPaymentConfirmedAt: confirmedAt,
    confirmedCommercialIntentChangeId: "change_1",
    currentStart: periodStart,
    currentEnd: periodEnd,
    billingOfferId: null,
    billingOffer: null,
    replacesSubscriptionId: null,
    replacesSubscription: null,
    invoices: [exactInvoice()],
    ...overrides,
  } as unknown as BillingPaidEvidenceSubscription;
}

function resolve(
  subscription: BillingPaidEvidenceSubscription,
  at: Date = now
) {
  return resolveTrustedPaidThrough(subscription, at);
}

describe("stored paid commercial evidence", () => {
  it.each(["ACTIVE", "AUTHENTICATED"])(
    "does not infer paid access from %s without evidence",
    status => {
      const subscription = exactSubscription({
        status,
        paidThrough: null,
        lastConfirmedInvoiceId: null,
        lastConfirmedPaymentId: null,
        lastPaymentConfirmedAt: null,
        confirmedCommercialIntentChangeId: null,
        currentStart: null,
        currentEnd: null,
        invoices: [],
      });

      expect(resolve(subscription)).toBeNull();
    }
  );

  it("does not trust a future raw paidThrough without confirmation pointers", () => {
    const subscription = exactSubscription({
      lastConfirmedInvoiceId: null,
      lastConfirmedPaymentId: null,
      lastPaymentConfirmedAt: null,
      confirmedCommercialIntentChangeId: null,
      invoices: [],
    });

    expect(resolve(subscription)).toBeNull();
  });

  it("returns an exact current provider-settled boundary", () => {
    expect(resolve(exactSubscription())).toEqual(periodEnd);
  });

  it("accepts an exact replacement-intent lineage after cutover", () => {
    const replacementIntent = exactIntent({
      organizationSubscriptionId: "source_subscription_row",
      replacementSubscriptionId: "subscription_1",
      authorizedSourceRazorpaySubscriptionId: "sub_source",
    });
    const subscription = exactSubscription({
      replacesSubscriptionId: "source_subscription_row",
      replacesSubscription: {
        id: "source_subscription_row",
        organizationId: "org_1",
        providerMode: "TEST",
        razorpaySubscriptionId: "sub_source",
      },
      invoices: [exactInvoice({ commercialIntentChange: replacementIntent })],
    });

    expect(resolve(subscription)).toEqual(periodEnd);
  });

  it("rejects a replacement intent with mismatched source lineage", () => {
    const replacementIntent = exactIntent({
      organizationSubscriptionId: "source_subscription_row",
      replacementSubscriptionId: "subscription_1",
      authorizedSourceRazorpaySubscriptionId: "sub_other",
    });
    const subscription = exactSubscription({
      replacesSubscriptionId: "source_subscription_row",
      replacesSubscription: {
        id: "source_subscription_row",
        organizationId: "org_1",
        providerMode: "TEST",
        razorpaySubscriptionId: "sub_source",
      },
      invoices: [exactInvoice({ commercialIntentChange: replacementIntent })],
    });

    expect(resolve(subscription)).toBeNull();
  });

  it("rejects an otherwise exact but expired paid period", () => {
    expect(resolve(exactSubscription(), periodEnd)).toBeNull();
  });

  it("rejects evidence from a different provider mode", () => {
    const subscription = exactSubscription({
      invoices: [exactInvoice({ providerMode: "LIVE" })],
    });
    expect(resolve(subscription)).toBeNull();
  });

  it.each([
    ["invoice pointer", { lastConfirmedInvoiceId: "invoice_other" }],
    ["payment pointer", { lastConfirmedPaymentId: "payment_other" }],
    ["intent pointer", { confirmedCommercialIntentChangeId: "change_other" }],
  ])("rejects a mismatched %s", (_label, overrides) => {
    expect(resolve(exactSubscription(overrides))).toBeNull();
  });

  it.each([
    ["organization", { organizationId: "org_other" }],
    ["provider subscription", { razorpaySubscriptionId: "sub_other" }],
    ["provider plan", { razorpayPlanId: "plan_other" }],
    ["logical plan", { plan: "BASIC" }],
    ["quantity", { quantity: 3 }],
    ["unit amount", { amountSubunits: 50000 }],
    ["billing cadence", { interval: 2 }],
  ])("rejects a subscription/evidence %s mismatch", (_label, overrides) => {
    expect(resolve(exactSubscription(overrides))).toBeNull();
  });

  it.each([
    ["invoice amount", { amountSubunits: 99799 }],
    ["paid amount", { amountPaidSubunits: 99799 }],
    ["amount due", { amountDueSubunits: 1 }],
    ["payment amount", { paymentAmountSubunits: 99799 }],
  ])("rejects a mismatched %s", (_label, invoiceOverrides) => {
    const subscription = exactSubscription({
      invoices: [exactInvoice(invoiceOverrides)],
    });
    expect(resolve(subscription)).toBeNull();
  });

  it.each([
    ["invoice currency", { currency: "USD" }],
    ["payment currency", { paymentCurrency: "USD" }],
    ["invoice status", { status: "open" }],
    ["payment status", { paymentStatus: "authorized" }],
    ["capture flag", { paymentCaptured: false }],
    ["evidence failure", { evidenceFailureCode: "MISMATCH" }],
    ["period end", { periodEnd: new Date("2026-09-02T00:00:00.000Z") }],
  ])("rejects a mismatched %s", (_label, invoiceOverrides) => {
    const subscription = exactSubscription({
      invoices: [exactInvoice(invoiceOverrides)],
    });
    expect(resolve(subscription)).toBeNull();
  });

  it.each([
    ["change status", { status: "FAILED" }],
    ["operation status", { operationStatus: "FAILED" }],
    ["provider mode", { authorizedProviderMode: "LIVE" }],
    ["plan", { authorizedPlan: "BASIC" }],
    ["quantity", { authorizedQuantity: 3 }],
    ["gross amount", { authorizedGrossAmountSubunits: 99799 }],
    ["expected amount", { authorizedExpectedAmountSubunits: 99799 }],
    ["currency", { authorizedCurrency: "USD" }],
    ["cadence", { authorizedPeriod: "yearly" }],
  ])("rejects a mismatched immutable intent %s", (_label, intentOverrides) => {
    const subscription = exactSubscription({
      invoices: [exactInvoice({ commercialIntentChange: exactIntent(intentOverrides) })],
    });
    expect(resolve(subscription)).toBeNull();
  });

  it("accepts an exactly correlated offered settlement", () => {
    const offeredIntent = exactIntent({
      authorizedRazorpayOfferId: "offer_1",
      authorizedExpectedAmountSubunits: 89800,
      authorizedOfferValidThroughPaidCount: 1,
    });
    const subscription = exactSubscription({
      billingOfferId: "offer_row_1",
      billingOffer: {
        id: "offer_row_1",
        providerMode: "TEST",
        razorpayOfferId: "offer_1",
      },
      invoices: [exactInvoice({
        razorpayOfferId: "offer_1",
        amountSubunits: 89800,
        amountPaidSubunits: 89800,
        paymentAmountSubunits: 89800,
        commercialIntentChange: offeredIntent,
      })],
    });

    expect(resolve(subscription)).toEqual(periodEnd);
  });

  it("rejects an offered settlement whose local offer lineage differs", () => {
    const offeredIntent = exactIntent({
      authorizedRazorpayOfferId: "offer_1",
      authorizedExpectedAmountSubunits: 89800,
      authorizedOfferValidThroughPaidCount: 1,
    });
    const subscription = exactSubscription({
      billingOfferId: "offer_row_1",
      billingOffer: {
        id: "offer_row_1",
        providerMode: "TEST",
        razorpayOfferId: "offer_other",
      },
      invoices: [exactInvoice({
        razorpayOfferId: "offer_1",
        amountSubunits: 89800,
        amountPaidSubunits: 89800,
        paymentAmountSubunits: 89800,
        commercialIntentChange: offeredIntent,
      })],
    });

    expect(resolve(subscription)).toBeNull();
  });

  it("fails closed without throwing for malformed stored dates and relations", () => {
    const malformed = exactSubscription({
      paidThrough: new Date("invalid"),
      invoices: [{ commercialIntentChange: null }],
    });

    expect(() => resolve(malformed)).not.toThrow();
    expect(resolve(malformed)).toBeNull();
  });
});
