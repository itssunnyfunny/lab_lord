import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const paidPeriodStart = new Date("2026-08-01T00:00:00.000Z");
const paidAt = new Date("2026-08-01T00:01:00.000Z");
const paidConfirmedAt = new Date("2026-08-01T00:02:00.000Z");
const accessGrantedAt = new Date("2026-08-10T00:00:00.000Z");
const effectiveAt = new Date("2026-09-01T00:00:00.000Z");
const accessGraceEndsAt = new Date("2026-09-04T00:00:00.000Z");

function organization(overrides: {
  accessRevokedAt?: Date | null;
  candidateStatus?: string;
  candidatePaymentMethod?: string;
  changeStatus?: string;
  failureCategory?: string | null;
} = {}) {
  const replacementBillingChange = {
    id: "change_upgrade",
    organizationId: "org_1",
    organizationSubscriptionId: "sub_source_row",
    replacementSubscriptionId: "sub_candidate_row",
    branchId: null,
    sequence: 1,
    idempotencyKey: "upgrade-1",
    type: "PLAN_UPGRADE",
    status: overrides.changeStatus ?? "SCHEDULED",
    operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
    fromPlan: "BASIC",
    toPlan: "PRO",
    fromQuantity: 1,
    toQuantity: 1,
    effectiveAt,
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
    failureCategory: overrides.failureCategory ?? null,
    failureCode: null,
    checkoutOpenedAt: null,
    verificationStartedAt: null,
    providerConfirmedAt: accessGrantedAt,
    accessGrantedAt,
    accessRevokedAt: overrides.accessRevokedAt ?? null,
    accessGraceEndsAt,
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
      razorpaySubscriptionId: "sub_basic",
      status: "ACTIVE",
      providerPaymentMethod: "UPI",
      paidThrough,
      currentStart: paidPeriodStart,
      currentEnd: paidThrough,
      lastConfirmedInvoiceId: "invoice_basic",
      lastConfirmedPaymentId: "payment_basic",
      lastPaymentConfirmedAt: paidConfirmedAt,
      confirmedCommercialIntentChangeId: "change_basic_paid",
      billingOfferId: null,
      billingOffer: null,
      replacesSubscriptionId: null,
      replacesSubscription: null,
      invoices: [{
        organizationId: "org_1",
        organizationSubscriptionId: "sub_source_row",
        razorpayInvoiceId: "invoice_basic",
        razorpayPaymentId: "payment_basic",
        status: "paid",
        amountSubunits: 29900,
        amountPaidSubunits: 29900,
        amountDueSubunits: 0,
        currency: "INR",
        commercialEvidenceVersion: 1,
        commercialIntentChangeId: "change_basic_paid",
        providerMode: "TEST",
        razorpaySubscriptionId: "sub_basic",
        razorpayPlanId: "plan_basic",
        providerQuantity: 1,
        razorpayOfferId: null,
        paymentAmountSubunits: 29900,
        paymentCurrency: "INR",
        paymentStatus: "captured",
        paymentCaptured: true,
        evidenceConfirmedAt: paidConfirmedAt,
        evidenceFailureCode: null,
        periodStart: paidPeriodStart,
        periodEnd: paidThrough,
        paidAt,
        createdAt: paidConfirmedAt,
        commercialIntentChange: {
          id: "change_basic_paid",
          organizationId: "org_1",
          organizationSubscriptionId: "sub_source_row",
          replacementSubscriptionId: null,
          status: "APPLIED",
          operationStatus: "APPLIED",
          failureCategory: null,
          failureCode: null,
          appliedAt: paidConfirmedAt,
          providerConfirmedAt: paidConfirmedAt,
          toPlan: "BASIC",
          toQuantity: 1,
          commercialIntentVersion: 1,
          commercialIntentCapturedAt: new Date("2026-07-31T00:00:00.000Z"),
          authorizedProviderMode: "TEST",
          authorizedSourceRazorpaySubscriptionId: "sub_basic",
          authorizedRazorpaySubscriptionId: "sub_basic",
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
        },
      }],
      chargeAt: new Date("2026-10-01T00:00:00.000Z"),
    },
    pendingSubscriptionReplacement: {
      id: "sub_candidate_row",
      providerMode: "TEST",
      plan: "PRO",
      quantity: 1,
      status: overrides.candidateStatus ?? "AUTHENTICATED",
      providerPaymentMethod: overrides.candidatePaymentMethod ?? "UPI",
      replacementBillingChange,
    },
    branches: [{ id: "branch_1" }, { id: "branch_2" }],
    _count: { branches: 2 },
  };
}

