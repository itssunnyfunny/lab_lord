import { prisma } from "@/lib/prisma";
import {
  getRazorpayClient,
  type RazorpayPayment,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import type { ProviderPaymentMethod, SaasSubscriptionStatus } from "@/app/generated/prisma/client";

const SUBSCRIPTION_STATUSES = new Set([
  "CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "CANCELLED", "COMPLETED", "EXPIRED",
]);

function status(value: string): SaasSubscriptionStatus {
  const normalized = value.toUpperCase();
  return (SUBSCRIPTION_STATUSES.has(normalized) ? normalized : "PENDING") as SaasSubscriptionStatus;
}

function paymentMethod(value: string | null | undefined): ProviderPaymentMethod {
  const normalized = value?.toLowerCase();
  if (normalized === "card") return "CARD";
  if (normalized === "upi") return "UPI";
  if (normalized === "emandate" || normalized === "netbanking") return "EMANDATE";
  return "UNKNOWN";
}

function date(value: number | null | undefined) {
  return value && value > 0 ? new Date(value * 1000) : null;
}

function hasConfirmedPaidPeriod(
  subscription: RazorpaySubscription,
  payment: RazorpayPayment | null,
  invoicePaid: boolean,
  now: Date
) {
  const periodStart = date(subscription.current_start);
  const periodEnd = date(subscription.current_end);
  const captured = payment?.status === "captured" && payment.captured !== false;
  return Boolean(
    periodStart && periodEnd && periodStart <= now && periodEnd > periodStart
    && (invoicePaid || (captured && payment?.invoice_id))
  );
}

export class BillingReconciliationService {
  static async reconcileByOrganization(
    organizationId: string,
    options: { paymentId?: string | null; now?: Date } = {}
  ) {
    const local = await prisma.organizationSubscription.findUnique({ where: { organizationId } });
    if (!local) throw new Error("Subscription not found");
    return this.reconcileProviderSubscription(local.razorpaySubscriptionId, options);
  }

  static async reconcileProviderSubscription(
    razorpaySubscriptionId: string,
    options: { paymentId?: string | null; now?: Date } = {}
  ) {
    const now = options.now ?? new Date();
    const razorpay = getRazorpayClient();
    const [providerSubscription, invoices, explicitPayment] = await Promise.all([
      razorpay.fetchSubscription(razorpaySubscriptionId),
      razorpay.fetchSubscriptionInvoices(razorpaySubscriptionId),
      options.paymentId ? razorpay.fetchPayment(options.paymentId) : Promise.resolve(null),
    ]);
    const paidInvoice = [...invoices.items]
      .filter(invoice => invoice.status === "paid" && invoice.payment_id)
      .sort((a, b) => (b.paid_at ?? 0) - (a.paid_at ?? 0))[0] ?? null;
    const confirmedPayment = explicitPayment
      ?? (paidInvoice?.payment_id ? await razorpay.fetchPayment(paidInvoice.payment_id) : null);
    const confirmedPaidPeriod = hasConfirmedPaidPeriod(
      providerSubscription,
      confirmedPayment,
      Boolean(paidInvoice),
      now
    );
    const confirmedMethod = paymentMethod(confirmedPayment?.method);

    return prisma.$transaction(async tx => {
      const local = await tx.organizationSubscription.findUnique({
        where: { razorpaySubscriptionId },
      });
      if (!local) throw new Error("Subscription not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${local.organizationId} FOR UPDATE
      `;

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

      const paidThrough = confirmedPaidPeriod ? date(providerSubscription.current_end) : local.paidThrough;
      const stored = await tx.organizationSubscription.update({
        where: { id: local.id },
        data: {
          status: status(providerSubscription.status),
          quantity: providerSubscription.quantity ?? local.quantity,
          providerStartAt: date(providerSubscription.start_at),
          authorizationExpiresAt: date(providerSubscription.expire_by),
          providerPaymentMethod: confirmedPayment
            ? paymentMethod(confirmedPayment.method)
            : paymentMethod(providerSubscription.payment_method) === "UNKNOWN"
              ? local.providerPaymentMethod
              : paymentMethod(providerSubscription.payment_method),
          currentStart: date(providerSubscription.current_start),
          currentEnd: date(providerSubscription.current_end),
          chargeAt: date(providerSubscription.charge_at),
          endedAt: date(providerSubscription.ended_at),
          paidThrough,
          lastConfirmedInvoiceId: confirmedPaidPeriod ? paidInvoice?.id ?? local.lastConfirmedInvoiceId : undefined,
          lastConfirmedPaymentId: confirmedPaidPeriod ? confirmedPayment?.id ?? local.lastConfirmedPaymentId : undefined,
          lastPaymentConfirmedAt: confirmedPaidPeriod ? now : undefined,
          lastReconciledAt: now,
        },
      });

      if (confirmedPaidPeriod) {
        const change = await tx.organizationBillingChange.findFirst({
          where: { organizationId: local.organizationId, status: "AWAITING_PAYMENT" },
          orderBy: { sequence: "asc" },
        });
        if (change) {
          if (change.branchId && ["QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(change.type)) {
            await tx.branch.update({
              where: { id: change.branchId },
              data: { billingStatus: "ACTIVE", billingActivatedAt: now, billingArchivedAt: null },
            });
          }
          await tx.organizationBillingChange.update({
            where: { id: change.id },
            data: {
              status: "APPLIED",
              providerInvoiceId: paidInvoice?.id ?? null,
              providerPaymentId: confirmedPayment?.id ?? null,
              appliedAt: now,
            },
          });
        }
      }

      return { subscription: stored, confirmedPaidPeriod, payment: confirmedPayment, invoices };
    });
  }
}
