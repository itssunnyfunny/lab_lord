import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationUpdate: vi.fn(),
  billingChangeFindFirst: vi.fn(),
  billingChangeFindUnique: vi.fn(),
  billingChangeFindUniqueOrThrow: vi.fn(),
  billingChangeUpdate: vi.fn(),
  billingChangeUpdateMany: vi.fn(),
  transaction: vi.fn(),
  recordBillingMutationAudit: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  subscriptionFindUniqueOrThrow: vi.fn(),
  getOrganizationForOwnerAccess: vi.fn(),
  enqueueMutation: vi.fn(),
  processNextMutation: vi.fn(),
  retryMutation: vi.fn(),
  fetchSubscription: vi.fn(),
  fetchPayment: vi.fn(),
  reconcileProviderSubscription: vi.fn(),
  syncAuthorizedAccess: vi.fn(),
  failReplacementCheckout: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { update: mocks.organizationUpdate },
    organizationBillingChange: {
      findFirst: mocks.billingChangeFindFirst,
      findUnique: mocks.billingChangeFindUnique,
      findUniqueOrThrow: mocks.billingChangeFindUniqueOrThrow,
      update: mocks.billingChangeUpdate,
      updateMany: mocks.billingChangeUpdateMany,
    },
    organizationSubscription: {
      findFirst: mocks.subscriptionFindFirst,
      findUnique: mocks.subscriptionFindUnique,
      findUniqueOrThrow: mocks.subscriptionFindUniqueOrThrow,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/razorpay", () => ({
  getRazorpayClient: () => ({
    fetchSubscription: mocks.fetchSubscription,
    fetchPayment: mocks.fetchPayment,
  }),
  getRazorpayKeyId: () => "rzp_test_contract",
  resolveRazorpayMode: () => "TEST",
  sha256Hex: (value: string) => value,
  toRazorpaySubunits: (value: number) => value * 100,
  verifyRazorpaySubscriptionSignature: () => true,
  verifyRazorpayWebhookSignature: () => true,
}));

vi.mock("@/services/organization.service", () => ({
  OrganizationService: {
    getOrganizationForOwnerAccess: mocks.getOrganizationForOwnerAccess,
  },
}));

vi.mock("@/services/billingMutation.service", () => ({
  BillingMutationService: {
    enqueue: mocks.enqueueMutation,
    processNext: mocks.processNextMutation,
    retry: mocks.retryMutation,
  },
}));

vi.mock("@/services/billingMutationAudit.service", () => ({
  recordBillingMutationAudit: mocks.recordBillingMutationAudit,
}));

vi.mock("@/services/billingReconciliation.service", () => ({
  BillingReconciliationService: {
    reconcileProviderSubscription: mocks.reconcileProviderSubscription,
  },
}));

vi.mock("@/services/billingReplacement.service", () => ({
  BillingReplacementService: {
    syncAuthorizedAccess: mocks.syncAuthorizedAccess,
    failReplacementCheckout: mocks.failReplacementCheckout,
  },
}));

vi.mock("@/services/billingReplacementPolicy", () => ({
  isReplacementMutationEligible: () => true,
}));

vi.mock("@/services/billingPaymentMethod.service", () => ({
  isSupportedProviderPaymentMethod: (method: string) => ["CARD", "UPI", "EMANDATE"].includes(method),
  normalizeProviderPaymentMethod: (method: string | null | undefined) => {
    const normalized = method?.toUpperCase();
    return normalized === "CARD" || normalized === "UPI" ? normalized : "EMANDATE";
  },
}));

vi.mock("@/lib/billingFeature", () => ({
  areRazorpayMultiMethodSubscriptionsEnabled: () => true,
  assertRazorpayBillingWritesEnabled: vi.fn(),
}));

vi.mock("@/services/entitlement.service", () => ({ EntitlementService: {} }));
vi.mock("@/services/billingExperience.service", () => ({ BillingExperienceService: {} }));
vi.mock("@/services/razorpayPlanCatalog.service", () => ({
  ensureRazorpayPlanCatalogEntry: vi.fn(),
}));

import { BillingService } from "@/services/billing.service";

const createdAt = new Date("2026-08-10T00:00:00.000Z");

