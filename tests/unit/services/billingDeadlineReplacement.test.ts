import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationFindMany: vi.fn(),
  billingChangeFindMany: vi.fn(),
  billingChangeUpdateMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  subscriptionUpdate: vi.fn(),
  expireTrials: vi.fn(),
  archiveBranches: vi.fn(),
  retryMutation: vi.fn(),
  processNext: vi.fn(),
  reconcileByOrganization: vi.fn(),
  reconcileProviderSubscription: vi.fn(),
  failReplacementCheckout: vi.fn(),
  syncAuthorizedAccess: vi.fn(),
  scheduleSourceCancellation: vi.fn(),
  promoteIfReady: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findMany: mocks.organizationFindMany },
    organizationBillingChange: {
      findMany: mocks.billingChangeFindMany,
      updateMany: mocks.billingChangeUpdateMany,
    },
    organizationSubscription: {
      findMany: mocks.subscriptionFindMany,
      update: mocks.subscriptionUpdate,
    },
  },
}));

vi.mock("@/services/billingMutation.service", () => ({
  BillingMutationService: {
    retry: mocks.retryMutation,
    processNext: mocks.processNext,
  },
}));

vi.mock("@/services/billingReconciliation.service", () => ({
  BillingReconciliationService: {
    reconcileByOrganization: mocks.reconcileByOrganization,
    reconcileProviderSubscription: mocks.reconcileProviderSubscription,
  },
}));

vi.mock("@/services/branch.service", () => ({
  BranchService: { archiveDueBillingRemovals: mocks.archiveBranches },
}));

vi.mock("@/services/ownerTrial.service", () => ({
  OwnerTrialService: { expireDueTrials: mocks.expireTrials },
}));

vi.mock("@/lib/billingFeature", () => ({
  areRazorpayBillingWritesEnabled: () => true,
}));

vi.mock("@/services/billingPaymentMethod.service", () => ({
  isSupportedProviderPaymentMethod: () => true,
}));

vi.mock("@/services/billingReplacement.service", () => ({
  BillingReplacementService: {
    failReplacementCheckout: mocks.failReplacementCheckout,
    syncAuthorizedAccess: mocks.syncAuthorizedAccess,
    scheduleSourceCancellation: mocks.scheduleSourceCancellation,
    promoteIfReady: mocks.promoteIfReady,
  },
}));

import {
  BillingDeadlineService,
  REPLACEMENT_DEADLINE_PAGE_SIZE,
  isReplacementMandateConfirmed,
} from "@/services/billingDeadline.service";

const now = new Date("2026-09-01T00:00:00.000Z");

function replacementChange(overrides: Record<string, unknown> = {}) {
  const id = String(overrides.id ?? "change_1");
  return {
    id,
    organizationId: `org_${id}`,
    sequence: 1,
    status: "AWAITING_PAYMENT",
    operationStatus: "CHECKOUT_OPEN",
    failureCategory: null,
    failureCode: null,
    lastError: null,
    providerPaymentId: null,
    confirmationDeadlineAt: new Date("2026-09-02T00:00:00.000Z"),
    undoCutoffAt: new Date("2026-09-02T00:00:00.000Z"),
    organizationSubscription: {
      id: `source_${id}`,
      razorpaySubscriptionId: `sub_source_${id}`,
      cancelAtCycleEnd: false,
    },
    replacementSubscription: {
      id: `candidate_${id}`,
      razorpaySubscriptionId: `sub_candidate_${id}`,
      pendingReplacementOrganizationId: `org_${id}`,
    },
    ...overrides,
  };
}

function isReplacementQuery(args: { where?: Record<string, unknown> }) {
  const filter = args.where?.replacementSubscriptionId;
  return typeof filter === "object"
    && filter != null
    && "not" in filter
    && filter.not === null;
}

