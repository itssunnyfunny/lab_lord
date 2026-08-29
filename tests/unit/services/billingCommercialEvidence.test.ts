import { describe, expect, it } from "vitest";
import {
  buildCommercialIntentSnapshot,
  validateExactCommercialEvidence,
  type CommercialIntentRecord,
} from "@/services/billingCommercialEvidence.service";
import type {
  RazorpayInvoice,
  RazorpayPayment,
  RazorpayPlan,
  RazorpaySubscription,
} from "@/lib/razorpay";

const now = new Date("2026-08-15T12:00:00.000Z");
const periodStart = Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000);
const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

function intent(overrides: Partial<CommercialIntentRecord> = {}): CommercialIntentRecord {
  return {
    id: "change_1",
    organizationId: "org_1",
    toPlan: "BASIC",
    toQuantity: 2,
    ...buildCommercialIntentSnapshot({
      providerMode: "TEST",
      razorpaySubscriptionId: "sub_1",
      sourceRazorpayPlanId: "plan_basic",
      razorpayPlanId: "plan_basic",
      plan: "BASIC",
      quantity: 2,
      unitAmountSubunits: 29_900,
      currency: "INR",
      period: "monthly",
      interval: 1,
      capturedAt: new Date("2026-07-01T00:00:00.000Z"),
    }),
    ...overrides,
  };
}

function providerSubscription(
  overrides: Partial<RazorpaySubscription> = {}
): RazorpaySubscription {
  return {
    id: "sub_1",
    entity: "subscription",
    plan_id: "plan_basic",
    status: "active",
    total_count: 120,
    quantity: 2,
    paid_count: 1,
    current_start: periodStart,
    current_end: periodEnd,
    offer_id: null,
    ...overrides,
  };
}

function payment(overrides: Partial<RazorpayPayment> = {}): RazorpayPayment {
  return {
    id: "pay_1",
    entity: "payment",
    amount: 59_800,
    currency: "INR",
    status: "captured",
    order_id: null,
    invoice_id: "inv_1",
    subscription_id: "sub_1",
    captured: true,
    method: "card",
    ...overrides,
  };
}

function invoice(overrides: Partial<RazorpayInvoice> = {}): RazorpayInvoice {
  return {
    id: "inv_1",
    entity: "invoice",
    subscription_id: "sub_1",
    payment_id: "pay_1",
    status: "paid",
    amount: 59_800,
    amount_paid: 59_800,
    amount_due: 0,
    currency: "INR",
    billing_start: periodStart,
    billing_end: periodEnd,
    issued_at: periodStart,
    paid_at: periodStart + 60,
    ...overrides,
  };
}

function providerPlan(overrides: Partial<RazorpayPlan> = {}): RazorpayPlan {
  return {
    id: "plan_basic",
    entity: "plan",
    interval: 1,
    period: "monthly",
    item: { amount: 29_900, currency: "INR", name: "Basic" },
    ...overrides,
  };
}

function validate(overrides: {
  intent?: CommercialIntentRecord | null;
  subscription?: RazorpaySubscription;
  payment?: RazorpayPayment | null;
  invoice?: RazorpayInvoice | null;
  plan?: RazorpayPlan | null;
  providerMode?: "TEST" | "LIVE";
} = {}) {
  return validateExactCommercialEvidence({
    intent: overrides.intent === undefined ? intent() : overrides.intent,
    organizationId: "org_1",
    providerMode: overrides.providerMode ?? "TEST",
    localSubscription: {
      organizationId: "org_1",
      providerMode: "TEST",
      razorpaySubscriptionId: "sub_1",
    },
    providerSubscription: overrides.subscription ?? providerSubscription(),
    payment: overrides.payment === undefined ? payment() : overrides.payment,
    invoice: overrides.invoice === undefined ? invoice() : overrides.invoice,
    providerPlan: overrides.plan === undefined ? providerPlan() : overrides.plan,
    now,
  });
}

