import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  localFindUnique: vi.fn(),
  localFindUniqueOrThrow: vi.fn(),
  organizationFindUnique: vi.fn(),
  organizationFindUniqueOrThrow: vi.fn(),
  organizationUpdate: vi.fn(),
  changeFindUnique: vi.fn(),
  changeFindFirst: vi.fn(),
  changeFindUniqueOrThrow: vi.fn(),
  changeAggregate: vi.fn(),
  changeCreate: vi.fn(),
  changeUpdate: vi.fn(),
  changeUpdateMany: vi.fn(),
  subscriptionUpdate: vi.fn(),
  branchUpdateMany: vi.fn(),
  transaction: vi.fn(),
  fetchSubscription: vi.fn(),
  fetchSubscriptionInvoices: vi.fn(),
  fetchPayment: vi.fn(),
  fetchPlan: vi.fn(),
  recordBillingMutationAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organizationSubscription: { findUnique: mocks.localFindUnique },
    organization: { findUnique: mocks.organizationFindUnique },
    organizationBillingChange: {
      findUnique: mocks.changeFindUnique,
      findFirst: mocks.changeFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/razorpay", () => ({
  resolveRazorpayMode: () => "TEST",
  fromRazorpaySubunits: (value: number) => value / 100,
  getRazorpayClient: () => ({
    fetchSubscription: mocks.fetchSubscription,
    fetchSubscriptionInvoices: mocks.fetchSubscriptionInvoices,
    fetchPayment: mocks.fetchPayment,
    fetchPlan: mocks.fetchPlan,
  }),
}));

vi.mock("@/services/billingMutationAudit.service", () => ({
  recordBillingMutationAudit: mocks.recordBillingMutationAudit,
}));

vi.mock("@/services/billingPaymentMethod.service", () => ({
  normalizeProviderPaymentMethod: (method: string | null | undefined) => {
    const normalized = method?.toUpperCase();
    return normalized === "CARD" || normalized === "UPI" || normalized === "EMANDATE"
      ? normalized
      : "UNKNOWN";
  },
  isSupportedProviderPaymentMethod: (method: string) => ["CARD", "UPI", "EMANDATE"].includes(method),
}));

import { BillingReconciliationService } from "@/services/billingReconciliation.service";

const now = new Date("2026-08-10T12:00:00.000Z");
const updatedAt = new Date("2026-08-10T11:00:00.000Z");

function localSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "source_row",
    organizationId: "org_1",
    currentOrganizationId: "org_1",
    pendingReplacementOrganizationId: null,
    providerMode: "TEST",
    plan: "BASIC",
    amount: 299,
    amountSubunits: 29900,
    currency: "INR",
    period: "monthly",
    interval: 1,
    quantity: 1,
    totalCount: 120,
    razorpayPlanId: "plan_basic",
    razorpaySubscriptionId: "sub_source",
    status: "ACTIVE",
    providerPaymentMethod: "UPI",
    cancellationRequestedAt: null,
    cancelAtCycleEnd: false,
    cancellationScheduledAt: null,
    paidThrough: new Date("2026-09-01T00:00:00.000Z"),
    lastConfirmedInvoiceId: null,
    lastConfirmedPaymentId: null,
    billingOfferId: null,
    confirmedCommercialIntentChangeId: "confirmed_source",
    updatedAt,
    ...overrides,
  };
}

function commercialIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "confirmed_source",
    organizationId: "org_1",
    organizationSubscriptionId: "source_row",
    replacementSubscriptionId: null,
    branchId: null,
    sequence: 1,
    type: "SUBSCRIPTION_AUTHORIZATION",
    status: "APPLIED",
    operationStatus: "APPLIED",
    fromPlan: "BASIC",
    toPlan: "BASIC",
    fromQuantity: 1,
    toQuantity: 1,
    failureCategory: null,
    failureCode: null,
    attemptCount: 0,
    accessGrantedAt: null,
    accessRevokedAt: null,
    commercialIntentVersion: 1,
    commercialIntentCapturedAt: new Date("2026-07-01T00:00:00.000Z"),
    authorizedProviderMode: "TEST",
    authorizedSourceRazorpaySubscriptionId: "sub_source",
    authorizedRazorpaySubscriptionId: "sub_source",
    authorizedSourceRazorpayPlanId: "plan_basic",
    authorizedRazorpayPlanId: "plan_basic",
    authorizedPlan: "BASIC",
    authorizedQuantity: 1,
    authorizedRazorpayOfferId: null,
    authorizedUnitAmountSubunits: 29900,
    authorizedGrossAmountSubunits: 29900,
    authorizedExpectedAmountSubunits: 29900,
    authorizedOfferValidThroughPaidCount: null,
    authorizedCurrency: "INR",
    authorizedPeriod: "monthly",
    authorizedInterval: 1,
    providerConfirmedAt: new Date("2026-07-01T00:00:00.000Z"),
    effectiveAt: null,
    updatedAt,
    ...overrides,
  };
}

function providerSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_source",
    entity: "subscription",
    plan_id: "plan_basic",
    status: "active",
    total_count: 120,
    quantity: 1,
    offer_id: null,
    payment_method: "upi",
    ...overrides,
  };
}

describe("replacement reconciliation trust contracts", () => {
  let local: ReturnType<typeof localSubscription>;
  let intent: ReturnType<typeof commercialIntent> | null;
  let sourceReplacement: {
    id: string;
    organizationId: string;
    organizationSubscriptionId: string;
    replacementSubscriptionId: string;
    sequence: number;
    status: string;
    operationStatus: string;
    effectiveAt: Date;
    providerConfirmedAt: Date | null;
    updatedAt: Date;
    [key: string]: unknown;
  } | null;
  let manualReviews: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    local = localSubscription();
    intent = commercialIntent();
    sourceReplacement = null;
    manualReviews = [];

    mocks.localFindUnique.mockImplementation(async () => ({ ...local }));
    mocks.localFindUniqueOrThrow.mockImplementation(async () => ({ ...local }));
    mocks.organizationFindUnique.mockResolvedValue({ billingMutationSequence: 2 });
    mocks.organizationFindUniqueOrThrow.mockResolvedValue({ billingMutationSequence: 2 });
    mocks.organizationUpdate.mockResolvedValue({ billingMutationSequence: 3 });
    mocks.fetchSubscription.mockResolvedValue(providerSubscription());
    mocks.fetchSubscriptionInvoices.mockResolvedValue({ entity: "collection", count: 0, items: [] });
    mocks.fetchPayment.mockResolvedValue(null);
    mocks.fetchPlan.mockResolvedValue(null);
    mocks.recordBillingMutationAudit.mockResolvedValue(undefined);
    mocks.subscriptionUpdate.mockImplementation(async ({ data }) => {
      local = { ...local, ...data };
      return { ...local };
    });
    mocks.branchUpdateMany.mockResolvedValue({ count: 1 });
    mocks.changeUpdateMany.mockImplementation(async ({ where, data }) => {
      if (intent?.id === where.id) intent = { ...intent, ...data } as ReturnType<typeof commercialIntent>;
      if (sourceReplacement?.id === where.id) sourceReplacement = { ...sourceReplacement, ...data };
      return { count: 1 };
    });
    mocks.changeAggregate.mockResolvedValue({ _max: { sequence: 2 } });
    mocks.changeCreate.mockImplementation(async ({ data }) => {
      const created = {
        id: `manual_review_${manualReviews.length + 1}`,
        attemptCount: 0,
        ...data,
      };
      manualReviews.push(created);
      return created;
    });
    mocks.changeUpdate.mockImplementation(async ({ where, data }) => {
      const index = manualReviews.findIndex(review => review.id === where.id);
      if (index >= 0) {
        manualReviews[index] = { ...manualReviews[index], ...data };
        return manualReviews[index];
      }
      throw new Error("Billing change not found");
    });
    mocks.changeFindUnique.mockImplementation(async ({ where }) => {
      if (where.id && where.id === intent?.id) return intent;
      if (where.id && where.id === sourceReplacement?.id) return sourceReplacement;
      if (where.idempotencyKey) {
        return manualReviews.find(review => review.idempotencyKey === where.idempotencyKey) ?? null;
      }
      if (where.replacementSubscriptionId) {
        return intent?.replacementSubscriptionId === where.replacementSubscriptionId ? intent : null;
      }
      return null;
    });
    mocks.changeFindUniqueOrThrow.mockImplementation(async ({ where }) => {
      if (where.id && where.id === intent?.id) return intent;
      if (where.id && where.id === sourceReplacement?.id) return sourceReplacement;
      throw new Error("Billing change not found");
    });
    mocks.changeFindFirst.mockImplementation(async ({ where }) => {
      if (where.replacementSubscriptionId?.not === null) return sourceReplacement;
      if (where.id === intent?.id) return intent;
      if (where.type === "SUBSCRIPTION_AUTHORIZATION"
        && Array.isArray(where.operationStatus?.in)
        && where.operationStatus.in.includes(intent?.operationStatus)) return intent;
      return null;
    });

    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "org_1" }]),
      organization: {
        findUniqueOrThrow: mocks.organizationFindUniqueOrThrow,
        update: mocks.organizationUpdate,
      },
      organizationSubscription: {
        findUnique: mocks.localFindUnique,
        findUniqueOrThrow: mocks.localFindUniqueOrThrow,
        update: mocks.subscriptionUpdate,
      },
      organizationBillingChange: {
        findUnique: mocks.changeFindUnique,
        findUniqueOrThrow: mocks.changeFindUniqueOrThrow,
        aggregate: mocks.changeAggregate,
        create: mocks.changeCreate,
        update: mocks.changeUpdate,
        updateMany: mocks.changeUpdateMany,
      },
      branch: { update: vi.fn(), updateMany: mocks.branchUpdateMany },
      organizationSubscriptionInvoice: { findUnique: vi.fn(), upsert: vi.fn() },
      organizationSubscriptionHistory: { upsert: vi.fn() },
      organizationOfferGrant: { updateMany: vi.fn() },
    };
    mocks.transaction.mockImplementation(async callback => callback(tx));
  });

  it("recovers a response-lost source cancellation from exact provider scheduling facts", async () => {
    const effectiveAt = new Date("2026-09-01T00:00:00.000Z");
    sourceReplacement = {
      id: "replacement_schedule",
      organizationId: "org_1",
      organizationSubscriptionId: "source_row",
      replacementSubscriptionId: "candidate_row",
      sequence: 2,
      status: "SCHEDULED",
      operationStatus: "SCHEDULED",
      effectiveAt,
      providerConfirmedAt: null,
      updatedAt,
    };
    mocks.fetchSubscription.mockResolvedValue(providerSubscription({
      has_scheduled_changes: true,
      change_scheduled_at: Math.floor(effectiveAt.getTime() / 1000),
    }));

    const result = await BillingReconciliationService.reconcileProviderSubscription("sub_source", { now });

    expect(result).toMatchObject({
      evidenceKind: "PENDING",
      subscription: {
        cancelAtCycleEnd: true,
        cancellationRequestedAt: now,
        cancellationScheduledAt: effectiveAt,
      },
    });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "replacement_schedule", status: "SCHEDULED" }),
      data: expect.objectContaining({ operationStatus: "SCHEDULED", lastError: null }),
    }));
  });

  it("quarantines candidate plan drift, revokes access, and preserves local commercial state", async () => {
    local = localSubscription({
      id: "candidate_row",
      currentOrganizationId: null,
      pendingReplacementOrganizationId: "org_1",
      plan: "PRO",
      amount: 499,
      amountSubunits: 49900,
      quantity: 2,
      razorpayPlanId: "plan_expected",
      razorpaySubscriptionId: "sub_candidate",
      status: "AUTHENTICATED",
      confirmedCommercialIntentChangeId: null,
    });
    intent = commercialIntent({
      id: "change_drift",
      organizationSubscriptionId: "source_row",
      replacementSubscriptionId: "candidate_row",
      branchId: "branch_2",
      type: "QUANTITY_INCREASE",
      status: "SCHEDULED",
      operationStatus: "SCHEDULED",
      fromPlan: "PRO",
      toPlan: "PRO",
      fromQuantity: 1,
      toQuantity: 2,
      accessGrantedAt: new Date("2026-08-09T00:00:00.000Z"),
      authorizedSourceRazorpaySubscriptionId: "sub_source",
      authorizedRazorpaySubscriptionId: "sub_candidate",
      authorizedSourceRazorpayPlanId: "plan_expected",
      authorizedRazorpayPlanId: "plan_expected",
      authorizedPlan: "PRO",
      authorizedQuantity: 2,
      authorizedUnitAmountSubunits: 49900,
      authorizedGrossAmountSubunits: 99800,
      authorizedExpectedAmountSubunits: 99800,
    });
    mocks.fetchSubscription.mockResolvedValue(providerSubscription({
      id: "sub_candidate",
      plan_id: "plan_unknown",
      status: "authenticated",
      quantity: 2,
    }));

    await expect(BillingReconciliationService.reconcileProviderSubscription(
      "sub_candidate",
      { now }
    )).rejects.toMatchObject({
      name: "BillingManualReviewRequiredError",
      code: "BILLING_MANUAL_REVIEW_REQUIRED",
      changeId: "change_drift",
    });

    expect(intent).toMatchObject({
      status: "FAILED",
      operationStatus: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "PROVIDER_PLAN_MISMATCH",
      accessRevokedAt: now,
    });
    expect(local).toMatchObject({ plan: "PRO", quantity: 2, razorpayPlanId: "plan_expected" });
    expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
    expect(mocks.branchUpdateMany).toHaveBeenCalledWith({
      where: { id: "branch_2", billingStatus: "ACTIVE" },
      data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
    });
  });

  it("does not reinterpret a promoted subscription's historical replacement as candidate drift", async () => {
    local = localSubscription({
      plan: "PRO",
      amount: 499,
      amountSubunits: 49900,
      quantity: 2,
      razorpayPlanId: "plan_standard",
      providerPaymentMethod: "CARD",
      confirmedCommercialIntentChangeId: "historical_change",
    });
    intent = commercialIntent({
      id: "historical_change",
      replacementSubscriptionId: local.id,
      type: "QUANTITY_INCREASE",
      fromPlan: "PRO",
      toPlan: "PRO",
      fromQuantity: 1,
      toQuantity: 2,
      authorizedRazorpayPlanId: "plan_standard",
      authorizedPlan: "PRO",
      authorizedQuantity: 2,
      authorizedUnitAmountSubunits: 49900,
      authorizedGrossAmountSubunits: 99800,
      authorizedExpectedAmountSubunits: 99800,
    });
    mocks.fetchSubscription.mockResolvedValue(providerSubscription({
      plan_id: "plan_standard",
      quantity: 2,
      payment_method: "card",
    }));

    await expect(BillingReconciliationService.reconcileProviderSubscription("sub_source", { now }))
      .resolves.toMatchObject({ evidenceKind: "PENDING", confirmedPaidPeriod: false });

    expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.branchUpdateMany).not.toHaveBeenCalled();
  });

  it("refetches instead of resurrecting a candidate changed while provider state was in flight", async () => {
    const cancelledAt = new Date("2026-08-10T11:30:00.000Z");
    const beforeFetch = localSubscription();
    const cancelled = localSubscription({ status: "CANCELLED", updatedAt: cancelledAt, endedAt: cancelledAt });
    mocks.localFindUnique.mockResolvedValueOnce(beforeFetch).mockResolvedValueOnce(cancelled);
    mocks.localFindUniqueOrThrow.mockResolvedValue(cancelled);
    intent = commercialIntent({
      status: "AWAITING_PAYMENT",
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
    });
    mocks.fetchSubscription
      .mockResolvedValueOnce(providerSubscription())
      .mockResolvedValueOnce(providerSubscription({ status: "cancelled", ended_at: 1786361400 }));
    mocks.fetchPayment.mockResolvedValue({
      id: "pay_auth",
      entity: "payment",
      amount: 29900,
      currency: "INR",
      status: "authorized",
      subscription_id: "sub_source",
      method: "upi",
      captured: false,
      invoice_id: null,
    });

    const result = await BillingReconciliationService.reconcileProviderSubscription(
      "sub_source",
      { now, paymentId: "pay_auth" }
    );

    expect(mocks.fetchSubscription).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ evidenceKind: "PENDING", subscription: { status: "CANCELLED" } });
    expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("quarantines a provider response for a different subscription identity", async () => {
    mocks.fetchSubscription.mockResolvedValue(providerSubscription({ id: "sub_other" }));

    await expect(BillingReconciliationService.reconcileProviderSubscription(
      "sub_source",
      { now }
    )).rejects.toMatchObject({
      name: "BillingManualReviewRequiredError",
      code: "BILLING_MANUAL_REVIEW_REQUIRED",
      changeId: "manual_review_1",
    });

    expect(intent).toMatchObject({
      status: "APPLIED",
      operationStatus: "APPLIED",
      failureCategory: null,
      failureCode: null,
    });
    expect(manualReviews).toContainEqual(expect.objectContaining({
      id: "manual_review_1",
      type: "COMMERCIAL_RECONCILIATION",
      status: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SUBSCRIPTION_MISMATCH",
    }));
    expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
  });
});
