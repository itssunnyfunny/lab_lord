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
      entity: "payment",
      amount: 39900,
      currency: "INR",
      status: "captured",
      order_id: null,
      subscription_id: "sub_basic",
      captured: true,
    })),
    fetchOrderPayments: vi.fn(async () => ({ entity: "collection", count: 0, items: [] })),
    capturePayment: vi.fn(async (paymentId: string) => ({
      id: paymentId,
      entity: "payment",
      amount: 39900,
      currency: "INR",
      status: "captured",
      order_id: null,
      captured: true,
    })),
    createPlan: vi.fn(async input => ({
      id: `plan_${input.notes.plan.toLowerCase()}`,
      entity: "plan",
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
      entity: "subscription",
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
      entity: "subscription",
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
    cancelSubscription: vi.fn(async subscriptionId => ({
      id: subscriptionId,
      entity: "subscription",
      plan_id: "plan_basic",
      customer_id: "cust_test",
      status: "cancelled",
      total_count: 120,
      ended_at: 1767225600,
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
    expect(checkout.amount).toBe(39900);
    expect(fakeRazorpay.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ amount: 39900, currency: "INR" }),
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
      amount: 399,
      amountSubunits: 39900,
      razorpayPlanId: "plan_basic",
      razorpaySubscriptionId: "sub_basic",
      status: "CREATED",
    });
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

  it("cancels a gateway subscription when local persistence fails", async () => {
    const fakeRazorpay = createFakeRazorpayClient();
    vi.mocked(fakeRazorpay.createSubscription).mockImplementationOnce(async input => ({
      id: "sub_orphan",
      entity: "subscription",
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
            entity: "subscription",
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
            amount: 39900,
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
      authPaymentId: "pay_webhook",
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
            entity: "subscription",
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
