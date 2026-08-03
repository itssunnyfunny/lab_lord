import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingService } from "@/services/billing.service";
import { hmacSha256Hex, setRazorpayClientForTests, sha256Hex, type RazorpayApiClient } from "@/lib/razorpay";
import { createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

function createFakeRazorpayClient() {
  const client: RazorpayApiClient = {
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
    createSubscription: vi.fn(async input => ({
      id: `sub_${input.notes.plan.toLowerCase()}`,
      entity: "subscription" as const,
      plan_id: input.plan_id,
      customer_id: "cust_test",
      status: "created",
      total_count: input.total_count,
      paid_count: 0,
      remaining_count: input.total_count,
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
      paid_count: 1,
      remaining_count: 119,
      current_start: 1767225600,
      current_end: 1769904000,
      charge_at: 1769904000,
      ended_at: null,
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

    const checkout = await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    expect(checkout.keyId).toBe("rzp_test_key");
    expect(checkout.subscriptionId).toBe("sub_basic");
    expect(checkout.amount).toBe(29900);
    expect(fakeRazorpay.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ amount: 29900, currency: "INR" }),
      notes: expect.objectContaining({ plan: "BASIC", billing_type: "saas_plan" }),
    }));
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: "plan_basic",
      customer_notify: true,
      notes: expect.objectContaining({ organization_id: org.id, billing_type: "saas_subscription" }),
    }));

    const stored = await testPrisma.organizationSubscription.findUnique({ where: { organizationId: org.id } });
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
    await expect(testPrisma.organizationSubscription.findUnique({ where: { organizationId: legacyOrg.id } })).resolves.toMatchObject({
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
    expect(fakeRazorpay.createSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationSubscription.count({
      where: { organizationId: org.id },
    })).resolves.toBe(1);
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
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { organizationId: org.id },
    })).resolves.toMatchObject({
      plan: "PRO",
      razorpaySubscriptionId: "sub_pro",
      status: "CREATED",
    });
    const history = await testPrisma.organizationSubscriptionHistory.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map(entry => entry.event)).toEqual([null, "checkout_replaced", null]);
  });

  it("cancels a gateway subscription when local persistence fails", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => ({
      id: "sub_orphan",
      entity: "subscription" as const,
      plan_id: input.plan_id,
      customer_id: { invalid: true } as never,
      status: "created",
      total_count: input.total_count,
    }));
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });

    await expect(
      BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" })
    ).rejects.toThrow();

    expect(fakeRazorpay.cancelSubscription).toHaveBeenCalledWith("sub_orphan", {
      cancel_at_cycle_end: false,
    });
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { organizationId: org.id },
    })).resolves.toBeNull();
  });

  it("verifies checkout signatures server-side before activating a subscription", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });

    const result = await BillingService.verifySubscriptionSuccess(user.id, org.id, {
      razorpay_subscription_id: "sub_basic",
      razorpay_payment_id: "pay_auth",
      razorpay_signature: hmacSha256Hex("pay_auth|sub_basic", "secret"),
    });

    expect(result.verified).toBe(true);
    expect(result.subscription?.status).toBe("ACTIVE");
    const stored = await testPrisma.organizationSubscription.findUnique({ where: { organizationId: org.id } });
    expect(stored?.authPaymentId).toBe("pay_auth");
    expect(stored?.currentEnd?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    const history = await testPrisma.organizationSubscriptionHistory.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map(entry => entry.source)).toEqual(["CHECKOUT", "VERIFICATION"]);
  });

  it("lets an owner schedule cancellation at the end of an active cycle", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
    await BillingService.createSubscriptionCheckout(user.id, org.id, { plan: "BASIC" });
    await BillingService.verifySubscriptionSuccess(user.id, org.id, {
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
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: org.id,
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
      method: { card: true, upi: false },
    });
  });

  it("keeps an early V2 cancellation local and undoable until the cutoff", async () => {
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id, billingModelVersion: "WORKSPACE_V2" });
    const now = new Date("2026-08-03T00:00:00.000Z");
    await testPrisma.organizationSubscription.create({
      data: {
        organizationId: org.id,
        plan: "PRO",
        amount: 499,
        amountSubunits: 49900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_standard",
        razorpaySubscriptionId: "sub_cancel_later",
        status: "ACTIVE",
        providerPaymentMethod: "CARD",
        paidThrough: new Date("2026-08-20T00:00:00.000Z"),
      },
    });

    const scheduled = await BillingService.scheduleWorkspaceCancellation(user.id, org.id, "cancel-early", now);
    expect(scheduled).toMatchObject({ scheduled: true, undoable: true });
    await expect(BillingService.undoWorkspaceCancellation(user.id, org.id, now))
      .resolves.toEqual({ undone: true });
  });

  it("processes Razorpay subscription webhooks idempotently", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    setRazorpayClientForTests(fakeRazorpay);
    const user = await createUser();
    const org = await createOrg({ ownerId: user.id });
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
    const second = await BillingService.handleRazorpayWebhook(rawBody, signature, "evt_subscription_charged");

    expect(first).toMatchObject({
      ok: true,
      event: "subscription.charged",
      organizationId: org.id,
      razorpayPaymentId: "pay_webhook",
      razorpaySubscriptionId: "sub_basic",
    });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    await expect(testPrisma.razorpayWebhookEvent.count()).resolves.toBe(1);
    const stored = await testPrisma.organizationSubscription.findUnique({ where: { organizationId: org.id } });
    expect(stored).toMatchObject({
      status: "ACTIVE",
      authPaymentId: null,
      razorpayCustomerId: "cust_webhook",
    });
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

  it("does not let stale webhooks regress an active or cancelled subscription", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
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
        },
      });
      return BillingService.handleRazorpayWebhook(
        body,
        hmacSha256Hex(body, "webhook_secret"),
        eventId
      );
    }

    await sendStatus("active", "evt_active");
    await sendStatus("authenticated", "evt_stale_authenticated");
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { organizationId: org.id },
    })).resolves.toMatchObject({ status: "ACTIVE" });

    await sendStatus("cancelled", "evt_cancelled");
    await sendStatus("active", "evt_stale_active");
    await expect(testPrisma.organizationSubscription.findUnique({
      where: { organizationId: org.id },
    })).resolves.toMatchObject({ status: "CANCELLED" });
  });
});
