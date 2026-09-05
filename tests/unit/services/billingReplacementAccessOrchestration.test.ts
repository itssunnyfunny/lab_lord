import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  billingChangeFindUnique: vi.fn(),
  planMappingFindFirst: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    organizationBillingChange: { findUnique: mocks.billingChangeFindUnique },
  },
}));

vi.mock("@/lib/billingFeature", () => ({
  assertRazorpayBillingWritesEnabled: vi.fn(),
}));

vi.mock("@/lib/razorpay", () => ({
  RazorpayApiError: class RazorpayApiError extends Error {},
  resolveRazorpayMode: () => "TEST",
  getRazorpayClient: () => ({ cancelSubscription: mocks.cancelSubscription }),
}));

import { BillingReplacementService } from "@/services/billingReplacement.service";

const now = new Date("2026-08-10T12:00:00.000Z");

describe("replacement access orchestration", () => {
  let source: Record<string, unknown>;
  let candidate: Record<string, unknown>;
  let change: Record<string, unknown>;
  let branch: Record<string, unknown>;
  let tx: Record<string, unknown>;
  let organizationLeaseToken: string | null;

  beforeEach(() => {
    vi.clearAllMocks();
    organizationLeaseToken = null;
    mocks.planMappingFindFirst.mockResolvedValue({ razorpayPlanId: "plan_basic", active: false });
    source = {
      id: "source_row",
      organizationId: "org_1",
      currentOrganizationId: "org_1",
      providerMode: "TEST",
      plan: "BASIC",
      quantity: 1,
      razorpayPlanId: "plan_basic",
      razorpaySubscriptionId: "sub_source",
      status: "ACTIVE",
      paidThrough: new Date("2026-09-01T00:00:00.000Z"),
    };
    candidate = {
      id: "candidate_row",
      organizationId: "org_1",
      pendingReplacementOrganizationId: "org_1",
      providerMode: "TEST",
      plan: "BASIC",
      quantity: 2,
      razorpayPlanId: "plan_basic",
      razorpaySubscriptionId: "sub_candidate",
      confirmedCommercialIntentChangeId: "change_1",
      providerPaymentMethod: "UPI",
      status: "AUTHENTICATED",
      cancelledAt: null,
      endedAt: null,
    };
    change = {
      id: "change_1",
      organizationId: "org_1",
      organizationSubscriptionId: "source_row",
      replacementSubscriptionId: "candidate_row",
      branchId: "branch_2",
      type: "QUANTITY_INCREASE",
      status: "AWAITING_PAYMENT",
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
      failureCategory: null,
      failureCode: null,
      attemptCount: 1,
      updatedAt: new Date("2026-08-10T11:00:00.000Z"),
      toPlan: "BASIC",
      toQuantity: 2,
      commercialIntentVersion: 1,
      commercialIntentCapturedAt: new Date("2026-08-01T00:00:00.000Z"),
      authorizedProviderMode: "TEST",
      authorizedSourceRazorpaySubscriptionId: "sub_source",
      authorizedRazorpaySubscriptionId: "sub_candidate",
      authorizedSourceRazorpayPlanId: "plan_basic",
      authorizedRazorpayPlanId: "plan_basic",
      authorizedPlan: "BASIC",
      authorizedQuantity: 2,
      authorizedRazorpayOfferId: null,
      authorizedUnitAmountSubunits: 29900,
      authorizedGrossAmountSubunits: 59800,
      authorizedExpectedAmountSubunits: 59800,
      authorizedOfferValidThroughPaidCount: null,
      authorizedCurrency: "INR",
      authorizedPeriod: "monthly",
      authorizedInterval: 1,
      accessGrantedAt: null,
      accessRevokedAt: null,
      effectiveAt: new Date("2026-09-01T00:00:00.000Z"),
      accessGraceEndsAt: new Date("2026-09-04T00:00:00.000Z"),
    };
    branch = {
      id: "branch_2",
      billingStatus: "PENDING_ACTIVATION",
      billingActivatedAt: null,
      billingArchivedAt: null,
    };

    const loadedChange = () => ({
      ...change,
      organizationSubscription: { ...source },
      replacementSubscription: { ...candidate },
      branch: { ...branch },
    });
    mocks.billingChangeFindUnique.mockImplementation(async args => args.select
      ? { organizationId: change.organizationId }
      : loadedChange());
    tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      organization: {
        findUnique: vi.fn(async () => ({
          billingMutationLeaseToken: organizationLeaseToken,
        })),
        findUniqueOrThrow: vi.fn(async () => ({
          billingMutationLeaseToken: organizationLeaseToken,
        })),
        update: vi.fn(async ({ data }: { data: { billingMutationLeaseToken?: string | null } }) => {
          if ("billingMutationLeaseToken" in data) {
            organizationLeaseToken = data.billingMutationLeaseToken ?? null;
          }
          return { id: "org_1", billingMutationLeaseToken: organizationLeaseToken };
        }),
        updateMany: vi.fn(async ({ where, data }: {
          where: { billingMutationLeaseToken?: string };
          data: { billingMutationLeaseToken?: string | null };
        }) => {
          if (where.billingMutationLeaseToken !== organizationLeaseToken) return { count: 0 };
          organizationLeaseToken = data.billingMutationLeaseToken ?? null;
          return { count: 1 };
        }),
      },
      organizationBillingChange: {
        findUnique: vi.fn(async (args: { select?: unknown }) => args.select
          ? { organizationId: change.organizationId }
          : loadedChange()),
        findUniqueOrThrow: vi.fn(async () => ({ ...change })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const persisted = Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined)
          );
          change = { ...change, ...persisted };
          return { ...change };
        }),
        updateMany: vi.fn(async ({ where, data }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if ("accessGrantedAt" in data && "accessGrantedAt" in where && change.accessGrantedAt) {
            return { count: 0 };
          }
          if ("accessRevokedAt" in data
            && "accessRevokedAt" in where
            && (!change.accessGrantedAt || change.accessRevokedAt)) {
            return { count: 0 };
          }
          const persisted = Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined)
          );
          change = { ...change, ...persisted };
          return { count: 1 };
        }),
      },
      saasRazorpayPlan: {
        findFirst: mocks.planMappingFindFirst,
      },
      organizationSubscription: {
        findFirst: vi.fn(async () => ({ ...source })),
        update: vi.fn(async ({ where, data }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          if (where.id === "source_row") {
            source = { ...source, ...data };
            return { ...source };
          }
          expect(where.id).toBe("candidate_row");
          candidate = { ...candidate, ...data };
          return { ...candidate };
        }),
        updateMany: vi.fn(async ({ where, data }: {
          where: { id: string; pendingReplacementOrganizationId?: string };
          data: Record<string, unknown>;
        }) => {
          if (where.id !== candidate.id
            || (where.pendingReplacementOrganizationId
              && where.pendingReplacementOrganizationId !== candidate.pendingReplacementOrganizationId)) {
            return { count: 0 };
          }
          candidate = { ...candidate, ...data };
          return { count: 1 };
        }),
      },
      organizationSubscriptionHistory: {
        upsert: vi.fn().mockResolvedValue({}),
      },
      organizationBillingChangeAudit: {
        findFirst: vi.fn(async () => null),
        upsert: vi.fn().mockResolvedValue({}),
      },
      organizationSubscriptionInvoice: {
        findUnique: vi.fn(async () => ({
          commercialEvidenceVersion: 1,
          commercialIntentChangeId: "change_1",
          organizationSubscriptionId: "candidate_row",
          providerMode: "TEST",
          razorpaySubscriptionId: "sub_candidate",
          razorpayPlanId: "plan_basic",
          providerQuantity: 2,
          razorpayOfferId: null,
          razorpayPaymentId: candidate.lastConfirmedPaymentId ?? null,
          paymentStatus: "captured",
          paymentCaptured: true,
          periodEnd: candidate.currentEnd ?? null,
        })),
      },
      branch: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          branch = { ...branch, ...data };
          return { ...branch };
        }),
        updateMany: vi.fn(async ({ where, data }: {
          where: { id: string; billingStatus?: string };
          data: Record<string, unknown>;
        }) => {
          if (where.id !== branch.id
            || (where.billingStatus && where.billingStatus !== branch.billingStatus)) {
            return { count: 0 };
          }
          branch = { ...branch, ...data };
          return { count: 1 };
        }),
      },
    };
    mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
    mocks.cancelSubscription.mockResolvedValue({
      id: "sub_candidate",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "cancelled",
      total_count: 120,
      quantity: 2,
      ended_at: Math.floor(now.getTime() / 1000),
    });
  });

  it("grants a confirmed branch addition once without changing canonical billing", async () => {
    await expect(BillingReplacementService.syncAuthorizedAccess("change_1", now))
      .resolves.toMatchObject({ action: "GRANT" });
    await expect(BillingReplacementService.syncAuthorizedAccess("change_1", now))
      .resolves.toMatchObject({ action: "NONE" });

    expect(change.accessGrantedAt).toEqual(now);
    expect(branch).toMatchObject({ billingStatus: "ACTIVE", billingActivatedAt: now });
    expect(source).toMatchObject({
      plan: "BASIC",
      quantity: 1,
      razorpaySubscriptionId: "sub_source",
      paidThrough: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(candidate.pendingReplacementOrganizationId).toBe("org_1");
    expect(mocks.planMappingFindFirst).not.toHaveBeenCalled();
  });

  it("resolves an exact manual-review replacement only through explicit reconciliation", async () => {
    change = {
      ...change,
      status: "FAILED",
      operationStatus: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "PROVIDER_EVIDENCE_UNCERTAIN",
      failedAt: new Date("2026-08-10T11:30:00.000Z"),
      lastError: "Awaiting exact provider evidence",
    };

    await expect(BillingReplacementService.syncAuthorizedAccess("change_1", now))
      .resolves.toMatchObject({ action: "NONE", change: { status: "FAILED" } });
    expect(change).toMatchObject({
      status: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      accessGrantedAt: null,
    });

    await expect(BillingReplacementService.syncAuthorizedAccess(
      "change_1",
      now,
      { resolveManualReview: true }
    )).resolves.toMatchObject({
      action: "GRANT",
      change: {
        status: "SCHEDULED",
        operationStatus: "SCHEDULED",
        failureCategory: null,
      },
    });

    expect(change).toMatchObject({
      status: "SCHEDULED",
      operationStatus: "SCHEDULED",
      failureCategory: null,
      failureCode: null,
      failedAt: null,
      accessGrantedAt: now,
    });
    expect(branch).toMatchObject({ billingStatus: "ACTIVE", billingActivatedAt: now });
    expect((tx.organizationSubscriptionHistory as { upsert: ReturnType<typeof vi.fn> }).upsert)
      .toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ event: "billing_change:PROVIDER_STATE_ADOPTED:NONE" }),
      }));
  });

  it("activates a future-start trial branch only after replacement authorization", async () => {
    change.type = "TRIAL_SUBSCRIPTION_UPDATE";

    await expect(BillingReplacementService.syncAuthorizedAccess("change_1", now))
      .resolves.toMatchObject({ action: "GRANT" });

    expect(change.accessGrantedAt).toEqual(now);
    expect(branch).toMatchObject({ billingStatus: "ACTIVE", billingActivatedAt: now });
    expect(source).toMatchObject({ quantity: 1, currentOrganizationId: "org_1" });

    candidate.status = "PENDING";
    await expect(BillingReplacementService.syncAuthorizedAccess(
      "change_1",
      new Date("2026-08-11T12:00:00.000Z")
    )).resolves.toMatchObject({ action: "REVOKE" });
    expect(branch).toMatchObject({ billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null });
  });

  it.each(["PENDING", "PAUSED"])(
    "atomically revokes branch access when the candidate becomes %s before cutover",
    async candidateStatus => {
      await BillingReplacementService.syncAuthorizedAccess("change_1", now);
      candidate.status = candidateStatus;

      await expect(BillingReplacementService.syncAuthorizedAccess(
        "change_1",
        new Date("2026-08-11T12:00:00.000Z")
      )).resolves.toMatchObject({ action: "REVOKE" });

      expect(change.accessRevokedAt).toEqual(new Date("2026-08-11T12:00:00.000Z"));
      expect(branch).toMatchObject({
        billingStatus: "PENDING_ACTIVATION",
        billingActivatedAt: null,
      });
      expect(source).toMatchObject({
        currentOrganizationId: "org_1",
        plan: "BASIC",
        quantity: 1,
      });
    }
  );

  it("keeps only the bounded eMandate debit-confirmation grace", async () => {
    candidate.providerPaymentMethod = "EMANDATE";
    await BillingReplacementService.syncAuthorizedAccess("change_1", now);
    candidate.status = "PENDING";

    await expect(BillingReplacementService.syncAuthorizedAccess(
      "change_1",
      new Date("2026-09-02T00:00:00.000Z")
    )).resolves.toMatchObject({ action: "NONE" });
    expect(branch.billingStatus).toBe("ACTIVE");

    await expect(BillingReplacementService.syncAuthorizedAccess(
      "change_1",
      new Date("2026-09-04T00:00:00.000Z")
    )).resolves.toMatchObject({ action: "REVOKE" });
    expect(branch.billingStatus).toBe("PENDING_ACTIVATION");
  });

  it("revokes complimentary branch access when the change requires manual review", async () => {
    await BillingReplacementService.syncAuthorizedAccess("change_1", now);
    change.failureCategory = "MANUAL_REVIEW_REQUIRED";

    await expect(BillingReplacementService.syncAuthorizedAccess(
      "change_1",
      new Date("2026-08-11T12:00:00.000Z")
    )).resolves.toMatchObject({ action: "REVOKE" });
    expect(branch.billingStatus).toBe("PENDING_ACTIVATION");
  });

  it("promotes from exact frozen intent and linked invoice evidence without catalog lookup", async () => {
    source.status = "EXPIRED";
    candidate = {
      ...candidate,
      status: "ACTIVE",
      currentStart: new Date("2026-08-10T00:00:00.000Z"),
      currentEnd: new Date("2026-09-10T00:00:00.000Z"),
      paidThrough: new Date("2026-09-10T00:00:00.000Z"),
      lastConfirmedInvoiceId: "inv_candidate",
      lastConfirmedPaymentId: "pay_candidate",
      amountSubunits: 29900,
      currency: "INR",
    };
    change = {
      ...change,
      status: "SCHEDULED",
      operationStatus: "SCHEDULED",
      providerConfirmedAt: now,
    };

    await expect(BillingReplacementService.promoteIfReady("change_1", now))
      .resolves.toMatchObject({ promoted: true, change: { status: "APPLIED" } });

    expect(mocks.planMappingFindFirst).not.toHaveBeenCalled();
    expect(source.currentOrganizationId).toBeNull();
    expect(candidate).toMatchObject({
      pendingReplacementOrganizationId: null,
      currentOrganizationId: "org_1",
    });
  });

  it("defers promotion while another provider mutation owns the organization lease", async () => {
    source.status = "EXPIRED";
    candidate = {
      ...candidate,
      status: "ACTIVE",
      currentStart: new Date("2026-08-10T00:00:00.000Z"),
      currentEnd: new Date("2026-09-10T00:00:00.000Z"),
      paidThrough: new Date("2026-09-10T00:00:00.000Z"),
      lastConfirmedInvoiceId: "inv_candidate",
      lastConfirmedPaymentId: "pay_candidate",
    };
    change = {
      ...change,
      status: "SCHEDULED",
      operationStatus: "SCHEDULED",
      providerConfirmedAt: now,
    };
    organizationLeaseToken = "mutation-in-flight";

    await expect(BillingReplacementService.promoteIfReady("change_1", now))
      .resolves.toMatchObject({ promoted: false, deferredByLease: true });

    expect(source.currentOrganizationId).toBe("org_1");
    expect(candidate.pendingReplacementOrganizationId).toBe("org_1");
    expect(candidate).not.toHaveProperty("currentOrganizationId");
    expect(change.status).toBe("SCHEDULED");
  });

  it("revokes complimentary branch access atomically when cutover needs manual review", async () => {
    branch = {
      ...branch,
      billingStatus: "ACTIVE",
      billingActivatedAt: new Date("2026-08-09T00:00:00.000Z"),
    };
    candidate = {
      ...candidate,
      status: "ACTIVE",
      currentStart: new Date("2026-08-10T00:00:00.000Z"),
      currentEnd: new Date("2026-09-10T00:00:00.000Z"),
      paidThrough: new Date("2026-09-10T00:00:00.000Z"),
      lastConfirmedInvoiceId: "inv_candidate",
      lastConfirmedPaymentId: "pay_candidate",
    };
    change = {
      ...change,
      status: "SCHEDULED",
      operationStatus: "SCHEDULED",
      accessGrantedAt: new Date("2026-08-09T00:00:00.000Z"),
    };

    await expect(BillingReplacementService.promoteIfReady("change_1", now))
      .resolves.toMatchObject({ promoted: false, manualReview: true });

    expect(change).toMatchObject({
      status: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      accessRevokedAt: now,
    });
    expect(branch).toMatchObject({
      billingStatus: "PENDING_ACTIVATION",
      billingActivatedAt: null,
    });
    expect(source.currentOrganizationId).toBe("org_1");
  });

  it("cancels only the candidate and restores access idempotently on abandon", async () => {
    change.accessGrantedAt = new Date("2026-08-09T00:00:00.000Z");
    branch.billingStatus = "ACTIVE";
    branch.billingActivatedAt = change.accessGrantedAt;

    await expect(BillingReplacementService.failReplacementCheckout(
      "change_1",
      "ABANDONED",
      now,
      "Checkout closed"
    )).resolves.toMatchObject({ status: "UNDONE", operationStatus: "ABANDONED" });
    await BillingReplacementService.failReplacementCheckout("change_1", "ABANDONED", now);

    expect(mocks.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.cancelSubscription).toHaveBeenCalledWith("sub_candidate", {
      cancel_at_cycle_end: false,
    });
    expect(change).toMatchObject({
      status: "UNDONE",
      operationStatus: "ABANDONED",
      accessRevokedAt: now,
    });
    expect(branch).toMatchObject({
      billingStatus: "PENDING_ACTIVATION",
      billingActivatedAt: null,
    });
    expect(candidate).toMatchObject({
      pendingReplacementOrganizationId: null,
      status: "CANCELLED",
    });
    expect(source).toMatchObject({
      currentOrganizationId: "org_1",
      razorpaySubscriptionId: "sub_source",
      status: "ACTIVE",
    });
  });

  it("archives a discarded replacement branch in the same transaction that releases its slot", async () => {
    change.accessGrantedAt = new Date("2026-08-09T00:00:00.000Z");
    branch.billingStatus = "ACTIVE";
    branch.billingActivatedAt = change.accessGrantedAt;

    await expect(BillingReplacementService.undoReplacement(
      "change_1",
      now,
      { branchDisposition: "ARCHIVE" }
    )).resolves.toMatchObject({ status: "UNDONE", operationStatus: "ABANDONED" });

    expect(candidate.pendingReplacementOrganizationId).toBeNull();
    expect(branch).toMatchObject({
      billingStatus: "ARCHIVED",
      billingActivatedAt: null,
      billingArchivedAt: now,
    });
    expect(change).toMatchObject({ accessRevokedAt: now });
  });
});
