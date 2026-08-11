import { prisma } from "@/lib/prisma";
import {
  getRazorpayClient,
  resolveRazorpayMode,
  type RazorpayInvoice,
  type RazorpayInvoices,
  type RazorpayPayment,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import {
  isSupportedProviderPaymentMethod,
  normalizeProviderPaymentMethod,
} from "@/services/billingPaymentMethod.service";
import type {
  OrganizationSubscription,
  SaasSubscriptionStatus,
} from "@/app/generated/prisma/client";

type BillingReconciliationResult = {
  subscription: OrganizationSubscription;
  confirmedPaidPeriod: boolean;
  payment: RazorpayPayment | null;
  invoices: RazorpayInvoices;
};

const SUBSCRIPTION_STATUSES = new Set([
  "CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "PAUSED",
  "CANCELLED", "COMPLETED", "EXPIRED",
]);

function status(value: string): SaasSubscriptionStatus {
  const normalized = value.toUpperCase();
  return (SUBSCRIPTION_STATUSES.has(normalized) ? normalized : "PENDING") as SaasSubscriptionStatus;
}

function date(value: number | null | undefined) {
  return value && value > 0 ? new Date(value * 1000) : null;
}

function invoiceBelongsToCurrentPeriod(
  subscription: RazorpaySubscription,
  invoice: RazorpayInvoice
) {
  const periodStart = subscription.current_start;
  if (!periodStart || invoice.subscription_id !== subscription.id) return false;
  const invoiceTimestamp = invoice.issued_at ?? invoice.paid_at;
  return Boolean(invoiceTimestamp && invoiceTimestamp >= periodStart);
}

function hasConfirmedPaidPeriod(
  subscription: RazorpaySubscription,
  payment: RazorpayPayment | null,
  invoice: RazorpayInvoice | null,
  now: Date
) {
  const periodStart = date(subscription.current_start);
  const periodEnd = date(subscription.current_end);
  const captured = payment?.status === "captured" && payment.captured !== false;
  return Boolean(
    periodStart && periodEnd && periodStart <= now && periodEnd > now && periodEnd > periodStart
    && invoice
    && invoice.status === "paid"
    && invoiceBelongsToCurrentPeriod(subscription, invoice)
    && captured
    && payment?.subscription_id === subscription.id
    && payment.invoice_id === invoice.id
    && invoice.payment_id === payment.id
  );
}

export class BillingReconciliationService {
  static async reconcileByOrganization(
    organizationId: string,
    options: { paymentId?: string | null; now?: Date } = {}
  ) {
    const local = await prisma.organizationSubscription.findUnique({
      where: { currentOrganizationId: organizationId },
    });
    if (!local) throw new Error("Subscription not found");
    return this.reconcileProviderSubscription(local.razorpaySubscriptionId, options);
  }

  static async reconcileProviderSubscription(
    razorpaySubscriptionId: string,
    options: { paymentId?: string | null; now?: Date } = {},
    staleRetry = 0
  ): Promise<BillingReconciliationResult> {
    const now = options.now ?? new Date();
    const localBeforeFetch = await prisma.organizationSubscription.findUnique({
      where: { razorpaySubscriptionId },
    });
    if (!localBeforeFetch) throw new Error("Subscription not found");
    const providerMode = resolveRazorpayMode();
    if (localBeforeFetch.providerMode !== providerMode) {
      throw new Error(
        `Subscription provider mode ${localBeforeFetch.providerMode} cannot be reconciled in ${providerMode} mode`
      );
    }
    const razorpay = getRazorpayClient();
    const [providerSubscription, invoices, explicitPayment] = await Promise.all([
      razorpay.fetchSubscription(razorpaySubscriptionId),
      razorpay.fetchSubscriptionInvoices(razorpaySubscriptionId),
      options.paymentId ? razorpay.fetchPayment(options.paymentId) : Promise.resolve(null),
    ]);
    if (providerSubscription.id !== razorpaySubscriptionId) {
      throw new Error("Razorpay subscription response mismatch during reconciliation");
    }
    if (explicitPayment && explicitPayment.subscription_id !== razorpaySubscriptionId) {
      throw new Error("Razorpay payment does not belong to this subscription");
    }
    const explicitPaidInvoice = explicitPayment?.invoice_id
      ? invoices.items.find(invoice =>
          invoice.id === explicitPayment.invoice_id
          && invoice.status === "paid"
          && invoiceBelongsToCurrentPeriod(providerSubscription, invoice)
        ) ?? null
      : null;
    const paidInvoice = explicitPaidInvoice ?? [...invoices.items]
      .filter(invoice =>
        invoice.status === "paid"
        && invoice.payment_id
        && invoiceBelongsToCurrentPeriod(providerSubscription, invoice)
      )
      .sort((a, b) => (b.paid_at ?? 0) - (a.paid_at ?? 0))[0] ?? null;
    const confirmedPayment = explicitPayment
      ?? (paidInvoice?.payment_id ? await razorpay.fetchPayment(paidInvoice.payment_id) : null);
    const confirmedMethod = normalizeProviderPaymentMethod(confirmedPayment?.method);
    const providerSubscriptionMethod = normalizeProviderPaymentMethod(
      providerSubscription.payment_method
    );
    const confirmedPaidPeriod = isSupportedProviderPaymentMethod(confirmedMethod)
      && hasConfirmedPaidPeriod(
      providerSubscription,
      confirmedPayment,
      paidInvoice,
      now
      );

    const reconciliation = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${localBeforeFetch.organizationId} FOR UPDATE
      `;
      const local = await tx.organizationSubscription.findUnique({
        where: { razorpaySubscriptionId },
      });
      if (!local) throw new Error("Subscription not found");
      if (local.updatedAt.getTime() !== localBeforeFetch.updatedAt.getTime()) {
        return { stale: true as const };
      }

      const linkedReplacementChange = local.pendingReplacementOrganizationId
        ? await tx.organizationBillingChange.findUnique({
            where: { replacementSubscriptionId: local.id },
          })
        : null;
      const providerPlan = await tx.saasRazorpayPlan.findFirst({
        where: {
          razorpayPlanId: providerSubscription.plan_id,
          providerMode,
        },
      });
      const unrecognizedReplacementPlan = providerSubscription.plan_id !== local.razorpayPlanId
        && !providerPlan
        && linkedReplacementChange != null;
      if (providerSubscription.plan_id !== local.razorpayPlanId
        && !providerPlan
        && !linkedReplacementChange) {
        throw new Error("Razorpay subscription references an unrecognized plan in this provider mode");
      }
      const linkedSourceReplacementChange = linkedReplacementChange
        ? null
        : await tx.organizationBillingChange.findFirst({
            where: {
              organizationSubscriptionId: local.id,
              replacementSubscriptionId: { not: null },
              status: { in: ["AWAITING_PAYMENT", "SCHEDULED", "FAILED"] },
            },
            orderBy: { sequence: "desc" },
          });
      const providerQuantity = providerSubscription.quantity ?? local.quantity;
      const replacementTargetMismatch = Boolean(
        linkedReplacementChange
        && (
          unrecognizedReplacementPlan
          ||
          providerSubscription.plan_id !== local.razorpayPlanId
          || providerQuantity !== (linkedReplacementChange.toQuantity ?? local.quantity)
          || (linkedReplacementChange.toPlan != null
            && providerPlan?.plan != null
            && linkedReplacementChange.toPlan !== providerPlan.plan)
        )
      );
      if (replacementTargetMismatch && linkedReplacementChange) {
        await tx.organizationBillingChange.update({
          where: { id: linkedReplacementChange.id },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            lastError: "Razorpay replacement no longer matches the authorized plan and quantity",
            failedAt: now,
            accessRevokedAt: linkedReplacementChange.accessGrantedAt
              && !linkedReplacementChange.accessRevokedAt
              ? now
              : undefined,
          },
        });
        if (linkedReplacementChange.accessGrantedAt
          && !linkedReplacementChange.accessRevokedAt
          && linkedReplacementChange.branchId) {
          if (linkedReplacementChange.type === "QUANTITY_INCREASE") {
            await tx.branch.updateMany({
              where: { id: linkedReplacementChange.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
            });
          }
          if (linkedReplacementChange.type === "BRANCH_REACTIVATION") {
            await tx.branch.updateMany({
              where: { id: linkedReplacementChange.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
          }
        }
      }
      const pendingAuthorization = await tx.organizationBillingChange.findFirst({
        where: {
          organizationId: local.organizationId,
          organizationSubscriptionId: local.id,
          type: "SUBSCRIPTION_AUTHORIZATION",
          operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
        },
        orderBy: { sequence: "desc" },
      });
      if (pendingAuthorization && (
        providerSubscription.plan_id !== local.razorpayPlanId
        || (pendingAuthorization.toPlan != null && pendingAuthorization.toPlan !== local.plan)
        || (pendingAuthorization.toQuantity != null
          && (providerSubscription.quantity ?? 1) !== pendingAuthorization.toQuantity)
      )) {
        throw new Error("Razorpay authorization does not match the expected plan and branch quantity");
      }
      const pendingChange = confirmedPaidPeriod
        ? await tx.organizationBillingChange.findFirst({
            where: {
              organizationId: local.organizationId,
              organizationSubscriptionId: local.id,
              replacementSubscriptionId: null,
              status: { in: ["AWAITING_PAYMENT", "SCHEDULED"] },
            },
            orderBy: { sequence: "asc" },
          })
        : null;
      const paidInvoiceAt = date(paidInvoice?.paid_at);
      const changeSubmittedAt = pendingChange?.processingStartedAt ?? pendingChange?.createdAt ?? null;
      const requiresFreshMutationPayment = Boolean(
        pendingChange
        && ["PLAN_UPGRADE", "PLAN_DOWNGRADE", "QUANTITY_INCREASE", "BRANCH_REMOVAL", "BRANCH_REACTIVATION"]
          .includes(pendingChange.type)
      );
      const freshMutationPaymentConfirmed = !requiresFreshMutationPayment || Boolean(
        paidInvoice
        && paidInvoiceAt
        && changeSubmittedAt
        && confirmedPayment?.status === "captured"
        && confirmedPayment.invoice_id === paidInvoice.id
        && Math.floor(paidInvoiceAt.getTime() / 1000) >= Math.floor(changeSubmittedAt.getTime() / 1000)
      );
      const providerMatchesChange = Boolean(
        pendingChange
        && freshMutationPaymentConfirmed
        && (!pendingChange.toPlan || pendingChange.toPlan === providerPlan?.plan)
        && (!pendingChange.toQuantity || pendingChange.toQuantity === providerSubscription.quantity)
        && (!pendingChange.effectiveAt || pendingChange.effectiveAt <= now)
      );
      const confirmedPlanChange = providerMatchesChange && pendingChange?.toPlan
        ? providerPlan
        : null;

      for (const invoice of invoices.items) {
        await tx.organizationSubscriptionInvoice.upsert({
          where: { razorpayInvoiceId: invoice.id },
          create: {
            organizationId: local.organizationId,
            organizationSubscriptionId: local.id,
            razorpayInvoiceId: invoice.id,
            razorpayPaymentId: invoice.payment_id ?? null,
            status: invoice.status,
            amountSubunits: invoice.amount,
            amountPaidSubunits: invoice.amount_paid,
            amountDueSubunits: invoice.amount_due,
            currency: invoice.currency,
            paymentMethod: invoice.payment_id === confirmedPayment?.id
              ? confirmedMethod
              : "UNKNOWN",
            periodStart: date(providerSubscription.current_start),
            periodEnd: date(providerSubscription.current_end),
            issuedAt: date(invoice.issued_at),
            paidAt: date(invoice.paid_at),
          },
          update: {
            razorpayPaymentId: invoice.payment_id ?? undefined,
            status: invoice.status,
            amountPaidSubunits: invoice.amount_paid,
            amountDueSubunits: invoice.amount_due,
            paidAt: date(invoice.paid_at),
            paymentMethod: invoice.payment_id === confirmedPayment?.id
              ? confirmedMethod
              : undefined,
          },
        });
      }

      const providerPaidThrough = confirmedPaidPeriod ? date(providerSubscription.current_end) : null;
      const paidThrough = providerPaidThrough
        && (!local.paidThrough || providerPaidThrough > local.paidThrough)
        ? providerPaidThrough
        : local.paidThrough;
      const providerSubscriptionStatus = status(providerSubscription.status);
      const providerScheduledAt = date(providerSubscription.change_scheduled_at);
      const sourceCancellationConfirmed = Boolean(
        linkedSourceReplacementChange?.effectiveAt
        && providerSubscription.has_scheduled_changes === true
        && providerScheduledAt
        && providerScheduledAt.getTime() === linkedSourceReplacementChange.effectiveAt.getTime()
      );
      const futureAuthorizationQuantitySynchronized = local.paidThrough == null
        && providerSubscriptionStatus === "AUTHENTICATED";
      const confirmedQuantity = providerQuantity === local.quantity
        || linkedReplacementChange != null
        || futureAuthorizationQuantitySynchronized
        || (confirmedPaidPeriod && (!pendingChange || providerMatchesChange))
        ? providerQuantity
        : local.quantity;
      const stored = await tx.organizationSubscription.update({
        where: { id: local.id },
        data: {
          plan: confirmedPlanChange?.plan,
          amount: confirmedPlanChange?.amount,
          amountSubunits: confirmedPlanChange?.amountSubunits,
          currency: confirmedPlanChange?.currency,
          period: confirmedPlanChange?.period,
          interval: confirmedPlanChange?.interval,
          razorpayPlanId: linkedReplacementChange
            ? providerSubscription.plan_id
            : confirmedPlanChange?.razorpayPlanId,
          ...(linkedReplacementChange && providerPlan
            ? {
                plan: providerPlan.plan,
                amount: providerPlan.amount,
                amountSubunits: providerPlan.amountSubunits,
                currency: providerPlan.currency,
                period: providerPlan.period,
                interval: providerPlan.interval,
              }
            : {}),
          status: providerSubscriptionStatus,
          quantity: confirmedQuantity,
          providerStartAt: date(providerSubscription.start_at),
          authorizationExpiresAt: date(providerSubscription.expire_by),
          providerPaymentMethod: isSupportedProviderPaymentMethod(confirmedMethod)
            ? confirmedMethod
            : isSupportedProviderPaymentMethod(providerSubscriptionMethod)
              ? providerSubscriptionMethod
              : local.providerPaymentMethod,
          currentStart: date(providerSubscription.current_start),
          currentEnd: date(providerSubscription.current_end),
          chargeAt: date(providerSubscription.charge_at),
          endedAt: date(providerSubscription.ended_at),
          cancelAtCycleEnd: sourceCancellationConfirmed ? true : undefined,
          cancellationRequestedAt: sourceCancellationConfirmed
            ? local.cancellationRequestedAt ?? now
            : undefined,
          cancellationScheduledAt: sourceCancellationConfirmed
            ? providerScheduledAt
            : undefined,
          paidThrough,
          lastConfirmedInvoiceId: confirmedPaidPeriod ? paidInvoice?.id ?? local.lastConfirmedInvoiceId : undefined,
          lastConfirmedPaymentId: confirmedPaidPeriod ? confirmedPayment?.id ?? local.lastConfirmedPaymentId : undefined,
          lastPaymentConfirmedAt: confirmedPaidPeriod ? now : undefined,
          lastReconciledAt: now,
        },
      });

      if (confirmedPaidPeriod && paidThrough) {
        const paymentDedupeId = paidInvoice?.id ?? confirmedPayment?.id ?? paidThrough.toISOString();
        await tx.organizationSubscriptionHistory.upsert({
          where: { dedupeKey: `paid:${local.razorpaySubscriptionId}:${paymentDedupeId}` },
          create: {
            organizationId: local.organizationId,
            organizationSubscriptionId: local.id,
            razorpaySubscriptionId: local.razorpaySubscriptionId,
            razorpayPaymentId: confirmedPayment?.id ?? null,
            plan: stored.plan,
            fromStatus: local.status,
            toStatus: stored.status,
            source: "WEBHOOK",
            event: "provider_paid_period_confirmed",
            amountSubunits: stored.amountSubunits,
            quantity: stored.quantity,
            unitAmountSubunits: stored.amountSubunits,
            totalAmountSubunits: stored.amountSubunits * stored.quantity,
            paidThrough,
            dedupeKey: `paid:${local.razorpaySubscriptionId}:${paymentDedupeId}`,
            currency: stored.currency,
          },
          update: {
            paidThrough,
            quantity: stored.quantity,
            totalAmountSubunits: stored.amountSubunits * stored.quantity,
          },
        });
        if (local.billingOfferId) {
          await tx.organizationOfferGrant.updateMany({
            where: {
              organizationId: local.organizationId,
              billingOfferId: local.billingOfferId,
              status: "RESERVED",
              billingOffer: { providerMode },
            },
            data: { status: "REDEEMED", redeemedAt: now },
          });
        }
        if (pendingChange && providerMatchesChange) {
          if (pendingChange.branchId && ["QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(pendingChange.type)) {
            await tx.branch.update({
              where: { id: pendingChange.branchId },
              data: { billingStatus: "ACTIVE", billingActivatedAt: now, billingArchivedAt: null },
            });
          }
          if (pendingChange.branchId && pendingChange.type === "BRANCH_REMOVAL") {
            await tx.branch.update({
              where: { id: pendingChange.branchId },
              data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
          }
          await tx.organizationBillingChange.update({
            where: { id: pendingChange.id },
            data: {
              status: "APPLIED",
              operationStatus: "APPLIED",
              providerInvoiceId: paidInvoice?.id ?? null,
              providerPaymentId: confirmedPayment?.id ?? null,
              providerConfirmedAt: now,
              resolvedAt: now,
              appliedAt: now,
            },
          });
        }
      }

      return {
        stale: false as const,
        subscription: stored,
        confirmedPaidPeriod,
        payment: confirmedPayment,
        invoices,
      };
    });

    if (reconciliation.stale) {
      if (staleRetry >= 2) {
        throw new Error("Subscription changed repeatedly while provider reconciliation was in flight");
      }
      return this.reconcileProviderSubscription(razorpaySubscriptionId, options, staleRetry + 1);
    }
    const { stale: _stale, ...result } = reconciliation;
    return result;
  }
}
