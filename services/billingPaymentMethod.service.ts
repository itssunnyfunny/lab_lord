import { prisma } from "@/lib/prisma";
import { BillingMutationService } from "@/services/billingMutation.service";
import type { ProviderPaymentMethod } from "@/app/generated/prisma/client";

const UNSUPPORTED_METHOD_MESSAGE = "V1 recurring subscriptions require card authorization";
const OPEN_AUTHORIZATION_STATUSES = [
  "CHECKOUT_OPEN",
  "VERIFYING",
  "AWAITING_PROVIDER_CONFIRMATION",
] as const;

export function normalizeProviderPaymentMethod(
  value: string | ProviderPaymentMethod | null | undefined
): ProviderPaymentMethod {
  const normalized = value?.toLowerCase();
  if (normalized === "card") return "CARD";
  if (normalized === "upi") return "UPI";
  if (normalized === "emandate" || normalized === "netbanking") return "EMANDATE";
  return "UNKNOWN";
}
type EnforceCardOnlyInput = {
  organizationId: string;
  organizationSubscriptionId?: string | null;
  razorpaySubscriptionId?: string | null;
  paymentMethod: string | ProviderPaymentMethod | null | undefined;
  paymentId?: string | null;
  now?: Date;
};

/**
 * Persists an unsupported recurring-payment method before scheduling provider
 * cancellation. Provider calls remain in the durable, per-organization FIFO,
 * so a failed cancellation is visible and retryable instead of being lost in
 * a callback or webhook request.
 */
export class BillingPaymentMethodService {
  static async enforceCardOnly(input: EnforceCardOnlyInput) {
    const method = normalizeProviderPaymentMethod(input.paymentMethod);
    if (method === "CARD" || method === "UNKNOWN") {
      return { enforced: false as const, method };
    }

    const now = input.now ?? new Date();
    const stored = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE
      `;

      const subscription = await tx.organizationSubscription.findFirst({
        where: {
          organizationId: input.organizationId,
          ...(input.organizationSubscriptionId
            ? { id: input.organizationSubscriptionId }
            : input.razorpaySubscriptionId
              ? { razorpaySubscriptionId: input.razorpaySubscriptionId }
              : {}),
        },
      });
      if (!subscription) throw new Error("Subscription not found");
      if (input.razorpaySubscriptionId
        && subscription.razorpaySubscriptionId !== input.razorpaySubscriptionId) {
        throw new Error("Razorpay subscription does not belong to this organization");
      }

      const updatedSubscription = await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          providerPaymentMethod: method,
          lastReconciledAt: now,
        },
      });

      const authorization = await tx.organizationBillingChange.findFirst({
        where: {
          organizationId: input.organizationId,
          organizationSubscriptionId: subscription.id,
          type: "SUBSCRIPTION_AUTHORIZATION",
          operationStatus: { in: [...OPEN_AUTHORIZATION_STATUSES] },
        },
        orderBy: { sequence: "desc" },
      });
      if (authorization) {
        await tx.organizationBillingChange.updateMany({
          where: {
            id: authorization.id,
            operationStatus: { in: [...OPEN_AUTHORIZATION_STATUSES] },
          },
          data: {
            status: "FAILED",
            operationStatus: "DECLINED",
            providerPaymentId: input.paymentId ?? authorization.providerPaymentId,
            failureCategory: "UNSUPPORTED_PAYMENT_METHOD",
            failureCode: method,
            lastError: UNSUPPORTED_METHOD_MESSAGE,
            declinedAt: now,
            failedAt: now,
            resolvedAt: now,
          },
        });
      }

      return updatedSubscription;
    });

    const cancellation = await BillingMutationService.enqueue({
      organizationId: input.organizationId,
      subscriptionId: stored.id,
      idempotencyKey: `unsupported-method-cancellation:${stored.razorpaySubscriptionId}`,
      type: "UNSUPPORTED_METHOD_CANCELLATION",
      fromPlan: stored.plan,
      toPlan: stored.plan,
      fromQuantity: stored.quantity,
      toQuantity: stored.quantity,
      createdByUserId: null,
      operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
    });

    let cancellationError: string | null = null;
    if (cancellation.status === "QUEUED") {
      try {
        await BillingMutationService.processNext(input.organizationId, now);
      } catch (error) {
        cancellationError = error instanceof Error ? error.message : "Provider cancellation failed";
      }
    }

    return {
      enforced: true as const,
      method,
      subscriptionId: stored.id,
      cancellationChangeId: cancellation.id,
      cancellationError,
    };
  }
}
