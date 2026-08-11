import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  localFindUnique: vi.fn(),
  transaction: vi.fn(),
  fetchSubscription: vi.fn(),
  fetchSubscriptionInvoices: vi.fn(),
  fetchPayment: vi.fn(),
  changeFindUnique: vi.fn(),
  changeFindFirst: vi.fn(),
  changeUpdate: vi.fn(),
  planFindFirst: vi.fn(),
  subscriptionUpdate: vi.fn(),
  invoiceUpsert: vi.fn(),
  historyUpsert: vi.fn(),
  branchUpdateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organizationSubscription: { findUnique: mocks.localFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/razorpay", () => ({
  resolveRazorpayMode: () => "TEST",
  getRazorpayClient: () => ({
    fetchSubscription: mocks.fetchSubscription,
    fetchSubscriptionInvoices: mocks.fetchSubscriptionInvoices,
    fetchPayment: mocks.fetchPayment,
  }),
}));

vi.mock("@/services/billingPaymentMethod.service", () => ({
  normalizeProviderPaymentMethod: (method: string | null | undefined) => {
    if (method?.toLowerCase() === "upi") return "UPI";
    if (method?.toLowerCase() === "card") return "CARD";
    return "UNKNOWN";
  },
  isSupportedProviderPaymentMethod: (method: string) => ["CARD", "UPI", "EMANDATE"].includes(method),
}));

import { BillingReconciliationService } from "@/services/billingReconciliation.service";

const now = new Date("2026-08-10T12:00:00.000Z");

function localSubscription(overrides: Record<string, unknown> = {}) {
  const updatedAt = new Date("2026-08-10T11:00:00.000Z");
  return {
    id: "source_row",
    organizationId: "org_1",
    providerMode: "TEST",
    plan: "BASIC",
    amount: 299,
    amountSubunits: 29900,
    currency: "INR",
    period: "monthly",
    interval: 1,
    quantity: 1,
    razorpayPlanId: "plan_basic",
    razorpaySubscriptionId: "sub_source",
    status: "ACTIVE",
    providerPaymentMethod: "UPI",
    cancellationRequestedAt: null,
    paidThrough: new Date("2026-09-01T00:00:00.000Z"),
    lastConfirmedInvoiceId: null,
    lastConfirmedPaymentId: null,
    billingOfferId: null,
    updatedAt,
    ...overrides,
  };
}