describe("authorized replacement access reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    mocks.organizationFindUnique.mockResolvedValue(organization());
    mocks.latestChange.mockResolvedValue(null);
    mocks.scheduledChanges.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
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
      organization({ accessRevokedAt: new Date("2026-08-11T00:00:00.000Z") })
    );

    const entitlement = await EntitlementService.getOrganizationProfile("org_1");
    const experience = await BillingExperienceService.getBillingExperience("org_1", "owner_1");

    expect(entitlement.effectivePlan).toBe("BASIC");
    expect(entitlement.entitlements).not.toContain("AI_ACCESS");
    expect(experience.effectivePlan).toBe("BASIC");
    expect(experience.entitlements).not.toContain("AI_ACCESS");
  });

  it.each([
    ["pending before cutover", { candidateStatus: "PENDING" }],
    ["paused mandate", { candidateStatus: "PAUSED" }],
    ["manual review", { failureCategory: "MANUAL_REVIEW_REQUIRED" }],
    ["closed replacement", { changeStatus: "FAILED" }],
  ] as const)("fails closed across entitlement readers for a %s", async (_label, overrides) => {
    mocks.organizationFindUnique.mockResolvedValue(organization(overrides));

    const entitlement = await EntitlementService.getOrganizationProfile("org_1");
    const experience = await BillingExperienceService.getBillingExperience("org_1", "owner_1");

    expect(entitlement.effectivePlan).toBe("BASIC");
    expect(entitlement.entitlements).not.toContain("AI_ACCESS");
    expect(experience.effectivePlan).toBe("BASIC");
    expect(experience.entitlements).not.toContain("AI_ACCESS");
  });

  it("honors only the bounded eMandate confirmation grace", async () => {
    vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
    mocks.organizationFindUnique.mockResolvedValue(organization({
      candidateStatus: "PENDING",
      candidatePaymentMethod: "EMANDATE",
    }));

    await expect(EntitlementService.getOrganizationProfile("org_1"))
      .resolves.toMatchObject({ effectivePlan: "PRO", accessMode: "FULL" });
    await expect(BillingExperienceService.getBillingExperience("org_1", "owner_1"))
      .resolves.toMatchObject({ effectivePlan: "STANDARD" });

    vi.setSystemTime(accessGraceEndsAt);
    await expect(EntitlementService.getOrganizationProfile("org_1"))
      .resolves.toMatchObject({ effectivePlan: "BASIC" });
    await expect(BillingExperienceService.getBillingExperience("org_1", "owner_1"))
      .resolves.toMatchObject({ effectivePlan: "BASIC" });
  });

  it("keeps authenticated replacement access after the pending-debit grace", async () => {
    vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
    mocks.organizationFindUnique.mockResolvedValue(organization({
      candidateStatus: "AUTHENTICATED",
      candidatePaymentMethod: "UPI",
    }));

    await expect(EntitlementService.getOrganizationProfile("org_1"))
      .resolves.toMatchObject({ effectivePlan: "PRO", accessMode: "FULL" });
    await expect(BillingExperienceService.getBillingExperience("org_1", "owner_1"))
      .resolves.toMatchObject({ effectivePlan: "STANDARD" });
  });
});
