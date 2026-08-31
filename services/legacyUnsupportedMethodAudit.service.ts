import { prisma } from "@/lib/prisma";
import { getRazorpayClient, resolveRazorpayMode, type RazorpaySubscription } from "@/lib/razorpay";
import {
  isSupportedProviderPaymentMethod,
  normalizeProviderPaymentMethod,
} from "@/services/billingPaymentMethod.service";
import type { ProviderPaymentMethod } from "@/app/generated/prisma/client";

export type LegacyCancellationAuditDisposition = "SUPERSEDE" | "KEEP" | "MANUAL_REVIEW";

export function legacyUnsupportedMethodCancellationDisposition(input: {
  expectedProviderSubscriptionId: string;
  localPaymentMethod: ProviderPaymentMethod;
  providerSubscription: RazorpaySubscription;
}): LegacyCancellationAuditDisposition {
  if (input.providerSubscription.id !== input.expectedProviderSubscriptionId) {
    return "MANUAL_REVIEW";
  }
  const status = input.providerSubscription.status.trim().toLowerCase();
  if (["cancelled", "completed", "expired"].includes(status)) return "KEEP";
  if (!["authenticated", "active", "pending", "paused", "halted"].includes(status)) {
    return "MANUAL_REVIEW";
  }
  const providerMethod = normalizeProviderPaymentMethod(input.providerSubscription.payment_method);
  const confirmedMethod = isSupportedProviderPaymentMethod(providerMethod)
    ? providerMethod
    : input.localPaymentMethod;
  return isSupportedProviderPaymentMethod(confirmedMethod) ? "SUPERSEDE" : "MANUAL_REVIEW";
}

export class LegacyUnsupportedMethodAuditService {
  static async run(options: { apply: boolean; organizationIds?: readonly string[] }) {
    const providerMode = resolveRazorpayMode();
    const changes = await prisma.organizationBillingChange.findMany({
      where: {
        ...(options.organizationIds
          ? { organizationId: { in: [...options.organizationIds] } }
          : {}),
        type: "UNSUPPORTED_METHOD_CANCELLATION",
        status: { in: ["QUEUED", "FAILED"] },
      },
      include: { organizationSubscription: true },
      orderBy: [{ organizationId: "asc" }, { sequence: "asc" }],
    });
    const rows: Array<{
      changeId: string;
      organizationId: string;
      providerSubscriptionId: string | null;
      disposition: LegacyCancellationAuditDisposition;
      applied: boolean;
      error?: string;
    }> = [];

    for (const change of changes) {
      const subscription = change.organizationSubscription;
      if (!subscription || subscription.providerMode !== providerMode) {
        rows.push({
          changeId: change.id,
          organizationId: change.organizationId,
          providerSubscriptionId: subscription?.razorpaySubscriptionId ?? null,
          disposition: "MANUAL_REVIEW",
          applied: false,
          error: subscription ? "Provider mode mismatch" : "Subscription record missing",
        });
        continue;
      }
      try {
        const providerSubscription = await getRazorpayClient().fetchSubscription(
          subscription.razorpaySubscriptionId
        );
        const disposition = legacyUnsupportedMethodCancellationDisposition({
          expectedProviderSubscriptionId: subscription.razorpaySubscriptionId,
          localPaymentMethod: subscription.providerPaymentMethod,
          providerSubscription,
        });
        let applied = false;
        if (options.apply && disposition === "SUPERSEDE") {
          const now = new Date();
          const update = await prisma.organizationBillingChange.updateMany({
            where: { id: change.id, status: { in: ["QUEUED", "FAILED"] } },
            data: {
              status: "SUPERSEDED",
              operationStatus: "ABANDONED",
              lastError: "Superseded after provider verification enabled this recurring payment method",
              resolvedAt: now,
              failedAt: null,
            },
          });
          applied = update.count === 1;
        }
        rows.push({
          changeId: change.id,
          organizationId: change.organizationId,
          providerSubscriptionId: subscription.razorpaySubscriptionId,
          disposition,
          applied,
        });
      } catch (error) {
        rows.push({
          changeId: change.id,
          organizationId: change.organizationId,
          providerSubscriptionId: subscription.razorpaySubscriptionId,
          disposition: "MANUAL_REVIEW",
          applied: false,
          error: error instanceof Error ? error.message : "Provider verification failed",
        });
      }
    }
    return { apply: options.apply, providerMode, count: rows.length, rows };
  }
}
