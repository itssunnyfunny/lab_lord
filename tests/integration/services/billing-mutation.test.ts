import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingMutationService } from "@/services/billingMutation.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { setRazorpayClientForTests, type RazorpayApiClient } from "@/lib/razorpay";
import { createBranch, createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

function fakeRazorpay(): RazorpayApiClient {
  const periodStart = Math.floor(Date.now() / 1000) - 60;
  const periodEnd = periodStart + 30 * 24 * 60 * 60;
  return {
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
    createPlan: vi.fn(async () => { throw new Error("unused"); }),
    createSubscription: vi.fn(async () => { throw new Error("unused"); }),
    fetchSubscription: vi.fn(async () => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: "plan_standard",
      status: "active",
      total_count: 120,
      quantity: 2,
      current_start: periodStart,
      current_end: periodEnd,
      charge_at: periodEnd,
      payment_method: "card",
    })),
    updateSubscription: vi.fn(async (_id, input) => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: input.plan_id ?? "plan_standard",
      status: "active",
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
      count: 1,
      items: [{
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
        paid_at: periodStart,
      }],
    })),
    cancelSubscription: vi.fn(async (_id, input) => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: "plan_standard",
      status: input.cancel_at_cycle_end ? "active" : "cancelled",
      total_count: 120,
      quantity: 1,
    })),
  };
}

describe("serialized workspace billing mutations", () => {
  beforeEach(async () => { await resetDatabase(); });
  afterEach(() => { setRazorpayClientForTests(null); });
  afterAll(async () => { await disconnectDatabase(); });

  async function setup() {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id, billingModelVersion: "WORKSPACE_V2" });
    const first = await createBranch({ organizationId: organization.id });
    await testPrisma.saasRazorpayPlan.create({
      data: {
        plan: "PRO", amount: 499, amountSubunits: 49900, razorpayPlanId: "plan_standard", active: true,
      },
    });
    const subscription = await testPrisma.organizationSubscription.create({
      data: {
        organizationId: organization.id,
        plan: "PRO",
        amount: 499,
        amountSubunits: 49900,
        totalCount: 120,
        quantity: 1,
        razorpayPlanId: "plan_standard",
        razorpaySubscriptionId: "sub_workspace",
        status: "ACTIVE",
        providerPaymentMethod: "CARD",
      },
    });
    return { owner, organization, first, subscription };
  }

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
    await testPrisma.saasRazorpayPlan.create({
      data: {
        plan: "BASIC", amount: 299, amountSubunits: 29900, razorpayPlanId: "plan_basic", active: true,
      },
    });
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
