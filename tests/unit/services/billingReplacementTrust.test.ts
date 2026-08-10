import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationUpdate: vi.fn(),
  billingChangeFindFirst: vi.fn(),
  billingChangeFindUnique: vi.fn(),
  billingChangeFindUniqueOrThrow: vi.fn(),
  billingChangeUpdate: vi.fn(),
  billingChangeUpdateMany: vi.fn(),
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
      subscription: { id: "sub_other", plan_id: "plan_pro", status: "authenticated" },
      payment: { id: "pay_auth", subscription_id: "sub_candidate", status: "authorized", method: "upi" },
      error: "Razorpay subscription response mismatch",
    },
    {
      label: "payment response id",
      subscription: { id: "sub_candidate", plan_id: "plan_pro", status: "authenticated" },
      payment: { id: "pay_other", subscription_id: "sub_candidate", status: "authorized", method: "upi" },
      error: "Razorpay payment response mismatch",
    },
    {
      label: "payment subscription association",
      subscription: { id: "sub_candidate", plan_id: "plan_pro", status: "authenticated" },
      payment: { id: "pay_auth", subscription_id: null, status: "authorized", method: "upi" },
      error: "Razorpay payment subscription mismatch",
    },
  ])("rejects a mismatched provider $label", async ({ subscription, payment, error }) => {
    const change = replacementChange();
    const candidate = candidateSubscription();
    mocks.billingChangeFindFirst.mockResolvedValue(change);
    mocks.subscriptionFindFirst.mockResolvedValue(candidate);
    mocks.fetchSubscription.mockResolvedValue(subscription);
    mocks.fetchPayment.mockResolvedValue(payment);

    await expect(BillingService.verifySubscriptionSuccess("owner_1", "org_1", {
      changeId: change.id,
      razorpay_subscription_id: "sub_candidate",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: "verified-signature",
    })).rejects.toThrow(error);

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
