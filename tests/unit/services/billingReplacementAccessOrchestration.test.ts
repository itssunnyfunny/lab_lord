import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  planMappingFindFirst: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/billingFeature", () => ({
  assertRazorpayBillingWritesEnabled: vi.fn(),
}));

vi.mock("@/lib/razorpay", () => ({
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

  beforeEach(() => {
    vi.clearAllMocks();
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
      toPlan: "BASIC",
      toQuantity: 2,
      accessGrantedAt: null,
      accessRevokedAt: null,
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
    tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      organizationBillingChange: {
        findUnique: vi.fn(async (args: { select?: unknown }) => args.select
          ? { organizationId: change.organizationId }
          : loadedChange()),
        findUniqueOrThrow: vi.fn(async () => ({ ...change })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          change = { ...change, ...data };
          return { ...change };
        }),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if ("accessGrantedAt" in data && change.accessGrantedAt) return { count: 0 };
          if ("accessRevokedAt" in data && (!change.accessGrantedAt || change.accessRevokedAt)) {
            return { count: 0 };
          }
          change = { ...change, ...data };
          return { count: 1 };
        }),
      },
      saasRazorpayPlan: {
        findFirst: mocks.planMappingFindFirst,
      },
      organizationSubscription: {
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
      },
      organizationSubscriptionHistory: {
        upsert: vi.fn().mockResolvedValue({}),
      },
      branch: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          branch = { ...branch, ...data };
          return { ...branch };
        }),
      },
    };
    mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
    mocks.cancelSubscription.mockResolvedValue({
      id: "sub_candidate",
      status: "cancelled",
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
    const mappingQuery = mocks.planMappingFindFirst.mock.calls[0][0];
    expect(mappingQuery).toMatchObject({
      where: {
        providerMode: "TEST",
        plan: "BASIC",
        razorpayPlanId: "plan_basic",
      },
    });
    expect(mappingQuery.where).not.toHaveProperty("active");
  });

  it("promotes against the exact historical plan mapping even when it is inactive", async () => {
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

    const mappingQuery = mocks.planMappingFindFirst.mock.calls[0][0];
    expect(mappingQuery.where).toMatchObject({
      providerMode: "TEST",
      plan: "BASIC",
      razorpayPlanId: "plan_basic",
    });
    expect(mappingQuery.where).not.toHaveProperty("active");
    expect(source.currentOrganizationId).toBeNull();
    expect(candidate).toMatchObject({
      pendingReplacementOrganizationId: null,
      currentOrganizationId: "org_1",
    });
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
});
