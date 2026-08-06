import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingDeadlineService } from "@/services/billingDeadline.service";
import { setRazorpayClientForTests, type RazorpayApiClient } from "@/lib/razorpay";
import { createBranch, createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("workspace billing deadlines", () => {
  beforeEach(async () => { await resetDatabase(); });
  afterEach(() => { setRazorpayClientForTests(null); });
  afterAll(async () => { await disconnectDatabase(); });

  function checkoutClient(status: "created" | "authenticated", paymentMethod?: "card"): RazorpayApiClient {
    return {
      createOrder: vi.fn(async () => { throw new Error("unused"); }),
      fetchPayment: vi.fn(async paymentId => ({
        id: paymentId,
        entity: "payment" as const,
        amount: 500,
        currency: "INR",
        status: status === "authenticated" ? "authorized" : "failed",
        order_id: null,
        subscription_id: "sub_deadline",
        method: paymentMethod,
      })),
      fetchOrderPayments: vi.fn(async () => ({ entity: "collection" as const, count: 0, items: [] })),
      capturePayment: vi.fn(async () => { throw new Error("unused"); }),
      createPlan: vi.fn(async () => { throw new Error("unused"); }),
      createSubscription: vi.fn(async () => { throw new Error("unused"); }),
      fetchSubscription: vi.fn(async () => ({
        id: "sub_deadline",
        entity: "subscription" as const,
        plan_id: "plan_basic",
        status,
        total_count: 120,
        quantity: 1,
        payment_method: paymentMethod,
      })),
      updateSubscription: vi.fn(async () => { throw new Error("unused"); }),
      cancelScheduledChanges: vi.fn(async () => { throw new Error("unused"); }),
      fetchSubscriptionInvoices: vi.fn(async () => ({ entity: "collection" as const, count: 0, items: [] })),
      cancelSubscription: vi.fn(async () => { throw new Error("unused"); }),
    };
  }

  it("expires a trial and archives a provider-free scheduled branch at its boundary", async () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: organization.id, name: "Main" });
    const branch = await createBranch({ organizationId: organization.id, name: "Closing" });
    await testPrisma.branch.update({
      where: { id: branch.id },
      data: { billingStatus: "REMOVAL_SCHEDULED" },
    });
    await testPrisma.ownerTrialGrant.create({
      data: {
        ownerId: owner.id,
        organizationId: organization.id,
        source: "ONBOARDING",
        status: "ACTIVE",
        trialStartedAt: new Date("2026-08-03T00:00:00.000Z"),
        trialEndsAt: new Date("2026-09-02T00:00:00.000Z"),
        consumedAt: new Date("2026-08-03T00:00:00.000Z"),
      },
    });
    await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        branchId: branch.id,
        sequence: 1,
        idempotencyKey: "deadline-removal",
        type: "BRANCH_REMOVAL",
        status: "SCHEDULED",
        fromQuantity: 2,
        toQuantity: 1,
        effectiveAt: new Date("2026-09-02T00:00:00.000Z"),
      },
    });

    const result = await BillingDeadlineService.run(now);

    expect(result).toMatchObject({ expiredTrials: 1, archivedBranches: 1, errors: [] });
    await expect(testPrisma.ownerTrialGrant.findUniqueOrThrow({ where: { ownerId: owner.id } }))
      .resolves.toMatchObject({ status: "EXPIRED" });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "ARCHIVED", billingArchivedAt: now });
  });

  it("marks an unconfirmed Checkout operation failed after provider reconciliation at its deadline", async () => {
    setRazorpayClientForTests(checkoutClient("created"));
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_deadline",
        status: "CREATED",
        providerStartAt: new Date("2026-09-10T00:00:00.000Z"),
      },
    });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: "checkout-timeout",
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "AWAITING_PAYMENT",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
        confirmationDeadlineAt: new Date("2026-09-02T23:45:00.000Z"),
      },
    });

    const result = await BillingDeadlineService.run(now);

    expect(result).toMatchObject({ timedOutCheckouts: 1, confirmedCheckouts: 0, errors: [] });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "CONFIRMATION_TIMEOUT",
      });
  });

  it("applies provider-confirmed card authorization at the confirmation deadline without paidThrough", async () => {
    setRazorpayClientForTests(checkoutClient("authenticated", "card"));
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_deadline",
        status: "CREATED",
        providerStartAt: new Date("2026-09-10T00:00:00.000Z"),
      },
    });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: "checkout-confirmed-at-deadline",
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "AWAITING_PAYMENT",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
        providerPaymentId: "pay_deadline_auth",
        confirmationDeadlineAt: new Date("2026-09-02T23:45:00.000Z"),
      },
    });

    const result = await BillingDeadlineService.run(now);

    expect(result).toMatchObject({ timedOutCheckouts: 0, confirmedCheckouts: 1, errors: [] });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "APPLIED", operationStatus: "APPLIED" });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ providerPaymentMethod: "CARD", paidThrough: null });
  });
});
