import { prisma } from "@/lib/prisma";
import { BILLING_PLANS, getActiveBillingPlan, getBillingPlan, publicBillingPlans, type BillingPlan } from "@/lib/billingPlans";
import {
  getRazorpayClient,
  getRazorpayKeyId,
  sha256Hex,
  toRazorpaySubunits,
  verifyRazorpaySubscriptionSignature,
  verifyRazorpayWebhookSignature,
  type RazorpayPayment,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import { OrganizationService } from "@/services/organization.service";
import type { OrganizationSubscription, Prisma } from "@/app/generated/prisma/client";
import type { SaasPlan, SaasSubscriptionStatus } from "@/types";

type CheckoutInput = {
  plan: string;
};

type VerifySubscriptionInput = {
  razorpay_subscription_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
};

type WebhookProcessingResult = {
  event: string;
  duplicate?: boolean;
  organizationId?: string | null;
  organizationSubscriptionId?: string | null;
  razorpayPaymentId?: string | null;
  razorpaySubscriptionId?: string | null;
};

const TERMINAL_STATUSES = new Set<SaasSubscriptionStatus>(["CANCELLED", "COMPLETED", "EXPIRED"]);
const CHECKOUT_REUSABLE_STATUSES = new Set<SaasSubscriptionStatus>(["CREATED"]);
const VALID_STATUSES = new Set<SaasSubscriptionStatus>([
  "CREATED",
  "AUTHENTICATED",
  "ACTIVE",
  "PENDING",
  "HALTED",
  "CANCELLED",
  "COMPLETED",
  "EXPIRED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUniqueConstraintError(error: unknown) {
  return isRecord(error) && error.code === "P2002";
}

function mapSubscriptionStatus(status: string | null | undefined): SaasSubscriptionStatus {
  const normalized = (status || "pending").trim().toUpperCase();
  return VALID_STATUSES.has(normalized as SaasSubscriptionStatus)
    ? normalized as SaasSubscriptionStatus
    : "PENDING";
}

function resolveWebhookStatus(
  current: SaasSubscriptionStatus,
  incoming: SaasSubscriptionStatus
): SaasSubscriptionStatus {
  if (TERMINAL_STATUSES.has(current)) return current;
  if (TERMINAL_STATUSES.has(incoming)) return incoming;
  if (incoming === "CREATED") return current;
  if (incoming === "AUTHENTICATED" && current !== "CREATED") return current;
  if (current === "HALTED" && incoming === "PENDING") return current;
  return incoming;
}

function timestampToDate(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

function assertRazorpayId(value: unknown, prefix: "sub" | "pay") {
  if (typeof value !== "string") throw new Error(`Missing Razorpay ${prefix} id`);
  const trimmed = value.trim();
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(trimmed)) {
    throw new Error(`Invalid Razorpay ${prefix} id`);
  }
  return trimmed;
}

function getSubscriptionCycles() {
  const raw = process.env.RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES;
  if (raw == null || raw.trim() === "") return 120;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1200) {
    throw new Error("RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES must be an integer from 1 to 1200");
  }
  return parsed;
}

function subscriptionSnapshotData(subscription: RazorpaySubscription) {
  const data: Prisma.OrganizationSubscriptionUpdateInput = {
    status: mapSubscriptionStatus(subscription.status),
    razorpayCustomerId: subscription.customer_id ?? null,
  };

  const currentStart = timestampToDate(subscription.current_start);
  const currentEnd = timestampToDate(subscription.current_end);
  const chargeAt = timestampToDate(subscription.charge_at);
  const endedAt = timestampToDate(subscription.ended_at);

  if (currentStart !== undefined) data.currentStart = currentStart;
  if (currentEnd !== undefined) data.currentEnd = currentEnd;
  if (chargeAt !== undefined) data.chargeAt = chargeAt;
  if (endedAt !== undefined) data.endedAt = endedAt;

  return data;
}

function serializeSubscription(subscription: OrganizationSubscription | null | undefined) {
  if (!subscription) return null;
  const plan = getBillingPlan(subscription.plan);
  return {
    id: subscription.id,
    organizationId: subscription.organizationId,
    plan: subscription.plan,
    planName: plan?.name ?? subscription.plan,
    shortName: plan?.shortName ?? subscription.plan,
    amount: subscription.amount,
    amountSubunits: subscription.amountSubunits,
    currency: subscription.currency,
    period: subscription.period,
    interval: subscription.interval,
    totalCount: subscription.totalCount,
    status: subscription.status,
    razorpaySubscriptionId: subscription.razorpaySubscriptionId,
    currentStart: subscription.currentStart,
    currentEnd: subscription.currentEnd,
    chargeAt: subscription.chargeAt,
    endedAt: subscription.endedAt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function isSuccessfulPayment(payment: RazorpayPayment | null) {
  if (!payment) return true;
  return payment.status === "captured" || payment.status === "authorized";
}

function getWebhookEntity<T extends Record<string, unknown>>(payload: unknown, key: string): T | null {
  if (!isRecord(payload)) return null;
  const wrapper = payload[key];
  if (!isRecord(wrapper)) return null;
  const entity = wrapper.entity;
  return isRecord(entity) ? entity as T : null;
}

export class BillingService {
  static serializeSubscription = serializeSubscription;

  static async listPlansForOrganization(userId: string, organizationId: string) {
    await OrganizationService.getOrganizationForOwner(organizationId, userId);
    const subscription = await prisma.organizationSubscription.findUnique({
      where: { organizationId },
    });

    return {
      plans: publicBillingPlans(),
      current: serializeSubscription(subscription),
    };
  }

  static async createSubscriptionCheckout(userId: string, organizationId: string, input: CheckoutInput) {
    const selectedPlan = getActiveBillingPlan(input.plan);
    const org = await OrganizationService.getOrganizationForOwner(organizationId, userId);
    const razorpayPlan = await this.ensureRazorpayPlan(selectedPlan);
    const razorpay = getRazorpayClient();
    let createdGatewaySubscriptionId: string | null = null;
    let subscription: OrganizationSubscription;

    try {
      subscription = await prisma.$transaction(async tx => {
        const lockedOrganizations = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "Organization"
          WHERE "id" = ${organizationId}
          FOR UPDATE
        `;
        if (lockedOrganizations.length === 0) throw new Error("Organization not found");

        const existing = await tx.organizationSubscription.findUnique({
          where: { organizationId },
        });

        if (existing) {
          if (existing.plan === selectedPlan.id && CHECKOUT_REUSABLE_STATUSES.has(existing.status)) {
            return existing;
          }

          if (!TERMINAL_STATUSES.has(existing.status)) {
            if (existing.plan === selectedPlan.id) {
              throw new Error(`This organization already has a ${existing.status.toLowerCase()} ${selectedPlan.shortName} subscription`);
            }
            throw new Error("Cancel or complete the current subscription before changing plans");
          }
        }

        const totalCount = getSubscriptionCycles();
        const gatewaySubscription = await razorpay.createSubscription({
          plan_id: razorpayPlan.razorpayPlanId,
          total_count: totalCount,
          quantity: 1,
          customer_notify: true,
          notes: {
            app: "lab_lords",
            billing_type: "saas_subscription",
            organization_id: organizationId,
            plan: selectedPlan.id,
          },
        });
        createdGatewaySubscriptionId = gatewaySubscription.id;

        const recordData = {
          organizationId,
          plan: selectedPlan.id as SaasPlan,
          amount: selectedPlan.amount ?? 0,
          amountSubunits: toRazorpaySubunits(selectedPlan.amount ?? 0, selectedPlan.currency),
          currency: selectedPlan.currency,
          period: selectedPlan.period,
          interval: selectedPlan.interval,
          totalCount,
          razorpayPlanId: razorpayPlan.razorpayPlanId,
          razorpaySubscriptionId: gatewaySubscription.id,
          razorpayCustomerId: gatewaySubscription.customer_id ?? null,
          status: mapSubscriptionStatus(gatewaySubscription.status),
          currentStart: timestampToDate(gatewaySubscription.current_start) ?? null,
          currentEnd: timestampToDate(gatewaySubscription.current_end) ?? null,
          chargeAt: timestampToDate(gatewaySubscription.charge_at) ?? null,
          endedAt: timestampToDate(gatewaySubscription.ended_at) ?? null,
          createdByUserId: userId,
        };

        return existing
          ? tx.organizationSubscription.update({
            where: { organizationId },
            data: recordData,
          })
          : tx.organizationSubscription.create({
            data: recordData,
          });
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (createdGatewaySubscriptionId) {
        try {
          await razorpay.cancelSubscription(createdGatewaySubscriptionId, {
            cancel_at_cycle_end: false,
          });
        } catch (compensationError) {
          console.error("[SAAS_SUBSCRIPTION_COMPENSATION_FAILED]", {
            organizationId,
            razorpaySubscriptionId: createdGatewaySubscriptionId,
            error: compensationError,
          });
        }
      }
      throw error;
    }

    return this.toCheckoutPayload(org, subscription, selectedPlan);
  }

  static async verifySubscriptionSuccess(
    userId: string,
    organizationId: string,
    input: VerifySubscriptionInput
  ) {
    await OrganizationService.getOrganizationForOwner(organizationId, userId);
    const subscriptionId = assertRazorpayId(input.razorpay_subscription_id, "sub");
    const paymentId = assertRazorpayId(input.razorpay_payment_id, "pay");
    if (typeof input.razorpay_signature !== "string" || !input.razorpay_signature.trim()) {
      throw new Error("Missing Razorpay signature");
    }

    const isVerified = verifyRazorpaySubscriptionSignature({
      subscriptionId,
      paymentId,
      signature: input.razorpay_signature,
    });
    if (!isVerified) throw new Error("Invalid Razorpay signature");

    const subscription = await prisma.organizationSubscription.findFirst({
      where: { organizationId, razorpaySubscriptionId: subscriptionId },
    });
    if (!subscription) throw new Error("Subscription does not belong to this organization");

    const [gatewaySubscription, gatewayPayment] = await Promise.all([
      getRazorpayClient().fetchSubscription(subscriptionId),
      getRazorpayClient().fetchPayment(paymentId),
    ]);

    if (gatewaySubscription.plan_id !== subscription.razorpayPlanId) {
      throw new Error("Razorpay subscription plan mismatch");
    }
    if (!isSuccessfulPayment(gatewayPayment)) {
      throw new Error("Razorpay payment has not been authorized");
    }

    const snapshot = subscriptionSnapshotData(gatewaySubscription);
    if (snapshot.status === "CREATED") {
      snapshot.status = "AUTHENTICATED";
    }

    const updated = await prisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: {
        ...snapshot,
        authPaymentId: paymentId,
      },
    });

    return {
      verified: true,
      subscription: serializeSubscription(updated),
    };
  }

  static async handleRazorpayWebhook(rawBody: string, signature: string | null, eventId: string | null) {
    if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
      throw new Error("Invalid Razorpay webhook signature");
    }

    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const event = typeof parsed.event === "string" && parsed.event.trim() ? parsed.event : "unknown";
    const payloadHash = sha256Hex(rawBody);
    const safeEventId = eventId?.trim() || `evt_${payloadHash}`;

    try {
      await prisma.razorpayWebhookEvent.create({
        data: {
          eventId: safeEventId,
          event,
          payloadHash,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await prisma.razorpayWebhookEvent.findUnique({ where: { eventId: safeEventId } });
      if (!existing) throw error;
      if (existing.payloadHash !== payloadHash) {
        throw new Error("Razorpay webhook event id collision");
      }
    }

    try {
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "RazorpayWebhookEvent"
          WHERE "eventId" = ${safeEventId}
          FOR UPDATE
        `;
        const webhookEvent = await tx.razorpayWebhookEvent.findUnique({
          where: { eventId: safeEventId },
        });
        if (!webhookEvent) throw new Error("Razorpay webhook event disappeared");
        if (webhookEvent.payloadHash !== payloadHash) {
          throw new Error("Razorpay webhook event id collision");
        }
        if (webhookEvent.processedAt) {
          return {
            ok: true,
            event: webhookEvent.event,
            duplicate: true,
            organizationId: webhookEvent.organizationId,
            organizationSubscriptionId: webhookEvent.organizationSubscriptionId,
            razorpayPaymentId: webhookEvent.razorpayPaymentId,
            razorpaySubscriptionId: webhookEvent.razorpaySubscriptionId,
          };
        }

        const result = await this.applyWebhookPayload(parsed, tx);
        await tx.razorpayWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            organizationId: result.organizationId ?? null,
            organizationSubscriptionId: result.organizationSubscriptionId ?? null,
            razorpayPaymentId: result.razorpayPaymentId ?? null,
            razorpaySubscriptionId: result.razorpaySubscriptionId ?? null,
            processedAt: new Date(),
            processingError: null,
          },
        });

        return {
          ok: true,
          ...result,
        };
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      try {
        await prisma.razorpayWebhookEvent.updateMany({
          where: {
            eventId: safeEventId,
            payloadHash,
            processedAt: null,
          },
          data: {
            processedAt: null,
            processingError: error instanceof Error ? error.message : "Webhook processing failed",
          },
        });
      } catch (recordingError) {
        console.error("[RAZORPAY_WEBHOOK_ERROR_RECORDING_FAILED]", recordingError);
      }
      throw error;
    }
  }

  private static async ensureRazorpayPlan(plan: BillingPlan) {
    const amountSubunits = toRazorpaySubunits(plan.amount ?? 0, plan.currency);
    const existing = await prisma.saasRazorpayPlan.findUnique({
      where: { plan: plan.id as SaasPlan },
    });

    if (existing) {
      if (
        existing.amount !== plan.amount ||
        existing.amountSubunits !== amountSubunits ||
        existing.currency !== plan.currency ||
        existing.period !== plan.period ||
        existing.interval !== plan.interval
      ) {
        throw new Error(`Stored Razorpay plan for ${plan.shortName} does not match the billing catalog`);
      }
      return existing;
    }

    const gatewayPlan = await getRazorpayClient().createPlan({
      period: plan.period,
      interval: plan.interval,
      item: {
        name: plan.name,
        amount: amountSubunits,
        currency: plan.currency,
        description: plan.description,
      },
      notes: {
        app: "lab_lords",
        billing_type: "saas_plan",
        plan: plan.id,
      },
    });

    try {
      return await prisma.saasRazorpayPlan.create({
        data: {
          plan: plan.id as SaasPlan,
          amount: plan.amount ?? 0,
          amountSubunits,
          currency: plan.currency,
          period: plan.period,
          interval: plan.interval,
          razorpayPlanId: gatewayPlan.id,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await prisma.saasRazorpayPlan.findUnique({
        where: { plan: plan.id as SaasPlan },
      });
      if (!raced) throw error;
      return raced;
    }
  }

  private static toCheckoutPayload(
    org: Awaited<ReturnType<typeof OrganizationService.getOrganizationForOwner>>,
    subscription: OrganizationSubscription,
    plan: BillingPlan
  ) {
    return {
      keyId: getRazorpayKeyId(),
      type: "subscription" as const,
      subscriptionId: subscription.razorpaySubscriptionId,
      amount: subscription.amountSubunits,
      currency: subscription.currency,
      name: "Lab Lords",
      description: `${plan.name} - ${plan.amount ? `Rs.${plan.amount}/month` : "custom"}`,
      plan: {
        id: plan.id,
        name: plan.name,
        shortName: plan.shortName,
        amount: plan.amount,
        currency: plan.currency,
        period: plan.period,
      },
      prefill: {
        name: org.legalName || org.name,
        email: org.contactEmail || org.owner?.email || undefined,
        contact: org.contactPhone || undefined,
      },
      notes: {
        app: "lab_lords",
        billing_type: "saas_subscription",
        organization_id: org.id,
        plan: plan.id,
      },
      subscription: serializeSubscription(subscription),
    };
  }

  private static async applyWebhookPayload(
    payload: Record<string, unknown>,
    tx: Prisma.TransactionClient
  ): Promise<WebhookProcessingResult> {
    const event = typeof payload.event === "string" ? payload.event : "unknown";
    const payloadRoot = isRecord(payload.payload) ? payload.payload : {};
    const subscriptionEntity = getWebhookEntity<RazorpaySubscription>(payloadRoot, "subscription");
    const paymentEntity = getWebhookEntity<RazorpayPayment>(payloadRoot, "payment");
    const subscriptionId = subscriptionEntity?.id ?? paymentEntity?.subscription_id ?? null;
    const paymentId = paymentEntity?.id ?? null;

    if (!subscriptionId) {
      return {
        event,
        razorpayPaymentId: paymentId,
        razorpaySubscriptionId: null,
      };
    }

    const subscription = await tx.organizationSubscription.findUnique({
      where: { razorpaySubscriptionId: subscriptionId },
    });

    if (!subscription) {
      return {
        event,
        razorpayPaymentId: paymentId,
        razorpaySubscriptionId: subscriptionId,
      };
    }

    const updateData: Prisma.OrganizationSubscriptionUpdateInput = {};
    if (subscriptionEntity) {
      const snapshot = subscriptionSnapshotData(subscriptionEntity);
      snapshot.status = resolveWebhookStatus(
        subscription.status as SaasSubscriptionStatus,
        mapSubscriptionStatus(subscriptionEntity.status)
      );
      Object.assign(updateData, snapshot);
    }

    if (paymentId && (event === "subscription.charged" || event === "payment.captured" || !subscription.authPaymentId)) {
      updateData.authPaymentId = paymentId;
    }

    if (Object.keys(updateData).length > 0) {
      await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: updateData,
      });
    }

    return {
      event,
      organizationId: subscription.organizationId,
      organizationSubscriptionId: subscription.id,
      razorpayPaymentId: paymentId,
      razorpaySubscriptionId: subscriptionId,
    };
  }

  static getPublicPlans() {
    return BILLING_PLANS;
  }
}