describe("exact billing commercial evidence", () => {
  it("freezes gross and offer-adjusted totals when authorization is created", () => {
    expect(buildCommercialIntentSnapshot({
      providerMode: "TEST",
      razorpaySubscriptionId: "sub_offer",
      razorpayPlanId: "plan_basic",
      plan: "BASIC",
      quantity: 2,
      unitAmountSubunits: 29_900,
      currency: "inr",
      period: "MONTHLY",
      interval: 1,
      offer: {
        razorpayOfferId: "offer_launch",
        discountType: "PERCENTAGE",
        discountValue: 10,
        durationType: "LIMITED_CYCLES",
        durationCycles: 2,
      },
    })).toMatchObject({
      commercialIntentVersion: 1,
      authorizedGrossAmountSubunits: 59_800,
      authorizedExpectedAmountSubunits: 53_820,
      authorizedRazorpayOfferId: "offer_launch",
      authorizedOfferValidThroughPaidCount: 2,
      authorizedCurrency: "INR",
      authorizedPeriod: "monthly",
    });
  });

  it.each([
    ["provider quantity", providerSubscription({ quantity: 1 }), "QUANTITY_MISMATCH"],
    ["provider plan", providerSubscription({ plan_id: "plan_other" }), "PROVIDER_PLAN_MISMATCH"],
    ["provider offer", providerSubscription({ offer_id: "offer_other" }), "OFFER_MISMATCH"],
  ])("rejects a mismatched %s before local commercial state is applied", (_label, subscription, code) => {
    expect(validate({ subscription })).toEqual({ kind: "MISMATCH", code });
  });

  it("accepts a small token payment only as mandate authorization", () => {
    expect(validate({
      subscription: providerSubscription({ status: "authenticated" }),
      payment: payment({ amount: 500, status: "authorized", captured: false, invoice_id: null }),
      invoice: null,
      plan: null,
    })).toEqual({ kind: "AUTHORIZATION_ONLY" });
  });

  it("accepts one exact, current, fully settled provider period", () => {
    expect(validate()).toEqual({
      kind: "EXACT_SETTLEMENT",
      expectedAmountSubunits: 59_800,
      periodStart: new Date(periodStart * 1000),
      periodEnd: new Date(periodEnd * 1000),
    });
  });

  it.each([
    ["underpayment", invoice({ amount: 29_900, amount_paid: 29_900 }), payment({ amount: 29_900 }), "EXPECTED_AMOUNT_MISMATCH"],
    ["remaining amount due", invoice({ amount_paid: 49_800, amount_due: 10_000 }), payment({ amount: 49_800 }), "INVOICE_AMOUNT_DUE"],
    ["partial invoice", invoice({ amount_paid: 49_800 }), payment({ amount: 49_800 }), "INVOICE_NOT_FULLY_PAID"],
    ["invoice/payment amount mismatch", invoice(), payment({ amount: 29_900 }), "INVOICE_PAYMENT_AMOUNT_MISMATCH"],
    ["invoice/payment currency mismatch", invoice(), payment({ currency: "USD" }), "CURRENCY_MISMATCH"],
    ["wrong expected currency", invoice({ currency: "USD" }), payment({ currency: "USD" }), "CURRENCY_MISMATCH"],
    ["uncaptured payment", invoice(), payment({ captured: false }), "PAYMENT_NOT_CAPTURED"],
  ])("rejects %s", (_label, invoiceEvidence, paymentEvidence, code) => {
    expect(validate({ invoice: invoiceEvidence, payment: paymentEvidence }))
      .toEqual({ kind: "MISMATCH", code });
  });

  it.each([
    ["invoice subscription", invoice({ subscription_id: "sub_other" }), payment(), "INVOICE_SUBSCRIPTION_MISMATCH"],
    ["payment subscription", invoice(), payment({ subscription_id: "sub_other" }), "PAYMENT_SUBSCRIPTION_MISMATCH"],
    ["payment invoice", invoice(), payment({ invoice_id: "inv_other" }), "INVOICE_PAYMENT_MISMATCH"],
    ["invoice period", invoice({ billing_end: periodEnd + 1 }), payment(), "BILLING_PERIOD_MISMATCH"],
  ])("rejects the wrong %s linkage", (_label, invoiceEvidence, paymentEvidence, code) => {
    expect(validate({ invoice: invoiceEvidence, payment: paymentEvidence }))
      .toEqual({ kind: "MISMATCH", code });
  });

  it("validates the frozen discounted total only during eligible offer cycles", () => {
    const offerIntent = intent({
      ...buildCommercialIntentSnapshot({
        providerMode: "TEST",
        razorpaySubscriptionId: "sub_1",
        razorpayPlanId: "plan_basic",
        plan: "BASIC",
        quantity: 2,
        unitAmountSubunits: 29_900,
        currency: "INR",
        period: "monthly",
        interval: 1,
        offer: {
          razorpayOfferId: "offer_launch",
          discountType: "PERCENTAGE",
          discountValue: 10,
          durationType: "LIMITED_CYCLES",
          durationCycles: 2,
        },
      }),
    });
    expect(validate({
      intent: offerIntent,
      subscription: providerSubscription({ offer_id: "offer_launch", paid_count: 1 }),
      invoice: invoice({ amount: 53_820, amount_paid: 53_820 }),
      payment: payment({ amount: 53_820 }),
    }).kind).toBe("EXACT_SETTLEMENT");
    expect(validate({
      intent: offerIntent,
      subscription: providerSubscription({ offer_id: "offer_launch", paid_count: 1 }),
    })).toEqual({ kind: "MISMATCH", code: "EXPECTED_AMOUNT_MISMATCH" });
    expect(validate({
      intent: offerIntent,
      subscription: providerSubscription({ offer_id: "offer_launch", paid_count: 3 }),
    }).kind).toBe("EXACT_SETTLEMENT");
  });
});
