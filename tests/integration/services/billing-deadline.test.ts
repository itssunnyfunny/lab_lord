import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BillingDeadlineService,
  recoverExpiredBillingMutationLease,
} from "@/services/billingDeadline.service";
import { setRazorpayClientForTests, type RazorpayApiClient } from "@/lib/razorpay";
import { createBranch, createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("workspace billing deadlines", () => {
  beforeEach(async () => { await resetDatabase(); });
  afterEach(() => {
    setRazorpayClientForTests(null);
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await disconnectDatabase(); });

  function checkoutClient(
    status: "created" | "authenticated",
    paymentMethod?: "card" | "upi" | "emandate"
  ): RazorpayApiClient {
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

  it("recovers only the exact expired lease snapshot and never a successor lease", async () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        sequence: 1,
        idempotencyKey: "stale-lease-change",
        type: "QUANTITY_INCREASE",
        status: "PROCESSING",
        attemptCount: 1,
        processingStartedAt: new Date("2026-09-02T23:55:00.000Z"),
      },
    });
    await testPrisma.organization.update({
      where: { id: organization.id },
      data: {
        billingMutationLeaseToken: "stale-lease",
        billingMutationLeaseUntil: new Date("2026-09-02T23:59:00.000Z"),
      },
    });
    const staleSnapshot = {
      id: organization.id,
      billingMutationLeaseToken: "stale-lease",
    };

    await testPrisma.organization.update({
      where: { id: organization.id },
      data: {
        billingMutationLeaseToken: "successor-lease",
        billingMutationLeaseUntil: new Date("2026-09-03T00:02:00.000Z"),
      },
    });

    await expect(recoverExpiredBillingMutationLease(staleSnapshot, now)).resolves.toBe(false);
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ billingMutationLeaseToken: "successor-lease" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "PROCESSING", attemptCount: 1 });

    await expect(recoverExpiredBillingMutationLease({
      id: organization.id,
      billingMutationLeaseToken: "successor-lease",
    }, new Date("2026-09-03T00:03:00.000Z"))).resolves.toBe(true);
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ billingMutationLeaseToken: null, billingMutationLeaseUntil: null });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "QUEUED", attemptCount: 1 });
  });

  it("does not consume automatic retry attempts while billing writes are held", async () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        sequence: 1,
        idempotencyKey: "held-failed-change",
        type: "QUANTITY_INCREASE",
        status: "FAILED",
        operationStatus: "FAILED",
        attemptCount: 1,
        failedAt: new Date("2026-09-02T23:55:00.000Z"),
        lastError: "Previous provider failure",
      },
    });
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "false");

    const result = await BillingDeadlineService.run(now);

    expect(result).toMatchObject({ retriedMutations: 0, errors: [] });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        attemptCount: 1,
        lastError: "Previous provider failure",
      });
  });

  it("marks an unconfirmed Checkout operation failed after provider reconciliation at its deadline", async () => {
    setRazorpayClientForTests(checkoutClient("created"));
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
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

  it("stops waiting after the deadline even when provider reconciliation is unavailable", async () => {
    const client = checkoutClient("created");
    vi.mocked(client.fetchSubscription).mockRejectedValue(new Error("provider unavailable"));
    setRazorpayClientForTests(client);
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_deadline_unavailable",
        status: "CREATED",
        providerStartAt: new Date("2026-09-10T00:00:00.000Z"),
      },
    });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: "checkout-timeout-provider-unavailable",
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "AWAITING_PAYMENT",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
        confirmationDeadlineAt: new Date("2026-09-02T23:45:00.000Z"),
      },
    });

    const result = await BillingDeadlineService.run(now);

    expect(result.timedOutCheckouts).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        organizationId: organization.id,
        message: "provider unavailable",
      }),
    ]);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "CONFIRMATION_TIMEOUT",
      });
  });

  it.each([
    ["card", "CARD"],
    ["upi", "UPI"],
    ["emandate", "EMANDATE"],
  ] as const)("applies provider-confirmed %s authorization at the confirmation deadline without paidThrough", async (
    providerMethod,
    storedMethod
  ) => {
    setRazorpayClientForTests(checkoutClient("authenticated", providerMethod));
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
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
      .resolves.toMatchObject({ providerPaymentMethod: storedMethod, paidThrough: null });
  });

  it("waits through the eMandate confirmation window, then cancels and reconciles it", async () => {
    const insideConfirmationWindow = new Date("2026-09-10T00:00:00.000Z");
    const lapsedAt = new Date("2026-09-16T00:00:00.000Z");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
    const client = checkoutClient("authenticated", "emandate");
    vi.mocked(client.cancelSubscription).mockResolvedValue({
      id: "sub_deadline",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "cancelled",
      total_count: 120,
      quantity: 1,
      payment_method: "emandate",
      ended_at: Math.floor(lapsedAt.getTime() / 1000),
    });
    setRazorpayClientForTests(client);
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_deadline",
        status: "AUTHENTICATED",
        providerPaymentMethod: "EMANDATE",
        providerStartAt: new Date("2026-09-09T00:00:00.000Z"),
      },
    });

    const waitingResult = await BillingDeadlineService.run(insideConfirmationWindow);

    expect(waitingResult).toMatchObject({ lapsedAuthorizations: 0, errors: [] });
    expect(client.fetchSubscription).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    })).resolves.toMatchObject({
      currentOrganizationId: organization.id,
      status: "AUTHENTICATED",
      authorizationLapsedAt: null,
      paidThrough: null,
    });

    const result = await BillingDeadlineService.run(lapsedAt);

    expect(client.cancelSubscription).toHaveBeenCalledWith("sub_deadline", {
      cancel_at_cycle_end: false,
    });
    expect(result).toMatchObject({ lapsedAuthorizations: 1, errors: [] });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    })).resolves.toMatchObject({
      currentOrganizationId: organization.id,
      razorpaySubscriptionId: "sub_deadline",
      status: "CANCELLED",
      authorizationLapsedAt: lapsedAt,
      cancelledAt: lapsedAt,
      endedAt: lapsedAt,
    });
    await expect(testPrisma.organizationSubscriptionHistory.findFirstOrThrow({
      where: {
        organizationSubscriptionId: subscription.id,
        event: "authorization_lapsed_provider_terminal",
      },
    })).resolves.toMatchObject({
      razorpaySubscriptionId: "sub_deadline",
      fromStatus: "AUTHENTICATED",
      toStatus: "CANCELLED",
    });
  });

  it("honors Razorpay's explicit eMandate authorization expiry", async () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
    const client = checkoutClient("authenticated", "emandate");
    vi.mocked(client.cancelSubscription).mockResolvedValue({
      id: "sub_deadline",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "cancelled",
      total_count: 120,
      quantity: 1,
      payment_method: "emandate",
      ended_at: Math.floor(now.getTime() / 1000),
    });
    setRazorpayClientForTests(client);
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_deadline",
        status: "AUTHENTICATED",
        providerPaymentMethod: "EMANDATE",
        providerStartAt: new Date("2026-09-09T00:00:00.000Z"),
        authorizationExpiresAt: now,
      },
    });

    const result = await BillingDeadlineService.run(now);

    expect(result).toMatchObject({ lapsedAuthorizations: 1, errors: [] });
    expect(client.cancelSubscription).toHaveBeenCalledWith("sub_deadline", {
      cancel_at_cycle_end: false,
    });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: subscription.id },
    })).resolves.toMatchObject({
      status: "CANCELLED",
      authorizationLapsedAt: now,
      paidThrough: null,
    });
  });

  it("does not lapse a CREATED eMandate while its seven-day confirmation window is open", async () => {
    const client = checkoutClient("created", "emandate");
    setRazorpayClientForTests(client);
    const now = new Date("2026-09-03T00:00:00.000Z");
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_deadline",
        status: "CREATED",
        providerPaymentMethod: "EMANDATE",
        providerStartAt: new Date("2026-09-02T00:00:00.000Z"),
      },
    });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: "emandate-confirmation-window",
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "AWAITING_PAYMENT",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
        providerPaymentId: "pay_deadline_auth",
        confirmationDeadlineAt: new Date("2026-09-09T00:00:00.000Z"),
        failureCategory: "PROVIDER_CONFIRMATION_PENDING",
        failureCode: "EMANDATE_AUTHORIZATION_PENDING",
      },
    });

    const result = await BillingDeadlineService.run(now);

    expect(result).toMatchObject({ lapsedAuthorizations: 0, timedOutCheckouts: 0, errors: [] });
    expect(client.fetchSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ status: "CREATED", paidThrough: null, authorizationLapsedAt: null });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ operationStatus: "AWAITING_PROVIDER_CONFIRMATION" });
  });
});
