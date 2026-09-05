import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { BillingMutationService } from "@/services/billingMutation.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { BillingExperienceService } from "@/services/billingExperience.service";
import { BranchService } from "@/services/branch.service";
import { BillingReplacementService } from "@/services/billingReplacement.service";
import { BillingDeadlineService, recoverExpiredBillingMutationLease } from "@/services/billingDeadline.service";
import { BillingService } from "@/services/billing.service";
import {
  getReplacementUndoCutoffAt,
  getSafeReplacementCycleBoundary,
} from "@/services/billingReplacementPolicy";
import {
  RazorpayApiError,
  setRazorpayClientForTests,
  type RazorpayPlanCatalogApiClient,
} from "@/lib/razorpay";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
} from "@/lib/billingErrors";
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
  undoQuantity?: number;
  providerPlanId?: string;
  providerOfferId?: string | null;
  paymentAmountSubunits?: number;
} = {}): RazorpayPlanCatalogApiClient {
  const periodStart = Math.floor(Date.now() / 1000) - 60;
  const periodEnd = periodStart + 30 * 24 * 60 * 60;
  const providerStatus = options.providerStatus ?? "active";
  const providerQuantity = options.providerQuantity ?? 2;
  const providerPlanId = options.providerPlanId ?? "plan_standard";
  const providerUnitAmountSubunits = providerPlanId.includes("basic") ? 29900 : 49900;
  const paymentAmountSubunits = options.paymentAmountSubunits
    ?? providerUnitAmountSubunits * providerQuantity;
  const client: RazorpayPlanCatalogApiClient = {
    createOrder: vi.fn(async () => { throw new Error("unused"); }),
    fetchPayment: vi.fn(async paymentId => ({
      id: paymentId,
      entity: "payment" as const,
      amount: paymentAmountSubunits,
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
      plan_id: providerPlanId,
      status: providerStatus,
      total_count: 120,
      quantity: providerQuantity,
      paid_count: 1,
      offer_id: options.providerOfferId ?? null,
      start_at: options.futureStartAt,
      current_start: options.omitCurrentPeriod ? undefined : periodStart,
      current_end: options.omitCurrentPeriod ? undefined : periodEnd,
      charge_at: options.omitCurrentPeriod ? undefined : periodEnd,
      payment_method: options.providerMethod ?? "card",
    })),
    updateSubscription: vi.fn(async (_id, input) => ({
      id: "sub_workspace",
      entity: "subscription" as const,
      plan_id: input.plan_id ?? providerPlanId,
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
      quantity: options.undoQuantity ?? 1,
      has_scheduled_changes: false,
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
        amount: paymentAmountSubunits,
        amount_paid: paymentAmountSubunits,
        amount_due: 0,
        currency: "INR",
        billing_start: periodStart,
        billing_end: periodEnd,
        issued_at: periodStart,
        paid_at: options.paidAt ?? Math.floor(Date.now() / 1000),
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
    vi.restoreAllMocks();
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
    const commercialIntent = await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 1,
        idempotencyKey: `baseline-commercial-intent:${organization.id}`,
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "APPLIED",
        operationStatus: "APPLIED",
        fromPlan: "PRO",
        toPlan: "PRO",
        fromQuantity: 1,
        toQuantity: 1,
        commercialIntentVersion: 1,
        commercialIntentCapturedAt: new Date(Date.now() - 60_000),
        authorizedProviderMode: "TEST",
        authorizedSourceRazorpaySubscriptionId: "sub_workspace",
        authorizedRazorpaySubscriptionId: "sub_workspace",
        authorizedSourceRazorpayPlanId: "plan_standard",
        authorizedRazorpayPlanId: "plan_standard",
        authorizedPlan: "PRO",
        authorizedQuantity: 1,
        authorizedRazorpayOfferId: null,
        authorizedUnitAmountSubunits: 49900,
        authorizedGrossAmountSubunits: 49900,
        authorizedExpectedAmountSubunits: 49900,
        authorizedOfferValidThroughPaidCount: null,
        authorizedCurrency: "INR",
        authorizedPeriod: "monthly",
        authorizedInterval: 1,
        providerConfirmedAt: new Date(Date.now() - 60_000),
        appliedAt: new Date(Date.now() - 60_000),
        resolvedAt: new Date(Date.now() - 60_000),
      },
    });
    await Promise.all([
      testPrisma.organization.update({
        where: { id: organization.id },
        data: { billingMutationSequence: 1 },
      }),
      testPrisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: { confirmedCommercialIntentChangeId: commercialIntent.id },
      }),
    ]);
    return { owner, organization, first, subscription, commercialIntent };
  }

  async function setupPendingUpiReplacement(idempotencyKey: string) {
    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "true");
    vi.stubEnv("RAZORPAY_BILLING_WRITES_ENABLED", "true");
    const razorpay = fakeRazorpay({ providerMethod: "upi" });
    setRazorpayClientForTests(razorpay);
    const context = await setup({ paymentMethod: "UPI" });
    const branch = await testPrisma.branch.create({
      data: {
        organizationId: context.organization.id,
        name: `Replacement ${idempotencyKey}`,
        billingStatus: "PENDING_ACTIVATION",
      },
    });
    const queued = await BillingMutationService.enqueue({
      organizationId: context.organization.id,
      subscriptionId: context.subscription.id,
      branchId: branch.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey,
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: context.owner.id,
    });
    await BillingMutationService.processNext(context.organization.id);
    const change = await testPrisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: queued.id },
      include: { replacementSubscription: true },
    });
    if (!change.replacementSubscription) throw new Error("Replacement candidate was not provisioned");
    return { ...context, branch, change, candidate: change.replacementSubscription, razorpay };
  }

  async function queuedReplacement(key: string) {
    vi.stubEnv("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED", "true");
    const razorpay = fakeRazorpay({ providerMethod: "upi" });
    setRazorpayClientForTests(razorpay);
    const context = await setup({ paymentMethod: "UPI" });
    const change = await BillingMutationService.enqueue({
      organizationId: context.organization.id, subscriptionId: context.subscription.id,
      type: "QUANTITY_INCREASE", idempotencyKey: key, fromQuantity: 1, toQuantity: 2,
      createdByUserId: context.owner.id,
    });
    return { ...context, razorpay, change };
  }

  it("never recreates a response-lost replacement during delayed discovery or a later cycle", async () => {
    const { razorpay, organization, subscription, change } = await queuedReplacement("replacement-response-loss");
    const create = vi.mocked(razorpay.createSubscription).getMockImplementation()!;
    let accepted: Awaited<ReturnType<typeof create>> | undefined;
    vi.mocked(razorpay.createSubscription).mockImplementation(async input => {
      accepted = await create(input);
      throw new Error("response lost after provider acceptance");
    });
    await expect(BillingMutationService.processNext(organization.id)).rejects.toThrow(/response lost/);
    const failed = await testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
    expect(failed).toMatchObject({ status: "FAILED", failureCategory: "MANUAL_REVIEW_REQUIRED", resolvedAt: null });
    expect(failed.providerMutationAdmittedAt).not.toBeNull();
    await expect(BillingMutationService.retry(change.id)).rejects.toThrow(/no new create/);
    await expect(BillingMutationService.enqueue({ organizationId: organization.id, subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE", idempotencyKey: "different-key", fromQuantity: 1, toQuantity: 3 }))
      .rejects.toBeInstanceOf(BillingChangeInProgressError);
    vi.mocked(razorpay.listSubscriptions!).mockResolvedValue({ entity: "collection", count: 1, items: [accepted!] });
    const fetch = vi.mocked(razorpay.fetchSubscription).getMockImplementation()!;
    vi.mocked(razorpay.fetchSubscription).mockImplementation(async id => ({
      ...await fetch(id), current_end: Math.floor(Date.now() / 1000) + 90 * 86400,
    }));
    const recovered = await BillingMutationService.retry(change.id);
    expect(recovered?.status).toBe("AWAITING_PAYMENT");
    expect(recovered?.authorizedProviderStartAt).toEqual(failed.authorizedProviderStartAt);
    expect(recovered?.authorizedProviderExpireAt).toEqual(failed.authorizedProviderExpireAt);
    expect(razorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
  });

  it("retains the confirmed replacement ID across local-finalization failure", async () => {
    const { razorpay, owner, organization, change } = await queuedReplacement("replacement-local-failure");
    const finalization = vi.spyOn(BillingReplacementService, "assertNoOpenReplacement")
      .mockRejectedValueOnce(new Error("local finalization unavailable"));
    await expect(BillingMutationService.processNext(organization.id)).rejects.toThrow(/local finalization/);
    finalization.mockRestore();
    const failed = await testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
    expect(failed.authorizedRazorpaySubscriptionId).toBe("sub_candidate");
    expect(failed.failureCategory).toBe("MANUAL_REVIEW_REQUIRED");
    const accepted = await vi.mocked(razorpay.createSubscription).mock.results[0].value;
    const fetch = vi.mocked(razorpay.fetchSubscription).getMockImplementation()!;
    vi.mocked(razorpay.fetchSubscription).mockImplementation(id => id === "sub_candidate" ? Promise.resolve(accepted) : fetch(id));
    const recovered = await BillingService.retryBillingOperation(owner.id, organization.id, change.id);
    expect(recovered.operation?.queueStatus).toBe("AWAITING_PAYMENT");
    expect(await testPrisma.organizationBillingChangeAudit.findFirst({ where: {
      changeId: change.id, outcome: "PROVIDER_STATE_ADOPTED", providerSubscriptionId: "sub_candidate",
    } })).not.toBeNull();
    expect(razorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
  });

  it("retries a known pre-dispatch replacement read failure", async () => {
    const { razorpay, organization, change } = await queuedReplacement("replacement-read-failure");
    const fetch = vi.mocked(razorpay.fetchSubscription).getMockImplementation()!;
    vi.mocked(razorpay.fetchSubscription).mockImplementation(async id => ({
      ...await fetch(id), quantity: 1, has_scheduled_changes: false,
    }));
    vi.mocked(razorpay.fetchSubscription).mockRejectedValueOnce(new Error("source read unavailable"));
    await expect(BillingMutationService.processNext(organization.id)).rejects.toThrow(/source read/);
    expect(await testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .toMatchObject({ failureCategory: "PRE_PROVIDER_FAILURE", providerMutationAdmittedAt: null });
    const retried = await BillingMutationService.retry(change.id);
    expect(retried?.status).toBe("AWAITING_PAYMENT");
    expect(razorpay.createSubscription).toHaveBeenCalledTimes(1);
  });

  it("quarantines multiple replacement matches without cancelling any provider object", async () => {
    const { razorpay, organization, change } = await queuedReplacement("replacement-duplicates");
    const create = vi.mocked(razorpay.createSubscription).getMockImplementation()!;
    let accepted: Awaited<ReturnType<typeof create>> | undefined;
    vi.mocked(razorpay.createSubscription).mockImplementation(async input => {
      accepted = await create(input);
      throw new Error("response lost");
    });
    await expect(BillingMutationService.processNext(organization.id)).rejects.toThrow(/response lost/);
    vi.mocked(razorpay.listSubscriptions!).mockResolvedValue({ entity: "collection", count: 2,
      items: [accepted!, { ...accepted!, id: "sub_duplicate" }] });
    await expect(BillingMutationService.retry(change.id)).rejects.toThrow(/manual review/);
    expect(razorpay.createSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
  });

  it("fences an expired replacement worker after dispatch and recovers only by provider reads", async () => {
    const { razorpay, organization, change } = await queuedReplacement("replacement-expired-worker");
    const create = vi.mocked(razorpay.createSubscription).getMockImplementation()!;
    let accepted: Awaited<ReturnType<typeof create>> | undefined;
    vi.mocked(razorpay.createSubscription).mockImplementation(async input => {
      accepted = await create(input);
      const leased = await testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
      await recoverExpiredBillingMutationLease(leased, new Date(leased.billingMutationLeaseUntil!.getTime() + 1));
      return accepted;
    });
    await expect(BillingMutationService.processNext(organization.id)).rejects.toThrow(/lease was lost/);
    expect(await testPrisma.organizationBillingChange.findUnique({ where: { id: change.id } }))
      .toMatchObject({ status: "FAILED", failureCategory: "MANUAL_REVIEW_REQUIRED", replacementSubscriptionId: null });
    vi.mocked(razorpay.listSubscriptions!).mockResolvedValue({ entity: "collection", count: 1, items: [accepted!] });
    expect((await BillingMutationService.retry(change.id))?.status).toBe("AWAITING_PAYMENT");
    expect(razorpay.createSubscription).toHaveBeenCalledTimes(1);
  });

  it.each(["response-loss", "local-finalization", "lease-expiry"] as const)(
    "never repeats source cancellation after %s", async fault => {
      const { razorpay, owner, organization, change, candidate, subscription } = await setupPendingUpiReplacement(`source-${fault}`);
      const now = new Date(change.undoCutoffAt!.getTime() + 1);
      await testPrisma.organizationBillingChange.update({ where: { id: change.id }, data: {
        status: "SCHEDULED", operationStatus: "SCHEDULED", providerConfirmedAt: new Date(),
      } });
      await testPrisma.organizationSubscription.update({ where: { id: candidate.id }, data: {
        status: "AUTHENTICATED", providerPaymentMethod: "UPI",
      } });
      await testPrisma.organizationSubscription.update({ where: { id: subscription.id }, data: {
        currentEnd: change.effectiveAt,
      } });
      // Source commercial reconciliation has separate integration coverage;
      // this fixture isolates the real durable cancellation transaction.
      vi.spyOn(BillingReconciliationService, "reconcileProviderSubscription").mockImplementation(async id => ({
        subscription: await testPrisma.organizationSubscription.findUniqueOrThrow({ where: { razorpaySubscriptionId: id } }),
        evidenceKind: "AUTHORIZATION_ONLY",
      }) as never);
      vi.mocked(razorpay.cancelSubscription).mockImplementation(async id => {
        await testPrisma.organizationBillingChange.update({ where: { id: change.id }, data: {
          operationStatus: "VERIFYING",
        } });
        await BillingReplacementService.syncAuthorizedAccess(change.id, now, { resolveManualReview: true });
        expect(await testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
          .toMatchObject({ status: "PROCESSING", failureCode: "SOURCE_CANCELLATION_PROCESSING" });
        if (fault === "response-loss") throw new Error("accepted cancellation response lost");
        if (fault === "local-finalization") {
          vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("local finalization unavailable"));
        } else {
          const leased = await testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
          await recoverExpiredBillingMutationLease(leased, new Date(leased.billingMutationLeaseUntil!.getTime() + 1));
        }
        return { id, entity: "subscription", plan_id: subscription.razorpayPlanId,
          status: "active", quantity: subscription.quantity, total_count: 120,
          has_scheduled_changes: true, change_scheduled_at: Math.floor(change.effectiveAt!.getTime() / 1000) };
      });
      await expect(BillingReplacementService.scheduleSourceCancellation(change.id, now)).rejects.toThrow();
      const failed = await testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
      expect(failed).toMatchObject({ status: "FAILED", failureCategory: "MANUAL_REVIEW_REQUIRED", resolvedAt: null });
      expect(failed.failureCode).toMatch(/^SOURCE_CANCELLATION_/);
      await BillingReplacementService.scheduleSourceCancellation(change.id, now);
      await expect(BillingMutationService.retry(change.id)).rejects.toBeInstanceOf(BillingManualReviewRequiredError);
      await expect(BillingService.retryBillingOperation(owner.id, organization.id, change.id))
        .rejects.toBeInstanceOf(BillingManualReviewRequiredError);
      await BillingReplacementService.syncAuthorizedAccess(change.id, now, { resolveManualReview: true });
      // An unrelated projection/error must not erase the immutable dispatch fence.
      await testPrisma.organizationBillingChange.update({ where: { id: change.id }, data: {
        status: "SCHEDULED", operationStatus: "SCHEDULED", failureCode: null, failureCategory: null,
      } });
      expect(await BillingReplacementService.scheduleSourceCancellation(change.id, now))
        .toMatchObject({ scheduled: false, reason: "MANUAL_REVIEW_REQUIRED" });
      expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(razorpay.cancelScheduledChanges).not.toHaveBeenCalled();
    }
  );

  it("finalizes one confirmed source cancellation and preserves its scheduled result", async () => {
    const { razorpay, change, candidate, subscription } = await setupPendingUpiReplacement("source-success");
    const now = new Date(change.undoCutoffAt!.getTime() + 1);
    await testPrisma.organizationBillingChange.update({ where: { id: change.id }, data: {
      status: "SCHEDULED", operationStatus: "SCHEDULED",
    } });
    await testPrisma.organizationSubscription.update({ where: { id: candidate.id }, data: {
      status: "AUTHENTICATED", providerPaymentMethod: "UPI",
    } });
    await testPrisma.organizationSubscription.update({ where: { id: subscription.id }, data: {
      currentEnd: change.effectiveAt,
    } });
    vi.spyOn(BillingReconciliationService, "reconcileProviderSubscription").mockImplementation(async id => ({
        subscription: await testPrisma.organizationSubscription.findUniqueOrThrow({ where: { razorpaySubscriptionId: id } }),
        evidenceKind: "AUTHORIZATION_ONLY",
      }) as never);
    vi.mocked(razorpay.cancelSubscription).mockResolvedValue({
      id: subscription.razorpaySubscriptionId, entity: "subscription", plan_id: subscription.razorpayPlanId,
      status: "active", quantity: subscription.quantity, total_count: 120,
      has_scheduled_changes: true, change_scheduled_at: Math.floor(change.effectiveAt!.getTime() / 1000),
    });
    expect(await BillingReplacementService.scheduleSourceCancellation(change.id, now)).toMatchObject({ scheduled: true });
    expect(await BillingReplacementService.scheduleSourceCancellation(change.id, now))
      .toMatchObject({ scheduled: true, reason: "ALREADY_SCHEDULED" });
    expect(await testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .toMatchObject({ cancelAtCycleEnd: true, cancellationScheduledAt: change.effectiveAt });
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it.each(["terminal", "confirmed"])("recovers a %s source after response loss using reads only", async evidence => {
    const { razorpay, owner, organization, change, subscription } = await setupPendingUpiReplacement("source-terminal-recovery");
    await testPrisma.organizationBillingChangeAudit.create({ data: {
      changeId: change.id, organizationId: organization.id, attemptCount: 2, dedupeKey: "source-admission",
      outcome: "PROVIDER_MUTATION_ADMITTED", failureCode: "SOURCE_CANCELLATION_PROCESSING",
    } });
    if (evidence === "confirmed") await testPrisma.organizationBillingChangeAudit.create({ data: {
      changeId: change.id, organizationId: organization.id, attemptCount: 2, dedupeKey: "source-confirmed",
      outcome: "PROVIDER_STATE_ADOPTED", failureCode: "SOURCE_CANCELLATION_CONFIRMED",
      providerSubscriptionId: subscription.razorpaySubscriptionId,
    } });
    await testPrisma.organizationBillingChange.update({ where: { id: change.id }, data: {
      status: "FAILED", operationStatus: "FAILED", failureCategory: "MANUAL_REVIEW_REQUIRED",
      failureCode: "SOURCE_CANCELLATION_OUTCOME_UNKNOWN",
    } });
    vi.mocked(razorpay.fetchSubscription).mockResolvedValue({ id: subscription.razorpaySubscriptionId,
      entity: "subscription", plan_id: subscription.razorpayPlanId, quantity: subscription.quantity,
      total_count: 120, status: evidence === "terminal" ? "cancelled" : "active",
      has_scheduled_changes: true, change_scheduled_at: Math.floor(change.effectiveAt!.getTime() / 1000) });
    const result = await BillingService.retryBillingOperation(owner.id, organization.id, change.id);
    expect(result.operation?.queueStatus).toBe("SCHEDULED");
    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    expect(razorpay.cancelScheduledChanges).not.toHaveBeenCalled();
  });

  it.each(["halted", "pending", "paused", "cancelled", "expired"])(
    "projects current %s replacement state even without paid evidence", async status => {
      const { razorpay, change, candidate } = await setupPendingUpiReplacement(`negative-${status}`);
      await testPrisma.organizationSubscription.update({ where: { id: candidate.id }, data: { status: "AUTHENTICATED" } });
      vi.mocked(razorpay.fetchSubscription).mockResolvedValue({ id: candidate.razorpaySubscriptionId,
        entity: "subscription", plan_id: candidate.razorpayPlanId, quantity: candidate.quantity,
        total_count: candidate.totalCount, status, offer_id: null,
        start_at: Math.floor(candidate.providerStartAt!.getTime() / 1000),
        expire_by: Math.floor(candidate.authorizationExpiresAt!.getTime() / 1000) });
      vi.mocked(razorpay.fetchSubscriptionInvoices).mockResolvedValue({ entity: "collection", count: 0, items: [] });
      const result = await BillingReconciliationService.reconcileProviderSubscription(candidate.razorpaySubscriptionId,
        { commercialIntentChangeId: change.id });
      expect(result.subscription.status).toBe(status.toUpperCase());
      expect(result.confirmedPaidPeriod).toBe(false);
      expect(result.subscription.paidThrough).toEqual(candidate.paidThrough);
      if (status === "halted") {
        await BillingDeadlineService.run(new Date());
        expect(await testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: candidate.id } }))
          .toMatchObject({ status: "HALTED", pendingReplacementOrganizationId: candidate.organizationId });
      }
      expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    }
  );

  it("preserves the legacy cancellation key and never compensates an uncertain cancellation", async () => {
    const { owner, organization, subscription } = await setup({ paymentMethod: "CARD" });
    await testPrisma.organization.update({ where: { id: organization.id }, data: { billingModelVersion: "LEGACY" } });
    const razorpay = fakeRazorpay({ providerQuantity: 1 });
    setRazorpayClientForTests(razorpay);
    vi.mocked(razorpay.cancelSubscription).mockRejectedValueOnce(new Error("accepted but response lost"));
    await expect(BillingService.scheduleWorkspaceCancellation(owner.id, organization.id, "legacy-key"))
      .rejects.toThrow("response lost");
    expect(await testPrisma.organizationBillingChange.findUnique({ where: { idempotencyKey: "legacy-key" } }))
      .toMatchObject({ status: "FAILED", failureCategory: "MANUAL_REVIEW_REQUIRED" });
    vi.mocked(razorpay.fetchSubscription).mockResolvedValue({ id: subscription.razorpaySubscriptionId,
      entity: "subscription", plan_id: subscription.razorpayPlanId, quantity: 1, total_count: 120, status: "cancelled" });
    await BillingService.scheduleWorkspaceCancellation(owner.id, organization.id, "legacy-key");
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.cancelScheduledChanges).not.toHaveBeenCalled();
  });

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

  it.each(["created", "authenticated"])("adopts exact replacement payment authorization with provider status %s without another mutation", async providerStatus => {
    const { owner, organization, subscription, branch, change, candidate, razorpay }
      = await setupPendingUpiReplacement("manual-replacement-exact-authorization");
    const paymentId = "pay_replacement_authorized";
    await testPrisma.organizationBillingChange.update({
      where: { id: change.id },
      data: {
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_EVIDENCE_UNCERTAIN",
        lastError: "Awaiting exact provider evidence",
        providerPaymentId: paymentId,
        failedAt: new Date(),
      },
    });
    vi.mocked(razorpay.fetchSubscription).mockResolvedValue({
      id: candidate.razorpaySubscriptionId,
      entity: "subscription",
      plan_id: candidate.razorpayPlanId,
      status: providerStatus,
      total_count: candidate.totalCount,
      quantity: candidate.quantity,
      offer_id: null,
      start_at: candidate.providerStartAt
        ? Math.floor(candidate.providerStartAt.getTime() / 1000)
        : undefined,
      expire_by: candidate.authorizationExpiresAt
        ? Math.floor(candidate.authorizationExpiresAt.getTime() / 1000)
        : undefined,
      payment_method: "upi",
    });
    vi.mocked(razorpay.fetchSubscriptionInvoices).mockResolvedValue({
      entity: "collection",
      count: 0,
      items: [],
    });
    vi.mocked(razorpay.fetchPayment).mockResolvedValue({
      id: paymentId,
      entity: "payment",
      amount: candidate.amountSubunits * candidate.quantity,
      currency: candidate.currency,
      status: "authorized",
      order_id: null,
      invoice_id: null,
      subscription_id: candidate.razorpaySubscriptionId,
      method: "upi",
      captured: false,
      created_at: Math.floor(Date.now() / 1000),
    });
    const providerMutationCounts = {
      create: vi.mocked(razorpay.createSubscription).mock.calls.length,
      update: vi.mocked(razorpay.updateSubscription).mock.calls.length,
      cancel: vi.mocked(razorpay.cancelSubscription).mock.calls.length,
      undo: vi.mocked(razorpay.cancelScheduledChanges).mock.calls.length,
    };

    await expect(BillingService.retryBillingOperation(owner.id, organization.id, change.id))
      .resolves.toMatchObject({
        resolutionOutcome: "PROVIDER_STATE_ADOPTED",
        operation: {
          id: change.id,
          queueStatus: "SCHEDULED",
          operationStatus: "SCHEDULED",
        },
      });

    expect(vi.mocked(razorpay.createSubscription)).toHaveBeenCalledTimes(providerMutationCounts.create);
    expect(vi.mocked(razorpay.updateSubscription)).toHaveBeenCalledTimes(providerMutationCounts.update);
    expect(vi.mocked(razorpay.cancelSubscription)).toHaveBeenCalledTimes(providerMutationCounts.cancel);
    expect(vi.mocked(razorpay.cancelScheduledChanges)).toHaveBeenCalledTimes(providerMutationCounts.undo);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "SCHEDULED",
        operationStatus: "SCHEDULED",
        failureCategory: null,
        failureCode: null,
        accessGrantedAt: expect.any(Date),
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({
        confirmedCommercialIntentChangeId: change.id,
        authPaymentId: paymentId,
        quantity: 2,
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ currentOrganizationId: organization.id, quantity: 1 });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "ACTIVE" });
  });

  it("retains manual review for pending replacement evidence without promotion or provider mutation", async () => {
    const { owner, organization, subscription, branch, change, candidate, razorpay }
      = await setupPendingUpiReplacement("manual-replacement-pending-evidence");
    await testPrisma.organizationBillingChange.update({
      where: { id: change.id },
      data: {
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_EVIDENCE_UNCERTAIN",
        lastError: "Awaiting exact provider evidence",
        providerPaymentId: null,
        failedAt: new Date(),
      },
    });
    vi.mocked(razorpay.fetchSubscription).mockResolvedValue({
      id: candidate.razorpaySubscriptionId,
      entity: "subscription",
      plan_id: candidate.razorpayPlanId,
      status: "created",
      total_count: candidate.totalCount,
      quantity: candidate.quantity,
      offer_id: null,
      payment_method: null,
    });
    vi.mocked(razorpay.fetchSubscriptionInvoices).mockResolvedValue({
      entity: "collection",
      count: 0,
      items: [],
    });
    const providerMutationCounts = {
      create: vi.mocked(razorpay.createSubscription).mock.calls.length,
      update: vi.mocked(razorpay.updateSubscription).mock.calls.length,
      cancel: vi.mocked(razorpay.cancelSubscription).mock.calls.length,
      undo: vi.mocked(razorpay.cancelScheduledChanges).mock.calls.length,
    };

    await expect(BillingService.retryBillingOperation(owner.id, organization.id, change.id))
      .rejects.toMatchObject({
        name: "BillingManualReviewRequiredError",
        code: "BILLING_MANUAL_REVIEW_REQUIRED",
        changeId: change.id,
      });

    expect(vi.mocked(razorpay.createSubscription)).toHaveBeenCalledTimes(providerMutationCounts.create);
    expect(vi.mocked(razorpay.updateSubscription)).toHaveBeenCalledTimes(providerMutationCounts.update);
    expect(vi.mocked(razorpay.cancelSubscription)).toHaveBeenCalledTimes(providerMutationCounts.cancel);
    expect(vi.mocked(razorpay.cancelScheduledChanges)).toHaveBeenCalledTimes(providerMutationCounts.undo);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "PROVIDER_EVIDENCE_UNCERTAIN",
        accessGrantedAt: null,
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({
        pendingReplacementOrganizationId: organization.id,
        confirmedCommercialIntentChangeId: null,
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ currentOrganizationId: organization.id, quantity: 1 });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "PENDING_ACTIVATION" });
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
      data: {
        status: "AUTHENTICATED",
        providerPaymentMethod: "EMANDATE",
        confirmedCommercialIntentChangeId: change.id,
      },
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

    expect([first.sequence, first.toQuantity]).toEqual([2, 2]);
    expect([second.sequence, second.toQuantity]).toEqual([3, 3]);
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

  it("adopts an exact provider target but never resubmits an ambiguous provider mutation", async () => {
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

    await expect(BillingService.retryBillingOperation(owner.id, organization.id, change.id))
      .resolves.toMatchObject({
        resolutionOutcome: "PROVIDER_STATE_ADOPTED",
        operation: {
          id: change.id,
          queueStatus: "APPLIED",
          operationStatus: "APPLIED",
        },
      });

    expect(razorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "APPLIED",
        failureCategory: null,
        failureCode: null,
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ quantity: 2 });
    await expect(testPrisma.organizationSubscriptionHistory.findMany({
      where: { organizationSubscriptionId: subscription.id },
      orderBy: { createdAt: "asc" },
      select: { event: true },
    })).resolves.toEqual(expect.arrayContaining([
      { event: "billing_change:MANUAL_REVIEW_REQUIRED:PROVIDER_MUTATION_OUTCOME_UNKNOWN" },
      { event: "billing_change:PROVIDER_STATE_ADOPTED:NONE" },
    ]));
  });

  it("retains manual review with a typed outcome when provider state still matches the source", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay({ providerQuantity: 1 });
    const timeout = new RazorpayApiError("response lost", { kind: "NETWORK" });
    vi.mocked(razorpay.updateSubscription).mockRejectedValueOnce(timeout);
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "QUANTITY_INCREASE",
      idempotencyKey: "ambiguous-source-unchanged",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });
    await expect(BillingMutationService.processNext(organization.id)).rejects.toBe(timeout);

    await expect(BillingService.retryBillingOperation(owner.id, organization.id, change.id))
      .rejects.toMatchObject({
        name: "BillingManualReviewRequiredError",
        code: "BILLING_MANUAL_REVIEW_REQUIRED",
        changeId: change.id,
      });

    expect(razorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "QUANTITY_MISMATCH",
      });
    await expect(testPrisma.organizationSubscriptionHistory.findMany({
      where: { organizationSubscriptionId: subscription.id },
      orderBy: { createdAt: "asc" },
      select: { event: true },
    })).resolves.toEqual(expect.arrayContaining([
      { event: "billing_change:MANUAL_REVIEW_REQUIRED:PROVIDER_MUTATION_OUTCOME_UNKNOWN" },
      { event: "billing_change:MANUAL_REVIEW_RETAINED:QUANTITY_MISMATCH" },
    ]));
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

  it("rejects general undo while the provider mutation is in flight", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay({ providerQuantity: 1, includePaidInvoice: false });
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
      idempotencyKey: "undo-during-provider-mutation",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });

    const processing = BillingMutationService.processNext(organization.id);
    await started;
    await expect(BillingService.undoWorkspaceChange(owner.id, organization.id, change.id))
      .rejects.toMatchObject({ code: "BILLING_CHANGE_IN_PROGRESS" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "PROCESSING" });
    releaseProvider();
    await expect(processing).resolves.toMatchObject({ status: "AWAITING_PAYMENT" });
  });

  it("blocks every replacement undo entry point while provider state requires manual review", async () => {
    const { owner, organization, change, candidate, razorpay } = await setupPendingUpiReplacement(
      "manual-review-replacement-undo"
    );
    vi.mocked(razorpay.cancelSubscription).mockClear();
    await testPrisma.organizationBillingChange.update({
      where: { id: change.id },
      data: {
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "MALFORMED_PROVIDER_EVIDENCE",
        resolvedAt: null,
      },
    });

    await expect(BillingService.undoWorkspaceChange(owner.id, organization.id, change.id))
      .rejects.toBeInstanceOf(BillingChangeInProgressError);
    await expect(BillingReplacementService.undoReplacement(change.id))
      .rejects.toBeInstanceOf(BillingChangeInProgressError);

    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: candidate.id },
    })).resolves.toMatchObject({ pendingReplacementOrganizationId: organization.id });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: change.branchId! } }))
      .resolves.toMatchObject({ billingStatus: "PENDING_ACTIVATION" });
  });

  it("does not restore a replacement-backed branch removal under manual review", async () => {
    const { owner, organization, branch, change, candidate, razorpay } = await setupPendingUpiReplacement(
      "manual-review-replacement-removal"
    );
    vi.mocked(razorpay.cancelSubscription).mockClear();
    await Promise.all([
      testPrisma.branch.update({
        where: { id: branch.id },
        data: { billingStatus: "REMOVAL_SCHEDULED" },
      }),
      testPrisma.organizationBillingChange.update({
        where: { id: change.id },
        data: {
          type: "BRANCH_REMOVAL",
          status: "FAILED",
          operationStatus: "FAILED",
          failureCategory: "MANUAL_REVIEW_REQUIRED",
          failureCode: "MALFORMED_PROVIDER_EVIDENCE",
          resolvedAt: null,
        },
      }),
    ]);

    await expect(BranchService.undoBillingRemoval(owner.id, branch.id))
      .rejects.toBeInstanceOf(BillingChangeInProgressError);

    expect(razorpay.cancelSubscription).not.toHaveBeenCalled();
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({
      where: { id: candidate.id },
    })).resolves.toMatchObject({ pendingReplacementOrganizationId: organization.id });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "REMOVAL_SCHEDULED" });
  });

  it("atomically restores a normal replacement-backed branch removal after exact cancellation", async () => {
    const { owner, organization, branch, change, candidate, razorpay } = await setupPendingUpiReplacement(
      "exact-replacement-removal-undo"
    );
    await Promise.all([
      testPrisma.branch.update({
        where: { id: branch.id },
        data: { billingStatus: "REMOVAL_SCHEDULED" },
      }),
      testPrisma.organizationBillingChange.update({
        where: { id: change.id },
        data: { type: "BRANCH_REMOVAL" },
      }),
    ]);
    vi.mocked(razorpay.cancelSubscription).mockReset();
    vi.mocked(razorpay.cancelSubscription).mockResolvedValue({
      id: candidate.razorpaySubscriptionId,
      entity: "subscription",
      plan_id: candidate.razorpayPlanId,
      status: "cancelled",
      total_count: candidate.totalCount,
      quantity: candidate.quantity,
      ended_at: Math.floor(Date.now() / 1000),
    });

    await expect(BranchService.undoBillingRemoval(owner.id, branch.id))
      .resolves.toEqual({ undone: true });

    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "UNDONE", operationStatus: "ABANDONED" });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({ pendingReplacementOrganizationId: null, status: "CANCELLED" });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({
        organizationId: organization.id,
        billingStatus: "ACTIVE",
        billingArchivedAt: null,
      });
  });

  it("never resubmits a response-lost replacement cancellation and adopts it read-only", async () => {
    const { owner, organization, branch, subscription, change, candidate, razorpay } = await setupPendingUpiReplacement(
      "response-lost-replacement-cancellation"
    );
    vi.mocked(razorpay.cancelSubscription).mockReset();
    vi.mocked(razorpay.cancelSubscription).mockRejectedValueOnce(
      new Error("connection closed after Razorpay accepted cancellation")
    );

    await expect(BillingReplacementService.undoReplacement(change.id))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "ABANDONED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "REPLACEMENT_UNDO_CANCELLATION_OUTCOME_UNKNOWN_RESTORE",
        resolvedAt: null,
      });
    await expect(BillingService.undoWorkspaceChange(owner.id, organization.id, change.id))
      .rejects.toBeInstanceOf(BillingChangeInProgressError);
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);

    vi.mocked(razorpay.fetchSubscription).mockResolvedValue({
      id: candidate.razorpaySubscriptionId,
      entity: "subscription",
      plan_id: candidate.razorpayPlanId,
      status: "cancelled",
      total_count: candidate.totalCount,
      quantity: candidate.quantity,
      ended_at: Math.floor(Date.now() / 1000),
    });
    const deadlineNow = new Date();
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { lastReconciledAt: deadlineNow },
    });
    const deadline = await BillingDeadlineService.run(deadlineNow);

    expect(deadline.retriedReplacementCancellations).toBe(1);
    expect(deadline.errors).toEqual([]);
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "UNDONE",
        operationStatus: "ABANDONED",
        failureCategory: null,
        failureCode: null,
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({
        status: "CANCELLED",
        pendingReplacementOrganizationId: null,
      });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "PENDING_ACTIVATION" });
  });

  it("quarantines response-lost failed-checkout cleanup and lets the deadline read provider truth", async () => {
    const { subscription, change, candidate, razorpay } = await setupPendingUpiReplacement(
      "response-lost-failed-checkout-cleanup"
    );
    vi.mocked(razorpay.cancelSubscription).mockReset();
    vi.mocked(razorpay.cancelSubscription).mockRejectedValueOnce(
      new Error("timeout after replacement cleanup was accepted")
    );

    await expect(BillingReplacementService.failReplacementCheckout(
      change.id,
      "FAILED",
      new Date(),
      "Mandate authorization failed"
    )).rejects.toBeInstanceOf(BillingManualReviewRequiredError);
    await expect(BillingReplacementService.failReplacementCheckout(change.id, "FAILED"))
      .rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "CANDIDATE_CANCELLATION_OUTCOME_UNKNOWN",
        resolvedAt: null,
      });

    vi.mocked(razorpay.fetchSubscription).mockResolvedValue({
      id: candidate.razorpaySubscriptionId,
      entity: "subscription",
      plan_id: candidate.razorpayPlanId,
      status: "cancelled",
      total_count: candidate.totalCount,
      quantity: candidate.quantity,
      ended_at: Math.floor(Date.now() / 1000),
    });
    const deadlineNow = new Date();
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { lastReconciledAt: deadlineNow },
    });
    const deadline = await BillingDeadlineService.run(deadlineNow);

    expect(deadline.retriedReplacementCancellations).toBe(1);
    expect(deadline.errors).toEqual([]);
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "PROVIDER_AUTHORIZATION_FAILED",
        failureCode: null,
      });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: candidate.id } }))
      .resolves.toMatchObject({ pendingReplacementOrganizationId: null, status: "CANCELLED" });
  });

  it("reads provider state before retrying a definitely rejected replacement cancellation", async () => {
    const { owner, organization, branch, change, candidate, razorpay } = await setupPendingUpiReplacement(
      "definitely-rejected-replacement-cancellation"
    );
    vi.mocked(razorpay.cancelSubscription).mockReset();
    vi.mocked(razorpay.cancelSubscription).mockRejectedValueOnce(new RazorpayApiError(
      "cancellation request was rejected",
      { kind: "REQUEST", status: 400 }
    ));

    await expect(BillingReplacementService.undoReplacement(change.id, new Date(), {
      branchDisposition: "ARCHIVE",
    }))
      .rejects.toBeInstanceOf(RazorpayApiError);
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "PROVIDER_REJECTED",
        failureCode: "REPLACEMENT_UNDO_CANCELLATION_PROVIDER_REJECTED_ARCHIVE",
      });

    vi.mocked(razorpay.fetchSubscription).mockResolvedValue({
      id: candidate.razorpaySubscriptionId,
      entity: "subscription",
      plan_id: candidate.razorpayPlanId,
      status: "authenticated",
      total_count: candidate.totalCount,
      quantity: candidate.quantity,
    });
    await expect(BillingService.retryBillingOperation(owner.id, organization.id, change.id))
      .resolves.toMatchObject({ resolutionOutcome: "PROVIDER_STATE_ADOPTED" });
    expect(razorpay.fetchSubscription).toHaveBeenCalledWith(candidate.razorpaySubscriptionId);
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        failureCategory: "PROVIDER_REJECTED",
        failureCode: "REPLACEMENT_UNDO_CANCELLATION_RETRY_SAFE_ARCHIVE",
      });

    vi.mocked(razorpay.cancelSubscription).mockResolvedValueOnce({
      id: candidate.razorpaySubscriptionId,
      entity: "subscription",
      plan_id: candidate.razorpayPlanId,
      status: "cancelled",
      total_count: candidate.totalCount,
      quantity: candidate.quantity,
    });
    await expect(BillingService.retryBillingOperation(owner.id, organization.id, change.id))
      .resolves.toMatchObject({
        operation: { queueStatus: "UNDONE", operationStatus: "ABANDONED" },
        resolutionOutcome: "SAFE_RETRY_SUBMITTED",
      });
    expect(razorpay.cancelSubscription).toHaveBeenCalledTimes(2);
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "ARCHIVED" });
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
        has_scheduled_changes: false,
      };
    });

    const undoing = BillingMutationService.undoScheduledProviderChange(scheduled.id);
    await undoStarted;
    // The provider call is outside a DB transaction, but the organization
    // lease prevents a concurrent provider mutation from overtaking it.
    await expect(testPrisma.organization.findUniqueOrThrow({ where: { id: organization.id } }))
      .resolves.toMatchObject({ id: organization.id });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: scheduled.id } }))
      .resolves.toMatchObject({
        status: "PROCESSING",
        failureCode: "SCHEDULED_UNDO_PROCESSING",
      });
    await expect(BillingMutationService.undoScheduledProviderChange(scheduled.id))
      .rejects.toBeInstanceOf(BillingChangeInProgressError);
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

  it("quarantines an accepted scheduled-change undo whose response is lost and adopts it by reconciliation", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const scheduled = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "PLAN_DOWNGRADE",
      idempotencyKey: "undo-timeout-downgrade",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      effectiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByUserId: owner.id,
    });
    await BillingMutationService.processNext(organization.id);
    const timeout = new RazorpayApiError("scheduled undo response was lost", { kind: "NETWORK" });
    vi.mocked(razorpay.cancelScheduledChanges).mockRejectedValueOnce(timeout);

    await expect(BillingMutationService.undoScheduledProviderChange(scheduled.id)).rejects.toBe(timeout);

    expect(razorpay.cancelScheduledChanges).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: scheduled.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        operationStatus: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "SCHEDULED_UNDO_OUTCOME_UNKNOWN",
        resolvedAt: null,
      });

    vi.mocked(razorpay.fetchSubscription).mockResolvedValueOnce({
      id: "sub_workspace",
      entity: "subscription",
      plan_id: "plan_standard",
      status: "active",
      total_count: 120,
      quantity: 1,
      has_scheduled_changes: false,
    });
    await expect(BillingMutationService.retry(scheduled.id))
      .resolves.toMatchObject({ id: scheduled.id, status: "UNDONE", operationStatus: "ABANDONED" });
    expect(razorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.cancelScheduledChanges).toHaveBeenCalledTimes(1);
  });

  it("reconciles a definitely rejected scheduled undo before its second provider mutation", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const scheduled = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "PLAN_DOWNGRADE",
      idempotencyKey: "undo-rejected-downgrade",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      effectiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByUserId: owner.id,
    });
    await BillingMutationService.processNext(organization.id);
    const rejected = new RazorpayApiError("scheduled undo was rejected", {
      kind: "REQUEST",
      status: 400,
    });
    vi.mocked(razorpay.cancelScheduledChanges).mockRejectedValueOnce(rejected);

    await expect(BillingMutationService.undoScheduledProviderChange(scheduled.id)).rejects.toBe(rejected);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: scheduled.id } }))
      .resolves.toMatchObject({
        status: "SCHEDULED",
        operationStatus: "SCHEDULED",
        failureCategory: "PROVIDER_REJECTED",
        failureCode: "SCHEDULED_UNDO_PROVIDER_REJECTED",
      });

    vi.mocked(razorpay.fetchSubscription).mockResolvedValueOnce({
      id: "sub_workspace",
      entity: "subscription",
      plan_id: "plan_standard",
      status: "active",
      total_count: 120,
      quantity: 1,
      has_scheduled_changes: true,
    });
    await expect(BillingMutationService.undoScheduledProviderChange(scheduled.id))
      .resolves.toMatchObject({ change: { id: scheduled.id, status: "UNDONE" } });

    expect(razorpay.fetchSubscription).toHaveBeenCalledTimes(1);
    expect(razorpay.cancelScheduledChanges).toHaveBeenCalledTimes(2);
    expect(vi.mocked(razorpay.fetchSubscription).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(razorpay.cancelScheduledChanges).mock.invocationCallOrder[1]!);
  });

  it("quarantines a malformed scheduled-change undo success response", async () => {
    const { owner, organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const scheduled = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      type: "PLAN_DOWNGRADE",
      idempotencyKey: "undo-malformed-downgrade",
      fromPlan: "PRO",
      toPlan: "BASIC",
      fromQuantity: 1,
      toQuantity: 1,
      effectiveAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByUserId: owner.id,
    });
    await BillingMutationService.processNext(organization.id);
    vi.mocked(razorpay.cancelScheduledChanges).mockResolvedValueOnce(null as never);

    await expect(BillingMutationService.undoScheduledProviderChange(scheduled.id))
      .rejects.toThrow("malformed subscription mutation response");

    expect(razorpay.cancelScheduledChanges).toHaveBeenCalledTimes(1);
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: scheduled.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "SCHEDULED_UNDO_OUTCOME_UNKNOWN",
      });
  });

  it("prioritizes unsupported-method cancellation over unresolved non-processing intent", async () => {
    const { organization, subscription } = await setup();
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    await testPrisma.organizationBillingChange.create({
      data: {
        organizationId: organization.id,
        organizationSubscriptionId: subscription.id,
        sequence: 2,
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
        sequence: 3,
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
    const razorpay = fakeRazorpay({ undoQuantity: 2 });
    setRazorpayClientForTests(razorpay);

    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: change.id, status: "SCHEDULED" });
    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ quantity: 2 });
    await expect(BranchService.undoBillingRemoval(owner.id, secondBranch.id))
      .resolves.toEqual({ undone: true });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "UNDONE", operationStatus: "ABANDONED" });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: secondBranch.id } }))
      .resolves.toMatchObject({ billingStatus: "ACTIVE" });
    expect(razorpay.cancelScheduledChanges).toHaveBeenCalledTimes(1);
  });

  it("quarantines a paid quantity increase backed only by an older paid invoice", async () => {
    const { owner, organization, subscription } = await setup();
    const paidThroughBefore = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await testPrisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { paidThrough: paidThroughBefore },
    });
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Unconfirmed branch", billingStatus: "PENDING_ACTIVATION" },
    });
    const razorpay = fakeRazorpay({
      paidAt: Math.floor(Date.now() / 1000) - 60 * 60,
      providerQuantity: 2,
    });
    setRazorpayClientForTests(razorpay);
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      idempotencyKey: "stale-invoice-quantity",
      type: "QUANTITY_INCREASE",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });
    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: change.id, status: "AWAITING_PAYMENT" });

    await expect(BillingReconciliationService.reconcileByOrganization(organization.id, {
      paymentId: "pay_paid",
    })).rejects.toBeInstanceOf(BillingManualReviewRequiredError);

    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ quantity: 1, paidThrough: paidThroughBefore });
    await expect(testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } }))
      .resolves.toMatchObject({ billingStatus: "PENDING_ACTIVATION" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({
        status: "FAILED",
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: "STALE_SETTLEMENT",
      });
    expect(razorpay.updateSubscription).toHaveBeenCalledTimes(1);
  });

  it("does not activate a pending branch until payment reconciliation", async () => {
    const { owner, organization, subscription } = await setup();
    const branch = await testPrisma.branch.create({
      data: { organizationId: organization.id, name: "Paid Branch", billingStatus: "PENDING_ACTIVATION" },
    });
    setRazorpayClientForTests(fakeRazorpay({ providerQuantity: 2 }));
    const change = await BillingMutationService.enqueue({
      organizationId: organization.id,
      subscriptionId: subscription.id,
      branchId: branch.id,
      idempotencyKey: "paid-branch",
      type: "QUANTITY_INCREASE",
      fromQuantity: 1,
      toQuantity: 2,
      createdByUserId: owner.id,
    });
    await expect(BillingMutationService.processNext(organization.id))
      .resolves.toMatchObject({ id: change.id, status: "AWAITING_PAYMENT" });

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
    const razorpay = fakeRazorpay({ providerPlanId: "plan_basic", providerQuantity: 1 });
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

    await BillingReconciliationService.reconcileByOrganization(organization.id, { paymentId: "pay_paid", now });

    await expect(testPrisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }))
      .resolves.toMatchObject({ plan: "BASIC", amount: 299, razorpayPlanId: "plan_basic" });
    await expect(testPrisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }))
      .resolves.toMatchObject({ status: "APPLIED" });
  });

  it("redeems one offer and records one paid period across duplicate reconciliation", async () => {
    const { organization, subscription, commercialIntent } = await setup();
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
    await testPrisma.organizationBillingChange.update({
      where: { id: commercialIntent.id },
      data: {
        authorizedRazorpayOfferId: "offer_launch",
        authorizedExpectedAmountSubunits: 39920,
        authorizedOfferValidThroughPaidCount: 3,
      },
    });
    setRazorpayClientForTests(fakeRazorpay({
      providerQuantity: 1,
      providerOfferId: "offer_launch",
      paymentAmountSubunits: 39920,
    }));

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
