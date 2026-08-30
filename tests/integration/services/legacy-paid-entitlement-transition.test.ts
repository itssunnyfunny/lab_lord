import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntitlementService } from "@/services/entitlement.service";
import {
  LegacyPaidEntitlementTransitionService,
  type LegacyPaidEntitlementProviderReader,
} from "@/services/legacyPaidEntitlementTransition.service";
import type {
  RazorpayInvoice,
  RazorpayInvoices,
  RazorpayPayment,
  RazorpayPlan,
  RazorpaySubscription,
} from "@/lib/razorpay";
import { createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

const now = new Date("2026-08-15T12:00:00.000Z");
const periodStart = Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000);
const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);
const periodEndDate = new Date(periodEnd * 1000);

function providerSubscription(): RazorpaySubscription {
  return {
    id: "sub_legacy_pro",
    entity: "subscription",
    plan_id: "plan_legacy_pro",
    status: "active",
    total_count: 120,
    quantity: 1,
    paid_count: 1,
    remaining_count: 119,
    current_start: periodStart,
    current_end: periodEnd,
    charge_at: periodEnd,
    ended_at: null,
    offer_id: null,
  };
}

function invoice(overrides: Partial<RazorpayInvoice> = {}): RazorpayInvoice {
  return {
    id: "inv_legacy_pro",
    entity: "invoice",
    subscription_id: "sub_legacy_pro",
    payment_id: "pay_legacy_pro",
    status: "paid",
    amount: 49_900,
    amount_paid: 49_900,
    amount_due: 0,
    currency: "INR",
    billing_start: periodStart,
    billing_end: periodEnd,
    issued_at: periodStart,
    paid_at: periodStart + 60,
    ...overrides,
  };
}

function payment(): RazorpayPayment {
  return {
    id: "pay_legacy_pro",
    entity: "payment",
    invoice_id: "inv_legacy_pro",
    subscription_id: "sub_legacy_pro",
    amount: 49_900,
    currency: "INR",
    status: "captured",
    captured: true,
    method: "card",
    order_id: null,
  };
}

function plan(): RazorpayPlan {
  return {
    id: "plan_legacy_pro",
    entity: "plan",
    period: "monthly",
    interval: 1,
    item: {
      amount: 49_900,
      currency: "INR",
      name: "Lab Lords Standard",
    },
  };
}

function exactInvoices(): RazorpayInvoices {
  return { entity: "collection", count: 1, items: [invoice()] };
}

function providerReader(): LegacyPaidEntitlementProviderReader {
  return {
    fetchSubscription: vi.fn(async () => providerSubscription()),
    fetchSubscriptionInvoices: vi.fn(async () => exactInvoices()),
    fetchPayment: vi.fn(async () => payment()),
    fetchPlan: vi.fn(async () => plan()),
  };
}

async function legacySubscription(paidThrough: Date | null = null) {
  const owner = await createUser();
  const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "LEGACY" });
  const subscription = await testPrisma.organizationSubscription.create({
    data: {
      organizationId: organization.id,
      currentOrganizationId: organization.id,
      providerMode: "TEST",
      plan: "PRO",
      amount: 499,
      amountSubunits: 49_900,
      currency: "INR",
      period: "monthly",
      interval: 1,
      totalCount: 120,
      quantity: 1,
      razorpayPlanId: "plan_legacy_pro",
      razorpaySubscriptionId: "sub_legacy_pro",
      status: "ACTIVE",
      paidThrough,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  });
  return { owner, organization, subscription };
}

