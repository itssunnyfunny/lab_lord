import { describe, expect, it, vi } from "vitest";
import {
  currentPaidInvoiceCandidates,
  hasCompleteRazorpayInvoiceCollection,
  inspectLegacyPaidEntitlementCandidate,
  legacyPaidEntitlementBatchProposalHash,
  legacyPaidEntitlementIdempotencyKey,
  legacyPaidEntitlementLocalSnapshotHash,
  type LegacyPaidEntitlementCandidate,
  type LegacyPaidEntitlementProviderReader,
} from "@/services/legacyPaidEntitlementTransition.service";
import type {
  RazorpayInvoice,
  RazorpayPayment,
  RazorpayPlan,
  RazorpaySubscription,
} from "@/lib/razorpay";

const now = new Date("2026-08-15T12:00:00.000Z");
const periodStart = Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000);
const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

function candidate(
  overrides: Partial<LegacyPaidEntitlementCandidate["subscription"] & {}> = {}
): LegacyPaidEntitlementCandidate {
  return {
    id: "org_1",
    billingModelVersion: "LEGACY",
    billingMutationSequence: 0,
    billingMutationLeaseToken: null,
    billingMutationLeaseUntil: null,
    subscription: {
      id: "local_sub_1",
      organizationId: "org_1",
      currentOrganizationId: "org_1",
      pendingReplacementOrganizationId: null,
      replacesSubscriptionId: null,
      providerMode: "TEST",
      plan: "BASIC",
      amount: 299,
      amountSubunits: 29_900,
      currency: "INR",
      period: "monthly",
      interval: 1,
      totalCount: 120,
      quantity: 2,
      razorpayPlanId: "plan_basic",
      razorpaySubscriptionId: "sub_1",
      razorpayCustomerId: null,
      status: "ACTIVE",
      authPaymentId: null,
      providerStartAt: null,
      authorizationExpiresAt: null,
      providerPaymentMethod: "UNKNOWN",
      paidThrough: null,
      lastConfirmedInvoiceId: null,
      lastConfirmedPaymentId: null,
      lastPaymentConfirmedAt: null,
      authorizationLapsedAt: null,
      billingOfferId: null,
      confirmedCommercialIntentChangeId: null,
      lastReconciledAt: null,
      currentStart: null,
      currentEnd: null,
      chargeAt: null,
      endedAt: null,
      cancelAtCycleEnd: false,
      cancellationRequestedAt: null,
      cancellationScheduledAt: null,
      cancelledAt: null,
      createdByUserId: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      billingOffer: null,
      replacesSubscription: null,
      confirmedCommercialIntentChange: null,
      invoices: [],
      ...overrides,
    },
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

function providerReader(
  invoices: RazorpayInvoice[] = [invoice()]
): LegacyPaidEntitlementProviderReader {
  return {
    fetchSubscription: vi.fn(async () => providerSubscription()),
    fetchSubscriptionInvoices: vi.fn(async () => ({
      entity: "collection" as const,
      count: invoices.length,
      items: invoices,
    })),
    fetchPayment: vi.fn(async () => payment()),
    fetchPlan: vi.fn(async () => providerPlan()),
  };
}

describe("legacy paid-entitlement transition inspection", () => {
  it.each(["ACTIVE", "AUTHENTICATED"] as const)(
    "never infers paid access from a %s provider subscription without settlement",
    async status => {
      const provider = providerReader([]);
      vi.mocked(provider.fetchSubscription).mockResolvedValue(
        providerSubscription({ status: status.toLowerCase() })
      );

      const result = await inspectLegacyPaidEntitlementCandidate({
        candidate: candidate({ status }),
        providerMode: "TEST",
        provider,
        now,
      });

      expect(result).toMatchObject({
        disposition: "MANUAL_REVIEW_REQUIRED",
        manualReviewCode: "CURRENT_PAID_INVOICE_MISSING",
        proposedPaidThrough: null,
      });
      expect(provider.fetchPayment).not.toHaveBeenCalled();
      expect(provider.fetchPlan).not.toHaveBeenCalled();
    }
  );

  it("refuses an incomplete provider invoice collection", async () => {
    const provider = providerReader();
    vi.mocked(provider.fetchSubscriptionInvoices).mockResolvedValue({
      entity: "collection",
      count: 2,
      items: [invoice()],
    });

    const result = await inspectLegacyPaidEntitlementCandidate({
      candidate: candidate(),
      providerMode: "TEST",
      provider,
      now,
    });

    expect(result.manualReviewCode).toBe("INCOMPLETE_INVOICE_COLLECTION");
    expect(provider.fetchPayment).not.toHaveBeenCalled();
  });

  it("refuses multiple plausible current paid invoices", async () => {
    const provider = providerReader([
      invoice(),
      invoice({ id: "inv_2", payment_id: "pay_2" }),
    ]);

    const result = await inspectLegacyPaidEntitlementCandidate({
      candidate: candidate(),
      providerMode: "TEST",
      provider,
      now,
    });

    expect(result.manualReviewCode).toBe("AMBIGUOUS_CURRENT_PAID_INVOICES");
    expect(provider.fetchPayment).not.toHaveBeenCalled();
    expect(provider.fetchPlan).not.toHaveBeenCalled();
  });

  it("accepts only one exact subscription, invoice, payment, and plan tuple", async () => {
    const provider = providerReader();

    const first = await inspectLegacyPaidEntitlementCandidate({
      candidate: candidate(),
      providerMode: "TEST",
      provider,
      now,
    });
    const second = await inspectLegacyPaidEntitlementCandidate({
      candidate: candidate(),
      providerMode: "TEST",
      provider,
      now,
    });

    expect(first).toMatchObject({
      disposition: "EXACT_SETTLEMENT",
      manualReviewCode: null,
      proposedPaidThrough: new Date(periodEnd * 1000),
      providerInvoiceId: "inv_1",
      providerPaymentId: "pay_1",
    });
    expect(first.proposalHash).toBe(second.proposalHash);
    expect(first.commercialIntent).toMatchObject({
      authorizedRazorpaySubscriptionId: "sub_1",
      authorizedRazorpayPlanId: "plan_basic",
      authorizedQuantity: 2,
      authorizedExpectedAmountSubunits: 59_800,
    });
  });

  it("fails closed on mode mismatch before any provider read", async () => {
    const provider = providerReader();

    const result = await inspectLegacyPaidEntitlementCandidate({
      candidate: candidate({ providerMode: "LIVE" }),
      providerMode: "TEST",
      provider,
      now,
    });

    expect(result.manualReviewCode).toBe("PROVIDER_MODE_MISMATCH");
    expect(provider.fetchSubscription).not.toHaveBeenCalled();
    expect(provider.fetchSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it("fails closed while another billing mutation owns the organization lease", async () => {
    const provider = providerReader();
    const leased = candidate();
    leased.billingMutationLeaseToken = "lease_1";
    leased.billingMutationLeaseUntil = new Date("2026-08-15T12:10:00.000Z");

    const result = await inspectLegacyPaidEntitlementCandidate({
      candidate: leased,
      providerMode: "TEST",
      provider,
      now,
    });

    expect(result.manualReviewCode).toBe("BILLING_MUTATION_IN_FLIGHT");
    expect(provider.fetchSubscription).not.toHaveBeenCalled();
  });

  it("rejects exact-looking settlement whose frozen amount does not match", async () => {
    const provider = providerReader();
    vi.mocked(provider.fetchPayment).mockResolvedValue(payment({ amount: 29_900 }));

    const result = await inspectLegacyPaidEntitlementCandidate({
      candidate: candidate(),
      providerMode: "TEST",
      provider,
      now,
    });

    expect(result.manualReviewCode).toBe("INVOICE_PAYMENT_AMOUNT_MISMATCH");
  });
});

describe("legacy paid-entitlement transition fences", () => {
  it("requires collection completeness in addition to valid item shape", () => {
    expect(hasCompleteRazorpayInvoiceCollection({
      entity: "collection",
      count: 1,
      items: [invoice()],
    })).toBe(true);
    expect(hasCompleteRazorpayInvoiceCollection({
      entity: "collection",
      count: 2,
      items: [invoice()],
    })).toBe(false);
  });

  it("matches only paid invoices for the provider current period", () => {
    expect(currentPaidInvoiceCandidates(providerSubscription(), [
      invoice(),
      invoice({ id: "inv_old", billing_start: periodStart - 10, billing_end: periodEnd - 10 }),
      invoice({ id: "inv_pending", status: "issued" }),
    ]).map(value => value.id)).toEqual(["inv_1"]);
  });

  it("uses a stable operation key while snapshot and batch hashes fence changes", () => {
    const original = candidate();
    const changed = candidate({ quantity: 3 });
    expect(legacyPaidEntitlementIdempotencyKey({
      organizationId: "org_1",
      organizationSubscriptionId: "local_sub_1",
    })).toBe("legacy-paid-entitlement-transition:v1:org_1:local_sub_1");
    expect(legacyPaidEntitlementLocalSnapshotHash(original))
      .not.toBe(legacyPaidEntitlementLocalSnapshotHash(changed));
    expect(legacyPaidEntitlementBatchProposalHash([
      { organizationId: "org_b", proposalHash: "b" },
      { organizationId: "org_a", proposalHash: "a" },
    ])).toBe(legacyPaidEntitlementBatchProposalHash([
      { organizationId: "org_a", proposalHash: "a" },
      { organizationId: "org_b", proposalHash: "b" },
    ]));
  });
});
