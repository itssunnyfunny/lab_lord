import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingMutationService } from "@/services/billingMutation.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { BillingExperienceService } from "@/services/billingExperience.service";
import { BranchService } from "@/services/branch.service";
import { BillingReplacementService } from "@/services/billingReplacement.service";
import {
  getReplacementUndoCutoffAt,
  getSafeReplacementCycleBoundary,
} from "@/services/billingReplacementPolicy";
import {
  RazorpayApiError,
  setRazorpayClientForTests,
  type RazorpayPlanCatalogApiClient,
} from "@/lib/razorpay";
import { createBranch, createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

function fakeRazorpay(options: {
  paidAt?: number;
  providerStatus?: "active" | "authenticated";
  providerQuantity?: number;
  includePaidInvoice?: boolean;
  providerMethod?: "card" | "upi" | "emandate";
  adoptReplacement?: boolean;
  futureStartAt?: number;
  omitCurrentPeriod?: boolean;
} = {}): RazorpayPlanCatalogApiClient {
  const periodStart = Math.floor(Date.now() / 1000) - 60;
  const periodEnd = periodStart + 30 * 24 * 60 * 60;
  const providerStatus = options.providerStatus ?? "active";
  const providerQuantity = options.providerQuantity ?? 2;
  const paidAt = options.paidAt ?? Math.floor(Date.now() / 1000);
  const client: RazorpayPlanCatalogApiClient = {
    createOrder: vi.fn(async () => { throw new Error("unused"); }),
    fetchPayment: vi.fn(async paymentId => ({
      id: paymentId,
      entity: "payment" as const,
      amount: 49900,
      currency: "INR",
      status: "captured",
      order_id: null,
      invoice_id: "inv_paid",
      subscription_id: "sub_workspace",
      method: "card",
      captured: true,
    })),
    fetchOrderPayments: vi.fn(async () => ({ entity: "collection" as const, count: 0, items: [] })),
    capturePayment: vi.fn(async () => { throw new Error("unused"); }),
    createPlan: vi.fn(async input => ({
      id: input.notes.plan === "BASIC" ? "plan_basic" : "plan_standard",
      entity: "plan" as const,
      interval: input.interval,
      period: input.period,
      item: { ...input.item },
      notes: input.notes,
    })),
    fetchPlan: vi.fn(async planId => ({
      id: planId,
      entity: "plan" as const,
      interval: 1,
      period: "monthly",
      item: {
        amount: planId.includes("basic") ? 29900 : 49900,
        currency: "INR",
        name: planId.includes("basic") ? "Lab Lords Basic" : "Lab Lords Standard",
      },
    })),
    listPlans: vi.fn(async () => ({ entity: "collection" as const, count: 0, items: [] })),
    createSubscription: vi.fn(async input => ({
      id: "sub_candidate",
      entity: "subscription" as const,
      plan_id: input.plan_id,
      status: "created",
      total_count: input.total_count,
      quantity: input.quantity,
      start_at: input.start_at,
      expire_by: input.expire_by,
      notes: input.notes,
    })),
    fetchSubscription: vi.fn(async () => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: "plan_standard",
      status: providerStatus,
      total_count: 120,
      quantity: providerQuantity,
      start_at: options.futureStartAt,
      current_start: options.omitCurrentPeriod ? undefined : periodStart,
      current_end: options.omitCurrentPeriod ? undefined : periodEnd,
      charge_at: options.omitCurrentPeriod ? undefined : periodEnd,
      payment_method: options.providerMethod ?? "card",
    })),
    updateSubscription: vi.fn(async (_id, input) => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: input.plan_id ?? "plan_standard",
      status: providerStatus,
      total_count: 120,
      quantity: input.quantity ?? 1,
      current_start: periodStart,
      current_end: periodEnd,
      charge_at: periodEnd,
      payment_method: "card",
    })),
    cancelScheduledChanges: vi.fn(async () => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: "plan_standard",
      status: "active",
      total_count: 120,
      quantity: 1,
    })),
    fetchSubscriptionInvoices: vi.fn(async () => ({
      entity: "collection" as const,
      count: options.includePaidInvoice === false ? 0 : 1,
      items: options.includePaidInvoice === false ? [] : [{
        id: "inv_paid",
        entity: "invoice" as const,
        subscription_id: "sub_workspace",
        payment_id: "pay_paid",
        status: "paid",
        amount: 49900,
        amount_paid: 49900,
        amount_due: 0,
        currency: "INR",
        issued_at: periodStart,
        paid_at: paidAt,
      }],
    })),
    cancelSubscription: vi.fn(async (_id, input) => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: "plan_standard",
      status: input.cancel_at_cycle_end ? "active" : "cancelled",
      total_count: 120,
      quantity: 1,
      has_scheduled_changes: input.cancel_at_cycle_end,
    })),
  };
  client.listSubscriptions = vi.fn(async () => ({
    entity: "collection" as const,
    count: options.adoptReplacement ? 1 : 0,
    items: options.adoptReplacement ? [{
      id: "sub_candidate",
      entity: "subscription" as const,
      plan_id: "plan_standard",
      status: "created",
      total_count: 120,
      quantity: 2,
      start_at: periodEnd,
      expire_by: periodEnd - 72 * 60 * 60,
      created_at: periodStart,
      notes: {
        app: "lab_lords",
        billing_type: "saas_subscription_replacement",
        organization_id: "filled-by-test",
        provider_mode: "TEST",
        billing_change_id: "filled-by-test",
        replacement_source_subscription_id: "sub_workspace",
        plan: "PRO",
      },
    }] : [],
  }));
  return client;
}