describe("legacy paid-entitlement transition", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("RAZORPAY_MODE", "TEST");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_legacy_transition");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it("dry-runs without writes, applies the exact period, and reruns idempotently", async () => {
    const { owner, organization, subscription } = await legacySubscription(
      new Date("2026-10-01T00:00:00.000Z")
    );
    const provider = providerReader();

    await expect(EntitlementService.getOrganizationProfile(organization.id))
      .resolves.toMatchObject({ effectivePlan: "BASIC", canWrite: true });

    const dryRun = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
    });

    expect(dryRun).toMatchObject({
      mode: "dry-run",
      providerMutations: 0,
      preCounts: {
        legacySubscriptions: 1,
        statusOnlyPremiumCandidates: 1,
        currentUnbackedPaidThrough: 1,
        exactBackedCurrentPeriods: 0,
      },
      proposalCounts: { exactSettlements: 1, applied: 0 },
    });
    await expect(testPrisma.organizationBillingChange.count()).resolves.toBe(0);
    await expect(testPrisma.organizationSubscriptionInvoice.count()).resolves.toBe(0);

    await expect(LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
      apply: true,
      confirmedBatchProposalHash: "0".repeat(64),
    })).rejects.toThrow("exact batch proposal hash");
    await expect(testPrisma.organizationBillingChange.count()).resolves.toBe(0);

    const applied = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
      apply: true,
      confirmedBatchProposalHash: dryRun.batchProposalHash,
    });

    expect(applied).toMatchObject({
      mode: "apply",
      proposalCounts: { applied: 1 },
      postCounts: {
        exactBackedCurrentPeriods: 1,
        currentUnbackedPaidThrough: 0,
      },
    });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    })).resolves.toMatchObject({
      paidThrough: periodEndDate,
      currentEnd: periodEndDate,
      lastConfirmedInvoiceId: "inv_legacy_pro",
      lastConfirmedPaymentId: "pay_legacy_pro",
    });
    await expect(EntitlementService.getOrganizationProfile(organization.id))
      .resolves.toMatchObject({ effectivePlan: "PRO", canWrite: true });

    const rerun = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
    });
    expect(rerun.proposalCounts).toMatchObject({ alreadyEvidenceBacked: 1, applied: 0 });
    const rerunApply = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
      apply: true,
      confirmedBatchProposalHash: rerun.batchProposalHash,
    });
    expect(rerunApply.proposalCounts.applied).toBe(0);
    await expect(testPrisma.organizationBillingChange.count()).resolves.toBe(1);
    await expect(testPrisma.organizationSubscriptionInvoice.count()).resolves.toBe(1);
  });

  it("persists ambiguous evidence for manual review without changing entitlement", async () => {
    const { organization, subscription } = await legacySubscription();
    const provider = providerReader();
    vi.mocked(provider.fetchSubscriptionInvoices).mockResolvedValue({
      entity: "collection",
      count: 2,
      items: [invoice(), invoice({ id: "inv_legacy_duplicate", payment_id: "pay_duplicate" })],
    });

    const dryRun = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
    });
    expect(dryRun.rows[0]).toMatchObject({
      disposition: "MANUAL_REVIEW_REQUIRED",
      manualReviewCode: "AMBIGUOUS_CURRENT_PAID_INVOICES",
      persistedManualReview: false,
    });
    await expect(testPrisma.organizationBillingChange.count()).resolves.toBe(0);

    const applied = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
      apply: true,
      confirmedBatchProposalHash: dryRun.batchProposalHash,
    });
    expect(applied.rows[0]).toMatchObject({
      disposition: "MANUAL_REVIEW_REQUIRED",
      manualReviewCode: "AMBIGUOUS_CURRENT_PAID_INVOICES",
      persistedManualReview: true,
      applied: false,
    });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    })).resolves.toMatchObject({ paidThrough: null, confirmedCommercialIntentChangeId: null });
    await expect(testPrisma.organizationBillingChange.findFirstOrThrow({
      where: { organizationId: organization.id },
    })).resolves.toMatchObject({
      type: "LEGACY_TRANSITION",
      status: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "AMBIGUOUS_CURRENT_PAID_INVOICES",
    });
    await expect(testPrisma.organizationSubscriptionHistory.count({
      where: { organizationId: organization.id, event: { contains: "MANUAL_REVIEW_REQUIRED" } },
    })).resolves.toBe(1);
  });

  it("re-fetches provider evidence before apply and quarantines a changed proposal", async () => {
    const { organization, subscription } = await legacySubscription();
    const provider = providerReader();
    const dryRun = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
    });
    vi.mocked(provider.fetchSubscriptionInvoices)
      .mockResolvedValueOnce(exactInvoices())
      .mockResolvedValueOnce({ entity: "collection", count: 0, items: [] });

    const result = await LegacyPaidEntitlementTransitionService.run({
      organizationIds: [organization.id],
      providerMode: "TEST",
      provider,
      now,
      apply: true,
      confirmedBatchProposalHash: dryRun.batchProposalHash,
    });

    expect(result.rows[0]).toMatchObject({
      disposition: "MANUAL_REVIEW_REQUIRED",
      manualReviewCode: "CURRENT_PAID_INVOICE_MISSING",
      persistedManualReview: true,
      applied: false,
    });
    expect(provider.fetchSubscriptionInvoices).toHaveBeenCalledTimes(3);
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    })).resolves.toMatchObject({ paidThrough: null, lastConfirmedInvoiceId: null });
    await expect(testPrisma.organizationSubscriptionInvoice.count()).resolves.toBe(0);
  });
});