describe("replacement reconciliation trust contracts", () => {
  let local: ReturnType<typeof localSubscription>;
  let linkedReplacement: Record<string, unknown> | null;
  let linkedSourceReplacement: Record<string, unknown> | null;
  let providerPlan: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    local = localSubscription();
    linkedReplacement = null;
    linkedSourceReplacement = null;
    providerPlan = {
      providerMode: "TEST",
      plan: "BASIC",
      razorpayPlanId: "plan_basic",
      amount: 299,
      amountSubunits: 29900,
      currency: "INR",
      period: "monthly",
      interval: 1,
      active: false,
    };
    mocks.localFindUnique.mockImplementation(async () => ({ ...local }));
    mocks.fetchSubscriptionInvoices.mockResolvedValue({ items: [] });
    mocks.changeFindUnique.mockImplementation(async () => linkedReplacement);
    mocks.changeFindFirst.mockImplementation(async args => {
      if (args.where?.replacementSubscriptionId?.not === null) {
        return linkedSourceReplacement;
      }
      return null;
    });
    mocks.planFindFirst.mockImplementation(async () => providerPlan);
    mocks.changeUpdate.mockImplementation(async ({ data }) => ({
      ...(linkedReplacement ?? linkedSourceReplacement ?? {}),
      ...data,
    }));
    mocks.subscriptionUpdate.mockImplementation(async ({ data }) => {
      local = { ...local, ...data };
      return { ...local };
    });
    mocks.invoiceUpsert.mockResolvedValue({});
    mocks.historyUpsert.mockResolvedValue({});
    mocks.branchUpdateMany.mockResolvedValue({ count: 1 });

    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "org_1" }]),
      organizationSubscription: {
        findUnique: mocks.localFindUnique,
        update: mocks.subscriptionUpdate,
      },
      organizationBillingChange: {
        findUnique: mocks.changeFindUnique,
        findFirst: mocks.changeFindFirst,
        update: mocks.changeUpdate,
      },
      saasRazorpayPlan: { findFirst: mocks.planFindFirst },
      organizationSubscriptionInvoice: { upsert: mocks.invoiceUpsert },
      organizationSubscriptionHistory: { upsert: mocks.historyUpsert },
      organizationOfferGrant: { updateMany: vi.fn() },
      branch: {
        update: vi.fn(),
        updateMany: mocks.branchUpdateMany,
      },
    };
    mocks.transaction.mockImplementation(async callback => callback(tx));
  });

  it("recovers a response-lost source cancellation from exact provider scheduling facts", async () => {
    const effectiveAt = new Date("2026-09-01T00:00:00.000Z");
    linkedSourceReplacement = {
      id: "change_1",
      organizationId: "org_1",
      organizationSubscriptionId: "source_row",
      replacementSubscriptionId: "candidate_row",
      status: "SCHEDULED",
      effectiveAt,
    };
    mocks.fetchSubscription.mockResolvedValue({
      id: "sub_source",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "active",
      total_count: 120,
      quantity: 1,
      payment_method: "upi",
      has_scheduled_changes: true,
      change_scheduled_at: Math.floor(effectiveAt.getTime() / 1000),
    });

    const result = await BillingReconciliationService.reconcileProviderSubscription(
      "sub_source",
      { now }
    );

    expect(result.subscription).toMatchObject({
      cancelAtCycleEnd: true,
      cancellationRequestedAt: now,
      cancellationScheduledAt: effectiveAt,
    });
    expect(mocks.subscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cancelAtCycleEnd: true,
        cancellationRequestedAt: now,
        cancellationScheduledAt: effectiveAt,
      }),
    }));
  });

  it("fails unknown candidate plan drift closed, revokes access, and keeps reconciliation durable", async () => {
    local = localSubscription({
      id: "candidate_row",
      plan: "PRO",
      amount: 499,
      amountSubunits: 49900,
      quantity: 2,
      razorpayPlanId: "plan_expected",
      razorpaySubscriptionId: "sub_candidate",
      status: "AUTHENTICATED",
      pendingReplacementOrganizationId: "org_1",
    });
    linkedReplacement = {
      id: "change_drift",
      organizationId: "org_1",
      organizationSubscriptionId: "source_row",
      replacementSubscriptionId: "candidate_row",
      branchId: "branch_2",
      type: "QUANTITY_INCREASE",
      status: "SCHEDULED",
      operationStatus: "SCHEDULED",
      toPlan: "PRO",
      toQuantity: 2,
      accessGrantedAt: new Date("2026-08-09T00:00:00.000Z"),
      accessRevokedAt: null,
    };
    providerPlan = null;
    mocks.fetchSubscription.mockResolvedValue({
      id: "sub_candidate",
      entity: "subscription",
      plan_id: "plan_unknown",
      status: "authenticated",
      total_count: 120,
      quantity: 2,
      payment_method: "upi",
    });

    await expect(BillingReconciliationService.reconcileProviderSubscription(
      "sub_candidate",
      { now }
    )).resolves.toMatchObject({
      subscription: {
        razorpayPlanId: "plan_unknown",
        status: "AUTHENTICATED",
      },
      confirmedPaidPeriod: false,
    });

    expect(mocks.changeUpdate).toHaveBeenCalledWith({
      where: { id: "change_drift" },
      data: expect.objectContaining({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        accessRevokedAt: now,
      }),
    });
    expect(mocks.branchUpdateMany).toHaveBeenCalledWith({
      where: { id: "branch_2", billingStatus: "ACTIVE" },
      data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
    });
  });

  it("does not reinterpret a promoted subscription's historical replacement as candidate drift", async () => {
    local = localSubscription({
      currentOrganizationId: "org_1",
      pendingReplacementOrganizationId: null,
      providerPaymentMethod: "CARD",
    });
    linkedReplacement = {
      id: "historical_change",
      status: "APPLIED",
      replacementSubscriptionId: local.id,
      branchId: "branch_2",
      type: "QUANTITY_INCREASE",
      accessGrantedAt: new Date("2026-07-01T00:00:00.000Z"),
      accessRevokedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    providerPlan = {
      providerMode: "TEST",
      plan: "PRO",
      razorpayPlanId: "plan_standard",
      amount: 499,
      amountSubunits: 49900,
      currency: "INR",
      period: "monthly",
      interval: 1,
      active: true,
    };
    mocks.fetchSubscription.mockResolvedValue({
      id: "sub_source",
      entity: "subscription",
      plan_id: "plan_standard",
      status: "active",
      total_count: 120,
      quantity: 2,
      payment_method: "card",
    });

    await BillingReconciliationService.reconcileProviderSubscription("sub_source", { now });

    expect(mocks.changeFindUnique).not.toHaveBeenCalled();
    expect(mocks.changeUpdate).not.toHaveBeenCalled();
    expect(mocks.branchUpdateMany).not.toHaveBeenCalled();
  });

  it("refetches instead of resurrecting a candidate changed while provider state was in flight", async () => {
    const fetchedAt = new Date("2026-08-10T11:00:00.000Z");
    const cancelledAt = new Date("2026-08-10T11:30:00.000Z");
    const beforeFetch = localSubscription({
      id: "candidate_row",
      razorpaySubscriptionId: "sub_candidate",
      status: "ACTIVE",
      updatedAt: fetchedAt,
    });
    const cancelled = localSubscription({
      id: "candidate_row",
      razorpaySubscriptionId: "sub_candidate",
      status: "CANCELLED",
      endedAt: cancelledAt,
      updatedAt: cancelledAt,
    });
    mocks.localFindUnique
      .mockReset()
      .mockResolvedValueOnce(beforeFetch)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(cancelled);
    mocks.fetchSubscription
      .mockResolvedValueOnce({
        id: "sub_candidate",
        entity: "subscription",
        plan_id: "plan_basic",
        status: "active",
        total_count: 120,
        quantity: 1,
        payment_method: "upi",
      })
      .mockResolvedValueOnce({
        id: "sub_candidate",
        entity: "subscription",
        plan_id: "plan_basic",
        status: "cancelled",
        total_count: 120,
        quantity: 1,
        payment_method: "upi",
        ended_at: Math.floor(cancelledAt.getTime() / 1000),
      });

    const result = await BillingReconciliationService.reconcileProviderSubscription(
      "sub_candidate",
      { now }
    );

    expect(mocks.fetchSubscription).toHaveBeenCalledTimes(2);
    expect(result.subscription.status).toBe("CANCELLED");
    expect(mocks.subscriptionUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ACTIVE" }),
    }));
  });

  it("rejects a provider response for a different subscription identity", async () => {
    mocks.fetchSubscription.mockResolvedValue({
      id: "sub_other",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "active",
      total_count: 120,
      quantity: 1,
      payment_method: "upi",
    });

    await expect(BillingReconciliationService.reconcileProviderSubscription(
      "sub_source",
      { now }
    )).rejects.toThrow("Razorpay subscription response mismatch during reconciliation");

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.subscriptionUpdate).not.toHaveBeenCalled();
  });
});