describe("serialized workspace billing mutations", () => {
  beforeEach(async () => { await resetDatabase(); });
  afterEach(() => {
    setRazorpayClientForTests(null);
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await disconnectDatabase(); });

  async function setup(options: { paymentMethod?: "CARD" | "UPI" | "EMANDATE" } = {}) {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const first = await createBranch({ organizationId: organization.id });
    await testPrisma.saasRazorpayPlan.create({
      data: {
        providerMode: "TEST",
        catalogKey: "razorpay-plan:v1:TEST:PRO:INR:49900:monthly:1",
        plan: "PRO", amount: 499, amountSubunits: 49900, razorpayPlanId: "plan_standard", active: true,
      },
    });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "PRO",
        amount: 499,
        amountSubunits: 49900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_standard",
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_workspace",
        status: "ACTIVE",
        providerPaymentMethod: options.paymentMethod ?? "CARD",
      },
    });
    return { owner, organization, first, subscription };
  }

  it("provisions one checkout-backed candidate for a UPI quantity increase", async () => {
    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "true");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
    const razorpay = fakeRazorpay({ providerMethod: "upi" });
    setRazorpayClientForTests(razorpay);
    const { owner, organization, subscription } = await setup({ paymentMethod: "UPI" });
    const secondBranch = await testPrisma.branch.create({
      data: {
        organizationId: organization.id,
        name: "Second",
        billingStatus: "PENDING_ACTIVATION",
      },
    });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: secondBranch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "upi-add-second",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    const processed = await BillingMutationService.processNext(organization.id);
    const [source, candidate, storedChange] = await Promise.all([
      testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      testPrisma.organizationSubscription.findUniqueOrThrow({
        where: { pendingReplacementOrganizationId: organization.id },
      }),
      testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }),
    ]);

    expect(processed).toMatchObject({ status: "AWAITING_PAYMENT", operationStatus: "CHECKOUT_OPEN" });
    expect(source.currentOrganizationId).toBe(organization.id);
    expect(source.quantity).toBe(1);
    expect(candidate).toMatchObject({
      replacesSubscriptionId: source.id,
      quantity: 2,
      razorpaySubscriptionId: "sub_candidate",
    });
    expect(storedChange.replacementSubscriptionId).toBe(candidate.id);
    expect(storedChange.undoCutoffAt?.getTime()).toBe(
      storedChange.effectiveAt!.getTime() - 72 * 60 * 60 * 1000
    );
    expect(razorpay.updateSubscription).not.toHaveBeenCalled();
  });

  it("keeps a future-start eMandate trial branch pending until its replacement is authorized", async () => {
    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "true");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
    const { owner, organization, subscription } = await setup({ paymentMethod: "EMANDATE" });
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const futureStartAt = Math.floor(trialEndsAt.getTime() / 1000);
    await testPrisma.ownerTrialGrant.create({
      data: {
        ownerId: owner.id,
        organizationId: organization.id,
        source: "ONBOARDING",
        status: "ACTIVE",
        trialStartedAt: new Date(),
        trialEndsAt,
        consumedAt: new Date(),
      },
    });
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: {
        status: "AUTHENTICATED",
        providerStartAt: trialEndsAt,
        currentStart: null,
        currentEnd: null,
        paidThrough: null,
      },
    });
    const razorpay = fakeRazorpay({
      providerMethod: "emandate",
      providerStatus: "authenticated",
      providerQuantity: 1,
      includePaidInvoice: false,
      futureStartAt,
      omitCurrentPeriod: true,
    });
    setRazorpayClientForTests(razorpay);

    const result = await BranchService.createBranchForOrg({
      organizationId: organization.id,
      userId: owner.id,
      name: "Future trial branch",
      contactPhone: "9876543210",
      idempotencyKey: "future-trial-emandate-branch",
    });

    expect(result).toMatchObject({
      billingStatus: "PENDING_ACTIVATION",
      action: "CHECKOUT_REQUIRED",
    });
    expect(razorpay.createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      quantity: 2,
      start_at: futureStartAt,
    }));
    const change = await testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: result.billingChangeId! },
      include: { replacementSubscription: true },
    });
    expect(change).toMatchObject({
      type: "TRIAL_SUBSCRIPTION_UPDATE",
      status: "AWAITING_PAYMENT",
      effectiveAt: new Date(futureStartAt * 1000),
      replacementSubscription: {
        quantity: 2,
        providerStartAt: new Date(futureStartAt * 1000),
      },
    });

    await testPrisma.organizationSubscription.update({
      where: { id: change.replacementSubscriptionId! },
      data: { status: "AUTHENTICATED", providerPaymentMethod: "EMANDATE" },
    });
    await expect(BillingReplacementService.syncAuthorizedAccess(change.id))
      .resolves.toMatchObject({ action: "GRANT" });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: result.id } }))
      .resolves.toMatchObject({ billingStatus: "ACTIVE" });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ currentOrganizationId: organization.id, quantity: 1 });
  });

  it("returns 409 semantics for a second unrelated billable intent while a candidate is open", async () => {
    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "true");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
    setRazorpayClientForTests(fakeRazorpay({ providerMethod: "upi" }));
    const { owner, organization, subscription } = await setup({ paymentMethod: "UPI" });
    const firstChange = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "PLAN_DOWNGRADE",
      idempotencyKey: "first-replacement",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      createdByUserId: owner.id,
    });
    await BillingMutationService.processNext(organization.id);

    await expect(BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "second-replacement",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    })).rejects.toMatchObject({
      code: "BILLING_CHANGE_IN_PROGRESS",
      existingChangeId: firstChange.id,
    });
    await expect(BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "PLAN_DOWNGRADE",
      idempotencyKey: "first-replacement",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      createdByUserId: owner.id,
    })).resolves.toMatchObject({ id: firstChange.id });
  });

  it("adopts a response-lost provider candidate by exact durable notes", async () => {
    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "true");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
    const razorpay = fakeRazorpay({ providerMethod: "emandate" });
    setRazorpayClientForTests(razorpay);
    const { owner, organization, subscription } = await setup({ paymentMethod: "EMANDATE" });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "adopt-response-lost",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });
    const now = new Date();
    const providerSource = await razorpay.fetchSubscription(subscription.razorpaySubscriptionId);
    const effectiveAt = getSafeReplacementCycleBoundary({
      now,
      currentCycleEnd: new Date(providerSource.current_end! * 1000),
      intervalMonths: 1,
    });
    const undoCutoffAt = getReplacementUndoCutoffAt(effectiveAt);
    vi.mocked(razorpay.listSubscriptions!).mockResolvedValueOnce({
      entity: "collection",
      count: 1,
      items: [{
        id: "sub_adopted",
        entity: "subscription",
        plan_id: "plan_standard",
        status: "created",
        total_count: 120,
        quantity: 2,
        start_at: Math.floor(effectiveAt.getTime() / 1000),
        expire_by: Math.floor(undoCutoffAt.getTime() / 1000),
        created_at: Math.floor(Date.now() / 1000),
        notes: {
          app: "lab_lords",
          billing_type: "saas_subscription_replacement",
          organization_id: organization.id,
          provider_mode: "TEST",
          billing_change_id: change.id,
          replacement_source_subscription_id: subscription.razorpaySubscriptionId,
          plan: "PRO",
        },
      }],
    });

    await BillingMutationService.processNext(organization.id, now);

    expect(razorpay.createSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { razorpaySubscriptionId: "sub_adopted" },
    })).resolves.toMatchObject({ pendingReplacementOrganizationId: organization.id });
  });

  it("assigns distinct FIFO targets to concurrent branch additions", async () => {
    const { owner, organization, subscription } = await setup();
    const branch2 = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Second", billingStatus: "PENDING_ACTIVATION" },
    });
    const first = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch2.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "add-second",
      createdByUserId: owner.id,
    });
    const branch3 = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Third", billingStatus: "PENDING_ACTIVATION" },
    });
    const second = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch3.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "add-third",
      createdByUserId: owner.id,
    });

    expect([first.sequence, first.toQuantity]).toEqual([1, 2]);
    expect([second.sequence, second.toQuantity]).toEqual([2, 3]);
    await expect(BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch3.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "add-third",
    })).resolves.toMatchObject({ id: second.id });
    await expect(BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch3.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "add-third",
      toQuantity: 99,
    })).rejects.toThrow("Idempotency key was already used for another billing operation");
  });

  it("does not submit a later mutation while the earlier provider payment is unresolved", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const branch2 = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Second", billingStatus: "PENDING_ACTIVATION" },
    });
    const first = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch2.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "fifo-awaiting-second",
      createdByUserId: owner.id,
    });
    const branch3 = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Third", billingStatus: "PENDING_ACTIVATION" },
    });
    const second = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch3.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "fifo-awaiting-third",
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: first.id, status: "AWAITING_PAYMENT" });
    await expect(BillingMutationService.processNext(organization.id)).resolves.toBeNull();
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: second.id } }))
      .resolves.toMatchObject({ status: "QUEUED", attemptCount: 0 });

    await testPrisma.organizationBillingChange.update({
      where: { id: first.id },
      data: { status: "APPLIED", operationStatus: "APPLIED", resolvedAt: new Date() },
    });
    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: second.id, status: "AWAITING_PAYMENT" });
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(2);
  });

  it("keeps later intent queued until an earlier scheduled provider change is resolved", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const scheduled = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "PLAN_DOWNGRADE",
      idempotencyKey: "fifo-scheduled-downgrade",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      effectiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByUserId: owner.id,
    });
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Later branch", billingStatus: "PENDING_ACTIVATION" },
    });
    const later = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "fifo-after-scheduled",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: scheduled.id, status: "SCHEDULED" });
    await expect(BillingMutationService.processNext(organization.id)).resolves.toBeNull();
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: later.id } }))
      .resolves.toMatchObject({ status: "QUEUED", attemptCount: 0 });

    await testPrisma.organizationBillingChange.update({
      where: { id: scheduled.id },
      data: { status: "UNDONE", operationStatus: "ABANDONED", resolvedAt: new Date() },
    });
    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: later.id, status: "AWAITING_PAYMENT" });
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(2);
  });

  it("does not submit a locally scheduled cancellation before its undo cutoff", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const now = new Date();
    const cutoff = new Date(now.getTime() + 60 * 60 * 1000);
    const cancellation = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "CANCELLATION",
      idempotencyKey: "future-cancellation-cutoff",
      operationStatus: "SCHEDULED",
      effectiveAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      undoCutoffAt: cutoff,
      createdByUserId: owner.id,
    });
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "After cancellation", billingStatus: "PENDING_ACTIVATION" },
    });
    const later = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "after-future-cancellation",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id, now)).resolves.toBeNull();
    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    expect(razorpay.updateSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: later.id } }))
      .resolves.toMatchObject({ status: "QUEUED", attemptCount: 0 });

    await expect(BillingMutationService.processNext(
      organization.id,
      new Date(cutoff.getTime() + 1)
    )).resolves.toMatchObject({ id: cancellation.id, status: "SCHEDULED" });
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(BillingMutationService.processNext(organization.id)).resolves.toBeNull();
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: later.id } }))
      .resolves.toMatchObject({ status: "QUEUED", attemptCount: 0 });
  });

  it("does not claim or count an attempt while provider writes are held", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "false");
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "held-quantity-change",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id)).resolves.toBeNull();
    expect(razorpay.updateSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "QUEUED", attemptCount: 0 });
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ billingMutationLeaseToken: null, billingMutationLeaseUntil: null });
  });

  it.each([
    ["network timeout", new RazorpayApiError("provider response was lost", { kind: "NETWORK" })],
    ["provider 5xx", new RazorpayApiError("provider failed after accepting the request", {
      kind: "PROVIDER",
      status: 503,
    })],
    ["HTTP 408 timeout", new RazorpayApiError("provider request timed out", {
      kind: "REQUEST",
      status: 408,
    })],
  ])("quarantines an ambiguous %s without resubmitting it", async (_label, providerError) => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    vi.mocked(razorpay.updateSubscription).mockRejectedValueOnce(providerError);
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: `ambiguous-${providerError.kind}`,
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id)).rejects.toBe(providerError);
    await expect(BillingMutationService.processNext(organization.id)).resolves.toBeNull();

    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        attemptCount: 1,
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_MUTATION_OUTCOME_UNKNOWN",
        resolvedAt: null,
      });
  });

  it("quarantines a malformed success response after exactly one provider mutation", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    vi.mocked(razorpay.updateSubscription).mockResolvedValueOnce(null as never);
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "malformed-provider-success",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id))
      .rejects.toThrow("malformed subscription mutation response");

    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_MUTATION_OUTCOME_UNKNOWN",
      });
  });

  it("quarantines a well-formed success response that does not match the requested target", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    vi.mocked(razorpay.updateSubscription).mockResolvedValueOnce({
      id: "sub_workspace",
      entity: "subscription",
      plan_id: "plan_standard",
      status: "active",
      total_count: 120,
      quantity: 9,
    });
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "mismatched-provider-success",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id))
      .rejects.toThrow("does not match the requested billing mutation");

    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_MUTATION_OUTCOME_UNKNOWN",
      });
  });

  it("keeps a definitely rejected provider mutation safely retryable", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay({ providerQuantity: 1 });
    const rejected = new RazorpayApiError("invalid quantity", { kind: "REQUEST", status: 400 });
    vi.mocked(razorpay.updateSubscription).mockRejectedValueOnce(rejected);
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "definitely-rejected-provider-mutation",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BillingMutationService.processNext(organization.id)).rejects.toBe(rejected);

    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "PROVIDER_REJECTED",
        failureCode: null,
      });

    await expect(BillingMutationService.retry(change.id))
      .resolves.toMatchObject({ id: change.id, status: "AWAITING_PAYMENT" });
    expect(razorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(2);
    expect(vi.mocked(razorpay.fetchSubscription).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(razorpay.updateSubscription).mock.invocationCallOrder[1]!);
  });

  it("reconciles but never resubmits an ambiguous provider mutation", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay({ providerQuantity: 2 });
    const timeout = new RazorpayApiError("response lost", { kind: "NETWORK" });
    vi.mocked(razorpay.updateSubscription).mockRejectedValueOnce(timeout);
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "ambiguous-retry-reconciles-first",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });
    await expect(BillingMutationService.processNext(organization.id)).rejects.toBe(timeout);

    await expect(BillingMutationService.retry(change.id))
      .rejects.toThrow("requires manual review");

    expect(razorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_STATE_DIFFERS_FROM_MUTATION_SOURCE",
      });
  });

  it("atomically discards a pending card branch before its quantity mutation is claimed", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay({ providerQuantity: 1, includePaidInvoice: false });
    setRazorpayClientForTests(razorpay);
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Discard before claim", billingStatus: "PENDING_ACTIVATION" },
    });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "discard-card-before-claim",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    await expect(BranchService.discardPendingActivation(owner.id, branch.id))
      .resolves.toEqual({ archived: true });
    await expect(BillingMutationService.processNext(organization.id)).resolves.toBeNull();

    expect(razorpay.updateSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "ARCHIVED" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "SUPERSEDED", operationStatus: "ABANDONED" });
  });

  it("rejects pending-branch discard while a card quantity provider mutation is in flight", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay({ providerQuantity: 1, includePaidInvoice: false });
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve; });
    vi.mocked(razorpay.updateSubscription).mockImplementationOnce(async (_id, input) => {
      providerStarted();
      await providerRelease;
      return {
        id: "sub_workspace",
        entity: "subscription",
        plan_id: input.plan_id ?? "plan_standard",
        status: "active",
        total_count: 120,
        quantity: input.quantity ?? 1,
        payment_method: "card",
      };
    });
    setRazorpayClientForTests(razorpay);
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Discard during provider call", billingStatus: "PENDING_ACTIVATION" },
    });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "discard-card-during-provider-call",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    const processing = BillingMutationService.processNext(organization.id);
    await started;
    const discardError = await BranchService.discardPendingActivation(owner.id, branch.id)
      .then(() => null, error => error as Error);
    releaseProvider();
    await expect(processing).resolves.toMatchObject({ id: change.id, status: "AWAITING_PAYMENT" });

    expect(discardError).toBeInstanceOf(Error);
    expect(discardError?.message).toContain("Another billing operation is still processing");
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "PENDING_ACTIVATION", billingArchivedAt: null });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "AWAITING_PAYMENT", operationStatus: "AWAITING_PROVIDER_CONFIRMATION" });
  });

  it("does not let an expired worker fail or release a successor lease", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve; });
    vi.mocked(razorpay.updateSubscription).mockImplementationOnce(async (_id, input) => {
      providerStarted();
      await providerRelease;
      return {
        id: "sub_workspace",
        entity: "subscription",
        plan_id: input.plan_id ?? "plan_standard",
        status: "active",
        total_count: 120,
        quantity: input.quantity ?? 1,
      };
    });
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "lost-worker-lease",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    const processing = BillingMutationService.processNext(organization.id);
    await started;
    await testPrisma.organization.update({
      where: { id: organization.id },
      data: {
        billingMutationLeaseToken: "successor-lease",
        billingMutationLeaseUntil: new Date(Date.now() + 60_000),
      },
    });
    releaseProvider();

    await expect(processing).rejects.toThrow("Billing mutation lease was lost");
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ billingMutationLeaseToken: "successor-lease" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "PROCESSING", attemptCount: 1, failedAt: null });
  });

  it("does not let a stale success overwrite a manual-review owner-visible state", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve; });
    vi.mocked(razorpay.updateSubscription).mockImplementationOnce(async (subscriptionId, input) => {
      providerStarted();
      await providerRelease;
      return {
        id: subscriptionId,
        entity: "subscription",
        plan_id: input.plan_id ?? "plan_standard",
        status: "active",
        total_count: 120,
        quantity: input.quantity ?? 1,
      };
    });
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "manual-review-wins-over-stale-success",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    const processing = BillingMutationService.processNext(organization.id);
    await started;
    await testPrisma.organizationBillingChange.update({
      where: { id: change.id },
      data: {
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "OWNER_VISIBLE_REVIEW",
        lastError: "Awaiting billing review",
      },
    });
    releaseProvider();

    await expect(processing).rejects.toThrow("superseded before finalization");
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "OWNER_VISIBLE_REVIEW",
        lastError: "Awaiting billing review",
      });
  });

  it("quarantines an old provider response after the current subscription is swapped", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve; });
    vi.mocked(razorpay.updateSubscription).mockImplementationOnce(async (subscriptionId, input) => {
      providerStarted();
      await providerRelease;
      return {
        id: subscriptionId,
        entity: "subscription",
        plan_id: input.plan_id ?? "plan_standard",
        status: "active",
        total_count: 120,
        quantity: input.quantity ?? 1,
        payment_method: "card",
      };
    });
    setRazorpayClientForTests(razorpay);
    const replacement = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        providerMode: "TEST",
        plan: "PRO",
        amount: 499,
        amountSubunits: 49900,
        totalCount: 120,
        quantity: 7,
        razorpayPlanId: "plan_standard",
        pendingReplacementOrganizationId: organization.id,
        replacesSubscriptionId: subscription.id,
        razorpaySubscriptionId: "sub_promoted_during_mutation",
        status: "AUTHENTICATED",
        providerPaymentMethod: "CARD",
      },
    });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "current-slot-swapped-during-provider-call",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    const processing = BillingMutationService.processNext(organization.id);
    await started;
    await testPrisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${organization.id} FOR UPDATE
      `;
      await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: { currentOrganizationId: null },
      });
      await tx.organizationSubscription.update({
        where: { id: replacement.id },
        data: {
          pendingReplacementOrganizationId: null,
          currentOrganizationId: organization.id,
        },
      });
    });
    releaseProvider();

    await expect(processing).rejects.toThrow("Billing mutation source subscription is no longer current");
    expect(razorpay.updateSubscription).toHaveBeenCalledWith("sub_workspace", expect.objectContaining({
      quantity: 2,
    }));
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: replacement.id } }))
      .resolves.toMatchObject({
        currentOrganizationId: organization.id,
        razorpaySubscriptionId: "sub_promoted_during_mutation",
        status: "AUTHENTICATED",
        quantity: 7,
      });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_MUTATION_OUTCOME_UNKNOWN",
      });
  });

  it("serializes scheduled-change undo and replays the next queued intent", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const scheduled = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "PLAN_DOWNGRADE",
      idempotencyKey: "undo-serialized-downgrade",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      effectiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByUserId: owner.id,
    });
    await BillingMutationService.processNext(organization.id);
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Queued after undo", billingStatus: "PENDING_ACTIVATION" },
    });
    const later = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "replay-after-undo",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    let undoProviderStarted!: () => void;
    let releaseUndoProvider!: () => void;
    const undoStarted = new Promise<void>(resolve => { undoProviderStarted = resolve; });
    const undoRelease = new Promise<void>(resolve => { releaseUndoProvider = resolve; });
    vi.mocked(razorpay.cancelScheduledChanges).mockImplementationOnce(async () => {
      undoProviderStarted();
      await undoRelease;
      return {
        id: "sub_workspace",
        entity: "subscription",
        plan_id: "plan_standard",
        status: "active",
        total_count: 120,
        quantity: 1,
      };
    });

    const undoing = BillingMutationService.undoScheduledProviderChange(scheduled.id);
    await undoStarted;
    // The provider call is outside a DB transaction, but the organization
    // lease prevents a concurrent provider mutation from overtaking it.
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ id: organization.id });
    await expect(BillingMutationService.processNext(organization.id)).resolves.toBeNull();
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    releaseUndoProvider();

    await expect(undoing).resolves.toMatchObject({
      change: { id: scheduled.id, status: "UNDONE", operationStatus: "ABANDONED" },
      replayed: { id: later.id, status: "AWAITING_PAYMENT" },
    });
    expect(razorpay.cancelScheduledChanges).toHaveBeenCalledTimes(1);
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(2);
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ billingMutationLeaseToken: null, billingMutationLeaseUntil: null });
  });

  it("prioritizes unsupported-method cancellation over unresolved non-processing intent", async () => {
    const { organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: "unresolved-before-safety",
        type: "QUANTITY_INCREASE",
        status: "AWAITING_PAYMENT",
        fromQuantity: 1,
        toQuantity: 2,
      },
    });
    const safety = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 2,
        idempotencyKey: "unsupported-method-safety",
        type: "UNSUPPORTED_METHOD_CANCELLATION",
        status: "QUEUED",
        fromPlan: "PRO",
        toPlan: "PRO",
        fromQuantity: 1,
        toQuantity: 1,
      },
    });

    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: safety.id, status: "APPLIED" });
    expect(razorpay.cancelSubscription).toHaveBeenCalledWith("sub_workspace", {
      cancel_at_cycle_end: false,
    });
    expect(razorpay.updateSubscription).not.toHaveBeenCalled();
  });

  it("fails closed before provider mutation or reconciliation for a wrong-mode subscription", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      idempotencyKey: "wrong-mode-quantity",
      type: "QUANTITY_INCREASE",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });
    vi.stubEnv("RAZORPAY_MODE", "LIVE");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_live_wrong_mode");

    await expect(BillingMutationService.processNext(organization.id))
      .rejects.toThrow("cannot be mutated in LIVE mode");
    expect(razorpay.updateSubscription).not.toHaveBeenCalled();
    await expect(BillingReconciliationService.reconcileByOrganization(organization.id))
      .rejects.toThrow("cannot be reconciled in LIVE mode");
    expect(razorpay.fetchSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "FAILED", operationStatus: "FAILED" });
  });

  it("keeps the confirmed paid quantity unchanged while a prorated branch charge is unresolved", async () => {
    const { owner, organization, subscription } = await setup();
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    });
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Pending paid branch", billingStatus: "PENDING_ACTIVATION" },
    });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "pending-paid-quantity",
      createdByUserId: owner.id,
    });
    setRazorpayClientForTests(fakeRazorpay());

    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: change.id, status: "AWAITING_PAYMENT" });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ quantity: 1 });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "PENDING_ACTIVATION" });
    await expect(BillingExperienceService.getBillingExperience(organization.id, owner.id))
      .resolves.toMatchObject({ confirmedQuantity: 1, projectedQuantity: 2 });
  });

  it("synchronizes future authenticated trial quantity without granting a paid period", async () => {
    const { owner, organization, subscription } = await setup();
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { status: "AUTHENTICATED", paidThrough: null },
    });
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Trial branch", billingStatus: "ACTIVE" },
    });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      type: "TRIAL_SUBSCRIPTION_UPDATE",
      idempotencyKey: "future-trial-quantity",
      createdByUserId: owner.id,
    });
    setRazorpayClientForTests(fakeRazorpay({
      providerStatus: "authenticated",
      providerQuantity: 2,
      includePaidInvoice: false,
    }));

    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: change.id, status: "APPLIED" });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ quantity: 2, paidThrough: null, status: "AUTHENTICATED" });
  });

  it("keeps the current paid quantity while a branch reduction is scheduled for cycle end", async () => {
    const { owner, organization, subscription } = await setup();
    const secondBranch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Scheduled removal", billingStatus: "REMOVAL_SCHEDULED" },
    });
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: {
        quantity: 2,
        paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: secondBranch.id,
      type: "BRANCH_REMOVAL",
      fromQuantity: 2,
      toQuantity: 1,
      effectiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      idempotencyKey: "scheduled-paid-reduction",
      createdByUserId: owner.id,
    });
    setRazorpayClientForTests(fakeRazorpay());

    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: change.id, status: "SCHEDULED" });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ quantity: 2 });
  });

  it("does not confirm a paid quantity increase from an older paid invoice", async () => {
    const { organization, subscription } = await setup();
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { paidThrough: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    });
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Unconfirmed branch", billingStatus: "PENDING_ACTIVATION" },
    });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        branchId: branch.id,
        sequence: 1,
        idempotencyKey: "stale-invoice-quantity",
        type: "QUANTITY_INCREASE",
        status: "AWAITING_PAYMENT",
        fromQuantity: 1,
        toQuantity: 2,
        processingStartedAt: new Date(),
      },
    });
    setRazorpayClientForTests(fakeRazorpay({
      paidAt: Math.floor(Date.now() / 1000) - 60 * 60,
    }));

    const result = await BillingReconciliationService.reconcileByOrganization(organization.id, {
      paymentId: "pay_paid",
    });

    expect(result.confirmedPaidPeriod).toBe(true);
    expect(result.subscription.quantity).toBe(1);
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "PENDING_ACTIVATION" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "AWAITING_PAYMENT" });
  });

  it("does not activate a pending branch until payment reconciliation", async () => {
    const { organization, subscription } = await setup();
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Paid Branch", billingStatus: "PENDING_ACTIVATION" },
    });
    const change = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        branchId: branch.id,
        sequence: 1,
        idempotencyKey: "paid-branch",
        type: "QUANTITY_INCREASE",
        status: "AWAITING_PAYMENT",
        fromQuantity: 1,
        toQuantity: 2,
      },
    });
    setRazorpayClientForTests(fakeRazorpay());

    const before = await testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } });
    expect(before.billingStatus).toBe("PENDING_ACTIVATION");
    const result = await BillingReconciliationService.reconcileByOrganization(organization.id, {
      paymentId: "pay_paid",
    });

    expect(result.confirmedPaidPeriod).toBe(true);
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "ACTIVE" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "APPLIED", providerPaymentId: "pay_paid" });
    expect(result.subscription.paidThrough).not.toBeNull();
  });

  it("keeps Standard until a scheduled Basic downgrade is confirmed at the provider", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const now = new Date();
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      idempotencyKey: "downgrade-basic",
      type: "PLAN_DOWNGRADE",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      effectiveAt: now,
      createdByUserId: owner.id,
    });

    await BillingMutationService.processNext(organization.id, now);
    expect(razorpay.createPlan).toHaveBeenCalledTimes(1);
    await expect(testPrisma.saasRazorpayPlan.findFirst({
      where: { providerMode: "TEST", plan: "BASIC", active: true },
    })).resolves.toMatchObject({ razorpayPlanId: "plan_basic", amountSubunits: 29900 });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ plan: "PRO" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "SCHEDULED" });

    vi.mocked(razorpay.fetchSubscription).mockImplementationOnce(async () => {
      const periodStart = Math.floor(now.getTime() / 1000) - 60;
      return {
        id: "sub_workspace",
        entity: "subscription" as const,
        plan_id: "plan_basic",
        status: "active",
        total_count: 120,
        quantity: 1,
        current_start: periodStart,
        current_end: periodStart + 30 * 24 * 60 * 60,
        payment_method: "card",
      };
    });
    await BillingReconciliationService.reconcileByOrganization(organization.id, { paymentId: "pay_paid", now });

    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ plan: "BASIC", amount: 299, razorpayPlanId: "plan_basic" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "APPLIED" });
  });

  it("redeems one offer and records one paid period across duplicate reconciliation", async () => {
    const { organization, subscription } = await setup();
    const offer = await testPrisma.billingOffer.create({
      data: {
        providerMode: "TEST",
        name: "Launch offer",
        plan: "PRO",
        razorpayOfferId: "offer_launch",
        discountType: "PERCENTAGE",
        discountValue: 20,
        durationType: "LIMITED_CYCLES",
        durationCycles: 3,
      },
    });
    await testPrisma.organizationOfferGrant.create({
      data: {
        organizationId: organization.id,
        billingOfferId: offer.id,
        status: "RESERVED",
        subscriptionId: subscription.razorpaySubscriptionId,
      },
    });
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { billingOfferId: offer.id },
    });
    setRazorpayClientForTests(fakeRazorpay());

    await BillingReconciliationService.reconcileByOrganization(organization.id, { paymentId: "pay_paid" });
    await BillingReconciliationService.reconcileByOrganization(organization.id, { paymentId: "pay_paid" });

    await expect(testPrisma.organizationOfferGrant.findUniqueOrThrow({
      where: { organizationId_billingOfferId: { organizationId: organization.id, billingOfferId: offer.id } },
    })).resolves.toMatchObject({ status: "REDEEMED" });
    await expect(testPrisma.organizationSubscriptionInvoice.count({ where: { organizationId: organization.id } }))
      .resolves.toBe(1);
    await expect(testPrisma.organizationSubscriptionHistory.count({
      where: { organizationId: organization.id, event: "provider_paid_period_confirmed" },
    })).resolves.toBe(1);
  });
});
