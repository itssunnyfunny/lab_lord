import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingService } from "@/services/billing.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { BranchService } from "@/services/branch.service";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
} from "@/lib/billingErrors";
import {
  hmacSha256Hex,
  RazorpayApiError,
  setRazorpayClientForTests,
  sha256Hex,
  type RazorpayApiClient,
  type RazorpayPlanCatalogApiClient,
} from "@/lib/razorpay";
import { createBranch, createOrg, createSaasSubscription, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

function createFakeRazorpayClient() {
  const client: RazorpayPlanCatalogApiClient = {
    createOrder: vi.fn(async () => {
      throw new Error("Orders are not used by SaaS billing tests");
    }),
    fetchPayment: vi.fn(async (paymentId: string) => ({
      id: paymentId,
      entity: "payment" as const,
      amount: 29900,
      currency: "INR",
      status: "captured",
      order_id: null,
      subscription_id: "sub_basic",
      method: "card",
      captured: true,
    })),
    fetchOrderPayments: vi.fn(async () => ({ entity: "collection" as const, count: 0, items: [] })),
    capturePayment: vi.fn(async (paymentId: string) => ({
      id: paymentId,
      entity: "payment" as const,
      amount: 29900,
      currency: "INR",
      status: "captured",
      order_id: null,
      captured: true,
    })),
    createPlan: vi.fn(async input => ({
      id: `plan_${input.notes.plan.toLowerCase()}`,
      entity: "plan" as const,
      interval: input.interval,
      period: input.period,
      item: {
        amount: input.item.amount,
        currency: input.item.currency,
        name: input.item.name,
        description: input.item.description,
      },
    })),
    fetchPlan: vi.fn(async planId => {
      const standard = planId.includes("pro") || planId.includes("standard");
      return {
        id: planId,
        entity: "plan" as const,
        interval: 1,
        period: "monthly",
        item: {
          amount: standard ? 49900 : 29900,
          currency: "INR",
          name: standard ? "Lab Lords Standard" : "Lab Lords Basic",
        },
      };
    }),
    listPlans: vi.fn(async () => ({
      entity: "collection" as const,
      count: 0,
      items: [],
    })),
    createSubscription: vi.fn(async input => ({
      id: `sub_${input.notes.plan.toLowerCase()}`,
      entity: "subscription" as const,
      plan_id: input.plan_id,
      customer_id: "cust_test",
      status: "created",
      total_count: input.total_count,
      quantity: input.quantity,
      paid_count: 0,
      remaining_count: input.total_count,
      start_at: input.start_at ?? null,
      expire_by: input.expire_by ?? null,
      offer_id: input.offer_id ?? null,
      current_start: null,
      current_end: null,
      charge_at: null,
      ended_at: null,
      notes: input.notes,
    })),
    fetchSubscription: vi.fn(async (subscriptionId: string) => ({
      id: subscriptionId,
      entity: "subscription" as const,
      plan_id: "plan_basic",
      customer_id: "cust_test",
      status: "active",
      total_count: 120,
      quantity: 1,
      paid_count: 1,
      remaining_count: 119,
      current_start: 1767225600,
      current_end: 1769904000,
      charge_at: 1769904000,
      ended_at: null,
      offer_id: null,
    })),
    listSubscriptions: vi.fn(async () => ({
      entity: "collection" as const,
      count: 0,
      items: [],
    })),
    updateSubscription: vi.fn(async (subscriptionId, input) => ({
      id: subscriptionId,
      entity: "subscription" as const,
      plan_id: input.plan_id ?? "plan_basic",
      status: "active",
      total_count: 120,
      quantity: input.quantity ?? 1,
      current_start: 1767225600,
      current_end: 1769904000,
      charge_at: 1769904000,
      start_at: input.start_at ?? null,
    })),
    cancelScheduledChanges: vi.fn(async subscriptionId => ({
      id: subscriptionId,
      entity: "subscription" as const,
      plan_id: "plan_basic",
      status: "active",
      total_count: 120,
      quantity: 1,
      has_scheduled_changes: false,
    })),
    fetchSubscriptionInvoices: vi.fn(async () => ({
      entity: "collection" as const,
      count: 0,
      items: [],
    })),
    cancelSubscription: vi.fn(async (subscriptionId, input) => ({
      id: subscriptionId,
      entity: "subscription" as const,
      plan_id: "plan_basic",
      customer_id: "cust_test",
      status: input.cancel_at_cycle_end ? "active" : "cancelled",
      total_count: 120,
      current_end: input.cancel_at_cycle_end ? 1769904000 : null,
      ended_at: input.cancel_at_cycle_end ? null : 1767225600,
      has_scheduled_changes: input.cancel_at_cycle_end,
      change_scheduled_at: input.cancel_at_cycle_end ? 1769904000 : null,
    })),
  };

  return client;
}

function providerSubscriptionForCreate(
  input: Parameters<RazorpayApiClient["createSubscription"]>[0],
  id: string,
  overrides: Partial<Awaited<ReturnType<RazorpayApiClient["createSubscription"]>>> = {}
) {
  return {
    id,
    entity: "subscription" as const,
    plan_id: input.plan_id,
    customer_id: "cust_test",
    status: "created",
    total_count: input.total_count,
    quantity: input.quantity,
    paid_count: 0,
    remaining_count: input.total_count,
    start_at: input.start_at ?? null,
    expire_by: input.expire_by ?? null,
    offer_id: input.offer_id ?? null,
    notes: input.notes,
    ...overrides,
  };
}

function exactBasicAuthorizationIntent(capturedAt = new Date()) {
  return {
    commercialIntentVersion: 1,
    commercialIntentCapturedAt: capturedAt,
    authorizedProviderMode: "TEST" as const,
    authorizedSourceRazorpaySubscriptionId: "sub_basic",
    authorizedRazorpaySubscriptionId: "sub_basic",
    authorizedSourceRazorpayPlanId: "plan_basic",
    authorizedRazorpayPlanId: "plan_basic",
    authorizedPlan: "BASIC" as const,
    authorizedQuantity: 1,
    authorizedRazorpayOfferId: null,
    authorizedUnitAmountSubunits: 29900,
    authorizedGrossAmountSubunits: 29900,
    authorizedExpectedAmountSubunits: 29900,
    authorizedOfferValidThroughPaidCount: null,
    authorizedCurrency: "INR",
    authorizedPeriod: "monthly",
    authorizedInterval: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function subscriptionActivatedWebhookBody() {
  return JSON.stringify({
    event: "subscription.activated",
    payload: {
      subscription: {
        entity: {
          id: "sub_basic",
          entity: "subscription",
          plan_id: "plan_basic",
          status: "active",
          total_count: 120,
          quantity: 1,
        },
      },
    },
  });
}

describe("BillingService SaaS subscriptions", () => {
  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "secret");
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "webhook_secret");
  });

  afterEach(() => {
    setRazorpayClientForTests(null);
    vi.unstubAllEnvs();
  });

  it("creates a Razorpay subscription checkout for the Basic SaaS plan", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, name: "Owner Lab" });
    await testPrisma.organization.update({
      where: { id: org.id },
      data: { contactPhone: "09876 543210" },
    });

    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    expect(checkout.keyId).toBe("rzp_test_key");
    expect(checkout.subscriptionId).toBe("sub_basic");
    expect(checkout.amount).toBe(29900);
    expect(checkout).toMatchObject({
      purpose: "INITIAL",
      testMode: true,
      description: "Basic: 1 branch x Rs.299 = Rs.299/month",
      prefill: { contact: "+919876543210" },
      config: {
        display: {
          sequence: ["block.cards"],
          preferences: { show_default_blocks: false },
        },
      },
      summary: {
        plan: "BASIC",
        unitAmount: 299,
        quantity: 1,
        estimatedMonthlyTotal: 299,
        planFeeDueToday: 299,
        trialEndsAt: null,
        firstChargeAt: null,
      },
    });
    expect(fakeRazorpay.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ amount: 29900, currency: "INR" }),
      notes: expect.objectContaining({ plan: "BASIC", billing_type: "saas_plan" }),
    }));
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: "plan_basic",
      customer_notify: true,
      notes: expect.objectContaining({ organization_id: org.id, billing_type: "saas_subscription" }),
    }));

    const stored = await testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: org.id },
    });
    expect(stored).toMatchObject({
      plan: "BASIC",
      amount: 299,
      amountSubunits: 29900,
      razorpayPlanId: "plan_basic",
      razorpaySubscriptionId: "sub_basic",
      status: "CREATED",
    });
    await expect(testPrisma.organizationSubscriptionHistory.findMany({
      where: { organizationId: org.id },
    })).resolves.toMatchObject([{ source: "CHECKOUT", fromStatus: null, toStatus: "CREATED" }]);
    await expect(testPrisma.organization.findUnique({
      where: { id: org.id },
      select: { selectedPostTrialPlan: true },
    })).resolves.toEqual({ selectedPostTrialPlan: "BASIC" });
  });

  it("blocks coming-soon and custom plans from checkout", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    await expect(
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "AGENT_CONTROL" })
    ).rejects.toThrow("not available");
    await expect(
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "CUSTOM" })
    ).rejects.toThrow("not available");
    expect(fakeRazorpay.createPlan).not.toHaveBeenCalled();
  });

  it("publishes only the Basic and Standard monthly plans", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    const overview = await BillingService.listPlansForOrganization(user.id, org.id);

    expect(overview.plans.map(plan => ({ id: plan.id, name: plan.shortName, amount: plan.amount }))).toEqual([
      { id: "BASIC", name: "Basic", amount: 299 },
      { id: "PRO", name: "Standard", amount: 499 },
    ]);
    expect(overview.entitlements).toMatchObject({
      plan: null,
      effectivePlan: "BASIC",
      fallbackAccess: true,
    });
  });

  it("publishes the server-controlled Checkout method availability", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "false");
    await expect(BillingService.listPlansForOrganization(user.id, org.id))
      .resolves.toMatchObject({
        multiMethodSubscriptionsEnabled: false,
        checkoutMethodAvailability: {
          mode: "CARD_ONLY",
          potentialMethods: ["CARD"],
          providerControlsVisibility: false,
        },
      });

    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "true");
    await expect(BillingService.listPlansForOrganization(user.id, org.id))
      .resolves.toMatchObject({
        multiMethodSubscriptionsEnabled: true,
        checkoutMethodAvailability: {
          mode: "PROVIDER_MANAGED",
          potentialMethods: ["CARD", "UPI", "EMANDATE"],
          providerControlsVisibility: true,
        },
      });
  });

  it("uses the local post-trial choice when no provider subscription exists", async () => {
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "PRO",
    });

    const overview = await BillingService.listPlansForOrganization(user.id, org.id);

    expect(overview.experience).toMatchObject({
      effectivePlan: "NONE",
      selectedPostTrialPlan: "STANDARD",
      paymentAction: "AUTHORIZE_CARD",
      projectedUnitAmount: 499,
      customerMessage: "Authorize the selected plan to activate billing for this workspace.",
    });
    expect(overview.entitlements.effectivePlan).toBe("BASIC");
  });

  it("does not invent a post-trial plan or charge date for an unconfigured workspace", async () => {
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: null,
    });

    const overview = await BillingService.listPlansForOrganization(user.id, org.id);

    expect(overview.experience).toMatchObject({
      selectedPostTrialPlan: null,
      projectedUnitAmount: 0,
      projectedMonthlyTotal: 0,
      planFeeDueToday: 0,
      nextChargeAt: null,
      paymentAction: "CHOOSE_PLAN",
      authorizationStatus: "NOT_AUTHORIZED",
      customerMessage: "Choose a plan and authorize a supported recurring payment method for this workspace.",
    });
    expect(overview.experience.customerMessage).not.toContain("trial");
    expect(overview).not.toHaveProperty("projection");
    expect(overview.razorpayTestMode).toBe(true);
  });

  it("asks the owner to authorize the selected plan while Standard trial access continues", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    const now = new Date();
    await testPrisma.ownerTrialGrant.create({
      data: {
        ownerId: user.id,
        organizationId: org.id,
        source: "ONBOARDING",
        status: "ACTIVE",
        claimedAt: now,
        trialStartedAt: now,
        trialEndsAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        consumedAt: now,
      },
    });
    await createBranch({ organizationId: org.id });

    const overview = await BillingService.listPlansForOrganization(user.id, org.id);

    expect(overview.experience).toMatchObject({
      effectivePlan: "STANDARD_TRIAL",
      selectedPostTrialPlan: "BASIC",
      paymentAction: "AUTHORIZE_CARD",
      planFeeDueToday: 0,
      authorizationStatus: "NOT_AUTHORIZED",
      nextChargeAt: null,
    });
    expect(overview.entitlements.effectivePlan).toBe("PRO");
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    expect(checkout.summary).toMatchObject({
      planFeeDueToday: 0,
      trialEndsAt: expect.any(String),
      firstChargeAt: null,
    });
    expect(checkout.description).toMatch(/^Basic: 1 branch x Rs\.299 = Rs\.299\/month; starts /);
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      start_at: expect.any(Number),
    }));
  });

  it("scopes an active owner trial to its bound organization", async () => {
    const owner = await createUser();
    const trialOrganization = await createOrg({
      ownerId: owner.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "PRO",
    });
    const otherOrganization = await createOrg({
      ownerId: owner.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    const now = new Date();
    await testPrisma.ownerTrialGrant.create({
      data: {
        ownerId: owner.id,
        organizationId: trialOrganization.id,
        source: "ONBOARDING",
        status: "ACTIVE",
        claimedAt: now,
        trialStartedAt: now,
        trialEndsAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        consumedAt: now,
      },
    });
    const bound = await BillingService.listPlansForOrganization(owner.id, trialOrganization.id);
    const unbound = await BillingService.listPlansForOrganization(owner.id, otherOrganization.id);

    expect(bound.experience.effectivePlan).toBe("STANDARD_TRIAL");
    expect(bound.trial).toMatchObject({ organizationId: trialOrganization.id, status: "ACTIVE" });
    expect(unbound.experience).toMatchObject({ effectivePlan: "NONE", trialEndsAt: null });
    expect(unbound.trial).toBeNull();
    expect(unbound.ownerTrialEligibility).toEqual({
      status: "ACTIVE",
      claimable: false,
      boundOrganizationId: trialOrganization.id,
    });
  });

  it("replaces a stale Razorpay price mapping without changing existing subscriptions", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.createPlan).mockImplementationOnce(async input => ({
      id: "plan_basic_299",
      entity: "plan" as const,
      interval: input.interval,
      period: input.period,
      item: { ...input.item },
    }));
    setRazorpayClientForTests(fakeRazorpay);
    const legacyOwner = await createUser({ email: "legacy-owner@example.com" });
    const legacyOrg = await createOrg({ ownerId: legacyOwner.id, name: "Legacy Lab" });
    await testPrisma.saasRazorpayPlan.create({
      data: {
        providerMode: "TEST",
        catalogKey: "razorpay-plan:v1:TEST:BASIC:INR:39900:monthly:1",
        plan: "BASIC",
        amount: 399,
        amountSubunits: 39900,
        currency: "INR",
        period: "monthly",
        interval: 1,
        razorpayPlanId: "plan_basic_399",
      },
    });
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: legacyOrg.id,
        currentOrganizationId: legacyOrg.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 399,
        amountSubunits: 39900,
        currency: "INR",
        period: "monthly",
        interval: 1,
        totalCount: 120,
        razorpayPlanId: "plan_basic_399",
        razorpaySubscriptionId: "sub_legacy_basic",
        status: "ACTIVE",
      },
    });
    const newOwner = await createUser({ email: "new-owner@example.com" });
    const newOrg = await createOrg({ ownerId: newOwner.id, name: "New Lab" });

    const checkout = await BillingService.createSubscriptionCheckout(newOwner.id, newOrg.id, { plan: "BASIC" });

    expect(checkout.amount).toBe(29900);
    await expect(testPrisma.saasRazorpayPlan.findFirst({ where: { plan: "BASIC", active: true } })).resolves.toMatchObject({
      amount: 299,
      amountSubunits: 29900,
      razorpayPlanId: "plan_basic_299",
    });
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: legacyOrg.id },
    })).resolves.toMatchObject({
      amount: 399,
      amountSubunits: 39900,
      razorpayPlanId: "plan_basic_399",
    });
  });

  it("serializes concurrent checkout requests for the same organization", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    const [first, second] = await Promise.all([
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }),
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }),
    ]);

    expect(first.subscriptionId).toBe("sub_basic");
    expect(second.subscriptionId).toBe("sub_basic");
    expect(second.changeId).toBe(first.changeId);
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationSubscription.count({
      where: { organizationId: org.id },
    })).resolves.toBe(1);
    await expect(testPrisma.organizationBillingChange.count({
      where: {
        organizationId: org.id,
        type: "SUBSCRIPTION_AUTHORIZATION",
        operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
      },
    })).resolves.toBe(1);
  });

  it("blocks a branch quantity mutation while initial provider creation is in flight", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    const providerEntered = deferred();
    const releaseProvider = deferred();
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => {
      providerEntered.resolve();
      await releaseProvider.promise;
      return providerSubscriptionForCreate(input, "sub_quantity_fenced");
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
    });
    await createBranch({ organizationId: org.id });
    const now = new Date();
    await testPrisma.ownerTrialGrant.create({
      data: {
        ownerId: user.id,
        organizationId: org.id,
        source: "ONBOARDING",
        status: "ACTIVE",
        claimedAt: now,
        trialStartedAt: now,
        trialEndsAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        consumedAt: now,
      },
    });

    const checkoutPromise = BillingService.createSubscriptionCheckout(
      user.id,
      org.id,
      { plan: "BASIC" }
    );
    await providerEntered.promise;
    try {
      await expect(BranchService.createBranchForOrg({
        organizationId: org.id,
        userId: user.id,
        name: "Racing Branch",
        contactPhone: "9876543210",
        idempotencyKey: "racing-branch",
      })).rejects.toBeInstanceOf(BillingChangeInProgressError);
    } finally {
      releaseProvider.resolve();
    }

    await expect(checkoutPromise).resolves.toMatchObject({
      subscriptionId: "sub_quantity_fenced",
      summary: { quantity: 1 },
    });
    await expect(testPrisma.branch.count({ where: { organizationId: org.id } }))
      .resolves.toBe(1);
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("adopts an accepted create after a lost response without issuing a second provider mutation", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    let accepted: ReturnType<typeof providerSubscriptionForCreate> | null = null;
    let submittedNotes: Record<string, string> | null = null;
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => {
      accepted = providerSubscriptionForCreate(input, "sub_lost_response");
      submittedNotes = input.notes;
      throw new RazorpayApiError("provider response was lost", { kind: "NETWORK" });
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
    });
    await createBranch({ organizationId: org.id });

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    const change = await testPrisma.organizationBillingChange.findFirstOrThrow({
      where: { organizationId: org.id, provisioningIntentVersion: 1 },
    });
    expect(change).toMatchObject({
      organizationId: org.id,
      organizationSubscriptionId: null,
      operationStatus: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SUBSCRIPTION_CREATE_OUTCOME_UNKNOWN",
      authorizedProviderMode: "TEST",
      authorizedBillingModelVersion: "WORKSPACE_V2",
      authorizedPlan: "BASIC",
      authorizedQuantity: 1,
      authorizedRazorpaySubscriptionId: null,
      attemptCount: 1,
      resolvedAt: null,
    });
    expect(change.providerMutationAdmittedAt).toBeInstanceOf(Date);
    expect(change.authorizedProviderExpireAt).toBeInstanceOf(Date);
    expect(submittedNotes).toMatchObject({
      app: "lab_lords",
      billing_type: "saas_subscription",
      organization_id: org.id,
      provider_mode: "TEST",
      billing_change_id: change.id,
      billing_model_version: "WORKSPACE_V2",
      plan: "BASIC",
      provider_plan_id: "plan_basic",
      quantity: "1",
      offer_id: "none",
      start_at: "immediate",
      total_count: "120",
    });
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: org.id },
    })).resolves.toBeNull();

    if (!accepted) throw new Error("Accepted provider subscription was not captured");
    const acceptedProvider = accepted as ReturnType<typeof providerSubscriptionForCreate>;
    vi.mocked(fakeRazorpay.listSubscriptions!).mockResolvedValueOnce({
      entity: "collection",
      count: 1,
      items: [acceptedProvider],
    });

    await expect(BillingService.retryBillingOperation(user.id, org.id, change.id))
      .resolves.toMatchObject({
        resolutionOutcome: "PROVIDER_STATE_ADOPTED",
        checkout: { subscriptionId: "sub_lost_response" },
      });
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({
      organizationId: org.id,
      providerMode: "TEST",
      razorpaySubscriptionId: "sub_lost_response",
      status: "CREATED",
      paidThrough: null,
    });
    await expect(testPrisma.organizationBillingChangeAudit.findMany({
      where: { changeId: change.id },
      orderBy: { createdAt: "asc" },
    })).resolves.toMatchObject([
      { outcome: "PROVISIONING_INTENT_CREATED", attemptCount: 0 },
      { outcome: "PROVIDER_MUTATION_ADMITTED", attemptCount: 1 },
      { outcome: "MANUAL_REVIEW_REQUIRED", failureCode: "SUBSCRIPTION_CREATE_OUTCOME_UNKNOWN" },
      { outcome: "PROVIDER_STATE_ADOPTED", providerSubscriptionId: "sub_lost_response" },
    ]);
  });

  it("does not adopt a recovered provider subscription after local billing state advances", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    let accepted: ReturnType<typeof providerSubscriptionForCreate> | null = null;
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => {
      accepted = providerSubscriptionForCreate(input, "sub_stale_local_state");
      throw new RazorpayApiError("provider response was lost", { kind: "NETWORK" });
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
    });
    await createBranch({ organizationId: org.id });

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);
    const change = await testPrisma.organizationBillingChange.findFirstOrThrow({
      where: { organizationId: org.id, provisioningIntentVersion: 1 },
    });
    if (!accepted) throw new Error("Accepted provider subscription was not captured");
    vi.mocked(fakeRazorpay.listSubscriptions!).mockResolvedValueOnce({
      entity: "collection",
      count: 1,
      items: [accepted as ReturnType<typeof providerSubscriptionForCreate>],
    });
    await testPrisma.organization.update({
      where: { id: org.id },
      data: { billingMutationSequence: { increment: 1 } },
    });

    await expect(BillingService.retryBillingOperation(user.id, org.id, change.id))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: org.id },
    })).resolves.toBeNull();
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: change.id },
    })).resolves.toMatchObject({
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SUBSCRIPTION_CREATE_LOCAL_FINALIZATION_FAILED",
      resolvedAt: null,
    });
  });

  it("audits a runtime-mode mismatch without reading or mutating provider state", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => {
      void providerSubscriptionForCreate(input, "sub_mode_mismatch");
      throw new RazorpayApiError("provider response was lost", { kind: "NETWORK" });
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);
    const change = await testPrisma.organizationBillingChange.findFirstOrThrow({
      where: { organizationId: org.id, provisioningIntentVersion: 1 },
    });

    vi.stubEnv("RAZORPAY_MODE", "LIVE");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_live_key");
    await expect(BillingService.getBillingOperation(user.id, org.id, change.id))
      .resolves.toMatchObject({
        operation: { id: change.id },
        resolutionHistory: expect.arrayContaining([
          expect.objectContaining({ outcome: "MANUAL_REVIEW_REQUIRED" }),
        ]),
      });
    await expect(BillingService.retryBillingOperation(user.id, org.id, change.id))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    expect(fakeRazorpay.listSubscriptions).not.toHaveBeenCalled();
    expect(fakeRazorpay.fetchSubscription).not.toHaveBeenCalled();
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: change.id },
    })).resolves.toMatchObject({
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SUBSCRIPTION_CREATE_MODE_MISMATCH",
      resolvedAt: null,
    });
    await expect(testPrisma.organizationBillingChangeAudit.findMany({
      where: { changeId: change.id },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: "MANUAL_REVIEW_RETAINED",
        failureCode: "SUBSCRIPTION_CREATE_MODE_MISMATCH",
      }),
    ]));
  });

  it("keeps multiple exact provider matches in manual review without cancelling or recreating them", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    let accepted: ReturnType<typeof providerSubscriptionForCreate> | null = null;
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => {
      accepted = providerSubscriptionForCreate(input, "sub_duplicate_a");
      throw new RazorpayApiError("provider response was lost", { kind: "NETWORK" });
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);
    const change = await testPrisma.organizationBillingChange.findFirstOrThrow({
      where: { organizationId: org.id, provisioningIntentVersion: 1 },
    });
    if (!accepted) throw new Error("Accepted provider subscription was not captured");
    const acceptedProvider = accepted as ReturnType<typeof providerSubscriptionForCreate>;
    vi.mocked(fakeRazorpay.listSubscriptions!).mockResolvedValueOnce({
      entity: "collection",
      count: 2,
      items: [acceptedProvider, { ...acceptedProvider, id: "sub_duplicate_b" }],
    });

    await expect(BillingService.retryBillingOperation(user.id, org.id, change.id))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: change.id },
    })).resolves.toMatchObject({
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SUBSCRIPTION_CREATE_MULTIPLE_MATCHES",
      resolvedAt: null,
    });
    await expect(testPrisma.organizationSubscription.count({
      where: { organizationId: org.id },
    })).resolves.toBe(0);
  });

  it("keeps an authorized or charged unknown match in manual review without granting access", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    let accepted: ReturnType<typeof providerSubscriptionForCreate> | null = null;
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => {
      accepted = providerSubscriptionForCreate(input, "sub_unknown_charged");
      throw new RazorpayApiError("provider response was lost", { kind: "NETWORK" });
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);
    const change = await testPrisma.organizationBillingChange.findFirstOrThrow({
      where: { organizationId: org.id, provisioningIntentVersion: 1 },
    });
    if (!accepted) throw new Error("Accepted provider subscription was not captured");
    const acceptedProvider = accepted as ReturnType<typeof providerSubscriptionForCreate>;
    vi.mocked(fakeRazorpay.listSubscriptions!).mockResolvedValueOnce({
      entity: "collection",
      count: 1,
      items: [{ ...acceptedProvider, status: "authenticated", paid_count: 1 }],
    });

    await expect(BillingService.retryBillingOperation(user.id, org.id, change.id))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: change.id },
    })).resolves.toMatchObject({
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SUBSCRIPTION_CREATE_UNSAFE_MATCH",
      resolvedAt: null,
    });
    await expect(testPrisma.organizationSubscription.count({
      where: { organizationId: org.id },
    })).resolves.toBe(0);
  });

  it("rejects wrong-mode subscriptions in checkout, verification, recovery, and signed webhooks", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: org.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await testPrisma.organizationSubscription.update({
      where: { currentOrganizationId: org.id },
      data: { providerMode: "LIVE" },
    });

    await expect(
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" })
    ).rejects.toThrow("belongs to Razorpay LIVE mode");
    await expect(BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_wrongmode",
      razorpay_signature: hmacSha256Hex("pay_wrongmode|sub_basic", "secret"),
    })).rejects.toThrow("belongs to Razorpay LIVE mode");

    await testPrisma.organizationSubscription.update({
      where: { currentOrganizationId: org.id },
      data: { status: "PENDING" },
    });
    await expect(BillingService.getRecoveryCheckout(user.id, org.id))
      .rejects.toThrow("belongs to Razorpay LIVE mode");

    const rawBody = JSON.stringify({
      event: "subscription.halted",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
            entity: "subscription",
            plan_id: "plan_basic",
            status: "halted",
            total_count: 120,
          },
        },
      },
    });
    await expect(BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_wrong_provider_mode"
    )).rejects.toThrow("belongs to Razorpay LIVE mode");
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({ providerMode: "LIVE", status: "PENDING" });
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("replaces a CREATED checkout when the projected branch quantity changes", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    const createSubscription = vi.mocked(fakeRazorpay.createSubscription);
    const originalCreate = createSubscription.getMockImplementation();
    if (!originalCreate) throw new Error("Missing fake Razorpay subscription implementation");
    let providerSequence = 0;
    createSubscription.mockImplementation(async input => ({
      ...await originalCreate(input),
      id: `sub_basic_quantity_${++providerSequence}`,
      quantity: input.quantity,
    }));
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    const offer = await testPrisma.billingOffer.create({
      data: {
        providerMode: "TEST",
        name: "Basic launch offer",
        plan: "BASIC",
        razorpayOfferId: "offer_basic_quantity",
        discountType: "PERCENTAGE",
        discountValue: 10,
        durationType: "LIMITED_CYCLES",
        durationCycles: 2,
      },
    });
    const grant = await testPrisma.organizationOfferGrant.create({
      data: {
        organizationId: org.id,
        billingOfferId: offer.id,
        status: "ELIGIBLE",
      },
    });
    await createBranch({ organizationId: org.id, name: "First branch" });

    const first = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await createBranch({ organizationId: org.id, name: "Second branch" });
    const replacement = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    expect(first).toMatchObject({ subscriptionId: "sub_basic_quantity_1", summary: { quantity: 1 } });
    expect(replacement).toMatchObject({ subscriptionId: "sub_basic_quantity_2", summary: { quantity: 2 } });
    expect(fakeRazorpay.cancelSubscription).toHaveBeenCalledWith("sub_basic_quantity_1", {
      cancel_at_cycle_end: false,
    });
    expect(createSubscription).toHaveBeenCalledTimes(2);
    expect(createSubscription).toHaveBeenNthCalledWith(1, expect.objectContaining({
      offer_id: "offer_basic_quantity",
      quantity: 1,
    }));
    expect(createSubscription).toHaveBeenNthCalledWith(2, expect.objectContaining({
      offer_id: "offer_basic_quantity",
      quantity: 2,
    }));
    await expect(testPrisma.organizationBillingChange.count({
      where: {
        organizationId: org.id,
        type: "SUBSCRIPTION_AUTHORIZATION",
        operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
      },
    })).resolves.toBe(1);
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({
      razorpaySubscriptionId: "sub_basic_quantity_2",
      quantity: 2,
      status: "CREATED",
      billingOfferId: offer.id,
    });
    await expect(testPrisma.organizationOfferGrant.findUniqueOrThrow({
      where: { id: grant.id },
    })).resolves.toMatchObject({
      status: "RESERVED",
      subscriptionId: "sub_basic_quantity_2",
    });
  });

  it("releases a reserved offer when checkout replacement fails and reapplies it on retry", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    const createSubscription = vi.mocked(fakeRazorpay.createSubscription);
    const originalCreate = createSubscription.getMockImplementation();
    if (!originalCreate) throw new Error("Missing fake Razorpay subscription implementation");
    let providerAttempt = 0;
    createSubscription.mockImplementation(async input => {
      providerAttempt += 1;
      if (providerAttempt === 2) {
        throw new RazorpayApiError("Razorpay replacement unavailable", {
          kind: "REQUEST",
          status: 400,
        });
      }
      return {
        ...await originalCreate(input),
        id: `sub_basic_offer_retry_${providerAttempt}`,
        quantity: input.quantity,
      };
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    const offer = await testPrisma.billingOffer.create({
      data: {
        providerMode: "TEST",
        name: "Retry-safe Basic offer",
        plan: "BASIC",
        razorpayOfferId: "offer_basic_retry",
        discountType: "PERCENTAGE",
        discountValue: 10,
        durationType: "LIMITED_CYCLES",
        durationCycles: 2,
      },
    });
    const grant = await testPrisma.organizationOfferGrant.create({
      data: {
        organizationId: org.id,
        billingOfferId: offer.id,
        status: "ELIGIBLE",
      },
    });
    await createBranch({ organizationId: org.id, name: "First branch" });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await createBranch({ organizationId: org.id, name: "Second branch" });

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }))
      .rejects.toThrow("Razorpay replacement unavailable");
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({
      razorpaySubscriptionId: "sub_basic_offer_retry_1",
      status: "CANCELLED",
    });
    await expect(testPrisma.organizationOfferGrant.findUniqueOrThrow({
      where: { id: grant.id },
    })).resolves.toMatchObject({
      status: "ELIGIBLE",
      subscriptionId: null,
      reservedAt: null,
    });

    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValueOnce({
      id: "sub_basic_offer_retry_1",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "cancelled",
      total_count: 120,
      quantity: 1,
      paid_count: 0,
    });

    const retry = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    expect(retry).toMatchObject({
      subscriptionId: "sub_basic_offer_retry_3",
      summary: { quantity: 2 },
    });
    expect(createSubscription).toHaveBeenNthCalledWith(3, expect.objectContaining({
      offer_id: "offer_basic_retry",
      quantity: 2,
    }));
    await expect(testPrisma.organizationOfferGrant.findUniqueOrThrow({
      where: { id: grant.id },
    })).resolves.toMatchObject({
      status: "RESERVED",
      subscriptionId: "sub_basic_offer_retry_3",
    });
  });

  it("reuses a dismissed checkout and lets the owner switch plans before payment", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    const first = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const retried = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const switched = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "PRO" });

    expect(retried.subscriptionId).toBe(first.subscriptionId);
    expect(switched).toMatchObject({
      subscriptionId: "sub_pro",
      amount: 49900,
      plan: { id: "PRO", shortName: "Standard" },
    });
    expect(fakeRazorpay.cancelSubscription).toHaveBeenCalledWith("sub_basic", {
      cancel_at_cycle_end: false,
    });
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(2);
    const currentSubscription = await testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    });
    expect(currentSubscription).toMatchObject({
      plan: "PRO",
      razorpaySubscriptionId: "sub_pro",
      status: "CREATED",
    });
    const retiredSubscription = await testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { razorpaySubscriptionId: "sub_basic" },
    });
    expect(retiredSubscription).toMatchObject({
      currentOrganizationId: null,
      plan: "BASIC",
      razorpaySubscriptionId: "sub_basic",
      status: "CANCELLED",
    });
    expect(currentSubscription.replacesSubscriptionId).toBe(retiredSubscription.id);
    await expect(testPrisma.organizationSubscription.count({
      where: { organizationId: org.id },
    })).resolves.toBe(2);
    const history = await testPrisma.organizationSubscriptionHistory.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map(entry => entry.event)).toEqual([null, "checkout_replaced", null]);
    const authorizationOperations = await testPrisma.organizationBillingChange.findMany({
      where: { organizationId: org.id, type: "SUBSCRIPTION_AUTHORIZATION" },
      orderBy: { sequence: "asc" },
    });
    expect(authorizationOperations).toHaveLength(2);
    expect(authorizationOperations[0]).toMatchObject({
      toPlan: "BASIC",
      status: "SUPERSEDED",
      operationStatus: "ABANDONED",
    });
    expect(authorizationOperations[1]).toMatchObject({
      toPlan: "PRO",
      status: "AWAITING_PAYMENT",
      operationStatus: "CHECKOUT_OPEN",
    });
  });

  it("does not drop a locally expired provider identity when provider cleanup fails", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const first = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const lapsedAt = new Date("2026-08-11T00:00:00.000Z");
    await testPrisma.organizationSubscription.update({
      where: { currentOrganizationId: org.id },
      data: {
        status: "EXPIRED",
        providerPaymentMethod: "EMANDATE",
        authorizationLapsedAt: lapsedAt,
      },
    });
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValueOnce({
      id: first.subscriptionId,
      entity: "subscription",
      plan_id: "plan_basic",
      status: "authenticated",
      total_count: 120,
      quantity: 1,
      payment_method: "emandate",
    });
    vi.mocked(fakeRazorpay.cancelSubscription).mockRejectedValueOnce(
      new Error("provider cancellation unavailable")
    );

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "PRO" }))
      .rejects.toThrow("provider cancellation unavailable");

    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.cancelSubscription).toHaveBeenCalledWith(first.subscriptionId, {
      cancel_at_cycle_end: false,
    });
    await expect(testPrisma.organizationSubscription.findMany({
      where: { organizationId: org.id },
    })).resolves.toEqual([
      expect.objectContaining({
        currentOrganizationId: org.id,
        razorpaySubscriptionId: first.subscriptionId,
        status: "EXPIRED",
      }),
    ]);
  });

  it.each(["card", "upi"] as const)(
    "reopens the same initial provider identity after a normal %s checkout failure",
    async providerMethod => {
      const fakeRazorpay = createFakeRazorpayClient();
      setRazorpayClientForTests(fakeRazorpay);
      const user = await createUser();
      const org = await createOrg({ ownerId: user.id });
      const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
      await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
        event: "FAILED",
        reason: "network_error",
        source: "network",
      });
      vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValueOnce({
        id: checkout.subscriptionId,
        entity: "subscription",
        plan_id: "plan_basic",
        status: "created",
        total_count: 120,
        quantity: 1,
        payment_method: providerMethod,
      });

      const retried = await BillingService.retryBillingOperation(user.id, org.id, checkout.changeId);

      expect(retried).toMatchObject({
        subscriptionId: checkout.subscriptionId,
        operation: { operationStatus: "CHECKOUT_OPEN" },
      });
      expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
      expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
      await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
        where: { currentOrganizationId: org.id },
      })).resolves.toMatchObject({ razorpaySubscriptionId: checkout.subscriptionId });
    }
  );

  it("leaves only the winning authorization active when different plans race", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    await Promise.allSettled([
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }),
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "PRO" }),
    ]);

    const subscription = await testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    });
    const operations = await testPrisma.organizationBillingChange.findMany({
      where: { organizationId: org.id, type: "SUBSCRIPTION_AUTHORIZATION" },
      orderBy: { sequence: "asc" },
    });
    const active = operations.filter(operation =>
      ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"].includes(operation.operationStatus)
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      organizationSubscriptionId: subscription.id,
      toPlan: subscription.plan,
      toQuantity: subscription.quantity,
    });
    expect(operations.length).toBeGreaterThanOrEqual(1);
    expect(operations
      .filter(operation => operation.id !== active[0].id)
      .every(operation => operation.status === "SUPERSEDED" && operation.operationStatus === "ABANDONED"))
      .toBe(true);
  });

  it("recovers a known provider identity after local finalization fails without cancelling or recreating it", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    let accepted: Awaited<ReturnType<typeof fakeRazorpay.createSubscription>> | null = null;
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => {
      accepted = {
        id: "sub_orphan",
        entity: "subscription" as const,
        plan_id: input.plan_id,
        customer_id: { invalid: true } as never,
        status: "created",
        total_count: input.total_count,
        quantity: input.quantity,
        paid_count: 0,
        remaining_count: input.total_count,
        start_at: input.start_at ?? null,
        expire_by: input.expire_by ?? null,
        offer_id: input.offer_id ?? null,
        notes: input.notes,
      };
      return accepted;
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    await expect(BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" }))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    const change = await testPrisma.organizationBillingChange.findFirstOrThrow({
      where: { organizationId: org.id, provisioningIntentVersion: 1 },
    });
    expect(change).toMatchObject({
      authorizedRazorpaySubscriptionId: "sub_orphan",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SUBSCRIPTION_CREATE_LOCAL_FINALIZATION_FAILED",
      resolvedAt: null,
    });
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: org.id },
    })).resolves.toBeNull();

    if (!accepted) throw new Error("Provider create was not captured");
    const acceptedProvider = accepted as Awaited<
      ReturnType<typeof fakeRazorpay.createSubscription>
    >;
    vi.mocked(fakeRazorpay.listSubscriptions!).mockResolvedValueOnce({
      entity: "collection",
      count: 1,
      items: [{ ...acceptedProvider, customer_id: "cust_recovered" }],
    });

    await expect(BillingService.retryBillingOperation(user.id, org.id, change.id))
      .resolves.toMatchObject({
        resolutionOutcome: "PROVIDER_STATE_ADOPTED",
        checkout: { subscriptionId: "sub_orphan" },
      });
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({
      razorpaySubscriptionId: "sub_orphan",
      status: "CREATED",
    });
  });

  it("verifies checkout signatures server-side before activating a subscription", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC", returnPath: `/org/${org.id}/analytics` });

    const result = await BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: hmacSha256Hex("pay_auth|sub_basic", "secret"),
    });

    expect(result.verified).toBe(true);
    expect(result.operation).toMatchObject({ operationStatus: "APPLIED", returnPath: `/org/${org.id}/analytics` });
    expect(result.subscription?.status).toBe("ACTIVE");
    const stored = await testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: org.id },
    });
    expect(stored?.authPaymentId).toBe("pay_auth");
    expect(stored?.currentEnd?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    const history = await testPrisma.organizationSubscriptionHistory.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map(entry => entry.source)).toEqual(["CHECKOUT", "VERIFICATION"]);
  });

  it("waits seven days for a verified eMandate that remains CREATED without granting paid access", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "created",
      total_count: 120,
      quantity: 1,
      payment_method: "emandate",
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_emandateauth",
      entity: "payment",
      amount: 29900,
      currency: "INR",
      status: "authorized",
      order_id: null,
      subscription_id: "sub_basic",
      method: "emandate",
      captured: false,
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    const result = await BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_emandateauth",
      razorpay_signature: hmacSha256Hex("pay_emandateauth|sub_basic", "secret"),
    });

    expect(result).toMatchObject({ verified: true, pending: true });
    const [operation, subscription] = await Promise.all([
      testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: checkout.changeId } }),
      testPrisma.organizationSubscription.findUniqueOrThrow({ where: { currentOrganizationId: org.id } }),
    ]);
    expect(operation).toMatchObject({
      status: "AWAITING_PAYMENT",
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
      failureCode: "EMANDATE_AUTHORIZATION_PENDING",
    });
    expect(operation.confirmationDeadlineAt!.getTime() - operation.verificationStartedAt!.getTime())
      .toBe(7 * 24 * 60 * 60 * 1000);
    expect(subscription).toMatchObject({
      status: "CREATED",
      providerPaymentMethod: "EMANDATE",
      paidThrough: null,
    });
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
  });

  it("fails closed when a verified callback reports an unknown recurring payment method", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_walletauth",
      entity: "payment",
      amount: 29900,
      currency: "INR",
      status: "authorized",
      order_id: null,
      subscription_id: "sub_basic",
      method: "wallet",
      captured: false,
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    const result = await BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_walletauth",
      razorpay_signature: hmacSha256Hex("pay_walletauth|sub_basic", "secret"),
    });

    expect(result).toMatchObject({ verified: true, pending: true });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: checkout.changeId } }))
      .resolves.toMatchObject({
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
        failureCategory: "UNKNOWN_PAYMENT_METHOD",
        failureCode: "UNKNOWN",
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({ status: "CREATED", providerPaymentMethod: "UNKNOWN", paidThrough: null });
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
  });

  it("does not advance a checkout operation when its callback signature is invalid", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    await expect(BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: "invalid-signature",
    })).rejects.toThrow("Invalid Razorpay signature");

    const operation = await testPrisma.organizationBillingChange.findUnique({
      where: { id: checkout.changeId },
    });
    expect(operation).toMatchObject({
      status: "AWAITING_PAYMENT",
      operationStatus: "CHECKOUT_OPEN",
      verificationStartedAt: null,
    });
    expect(fakeRazorpay.fetchSubscription).not.toHaveBeenCalled();
    expect(fakeRazorpay.fetchPayment).not.toHaveBeenCalled();
  });

  it("persists sanitized checkout outcomes idempotently and lets provider success win", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    const declined = await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "DECLINED",
      failureCode: "BAD CODE<>",
      reason: "card_declined",
      source: "bank",
      step: "authentication",
      paymentId: "pay_declined",
    });
    expect(declined.operation).toMatchObject({
      operationStatus: "DECLINED",
      queueStatus: "FAILED",
      failureCategory: "CUSTOMER_OR_ISSUER_DECLINED",
      providerPaymentId: "pay_declined",
    });
    expect(declined.operation.failureCode).not.toContain("<");

    const duplicate = await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "ABANDONED",
    });
    expect(duplicate).toMatchObject({ ignored: true, operation: { operationStatus: "DECLINED" } });

    const verified = await BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: hmacSha256Hex("pay_auth|sub_basic", "secret"),
    });
    expect(verified.operation.operationStatus).toBe("APPLIED");

    const lateDismissal = await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "ABANDONED",
    });
    expect(lateDismissal).toMatchObject({ ignored: true, operation: { operationStatus: "APPLIED" } });
    const overview = await BillingService.listPlansForOrganization(user.id, org.id);
    expect(overview.experience.activeOperation).toBeNull();
    expect(overview.experience.latestOperation?.status).toBe("APPLIED");
    expect(overview.experience.customerState).not.toBe("PAYMENT_DECLINED");
  });

  it("never reopens a terminal Checkout decline during reconciliation", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "DECLINED",
      reason: "payment_declined",
      source: "bank",
      paymentId: "pay_declined",
    });
    vi.mocked(fakeRazorpay.fetchSubscription).mockClear();
    vi.mocked(fakeRazorpay.fetchPayment).mockClear();

    const result = await BillingService.reconcileMutation(user.id, org.id, checkout.changeId);

    expect(result).toMatchObject({ pending: false, operation: { operationStatus: "DECLINED" } });
    expect(fakeRazorpay.fetchSubscription).not.toHaveBeenCalled();
    expect(fakeRazorpay.fetchPayment).not.toHaveBeenCalled();
  });

  it("uses the stored payment id and resolves a provider-reported failed authorization", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "created",
      total_count: 120,
      quantity: 1,
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_failed",
      entity: "payment",
      amount: 500,
      currency: "INR",
      status: "failed",
      order_id: null,
      subscription_id: "sub_basic",
      method: "card",
      captured: false,
      error_code: "BAD_REQUEST_ERROR",
      error_description: "Payment failed",
      error_source: "bank",
      error_step: "payment_authorization",
      error_reason: "payment_failed",
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "AWAITING_PROVIDER_CONFIRMATION",
      reason: "result_unknown",
      paymentId: "pay_failed",
    });

    const result = await BillingService.reconcileMutation(user.id, org.id, checkout.changeId);

    expect(fakeRazorpay.fetchPayment).toHaveBeenCalledWith("pay_failed");
    expect(result.operation).toMatchObject({
      queueStatus: "FAILED",
      operationStatus: "FAILED",
      providerPaymentId: "pay_failed",
      failureCategory: "BANK_OR_ISSUER_ERROR",
    });
  });

  it("returns an unconfirmed provider response to awaiting instead of leaving VERIFYING", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "created",
      total_count: 120,
      quantity: 1,
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "AWAITING_PROVIDER_CONFIRMATION",
      reason: "result_unknown",
    });

    const result = await BillingService.reconcileMutation(user.id, org.id, checkout.changeId);

    expect(result.operation).toMatchObject({
      queueStatus: "AWAITING_PAYMENT",
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
    });
  });

  it("expires a stale unsupported-card authorization instead of polling it again", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "PRO" });
    await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "AWAITING_PROVIDER_CONFIRMATION",
      failureCode: "BAD_REQUEST_ERROR",
      source: "customer",
      step: "payment_initiation",
      reason: "card_mandate_card_not_supported",
    });
    await testPrisma.organizationBillingChange.update({
      where: { id: checkout.changeId },
      data: { confirmationDeadlineAt: new Date(Date.now() - 60_000) },
    });
    vi.mocked(fakeRazorpay.fetchSubscription).mockClear();

    const result = await BillingService.reconcileMutation(user.id, org.id, checkout.changeId);

    expect(fakeRazorpay.fetchSubscription).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      pending: false,
      operation: {
        queueStatus: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "CONFIRMATION_TIMEOUT",
        failureCode: "BAD_REQUEST_ERROR|customer|payment_initiation|card_mandate_card_not_supported",
      },
    });
    const overview = await BillingService.listPlansForOrganization(user.id, org.id);
    expect(overview.experience).toMatchObject({
      customerState: "PAYMENT_FAILED",
      paymentAction: "RETRY_AUTHORIZATION",
      activeOperation: null,
      latestOperation: {
        id: checkout.changeId,
        status: "FAILED",
        failureCategory: "CONFIRMATION_TIMEOUT",
      },
    });
  });

  it("uses a signed payment.failed webhook to resolve an open authorization", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "created",
      total_count: 120,
      quantity: 1,
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_webhook_failed",
      entity: "payment",
      amount: 500,
      currency: "INR",
      status: "failed",
      order_id: null,
      subscription_id: "sub_basic",
      method: "card",
      captured: false,
      error_code: "BAD_REQUEST_ERROR",
      error_source: "customer",
      error_step: "payment_authentication",
      error_reason: "payment_cancelled",
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: org.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const rawBody = JSON.stringify({
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_webhook_failed",
            entity: "payment",
            amount: 500,
            currency: "INR",
            status: "failed",
            order_id: null,
            subscription_id: "sub_basic",
            method: "card",
            captured: false,
            error_code: "BAD_REQUEST_ERROR",
            error_source: "customer",
            error_step: "payment_authentication",
            error_reason: "payment_cancelled",
          },
        },
      },
    });

    await BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_checkout_cancelled"
    );

    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: checkout.changeId },
    })).resolves.toMatchObject({
      status: "UNDONE",
      operationStatus: "ABANDONED",
      providerPaymentId: "pay_webhook_failed",
      failureCategory: "CHECKOUT_ABANDONED",
    });
  });

  it("keeps an ambiguous Checkout result pending instead of claiming a failure", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    const pending = await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "AWAITING_PROVIDER_CONFIRMATION",
      reason: "result_unknown",
      source: "network",
    });

    expect(pending.operation).toMatchObject({
      queueStatus: "AWAITING_PAYMENT",
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
      failureCategory: "PROVIDER_CONFIRMATION_PENDING",
    });
    const overview = await BillingService.listPlansForOrganization(user.id, org.id);
    expect(overview.experience).toMatchObject({
      authorizationStatus: "VERIFYING",
      paymentAction: "WAIT_FOR_CONFIRMATION",
      activeOperation: { id: checkout.changeId },
    });
  });

  it("surfaces a real Checkout dismissal while ignoring deliberate billing-change undos", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "ABANDONED",
    });

    const overview = await BillingService.listPlansForOrganization(user.id, org.id);
    expect(overview.experience).toMatchObject({
      customerState: "PAYMENT_NOT_COMPLETED",
      paymentAction: "RETRY_AUTHORIZATION",
      latestOperation: {
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "ABANDONED",
        failureCategory: "CHECKOUT_ABANDONED",
      },
    });
  });

  it("returns a reload-safe pending result when callback provider fetch is delayed", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockRejectedValueOnce(new Error("temporary provider outage"));
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    const result = await BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: hmacSha256Hex("pay_auth|sub_basic", "secret"),
    });

    expect(result).toMatchObject({
      verified: false,
      pending: true,
      operation: { operationStatus: "AWAITING_PROVIDER_CONFIRMATION" },
      processingUrl: `/org/${org.id}/billing/processing/${checkout.changeId}`,
    });
  });

  it("does not let a transient callback error regress webhook-confirmed success", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    let rejectSubscriptionFetch!: (reason?: unknown) => void;
    vi.mocked(fakeRazorpay.fetchSubscription).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectSubscriptionFetch = reject;
    }));
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    const verification = BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: hmacSha256Hex("pay_auth|sub_basic", "secret"),
    });
    await vi.waitFor(() => expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(1));
    const providerConfirmedAt = new Date("2026-08-06T12:00:00.000Z");
    await testPrisma.organizationBillingChange.update({
      where: { id: checkout.changeId },
      data: {
        status: "APPLIED",
        operationStatus: "APPLIED",
        providerConfirmedAt,
        appliedAt: providerConfirmedAt,
        resolvedAt: providerConfirmedAt,
      },
    });
    rejectSubscriptionFetch(new Error("temporary Razorpay outage"));

    const result = await verification;
    expect(result).toMatchObject({ verified: true, operation: { operationStatus: "APPLIED" } });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: checkout.changeId },
    })).resolves.toMatchObject({
      status: "APPLIED",
      operationStatus: "APPLIED",
      providerConfirmedAt,
      appliedAt: providerConfirmedAt,
      resolvedAt: providerConfirmedAt,
      failureCategory: null,
    });
  });

  it("lets only one concurrent callback claim provider verification", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    let resolveSubscriptionFetch!: (subscription: Awaited<ReturnType<RazorpayApiClient["fetchSubscription"]>>) => void;
    vi.mocked(fakeRazorpay.fetchSubscription).mockImplementationOnce(() => new Promise(resolve => {
      resolveSubscriptionFetch = resolve;
    }));
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const input = {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: hmacSha256Hex("pay_auth|sub_basic", "secret"),
    };

    const first = BillingService.verifySubscriptionSuccess(user.id, org.id, input);
    await vi.waitFor(() => expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(1));
    const second = await BillingService.verifySubscriptionSuccess(user.id, org.id, input);
    expect(second).toMatchObject({
      verified: false,
      pending: true,
      operation: { operationStatus: "VERIFYING" },
    });
    resolveSubscriptionFetch({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      customer_id: "cust_test",
      status: "active",
      total_count: 120,
      quantity: 1,
      paid_count: 1,
      remaining_count: 119,
      current_start: 1767225600,
      current_end: 1769904000,
      charge_at: 1769904000,
      ended_at: null,
    });

    await expect(first).resolves.toMatchObject({
      verified: true,
      operation: { operationStatus: "APPLIED" },
    });
    expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    expect(fakeRazorpay.fetchPayment).toHaveBeenCalledTimes(1);
  });

  it("does not reopen Checkout when provider success wins a retry race", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await BillingService.recordCheckoutEvent(user.id, org.id, checkout.changeId, {
      event: "FAILED",
      reason: "network_error",
      source: "network",
    });
    let resolveSubscriptionFetch!: (subscription: Awaited<ReturnType<RazorpayApiClient["fetchSubscription"]>>) => void;
    vi.mocked(fakeRazorpay.fetchSubscription).mockImplementationOnce(() => new Promise(resolve => {
      resolveSubscriptionFetch = resolve;
    }));

    const retry = BillingService.retryBillingOperation(user.id, org.id, checkout.changeId);
    await vi.waitFor(() => expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(1));
    const providerConfirmedAt = new Date("2026-08-06T13:00:00.000Z");
    await testPrisma.organizationBillingChange.update({
      where: { id: checkout.changeId },
      data: {
        status: "APPLIED",
        operationStatus: "APPLIED",
        providerConfirmedAt,
        appliedAt: providerConfirmedAt,
        resolvedAt: providerConfirmedAt,
      },
    });
    resolveSubscriptionFetch({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "created",
      total_count: 120,
      paid_count: 0,
      remaining_count: 120,
    });

    const result = await retry;
    expect(result).toMatchObject({
      reconciled: true,
      operation: { operationStatus: "APPLIED" },
    });
    expect(result).not.toHaveProperty("keyId");
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: checkout.changeId },
    })).resolves.toMatchObject({
      status: "APPLIED",
      operationStatus: "APPLIED",
      providerConfirmedAt,
    });
  });

  it("only exposes a provider-confirmed charge date after card authorization", async () => {
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    const chargeAt = new Date("2026-09-01T00:00:00.000Z");
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: org.id,
        currentOrganizationId: org.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_charge_date",
        status: "CREATED",
        providerPaymentMethod: "UNKNOWN",
        chargeAt,
      },
    });

    const before = await BillingService.listPlansForOrganization(user.id, org.id);
    expect(before.experience).toMatchObject({ authorizationStatus: "NOT_AUTHORIZED", nextChargeAt: null });

    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { status: "AUTHENTICATED", providerPaymentMethod: "CARD" },
    });
    const after = await BillingService.listPlansForOrganization(user.id, org.id);
    expect(after.experience).toMatchObject({
      authorizationStatus: "AUTHORIZED",
      nextChargeAt: chargeAt.toISOString(),
    });
  });

  it("lets an owner schedule cancellation at the end of an active cycle", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await BillingService.verifySubscriptionSuccess(user.id, org.id, {
      changeId: checkout.changeId,
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: hmacSha256Hex("pay_auth|sub_basic", "secret"),
    });

    const result = await BillingService.cancelSubscription(user.id, org.id);

    expect(result).toMatchObject({ cancelled: false, scheduled: true });
    expect(result.subscription).toMatchObject({
      status: "ACTIVE",
      cancelAtCycleEnd: true,
    });
    expect(fakeRazorpay.cancelSubscription).toHaveBeenCalledWith("sub_basic", {
      cancel_at_cycle_end: true,
    });
    const lastHistory = await testPrisma.organizationSubscriptionHistory.findFirst({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
    });
    expect(lastHistory).toMatchObject({
      source: "CUSTOMER_CANCELLATION",
      event: "cancel_at_cycle_end",
      fromStatus: "ACTIVE",
      toStatus: "ACTIVE",
    });
  });

  it("does not offer cycle-end cancellation before a subscription is active", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    await expect(BillingService.cancelSubscription(user.id, org.id)).rejects.toThrow(
      "Only an active subscription"
    );
    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
  });

  it("keeps billing recovery available while a V2 organization is read-only", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    await testPrisma.organization.update({
      where: { id: org.id },
      data: { contactEmail: "billing-recovery@example.test", contactPhone: "98765 43210" },
    });
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: org.id,
        currentOrganizationId: org.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_recovery",
        status: "HALTED",
        providerPaymentMethod: "CARD",
      },
    });

    await expect(BillingService.getRecoveryCheckout(user.id, org.id)).resolves.toMatchObject({
      subscriptionId: "sub_recovery",
      subscription_card_change: true,
      testMode: true,
      prefill: { email: "billing-recovery@example.test", contact: "+919876543210" },
      description: "Recover payment for Basic: 1 branch x Rs.299 = Rs.299/month",
      config: { display: { sequence: ["block.cards"] } },
    });
  });

  it("persists one reload-safe checkout operation for payment recovery", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        currentOrganizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_recovery",
        status: "HALTED",
        providerPaymentMethod: "CARD",
      },
    });

    const first = await BillingService.getRecoveryCheckout(owner.id, organization.id, `/org/${organization.id}/settings#billing`);
    const second = await BillingService.getRecoveryCheckout(owner.id, organization.id, "/ignored-on-reload");
    if (!("changeId" in first) || !("changeId" in second)) {
      throw new Error("Expected a Razorpay recovery checkout payload");
    }

    expect(first).toMatchObject({ subscription_card_change: true, changeId: second.changeId });
    await expect(testPrisma.organizationBillingChange.count({ where: { organizationId: organization.id } })).resolves.toBe(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: first.changeId } }))
      .resolves.toMatchObject({ status: "AWAITING_PAYMENT", operationStatus: "CHECKOUT_OPEN" });
  });

  it("reopens a failed recovery retry in Razorpay card-change mode", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        currentOrganizationId: organization.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_recovery",
        status: "HALTED",
        providerPaymentMethod: "CARD",
      },
    });
    const checkout = await BillingService.getRecoveryCheckout(owner.id, organization.id);
    if (!("changeId" in checkout)) {
      throw new Error("Expected a Razorpay recovery checkout payload");
    }
    await BillingService.recordCheckoutEvent(owner.id, organization.id, checkout.changeId, {
      event: "FAILED",
      reason: "network_error",
      source: "network",
    });

    const retried = await BillingService.retryBillingOperation(owner.id, organization.id, checkout.changeId);

    expect(retried).toMatchObject({
      changeId: checkout.changeId,
      subscriptionId: "sub_recovery",
      subscription_card_change: true,
      config: { display: { sequence: ["block.cards"] } },
    });
  });

  it("keeps an early V2 cancellation local and undoable until the cutoff", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    const now = new Date();
    const paidThrough = new Date(now.getTime() + 17 * 24 * 60 * 60 * 1000);
    await createSaasSubscription({
      organizationId: org.id,
      plan: "PRO",
      status: "ACTIVE",
      paidThrough,
    });

    const scheduled = await BillingService.scheduleWorkspaceCancellation(user.id, org.id, "cancel-early", now);
    expect(scheduled).toMatchObject({ scheduled: true, undoable: true });
    await expect(BillingService.undoWorkspaceCancellation(user.id, org.id, now))
      .resolves.toEqual({ undone: true });

    const overview = await BillingService.listPlansForOrganization(user.id, org.id);
    expect(overview.experience).toMatchObject({
      customerState: "STANDARD_ACTIVE",
      paymentAction: "NONE",
      latestOperation: {
        type: "CANCELLATION",
        status: "ABANDONED",
      },
    });
    expect(overview.experience.customerMessage).not.toContain("Payment was not completed");
  });

  it("processes Razorpay subscription webhooks idempotently from provider state", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: org.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const rawBody = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
      entity: "subscription" as const,
            plan_id: "plan_basic",
            customer_id: "cust_webhook",
            status: "active",
            total_count: 120,
            current_start: 1767225600,
            current_end: 1769904000,
            charge_at: 1769904000,
            ended_at: null,
          },
        },
        payment: {
          entity: {
            id: "pay_webhook",
            entity: "payment",
            amount: 29900,
            currency: "INR",
            status: "captured",
            order_id: null,
            subscription_id: "sub_basic",
          },
        },
      },
    });
    const signature = hmacSha256Hex(rawBody, "webhook_secret");

    const first = await BillingService.handleRazorpayWebhook(rawBody, signature, "evt_subscription_charged");
    vi.mocked(fakeRazorpay.fetchSubscription).mockRejectedValueOnce(new Error("provider unavailable"));
    const second = await BillingService.handleRazorpayWebhook(rawBody, signature, "evt_subscription_charged");

    expect(first).toMatchObject({
      ok: true,
      event: "subscription.charged",
      organizationId: org.id,
      razorpayPaymentId: "pay_webhook",
      razorpaySubscriptionId: "sub_basic",
    });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.razorpayWebhookEvent.count()).resolves.toBe(1);
    const stored = await testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: org.id },
    });
    expect(stored).toMatchObject({
      status: "ACTIVE",
      authPaymentId: "pay_webhook",
      razorpayCustomerId: "cust_test",
    });
  });

  it("reconciles invoice-only paid webhooks using the invoice subscription and payment ids", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: org.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const providerNow = Math.floor(Date.now() / 1000);
    const periodStart = providerNow - 60;
    const periodEnd = periodStart + 30 * 24 * 60 * 60;

    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "active",
      total_count: 120,
      quantity: 1,
      paid_count: 1,
      current_start: periodStart,
      current_end: periodEnd,
      charge_at: periodEnd,
      offer_id: null,
      payment_method: "card",
    });

    vi.mocked(fakeRazorpay.fetchSubscriptionInvoices).mockResolvedValue({
      entity: "collection",
      count: 1,
      items: [{
        id: "inv_paid_only",
        entity: "invoice",
        subscription_id: "sub_basic",
        payment_id: "pay_invoice_only",
        status: "paid",
        amount: 29900,
        amount_paid: 29900,
        amount_due: 0,
        currency: "INR",
        billing_start: periodStart,
        billing_end: periodEnd,
        issued_at: periodStart,
        paid_at: providerNow,
      }],
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_invoice_only",
      entity: "payment",
      amount: 29900,
      currency: "INR",
      status: "captured",
      order_id: null,
      invoice_id: "inv_paid_only",
      subscription_id: "sub_basic",
      method: "card",
      captured: true,
    });

    const rawBody = JSON.stringify({
      event: "invoice.paid",
      payload: {
        invoice: {
          entity: {
            id: "inv_paid_only",
            entity: "invoice",
            subscription_id: "sub_basic",
            payment_id: "pay_invoice_only",
            status: "paid",
            amount: 29900,
            amount_paid: 29900,
            amount_due: 0,
            currency: "INR",
            billing_start: periodStart,
            billing_end: periodEnd,
          },
        },
      },
    });

    const result = await BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_invoice_paid_only"
    );

    expect(result).toMatchObject({
      ok: true,
      event: "invoice.paid",
      organizationId: org.id,
      razorpaySubscriptionId: "sub_basic",
      razorpayPaymentId: "pay_invoice_only",
    });
    await expect(testPrisma.organizationSubscriptionInvoice.findUnique({
      where: { razorpayInvoiceId: "inv_paid_only" },
    })).resolves.toMatchObject({
      organizationId: org.id,
      razorpayPaymentId: "pay_invoice_only",
      status: "paid",
      paymentMethod: "CARD",
    });
  });

  it("quarantines a captured payment without exact capture evidence and preserves access", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: org.id });
    const checkout = await BillingService.createSubscriptionCheckout(
      user.id,
      org.id,
      { plan: "BASIC" }
    );
    const providerNow = Math.floor(Date.now() / 1000);
    const periodStart = providerNow - 60;
    const periodEnd = providerNow + 30 * 24 * 60 * 60;

    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "active",
      total_count: 120,
      quantity: 1,
      paid_count: 1,
      current_start: periodStart,
      current_end: periodEnd,
      offer_id: null,
      payment_method: "card",
    });
    vi.mocked(fakeRazorpay.fetchSubscriptionInvoices).mockResolvedValue({
      entity: "collection",
      count: 1,
      items: [{
        id: "inv_missing_capture",
        entity: "invoice",
        subscription_id: "sub_basic",
        payment_id: "pay_missing_capture",
        status: "paid",
        amount: 29900,
        amount_paid: 29900,
        amount_due: 0,
        currency: "INR",
        billing_start: periodStart,
        billing_end: periodEnd,
        issued_at: periodStart,
        paid_at: providerNow,
      }],
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_missing_capture",
      entity: "payment",
      amount: 29900,
      currency: "INR",
      status: "captured",
      order_id: null,
      invoice_id: "inv_missing_capture",
      subscription_id: "sub_basic",
      method: "card",
    });

    await expect(BillingReconciliationService.reconcileByOrganization(org.id))
      .rejects.toThrow("Razorpay returned malformed commercial evidence");

    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({
      plan: "BASIC",
      quantity: 1,
      paidThrough: null,
      confirmedCommercialIntentChangeId: null,
      lastConfirmedInvoiceId: null,
      lastConfirmedPaymentId: null,
    });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: checkout.changeId },
    })).resolves.toMatchObject({
      status: "FAILED",
      operationStatus: "FAILED",
      failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "MALFORMED_PROVIDER_EVIDENCE",
      resolvedAt: null,
    });
  });

  it.each([
    ["incomplete", "INCOMPLETE_PROVIDER_EVIDENCE", "count-mismatch", null],
    ["ambiguous", "AMBIGUOUS_PROVIDER_EVIDENCE", "duplicate", null],
    ["incomplete paid sibling", "INCOMPLETE_PROVIDER_EVIDENCE", "malformed-paid", null],
    ["explicit-payment ambiguous", "AMBIGUOUS_PROVIDER_EVIDENCE", "duplicate", "pay_current_primary"],
  ] as const)(
    "quarantines %s current-period invoice evidence without advancing entitlement",
    async (_label, failureCode, collectionKind, explicitPaymentId) => {
      const fakeRazorpay = createFakeRazorpayClient();
      setRazorpayClientForTests(fakeRazorpay);
      const user = await createUser();
      const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
      await createBranch({ organizationId: org.id });
      const checkout = await BillingService.createSubscriptionCheckout(
        user.id,
        org.id,
        { plan: "BASIC" }
      );
      const providerNow = Math.floor(Date.now() / 1000);
      const periodStart = providerNow - 60;
      const periodEnd = providerNow + 30 * 24 * 60 * 60;
      const firstInvoice = {
        id: "inv_current_primary",
        entity: "invoice" as const,
        subscription_id: "sub_basic",
        payment_id: "pay_current_primary",
        status: "paid",
        amount: 29900,
        amount_paid: 29900,
        amount_due: 0,
        currency: "INR",
        billing_start: periodStart,
        billing_end: periodEnd,
        issued_at: periodStart,
        paid_at: providerNow,
      };

      vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
        id: "sub_basic",
        entity: "subscription",
        plan_id: "plan_basic",
        status: "active",
        total_count: 120,
        quantity: 1,
        paid_count: 1,
        current_start: periodStart,
        current_end: periodEnd,
        offer_id: null,
        payment_method: "card",
      });
      vi.mocked(fakeRazorpay.fetchSubscriptionInvoices).mockResolvedValue({
        entity: "collection",
        count: 2,
        items: collectionKind === "duplicate"
          ? [
              firstInvoice,
              {
                ...firstInvoice,
                id: "inv_current_duplicate",
                payment_id: "pay_current_duplicate",
              },
            ]
          : collectionKind === "malformed-paid"
            ? [
                firstInvoice,
                {
                  ...firstInvoice,
                  id: "inv_current_incomplete",
                  payment_id: null,
                  billing_start: null,
                  billing_end: null,
                },
              ]
            : [firstInvoice],
      });

      await expect(BillingReconciliationService.reconcileByOrganization(
        org.id,
        explicitPaymentId ? { paymentId: explicitPaymentId } : {}
      ))
        .rejects.toThrow();
      if (explicitPaymentId) {
        expect(fakeRazorpay.fetchPayment).toHaveBeenCalledWith(explicitPaymentId);
      } else {
        expect(fakeRazorpay.fetchPayment).not.toHaveBeenCalled();
      }
      await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
        where: { currentOrganizationId: org.id },
      })).resolves.toMatchObject({
        paidThrough: null,
        confirmedCommercialIntentChangeId: null,
        lastConfirmedInvoiceId: null,
        lastConfirmedPaymentId: null,
      });
      await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
        where: { id: checkout.changeId },
      })).resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode,
        resolvedAt: null,
      });
    }
  );

  it("does not advance or regress paidThrough from an invoice for an older provider period", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    await createBranch({ organizationId: org.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const existingPaidThrough = new Date("2026-05-01T00:00:00.000Z");
    await testPrisma.organizationSubscription.update({
      where: { currentOrganizationId: org.id },
      data: { status: "PENDING", providerPaymentMethod: "CARD", paidThrough: existingPaidThrough },
    });
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "pending",
      total_count: 120,
      quantity: 1,
      current_start: 1772323200,
      current_end: 1775001600,
      payment_method: "card",
    });
    vi.mocked(fakeRazorpay.fetchSubscriptionInvoices).mockResolvedValue({
      entity: "collection",
      count: 1,
      items: [{
        id: "inv_old_period",
        entity: "invoice",
        subscription_id: "sub_basic",
        payment_id: "pay_old_period",
        status: "paid",
        amount: 29900,
        amount_paid: 29900,
        amount_due: 0,
        currency: "INR",
        billing_start: 1767225600,
        billing_end: 1769904000,
        issued_at: 1767225600,
        paid_at: 1767225601,
      }],
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_old_period",
      entity: "payment",
      amount: 29900,
      currency: "INR",
      status: "captured",
      order_id: null,
      invoice_id: "inv_old_period",
      subscription_id: "sub_basic",
      method: "card",
      captured: true,
    });

    const result = await BillingReconciliationService.reconcileByOrganization(org.id);

    expect(result.confirmedPaidPeriod).toBe(false);
    expect(result.subscription.paidThrough).toEqual(existingPaidThrough);
    await expect(testPrisma.organizationSubscriptionHistory.count({
      where: { organizationId: org.id, event: "provider_paid_period_confirmed" },
    })).resolves.toBe(0);
  });

  it("rejects a lost-callback authorization whose provider plan or quantity differs", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    await createBranch({ organizationId: org.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await testPrisma.saasRazorpayPlan.create({
      data: {
        providerMode: "TEST",
        catalogKey: "razorpay-plan:v1:TEST:PRO:INR:49900:monthly:1",
        plan: "PRO",
        amount: 499,
        amountSubunits: 49900,
        razorpayPlanId: "plan_standard",
        active: true,
      },
    });
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_standard",
      status: "authenticated",
      total_count: 120,
      quantity: 2,
      payment_method: "card",
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_mismatched_authorization",
      entity: "payment",
      amount: 500,
      currency: "INR",
      status: "authorized",
      order_id: null,
      subscription_id: "sub_basic",
      method: "card",
      captured: false,
    });
    const rawBody = JSON.stringify({
      event: "subscription.authenticated",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
            entity: "subscription",
            plan_id: "plan_standard",
            status: "authenticated",
            total_count: 120,
            quantity: 2,
          },
        },
        payment: {
          entity: {
            id: "pay_mismatched_authorization",
            entity: "payment",
            amount: 500,
            currency: "INR",
            status: "authorized",
            order_id: null,
            subscription_id: "sub_basic",
            method: "card",
          },
        },
      },
    });

    await expect(BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_mismatched_authorization"
    )).rejects.toThrow("The provider plan does not match the commercial authorization");
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({ plan: "BASIC", quantity: 1, paidThrough: null, authPaymentId: null });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: checkout.changeId },
    })).resolves.not.toMatchObject({ operationStatus: "APPLIED" });
    await expect(testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_mismatched_authorization" },
    })).resolves.toMatchObject({ processedAt: null });
  });

  it("completes lost-callback card authorization from a signed webhook without inventing paid access", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    await createBranch({ organizationId: org.id });
    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const rawBody = JSON.stringify({
      event: "subscription.authenticated",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
            entity: "subscription",
            plan_id: "plan_basic",
            status: "authenticated",
            total_count: 120,
            quantity: 1,
          },
        },
        payment: {
          entity: {
            id: "pay_webhook_auth",
            entity: "payment",
            amount: 500,
            currency: "INR",
            status: "authorized",
            order_id: null,
            subscription_id: "sub_basic",
            method: "card",
          },
        },
      },
    });

    await BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_lost_callback_authorized"
    );

    const [subscription, operation] = await Promise.all([
      testPrisma.organizationSubscription.findUniqueOrThrow({
        where: { currentOrganizationId: org.id },
      }),
      testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: checkout.changeId } }),
    ]);
    expect(subscription).toMatchObject({
      providerPaymentMethod: "CARD",
      paidThrough: null,
    });
    expect(operation).toMatchObject({
      status: "APPLIED",
      operationStatus: "APPLIED",
      providerPaymentId: "pay_webhook_auth",
    });
  });

  it("accepts lost-callback UPI authorization without inventing paid access", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "authenticated",
      total_count: 120,
      quantity: 1,
      payment_method: "upi",
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_webhook_upi",
      entity: "payment",
      amount: 500,
      currency: "INR",
      status: "authorized",
      order_id: null,
      subscription_id: "sub_basic",
      method: "upi",
      captured: false,
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    await createBranch({ organizationId: org.id });
    await testPrisma.saasRazorpayPlan.create({
      data: {
        providerMode: "TEST",
        catalogKey: "razorpay-plan:v1:TEST:BASIC:INR:29900:monthly:1",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        currency: "INR",
        period: "monthly",
        interval: 1,
        razorpayPlanId: "plan_basic",
        active: true,
      },
    });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: org.id,
        currentOrganizationId: org.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_basic",
        status: "CREATED",
        createdByUserId: user.id,
      },
    });
    await testPrisma.organization.update({
      where: { id: org.id },
      data: { billingMutationSequence: 1 },
    });
    const checkout = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: org.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: "lost-callback-upi-authorization",
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "AWAITING_PAYMENT",
        operationStatus: "CHECKOUT_OPEN",
        toPlan: "BASIC",
        toQuantity: 1,
        ...exactBasicAuthorizationIntent(),
      },
    });
    const rawBody = JSON.stringify({
      event: "subscription.authenticated",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
            entity: "subscription",
            plan_id: "plan_basic",
            status: "authenticated",
            total_count: 120,
            quantity: 1,
            payment_method: "upi",
          },
        },
        payment: {
          entity: {
            id: "pay_webhook_upi",
            entity: "payment",
            amount: 500,
            currency: "INR",
            status: "authorized",
            order_id: null,
            subscription_id: "sub_basic",
            method: "upi",
          },
        },
      },
    });

    await BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_lost_callback_upi"
    );

    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({
      providerPaymentMethod: "UPI",
      status: "AUTHENTICATED",
      paidThrough: null,
    });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: checkout.id },
    })).resolves.toMatchObject({
      status: "APPLIED",
      operationStatus: "APPLIED",
      providerPaymentId: "pay_webhook_upi",
    });
    await expect(testPrisma.organizationBillingChange.count({
      where: { organizationId: org.id, type: "UNSUPPORTED_METHOD_CANCELLATION" },
    })).resolves.toBe(0);
  });

  it("accepts lost-callback eMandate authorization without scheduling cancellation", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "authenticated",
      total_count: 120,
      quantity: 1,
      payment_method: "emandate",
    });
    vi.mocked(fakeRazorpay.fetchPayment).mockResolvedValue({
      id: "pay_webhook_emandate",
      entity: "payment",
      amount: 500,
      currency: "INR",
      status: "authorized",
      order_id: null,
      subscription_id: "sub_basic",
      method: "emandate",
      captured: false,
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "WORKSPACE_V2",
      selectedPostTrialPlan: "BASIC",
    });
    await createBranch({ organizationId: org.id });
    await testPrisma.saasRazorpayPlan.create({
      data: {
        providerMode: "TEST",
        catalogKey: "razorpay-plan:v1:TEST:BASIC:INR:29900:monthly:1",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        currency: "INR",
        period: "monthly",
        interval: 1,
        razorpayPlanId: "plan_basic",
        active: true,
      },
    });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: org.id,
        currentOrganizationId: org.id,
        providerMode: "TEST",
        plan: "BASIC",
        amount: 299,
        amountSubunits: 29900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_basic",
        razorpaySubscriptionId: "sub_basic",
        status: "CREATED",
        createdByUserId: user.id,
      },
    });
    await testPrisma.organization.update({
      where: { id: org.id },
      data: { billingMutationSequence: 1 },
    });
    const checkout = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: org.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: "lost-callback-emandate-authorization",
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "AWAITING_PAYMENT",
        operationStatus: "CHECKOUT_OPEN",
        toPlan: "BASIC",
        toQuantity: 1,
        ...exactBasicAuthorizationIntent(),
      },
    });
    const rawBody = JSON.stringify({
      event: "subscription.authenticated",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
            entity: "subscription",
            plan_id: "plan_basic",
            status: "authenticated",
            total_count: 120,
            quantity: 1,
            payment_method: "emandate",
          },
        },
        payment: {
          entity: {
            id: "pay_webhook_emandate",
            entity: "payment",
            amount: 500,
            currency: "INR",
            status: "authorized",
            order_id: null,
            subscription_id: "sub_basic",
            method: "emandate",
          },
        },
      },
    });

    await BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_lost_callback_emandate"
    );

    expect(fakeRazorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({
      providerPaymentMethod: "EMANDATE",
      status: "AUTHENTICATED",
      paidThrough: null,
    });

    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: checkout.id },
    })).resolves.toMatchObject({
      status: "APPLIED",
      operationStatus: "APPLIED",
      providerPaymentId: "pay_webhook_emandate",
    });
    await expect(testPrisma.organizationBillingChange.count({
      where: { organizationId: org.id, type: "UNSUPPORTED_METHOD_CANCELLATION" },
    })).resolves.toBe(0);
  });

  it("retries a previously failed webhook event", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const rawBody = JSON.stringify({
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
      entity: "subscription" as const,
            plan_id: "plan_basic",
            status: "active",
            total_count: 120,
          },
        },
      },
    });
    const payloadHash = sha256Hex(rawBody);
    await testPrisma.razorpayWebhookEvent.create({
      data: {
        eventId: "evt_retry",
        event: "subscription.activated",
        payloadHash,
        processingError: "Temporary database failure",
        processedAt: null,
      },
    });

    const result = await BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_retry"
    );

    expect(result).toMatchObject({ ok: true, event: "subscription.activated" });
    const event = await testPrisma.razorpayWebhookEvent.findUnique({
      where: { eventId: "evt_retry" },
    });
    expect(event?.processedAt).not.toBeNull();
    expect(event?.processingError).toBeNull();
  });

  it("verifies the signature before parsing malformed webhook JSON", async () => {
    const rawBody = Buffer.from("{", "utf8");

    await expect(BillingService.handleRazorpayWebhook(
      rawBody,
      "invalid-signature",
      "evt_invalid_before_parse"
    )).rejects.toThrow("Invalid Razorpay webhook signature");
    await expect(testPrisma.razorpayWebhookEvent.count()).resolves.toBe(0);

    await expect(BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_invalid_after_signature"
    )).rejects.toThrow("Invalid Razorpay webhook payload");
    await expect(testPrisma.razorpayWebhookEvent.count()).resolves.toBe(0);
  });

  it("rejects an event-id collision without overwriting the original receipt", async () => {
    const firstBody = JSON.stringify({ event: "payment.captured", payload: {} });
    const secondBody = JSON.stringify({ event: "payment.failed", payload: {} });

    await BillingService.handleRazorpayWebhook(
      firstBody,
      hmacSha256Hex(firstBody, "webhook_secret"),
      "evt_collision"
    );
    await expect(BillingService.handleRazorpayWebhook(
      secondBody,
      hmacSha256Hex(secondBody, "webhook_secret"),
      "evt_collision"
    )).rejects.toThrow("Razorpay webhook event id collision");

    await expect(testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_collision" },
    })).resolves.toMatchObject({
      event: "payment.captured",
      payloadHash: sha256Hex(firstBody),
      attemptCount: 1,
    });
  });

  it("accepts an in-flight duplicate without repeating provider reconciliation", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    const fetchSubscription = vi.mocked(fakeRazorpay.fetchSubscription);
    const originalFetch = fetchSubscription.getMockImplementation();
    if (!originalFetch) throw new Error("Missing fake Razorpay fetch implementation");
    const providerStarted = deferred();
    const releaseProvider = deferred();
    fetchSubscription.mockImplementationOnce(async subscriptionId => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return originalFetch(subscriptionId);
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const rawBody = subscriptionActivatedWebhookBody();
    const signature = hmacSha256Hex(rawBody, "webhook_secret");

    const owner = BillingService.handleRazorpayWebhook(
      rawBody,
      signature,
      "evt_concurrent_duplicate"
    );
    await providerStarted.promise;
    const duplicate = await BillingService.handleRazorpayWebhook(
      rawBody,
      signature,
      "evt_concurrent_duplicate"
    );

    expect(duplicate).toMatchObject({
      ok: true,
      event: "subscription.activated",
      duplicate: true,
      processing: true,
    });
    expect(fetchSubscription).toHaveBeenCalledTimes(1);

    releaseProvider.resolve();
    await expect(owner).resolves.toMatchObject({
      ok: true,
      event: "subscription.activated",
      organizationId: org.id,
    });
    await expect(testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_concurrent_duplicate" },
    })).resolves.toMatchObject({
      attemptCount: 1,
      processingToken: null,
      processingLeaseUntil: null,
      processingError: null,
    });
  });

  it("reclaims an expired webhook processing lease", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const rawBody = subscriptionActivatedWebhookBody();
    const startedAt = new Date(Date.now() - 5 * 60 * 1000);
    await testPrisma.razorpayWebhookEvent.create({
      data: {
        eventId: "evt_expired_claim",
        event: "subscription.activated",
        payloadHash: sha256Hex(rawBody),
        processingToken: "expired-token",
        processingStartedAt: startedAt,
        processingLeaseUntil: new Date(Date.now() - 1_000),
        attemptCount: 1,
      },
    });

    await expect(BillingService.handleRazorpayWebhook(
      rawBody,
      hmacSha256Hex(rawBody, "webhook_secret"),
      "evt_expired_claim"
    )).resolves.toMatchObject({ ok: true, organizationId: org.id });

    const receipt = await testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_expired_claim" },
    });
    expect(receipt.attemptCount).toBe(2);
    expect(receipt.processingStartedAt!.getTime()).toBeGreaterThan(startedAt.getTime());
    expect(receipt.processingToken).toBeNull();
    expect(receipt.processingLeaseUntil).toBeNull();
    expect(receipt.processedAt).not.toBeNull();
    expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(1);
  });

  it("prevents an expired stale processor from finalizing a successor claim", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    const fetchSubscription = vi.mocked(fakeRazorpay.fetchSubscription);
    const originalFetch = fetchSubscription.getMockImplementation();
    if (!originalFetch) throw new Error("Missing fake Razorpay fetch implementation");
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let providerAttempt = 0;
    fetchSubscription.mockImplementation(async subscriptionId => {
      providerAttempt += 1;
      if (providerAttempt === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else if (providerAttempt === 2) {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      return originalFetch(subscriptionId);
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    const rawBody = subscriptionActivatedWebhookBody();
    const signature = hmacSha256Hex(rawBody, "webhook_secret");

    const first = BillingService.handleRazorpayWebhook(
      rawBody,
      signature,
      "evt_stale_processor"
    );
    await firstStarted.promise;
    const firstReceipt = await testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_stale_processor" },
    });
    expect(firstReceipt.processingToken).not.toBeNull();
    await testPrisma.razorpayWebhookEvent.update({
      where: { id: firstReceipt.id },
      data: { processingLeaseUntil: new Date(Date.now() - 1_000) },
    });

    const second = BillingService.handleRazorpayWebhook(
      rawBody,
      signature,
      "evt_stale_processor"
    );
    await secondStarted.promise;
    const successor = await testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_stale_processor" },
    });
    expect(successor.attemptCount).toBe(2);
    expect(successor.processingToken).not.toBe(firstReceipt.processingToken);

    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      processing: true,
    });
    await expect(testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_stale_processor" },
    })).resolves.toMatchObject({
      attemptCount: 2,
      processingToken: successor.processingToken,
      processedAt: null,
    });

    releaseSecond.resolve();
    await expect(second).resolves.toMatchObject({ ok: true, organizationId: org.id });
    await expect(testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_stale_processor" },
    })).resolves.toMatchObject({
      attemptCount: 2,
      processingToken: null,
      processingLeaseUntil: null,
      processingError: null,
    });
    expect(fetchSubscription).toHaveBeenCalledTimes(2);
  });

  it("keeps a legacy webhook retryable until provider reconciliation succeeds", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({
      ownerId: user.id,
      billingModelVersion: "LEGACY",
      selectedPostTrialPlan: "BASIC",
    });
    await createBranch({ organizationId: org.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    vi.mocked(fakeRazorpay.fetchSubscription)
      .mockRejectedValueOnce(new Error("temporary provider outage"));

    const rawBody = JSON.stringify({
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: {
            id: "sub_basic",
            entity: "subscription",
            plan_id: "plan_basic",
            status: "active",
            total_count: 120,
            quantity: 1,
          },
        },
      },
    });
    const signature = hmacSha256Hex(rawBody, "webhook_secret");

    await expect(BillingService.handleRazorpayWebhook(
      rawBody,
      signature,
      "evt_provider_retry"
    )).rejects.toThrow("temporary provider outage");
    await expect(testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_provider_retry" },
    })).resolves.toMatchObject({
      processedAt: null,
      processingError: "Razorpay webhook reconciliation failed",
      processingToken: null,
      processingLeaseUntil: null,
      attemptCount: 1,
    });

    await expect(BillingService.handleRazorpayWebhook(
      rawBody,
      signature,
      "evt_provider_retry"
    )).resolves.toMatchObject({
      ok: true,
      organizationId: org.id,
      razorpaySubscriptionId: "sub_basic",
    });
    const event = await testPrisma.razorpayWebhookEvent.findUniqueOrThrow({
      where: { eventId: "evt_provider_retry" },
    });
    expect(event.processedAt).not.toBeNull();
    expect(event.processingError).toBeNull();
    expect(event.attemptCount).toBe(2);
    expect(event.processingToken).toBeNull();
    expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(2);
    await expect(testPrisma.organizationSubscriptionHistory.count({
      where: { organizationId: org.id, event: "subscription.activated" },
    })).resolves.toBe(0);
  });

  it("uses fetched provider status instead of a signed legacy webhook snapshot", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.fetchSubscription).mockResolvedValue({
      id: "sub_basic",
      entity: "subscription",
      plan_id: "plan_basic",
      status: "authenticated",
      total_count: 120,
      quantity: 1,
      paid_count: 0,
      remaining_count: 120,
      current_start: null,
      current_end: null,
      charge_at: null,
      ended_at: null,
      offer_id: null,
    });
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    async function sendStatus(status: string, eventId: string) {
      const body = JSON.stringify({
        event: `subscription.${status}`,
        payload: {
          subscription: {
            entity: {
              id: "sub_basic",
              entity: "subscription",
              plan_id: "plan_basic",
              status,
              total_count: 120,
            },
          },
          payment: {
            entity: {
              id: "pay_provider_authorization",
              entity: "payment",
              amount: 29900,
              currency: "INR",
              status: "captured",
              captured: true,
              order_id: null,
              subscription_id: "sub_basic",
              method: "card",
            },
          },
        },
      });
      return BillingService.handleRazorpayWebhook(
        body,
        hmacSha256Hex(body, "webhook_secret"),
        eventId
      );
    }

    await sendStatus("active", "evt_active");
    await sendStatus("cancelled", "evt_stale_cancelled");
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: org.id },
    })).resolves.toMatchObject({ status: "AUTHENTICATED", paidThrough: null });
    expect(fakeRazorpay.fetchSubscription).toHaveBeenCalledTimes(2);
    await expect(testPrisma.organizationSubscriptionHistory.count({
      where: { organizationId: org.id, event: { startsWith: "subscription." } },
    })).resolves.toBe(0);
  });
});
