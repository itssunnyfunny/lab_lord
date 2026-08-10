import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationFindUnique: vi.fn(),
  latestChange: vi.fn(),
  scheduledChanges: vi.fn(),
  staffFindFirst: vi.fn(),
  branchFindFirst: vi.fn(),
  branchFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findUnique: mocks.organizationFindUnique },
    organizationBillingChange: {
      findFirst: mocks.latestChange,
      findMany: mocks.scheduledChanges,
    },
    staff: { findFirst: mocks.staffFindFirst },
    branch: {
      findFirst: mocks.branchFindFirst,
      findUnique: mocks.branchFindUnique,
    },
  },
}));

vi.mock("@/lib/razorpay", () => ({
  resolveRazorpayMode: () => "TEST",
  getRazorpayClient: vi.fn(),
}));

import { BillingExperienceService } from "@/services/billingExperience.service";
import { EntitlementService } from "@/services/entitlement.service";

const paidThrough = new Date("2026-10-01T00:00:00.000Z");
const accessGrantedAt = new Date("2026-08-10T00:00:00.000Z");

function organization(accessRevokedAt: Date | null = null) {
  const replacementBillingChange = {
    id: "change_upgrade",
    organizationId: "org_1",
    organizationSubscriptionId: "sub_source_row",
    replacementSubscriptionId: "sub_candidate_row",
    branchId: null,
    sequence: 1,
    idempotencyKey: "upgrade-1",
    type: "PLAN_UPGRADE",
    status: "AWAITING_PAYMENT",
    operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
    fromPlan: "BASIC",
    toPlan: "PRO",
    fromQuantity: 1,
    toQuantity: 1,
    effectiveAt: new Date("2026-09-01T00:00:00.000Z"),
    undoCutoffAt: new Date("2026-08-29T00:00:00.000Z"),
    providerInvoiceId: null,
    providerPaymentId: null,
    attemptCount: 1,
    processingStartedAt: null,
    appliedAt: null,
    undoneAt: null,
    failedAt: null,
    lastError: null,
    returnPath: null,
    confirmationDeadlineAt: null,
    failureCategory: null,
    failureCode: null,
    checkoutOpenedAt: null,
    verificationStartedAt: null,
    providerConfirmedAt: accessGrantedAt,
    accessGrantedAt,
    accessRevokedAt,
    accessGraceEndsAt: new Date("2026-09-04T00:00:00.000Z"),
    abandonedAt: null,
    declinedAt: null,
    resolvedAt: null,
    createdByUserId: "owner_1",
    createdAt: accessGrantedAt,
    updatedAt: accessGrantedAt,
  };
  return {
    id: "org_1",
    ownerId: "owner_1",
    billingModelVersion: "WORKSPACE_V2",
    selectedPostTrialPlan: null,
    ownerTrialGrant: null,
    subscription: {
      id: "sub_source_row",
      providerMode: "TEST",
      plan: "BASIC",
      amount: 299,
      quantity: 1,
      status: "ACTIVE",
      providerPaymentMethod: "UPI",
      paidThrough,
      chargeAt: new Date("2026-10-01T00:00:00.000Z"),
    },
    pendingSubscriptionReplacement: {
      id: "sub_candidate_row",
      providerMode: "TEST",
      plan: "PRO",
      quantity: 1,
      status: "AUTHENTICATED",
      providerPaymentMethod: "UPI",
      replacementBillingChange,
    },
    branches: [{ id: "branch_1" }, { id: "branch_2" }],
    _count: { branches: 2 },
  };
}

describe("authorized replacement access reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organizationFindUnique.mockResolvedValue(organization());
    mocks.latestChange.mockResolvedValue(null);
    mocks.scheduledChanges.mockResolvedValue([]);
  });

  it("exposes upgrade entitlements while retaining canonical billing facts", async () => {
    const entitlement = await EntitlementService.getOrganizationProfile("org_1");
    const experience = await BillingExperienceService.getBillingExperience("org_1", "owner_1");

    expect(entitlement).toMatchObject({
      plan: "BASIC",
      effectivePlan: "PRO",
      subscriptionStatus: "ACTIVE",
      accessMode: "FULL",
      canWrite: true,
    });
    expect(entitlement.entitlements).toContain("AI_ACCESS");
    expect(experience).toMatchObject({
      effectivePlan: "STANDARD",
      providerStatus: "ACTIVE",
      paidThrough: paidThrough.toISOString(),
      confirmedQuantity: 1,
      currentUnitAmount: 299,
      authorizationStatus: "AUTHORIZED",
    });
    expect(experience.entitlements).toContain("AI_ACCESS");
  });

  it("stops exposing complimentary entitlements after revocation", async () => {
    mocks.organizationFindUnique.mockResolvedValue(
      organization(new Date("2026-08-11T00:00:00.000Z"))
    );

    const entitlement = await EntitlementService.getOrganizationProfile("org_1");
    const experience = await BillingExperienceService.getBillingExperience("org_1", "owner_1");

    expect(entitlement.effectivePlan).toBe("BASIC");
    expect(entitlement.entitlements).not.toContain("AI_ACCESS");
    expect(experience.effectivePlan).toBe("BASIC");
    expect(experience.entitlements).not.toContain("AI_ACCESS");
  });
});