function sourceSubscription(overrides: Record<string, unknown> = {}) {
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
    quantity: 1,
    totalCount: 120,
    razorpayPlanId: "plan_basic",
    razorpaySubscriptionId: "sub_source",
    status: "ACTIVE",
    providerPaymentMethod: "UPI",
    currentEnd: new Date("2026-09-01T00:00:00.000Z"),
    paidThrough: new Date("2026-09-01T00:00:00.000Z"),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function candidateSubscription(overrides: Record<string, unknown> = {}) {
  return sourceSubscription({
    id: "candidate_row",
    currentOrganizationId: null,
    pendingReplacementOrganizationId: "org_1",
    plan: "PRO",
    amount: 499,
    amountSubunits: 49900,
    razorpayPlanId: "plan_pro",
    razorpaySubscriptionId: "sub_candidate",
    status: "CREATED",
    paidThrough: null,
    ...overrides,
  });
}

function replacementChange(overrides: Record<string, unknown> = {}) {
  return {
    id: "change_1",
    organizationId: "org_1",
    organizationSubscriptionId: "source_row",
    replacementSubscriptionId: "candidate_row",
    type: "PLAN_UPGRADE",
    status: "AWAITING_PAYMENT",
    operationStatus: "CHECKOUT_OPEN",
    fromPlan: "BASIC",
    toPlan: "PRO",
    fromQuantity: 1,
    toQuantity: 1,
    returnPath: null,
    confirmationDeadlineAt: new Date("2026-08-17T00:00:00.000Z"),
    undoCutoffAt: new Date("2026-08-29T00:00:00.000Z"),
    effectiveAt: new Date("2026-09-01T00:00:00.000Z"),
    failureCategory: null,
    failureCode: null,
    providerPaymentId: null,
    providerConfirmedAt: null,
    lastError: null,
    attemptCount: 0,
    processingStartedAt: null,
    verificationStartedAt: null,
    commercialIntentVersion: 1,
    commercialIntentCapturedAt: createdAt,
    authorizedProviderMode: "TEST",
    authorizedSourceRazorpaySubscriptionId: "sub_source",
    authorizedRazorpaySubscriptionId: "sub_candidate",
    authorizedSourceRazorpayPlanId: "plan_basic",
    authorizedRazorpayPlanId: "plan_pro",
    authorizedPlan: "PRO",
    authorizedQuantity: 1,
    authorizedRazorpayOfferId: null,
    authorizedUnitAmountSubunits: 49900,
    authorizedGrossAmountSubunits: 49900,
    authorizedExpectedAmountSubunits: 49900,
    authorizedOfferValidThroughPaidCount: null,
    authorizedCurrency: "INR",
    authorizedPeriod: "monthly",
    authorizedInterval: 1,
    createdAt,
    updatedAt: createdAt,
    organizationSubscription: sourceSubscription(),
    replacementSubscription: candidateSubscription(),
    ...overrides,
  };
}

function organization() {
  return {
    id: "org_1",
    name: "Trust Contract Lab",
    billingModelVersion: "WORKSPACE_V2",
    selectedPostTrialPlan: "BASIC",
    ownerTrialGrant: null,
    subscription: sourceSubscription(),
  };
}

describe("replacement billing trust and race contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrganizationForOwnerAccess.mockResolvedValue(organization());
    mocks.organizationUpdate.mockResolvedValue({});
    mocks.billingChangeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async callback => callback({
      organizationBillingChange: { updateMany: mocks.billingChangeUpdateMany },
    }));
    mocks.recordBillingMutationAudit.mockResolvedValue(undefined);
    mocks.processNextMutation.mockResolvedValue(null);
    mocks.reconcileProviderSubscription.mockResolvedValue({});
    mocks.syncAuthorizedAccess.mockResolvedValue({ change: replacementChange() });
  });

  it.each(["ABANDONED", "DECLINED", "FAILED"] as const)(
    "treats a browser %s event as a reconciliation hint and never cancels the candidate",
    async event => {
      const change = replacementChange();
      const refreshed = replacementChange({
        status: "AWAITING_PAYMENT",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
      });
      mocks.billingChangeFindFirst.mockResolvedValue(change);
      mocks.billingChangeFindUniqueOrThrow.mockResolvedValue(refreshed);

      const result = await BillingService.recordCheckoutEvent(
        "owner_1",
        "org_1",
        change.id,
        { event, paymentId: "pay_hint" }
      );

      expect(mocks.billingChangeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: change.id, operationStatus: "CHECKOUT_OPEN" },
        data: expect.objectContaining({
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          resolvedAt: null,
        }),
      }));
      expect(mocks.reconcileProviderSubscription).toHaveBeenCalledWith(
        "sub_candidate",
        expect.objectContaining({ paymentId: "pay_hint" })
      );
      expect(mocks.failReplacementCheckout).not.toHaveBeenCalled();
      expect(result.operation).toMatchObject({
        queueStatus: "AWAITING_PAYMENT",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
      });
    }
  );

  it.each([
    {
      label: "subscription response id",
      subscription: { id: "sub_other" },
      payment: {},
      code: "SUBSCRIPTION_MISMATCH",
      error: "The provider subscription does not match the commercial authorization",
    },
    {
      label: "payment response id",
      subscription: {},
      payment: { id: "pay_other" },
      code: "PAYMENT_ID_MISMATCH",
      error: "The provider payment does not match the requested payment",
    },
    {
      label: "payment subscription association",
      subscription: {},
      payment: { subscription_id: null },
      code: "PAYMENT_SUBSCRIPTION_MISMATCH",
      error: "The payment does not belong to the authorized subscription",
    },
  ])("rejects a mismatched provider $label", async ({ subscription, payment, code, error }) => {
    const change = replacementChange();
    const candidate = candidateSubscription();
    mocks.billingChangeFindFirst.mockResolvedValue(change);
    mocks.subscriptionFindFirst.mockResolvedValue(candidate);
    mocks.billingChangeFindUniqueOrThrow.mockImplementationOnce(async () => {
      const claim = mocks.billingChangeUpdateMany.mock.calls[0]![0];
      return {
        ...change,
        operationStatus: "VERIFYING",
        verificationStartedAt: claim.data.verificationStartedAt,
      };
    });
    mocks.fetchSubscription.mockResolvedValue({
      id: "sub_candidate",
      entity: "subscription",
      plan_id: "plan_pro",
      status: "authenticated",
      quantity: 1,
      offer_id: null,
      ...subscription,
    });
    mocks.fetchPayment.mockResolvedValue({
      id: "pay_auth",
      entity: "payment",
      amount: 49900,
      currency: "INR",
      status: "authorized",
      subscription_id: "sub_candidate",
      method: "upi",
      captured: false,
      invoice_id: null,
      ...payment,
    });

    await expect(BillingService.verifySubscriptionSuccess("owner_1", "org_1", {
      changeId: change.id,
      razorpay_subscription_id: "sub_candidate",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: "verified-signature",
    })).rejects.toMatchObject({
      name: "BillingManualReviewRequiredError",
      code: "BILLING_MANUAL_REVIEW_REQUIRED",
      changeId: change.id,
      message: error,
    });

    const verificationStartedAt = mocks.billingChangeUpdateMany.mock.calls[0]![0]
      .data.verificationStartedAt;
    expect(mocks.billingChangeUpdateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: {
        id: change.id,
        operationStatus: "VERIFYING",
        attemptCount: 0,
        verificationStartedAt,
      },
      data: expect.objectContaining({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: code,
        providerPaymentId: "pay_auth",
        resolvedAt: null,
      }),
    }));
    expect(mocks.billingChangeUpdateMany.mock.calls[1]![0].where.verificationStartedAt)
      .toBe(verificationStartedAt);
    expect(mocks.recordBillingMutationAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changeId: change.id,
        attemptCount: 0,
        outcome: "MANUAL_REVIEW_REQUIRED",
        failureCode: code,
      })
    );
    expect(mocks.syncAuthorizedAccess).not.toHaveBeenCalled();
  });

  it("returns the existing PROCESSING plan replacement when an idempotent retry has no candidate yet", async () => {
    const processing = replacementChange({
      replacementSubscriptionId: null,
      replacementSubscription: null,
      status: "PROCESSING",
      operationStatus: "PROCESSING",
    });
    mocks.enqueueMutation.mockResolvedValue(processing);
    mocks.billingChangeFindUnique.mockResolvedValue(processing);

    const result = await BillingService.changeWorkspacePlan(
      "owner_1",
      "org_1",
      "PRO",
      "same-plan-change-request"
    );

    expect(result).toMatchObject({
      change: { id: processing.id, status: "PROCESSING" },
      operation: { queueStatus: "PROCESSING", operationStatus: "PROCESSING" },
      processingUrl: "/org/org_1/billing/processing/change_1",
    });
    expect(mocks.processNextMutation).toHaveBeenCalledWith("org_1");
  });

  it("returns an exact cancellation-pending replacement as processing and never reopens checkout", async () => {
    const cancellationPending = replacementChange({
      status: "FAILED",
      operationStatus: "FAILED",
      failureCategory: "PROVIDER_AUTHORIZATION_FAILED",
      failureCode: "CANDIDATE_CANCELLATION_PENDING",
      lastError: "Razorpay candidate cancellation is still being confirmed",
    });
    mocks.enqueueMutation.mockResolvedValue(cancellationPending);
    mocks.billingChangeFindUnique.mockResolvedValue(cancellationPending);

    const result = await BillingService.changeWorkspacePlan(
      "owner_1",
      "org_1",
      "PRO",
      "same-cancellation-pending-request"
    );

    expect(result).toMatchObject({
      change: { id: cancellationPending.id },
      operation: {
        queueStatus: "FAILED",
        operationStatus: "FAILED",
        failureCode: "CANDIDATE_CANCELLATION_PENDING",
      },
      processingUrl: "/org/org_1/billing/processing/change_1",
    });
    expect(result).not.toHaveProperty("keyId");
    expect(mocks.retryMutation).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "was undone",
      change: replacementChange({ status: "UNDONE", operationStatus: "ABANDONED" }),
      error: "discarded and cannot be retried",
    },
    {
      label: "passed its undo cutoff",
      change: replacementChange({
        status: "FAILED",
        operationStatus: "FAILED",
        undoCutoffAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
      error: "authorization window has closed",
    },
    {
      label: "is still cancelling its failed candidate",
      change: replacementChange({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCode: "CANDIDATE_CANCELLATION_PENDING",
      }),
      error: "still being cancelled",
    },
  ])("does not reopen a replacement that $label", async ({ change, error }) => {
    mocks.billingChangeFindFirst.mockResolvedValue(change);

    await expect(BillingService.retryBillingOperation(
      "owner_1",
      "org_1",
      change.id
    )).rejects.toThrow(error);

    expect(mocks.fetchSubscription).not.toHaveBeenCalled();
    expect(mocks.reconcileProviderSubscription).not.toHaveBeenCalled();
    expect(mocks.billingChangeUpdate).not.toHaveBeenCalled();
  });
});