describe("replacement billing deadlines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expireTrials.mockResolvedValue({ count: 0 });
    mocks.organizationFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.archiveBranches.mockResolvedValue({ archived: 0 });
    mocks.billingChangeFindMany.mockResolvedValue([]);
    mocks.failReplacementCheckout.mockResolvedValue({});
    mocks.scheduleSourceCancellation.mockResolvedValue({ scheduled: true, reason: null });
    mocks.promoteIfReady.mockResolvedValue({ promoted: false });
  });

  it("keeps replacements and manual-review changes out of generic retries", async () => {
    await BillingDeadlineService.run(now);

    const retryQuery = mocks.billingChangeFindMany.mock.calls
      .map(call => call[0])
      .find(args => args.where?.status === "FAILED" && !isReplacementQuery(args));
    expect(retryQuery.where).toMatchObject({
      replacementSubscriptionId: null,
      attemptCount: { lt: 3 },
      OR: [
        { failureCategory: null },
        { failureCategory: { not: "MANUAL_REVIEW_REQUIRED" } },
      ],
    });
    expect(mocks.retryMutation).not.toHaveBeenCalled();
  });

  it("paginates every pending replacement candidate with a stable cursor", async () => {
    const candidates = Array.from(
      { length: REPLACEMENT_DEADLINE_PAGE_SIZE + 1 },
      (_, index) => replacementChange({
        id: `change_${String(index).padStart(3, "0")}`,
        status: "FAILED",
        operationStatus: "FAILED",
        failureCode: "CANDIDATE_CANCELLATION_PENDING",
      })
    );
    mocks.billingChangeFindMany.mockImplementation(async args => {
      if (!isReplacementQuery(args)) return [];
      if (!args.cursor) return candidates.slice(0, REPLACEMENT_DEADLINE_PAGE_SIZE);
      return candidates.slice(REPLACEMENT_DEADLINE_PAGE_SIZE);
    });

    const result = await BillingDeadlineService.run(now);

    const replacementQueries = mocks.billingChangeFindMany.mock.calls
      .map(call => call[0])
      .filter(isReplacementQuery);
    expect(replacementQueries).toHaveLength(2);
    expect(replacementQueries[1]).toMatchObject({
      cursor: { id: candidates[REPLACEMENT_DEADLINE_PAGE_SIZE - 1].id },
      skip: 1,
      orderBy: { id: "asc" },
    });
    expect(mocks.failReplacementCheckout).toHaveBeenCalledTimes(candidates.length);
    expect(result.retriedReplacementCancellations).toBe(candidates.length);
  });

  it("times out only a candidate that remains unconfirmed", async () => {
    const change = replacementChange({
      confirmationDeadlineAt: new Date("2026-08-31T00:00:00.000Z"),
      undoCutoffAt: new Date("2026-08-31T00:00:00.000Z"),
    });
    mocks.billingChangeFindMany.mockImplementation(async args => isReplacementQuery(args) ? [change] : []);
    mocks.reconcileProviderSubscription.mockResolvedValue({
      subscription: { status: "CREATED", cancelAtCycleEnd: false },
      confirmedPaidPeriod: false,
    });
    mocks.syncAuthorizedAccess.mockResolvedValue({
      change: {
        ...change,
        providerConfirmedAt: null,
        operationStatus: "CHECKOUT_OPEN",
      },
    });

    await BillingDeadlineService.run(now);

    expect(mocks.failReplacementCheckout).toHaveBeenCalledWith(
      change.id,
      "FAILED",
      now,
      expect.stringContaining("not confirmed")
    );
    expect(mocks.scheduleSourceCancellation).not.toHaveBeenCalled();
    expect(mocks.promoteIfReady).not.toHaveBeenCalled();
  });

  it("delegates fresh source reconciliation to scheduling and does not time out a confirmed mandate", async () => {
    const change = replacementChange({
      confirmationDeadlineAt: new Date("2026-08-31T00:00:00.000Z"),
      undoCutoffAt: new Date("2026-08-31T00:00:00.000Z"),
    });
    mocks.billingChangeFindMany.mockImplementation(async args => isReplacementQuery(args) ? [change] : []);
    mocks.reconcileProviderSubscription.mockImplementation(async (subscriptionId: string) => ({
      subscription: {
        status: subscriptionId.startsWith("sub_candidate") ? "AUTHENTICATED" : "ACTIVE",
        cancelAtCycleEnd: false,
      },
      confirmedPaidPeriod: false,
    }));
    mocks.syncAuthorizedAccess.mockResolvedValue({
      change: {
        ...change,
        providerConfirmedAt: now,
        operationStatus: "SCHEDULED",
      },
    });

    await BillingDeadlineService.run(now);

    expect(mocks.failReplacementCheckout).not.toHaveBeenCalled();
    expect(mocks.scheduleSourceCancellation).toHaveBeenCalledWith(change.id, now);
  });

  it("delegates already-scheduled idempotency to the locked cancellation service", async () => {
    const change = replacementChange({
      undoCutoffAt: new Date("2026-08-31T00:00:00.000Z"),
    });
    mocks.billingChangeFindMany.mockImplementation(async args => isReplacementQuery(args) ? [change] : []);
    mocks.reconcileProviderSubscription.mockImplementation(async (subscriptionId: string) => ({
      subscription: {
        status: "ACTIVE",
        cancelAtCycleEnd: subscriptionId.startsWith("sub_source"),
      },
      confirmedPaidPeriod: false,
    }));
    mocks.syncAuthorizedAccess.mockResolvedValue({
      change: {
        ...change,
        providerConfirmedAt: now,
        operationStatus: "SCHEDULED",
      },
    });

    await BillingDeadlineService.run(now);

    expect(mocks.scheduleSourceCancellation).toHaveBeenCalledWith(change.id, now);
    expect(mocks.promoteIfReady).toHaveBeenCalledWith(change.id, now);
  });

  it("keeps retrying failed candidate cancellation but leaves manual review untouched", async () => {
    const retryable = replacementChange({
      id: "retryable",
      status: "FAILED",
      operationStatus: "FAILED",
      failureCode: "CANDIDATE_CANCELLATION_PENDING",
      lastError: "Provider cancellation unavailable",
    });
    const manualReview = replacementChange({
      id: "manual",
      status: "FAILED",
      operationStatus: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: null,
    });
    mocks.billingChangeFindMany.mockImplementation(async args => (
      isReplacementQuery(args) ? [retryable, manualReview] : []
    ));
    mocks.failReplacementCheckout
      .mockRejectedValueOnce(new Error("Provider cancellation unavailable"))
      .mockResolvedValue({});

    const first = await BillingDeadlineService.run(now);
    const second = await BillingDeadlineService.run(now);

    expect(mocks.failReplacementCheckout).toHaveBeenCalledTimes(2);
    expect(mocks.failReplacementCheckout).toHaveBeenNthCalledWith(
      1,
      retryable.id,
      "FAILED",
      now,
      retryable.lastError
    );
    expect(first.errors).toEqual([
      expect.objectContaining({ organizationId: retryable.organizationId }),
    ]);
    expect(second.retriedReplacementCancellations).toBe(1);
  });

  it("recognizes confirmation only from the durable scheduled state", () => {
    expect(isReplacementMandateConfirmed({
      operationStatus: "SCHEDULED",
      providerConfirmedAt: now,
    })).toBe(true);
    expect(isReplacementMandateConfirmed({
      operationStatus: "CHECKOUT_OPEN",
      providerConfirmedAt: now,
    })).toBe(false);
    expect(isReplacementMandateConfirmed({
      operationStatus: "SCHEDULED",
      providerConfirmedAt: null,
    })).toBe(false);
  });
});
