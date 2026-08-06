import { prisma } from "@/lib/prisma";
import crypto from "node:crypto";
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
import { EntitlementService } from "@/services/entitlement.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { BillingMutationService } from "@/services/billingMutation.service";
import { BillingExperienceService } from "@/services/billingExperience.service";
import type { OrganizationSubscription, OrganizationSubscriptionHistory, Prisma } from "@/app/generated/prisma/client";
import type { SaasPlan, SaasSubscriptionHistorySource, SaasSubscriptionStatus } from "@/types";

type CheckoutInput = {
  plan: string;
  returnPath?: unknown;
};

type VerifySubscriptionInput = {
  changeId?: unknown;
  razorpay_subscription_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
};

type CheckoutEventInput = {
  event?: unknown;
  failureCategory?: unknown;
  failureCode?: unknown;
  reason?: unknown;
  source?: unknown;
  step?: unknown;
  paymentId?: unknown;
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
const ACTIVE_AUTHORIZATION_OPERATION_STATUSES = [
  "CHECKOUT_OPEN",
  "VERIFYING",
  "AWAITING_PROVIDER_CONFIRMATION",
] as const;
const PROVIDER_CONFIRMED_OPERATION_STATUSES = ["APPLIED", "SCHEDULED"] as const;
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
function razorpayTestMode() {
  return getRazorpayKeyId().startsWith("rzp_test_");
}

function cardOnlyCheckoutConfig() {
  return {
    display: {
      blocks: {
        cards: {
          name: "Pay with card",
          instruments: [{ method: "card" as const }],
        },
      },
      sequence: ["block.cards"],
      preferences: { show_default_blocks: false },
    },
  };
}

function normalizeRazorpayContact(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return undefined;
}

function formatCheckoutDate(value: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(value);
}

function offerGrantIsEligibleAt(grant: {
  eligibleFrom: Date | null;
  eligibleUntil: Date | null;
  billingOffer: {
    active: boolean;
    validFrom: Date | null;
    validUntil: Date | null;
  };
}, now: Date) {
  return grant.billingOffer.active
    && (!grant.billingOffer.validFrom || grant.billingOffer.validFrom <= now)
    && (!grant.billingOffer.validUntil || grant.billingOffer.validUntil > now)
    && (!grant.eligibleFrom || grant.eligibleFrom <= now)
    && (!grant.eligibleUntil || grant.eligibleUntil > now);
}

function sanitizedCheckoutToken(value: unknown, maxLength = 100) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
  return normalized || null;
}

function normalizedFailureCategory(input: CheckoutEventInput, event: string) {
  if (event === "DECLINED") return "CUSTOMER_OR_ISSUER_DECLINED";
  if (event === "ABANDONED") return "CHECKOUT_ABANDONED";
  if (event === "AWAITING_PROVIDER_CONFIRMATION") return "PROVIDER_CONFIRMATION_PENDING";

  const explicit = sanitizedCheckoutToken(input.failureCategory);
  const source = sanitizedCheckoutToken(input.source)?.toLowerCase() ?? "";
  const reason = (sanitizedCheckoutToken(input.reason) ?? explicit)?.toLowerCase() ?? "";
  if (source.includes("bank") || source.includes("issuer")) return "BANK_OR_ISSUER_ERROR";
  if (source.includes("network") || reason.includes("network")) return "NETWORK_ERROR";
  if (source.includes("gateway") || source.includes("razorpay")) return "PAYMENT_PROVIDER_ERROR";
  if (explicit) return explicit.toUpperCase().replace(/[ .-]+/g, "_");
  return "CHECKOUT_ERROR";
}

function normalizedFailureCode(input: CheckoutEventInput) {
  const details = [
    sanitizedCheckoutToken(input.failureCode, 40),
    sanitizedCheckoutToken(input.source, 24),
    sanitizedCheckoutToken(input.step, 24),
    sanitizedCheckoutToken(input.reason, 40),
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? details.join("|").slice(0, 100) : null;
}

function checkoutPaymentId(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^pay_[A-Za-z0-9]+$/.test(trimmed) ? trimmed : null;
}

function isProviderConfirmedOperationStatus(status: string) {
  return PROVIDER_CONFIRMED_OPERATION_STATUSES.includes(
    status as (typeof PROVIDER_CONFIRMED_OPERATION_STATUSES)[number]
  );
}

async function enqueueAuthorizationOperation(input: {
  organizationId: string;
  subscriptionId: string;
  expectedProviderSubscriptionId: string;
  idempotencyPrefix: "subscription-authorization" | "payment-recovery";
  fromPlan: SaasPlan | null;
  toPlan: SaasPlan;
  fromQuantity: number | null;
  toQuantity: number;
  createdByUserId: string;
  returnPath: string;
  now: Date;
}) {
  return prisma.$transaction(async tx => {
    const lockedOrganizations = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Organization"
      WHERE "id" = ${input.organizationId}
      FOR UPDATE
    `;
    if (lockedOrganizations.length === 0) throw new Error("Organization not found");

    const currentSubscription = await tx.organizationSubscription.findUnique({
      where: { id: input.subscriptionId },
    });
    if (
      !currentSubscription
      || currentSubscription.organizationId !== input.organizationId
      || currentSubscription.razorpaySubscriptionId !== input.expectedProviderSubscriptionId
    ) {
      throw new Error("This checkout was superseded by a newer billing request; reload billing and try again");
    }

    const active = await tx.organizationBillingChange.findFirst({
      where: {
        organizationId: input.organizationId,
        type: "SUBSCRIPTION_AUTHORIZATION",
        operationStatus: { in: [...ACTIVE_AUTHORIZATION_OPERATION_STATUSES] },
        organizationSubscriptionId: input.subscriptionId,
        toPlan: input.toPlan,
        toQuantity: input.toQuantity,
      },
      orderBy: { sequence: "desc" },
    });
    if (active) {
      // Clean up any historical duplicate active rows while preserving the
      // single operation that this request can safely reuse.
      await tx.organizationBillingChange.updateMany({
        where: {
          organizationId: input.organizationId,
          type: "SUBSCRIPTION_AUTHORIZATION",
          id: { not: active.id },
          operationStatus: { in: [...ACTIVE_AUTHORIZATION_OPERATION_STATUSES] },
        },
        data: {
          status: "SUPERSEDED",
          operationStatus: "ABANDONED",
          lastError: "Superseded by the current subscription authorization request",
          resolvedAt: input.now,
        },
      });
      return active;
    }

    await tx.organizationBillingChange.updateMany({
      where: {
        organizationId: input.organizationId,
        type: "SUBSCRIPTION_AUTHORIZATION",
        operationStatus: { in: [...ACTIVE_AUTHORIZATION_OPERATION_STATUSES] },
      },
      data: {
        status: "SUPERSEDED",
        operationStatus: "ABANDONED",
        lastError: "Superseded by a newer subscription authorization request",
        resolvedAt: input.now,
      },
    });

    const organization = await tx.organization.update({
      where: { id: input.organizationId },
      data: { billingMutationSequence: { increment: 1 } },
      select: { billingMutationSequence: true },
    });
    return tx.organizationBillingChange.create({
      data: {
        organizationId: input.organizationId,
        organizationSubscriptionId: input.subscriptionId,
        sequence: organization.billingMutationSequence,
        idempotencyKey: `${input.idempotencyPrefix}:${input.organizationId}:${input.expectedProviderSubscriptionId}:${crypto.randomUUID()}`,
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: "AWAITING_PAYMENT",
        operationStatus: "CHECKOUT_OPEN",
        fromPlan: input.fromPlan,
        toPlan: input.toPlan,
        fromQuantity: input.fromQuantity,
        toQuantity: input.toQuantity,
        createdByUserId: input.createdByUserId,
        returnPath: input.returnPath,
        checkoutOpenedAt: input.now,
        confirmationDeadlineAt: new Date(input.now.getTime() + 15 * 60 * 1000),
      },
    });
  });
}

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
  const providerStartAt = timestampToDate(subscription.start_at);
  const authorizationExpiresAt = timestampToDate(subscription.expire_by);

  if (currentStart !== undefined) data.currentStart = currentStart;
  if (currentEnd !== undefined) data.currentEnd = currentEnd;
  if (chargeAt !== undefined) data.chargeAt = chargeAt;
  if (endedAt !== undefined) data.endedAt = endedAt;
  if (providerStartAt !== undefined) data.providerStartAt = providerStartAt;
  if (authorizationExpiresAt !== undefined) data.authorizationExpiresAt = authorizationExpiresAt;
  if (typeof subscription.quantity === "number" && subscription.quantity > 0) {
    data.quantity = subscription.quantity;
  }

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
    quantity: subscription.quantity,
    unitAmount: subscription.amount,
    monthlyTotal: subscription.amount * subscription.quantity,
    status: subscription.status,
    razorpaySubscriptionId: subscription.razorpaySubscriptionId,
    currentStart: subscription.currentStart,
    currentEnd: subscription.currentEnd,
    chargeAt: subscription.chargeAt,
    endedAt: subscription.endedAt,
    providerStartAt: subscription.providerStartAt,
    authorizationExpiresAt: subscription.authorizationExpiresAt,
    providerPaymentMethod: subscription.providerPaymentMethod,
    paidThrough: subscription.paidThrough,
    cancelAtCycleEnd: subscription.cancelAtCycleEnd,
    cancellationRequestedAt: subscription.cancellationRequestedAt,
    cancellationScheduledAt: subscription.cancellationScheduledAt,
    cancelledAt: subscription.cancelledAt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function getSafeReturnPath(value: unknown, organizationId: string) {
  if (typeof value !== "string") return `/org/${encodeURIComponent(organizationId)}/settings#billing`;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return `/org/${encodeURIComponent(organizationId)}/settings#billing`;
  }
  return path;
}

function serializeBillingOperation(change: {
  id: string;
  organizationId: string;
  type: string;
  status: string;
  operationStatus: string;
  returnPath: string | null;
  confirmationDeadlineAt: Date | null;
  failureCategory: string | null;
  failureCode: string | null;
  providerPaymentId: string | null;
  lastError: string | null;
  effectiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: change.id,
    organizationId: change.organizationId,
    type: change.type,
    queueStatus: change.status,
    operationStatus: change.operationStatus,
    returnPath: change.returnPath,
    confirmationDeadlineAt: change.confirmationDeadlineAt,
    failureCategory: change.failureCategory,
    failureCode: change.failureCode,
    providerPaymentId: change.providerPaymentId,
    message: change.lastError,
    effectiveAt: change.effectiveAt,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
  };
}

function serializeHistoryEntry(entry: OrganizationSubscriptionHistory) {
  return {
    id: entry.id,
    razorpaySubscriptionId: entry.razorpaySubscriptionId,
    razorpayPaymentId: entry.razorpayPaymentId,
    plan: entry.plan,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    source: entry.source,
    event: entry.event,
    amountSubunits: entry.amountSubunits,
    currency: entry.currency,
    createdAt: entry.createdAt,
  };
}

async function recordSubscriptionHistory(
  tx: Prisma.TransactionClient,
  subscription: OrganizationSubscription,
  input: {
    source: SaasSubscriptionHistorySource;
    fromStatus?: SaasSubscriptionStatus | null;
    event?: string | null;
    razorpayPaymentId?: string | null;
  }
) {
  const dedupeKey = `${input.source}:${subscription.razorpaySubscriptionId}:${input.event ?? "state"}:${input.razorpayPaymentId ?? subscription.status}`;
  return tx.organizationSubscriptionHistory.upsert({
    where: { dedupeKey },
    create: {
      organizationId: subscription.organizationId,
      organizationSubscriptionId: subscription.id,
      razorpaySubscriptionId: subscription.razorpaySubscriptionId,
      razorpayPaymentId: input.razorpayPaymentId ?? null,
      plan: subscription.plan,
      fromStatus: input.fromStatus ?? null,
      toStatus: subscription.status,
      source: input.source,
      event: input.event ?? null,
      amountSubunits: subscription.amountSubunits,
      quantity: subscription.quantity,
      unitAmountSubunits: subscription.amountSubunits,
      totalAmountSubunits: subscription.amountSubunits * subscription.quantity,
      paidThrough: subscription.paidThrough,
      dedupeKey,
      currency: subscription.currency,
    },
    update: {},
  });
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
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const [subscription, history, entitlements, invoices, scheduledChanges, ownerTrialGrant, offerGrant, experience] = await Promise.all([
      prisma.organizationSubscription.findUnique({ where: { organizationId } }),
      prisma.organizationSubscriptionHistory.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      EntitlementService.getOrganizationProfile(organizationId),
      prisma.organizationSubscriptionInvoice.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.organizationBillingChange.findMany({
        where: { organizationId, status: { in: ["QUEUED", "PROCESSING", "AWAITING_PAYMENT", "SCHEDULED", "FAILED"] } },
        orderBy: { sequence: "asc" },
      }),
      prisma.ownerTrialGrant.findUnique({ where: { ownerId: userId } }),
      prisma.organizationOfferGrant.findFirst({
        where: { organizationId, status: { in: ["ELIGIBLE", "RESERVED"] } },
        include: { billingOffer: true },
        orderBy: { billingOffer: { priority: "desc" } },
      }),
      BillingExperienceService.getBillingExperience(organizationId, userId),
    ]);

    const organizationTrial = organization.ownerTrialGrant;
    const ownerTrialClaimable = ownerTrialGrant?.status === "AVAILABLE"
      && !subscription
      && history.length === 0;

    return {
      billingModelVersion: organization.billingModelVersion,
      razorpayTestMode: razorpayTestMode(),
      plans: publicBillingPlans(),
      current: serializeSubscription(subscription),
      history: history.map(serializeHistoryEntry),
      entitlements,
      trial: organizationTrial
        ? {
            status: organizationTrial.status,
            source: organizationTrial.source,
            organizationId: organizationTrial.organizationId,
            startedAt: organizationTrial.trialStartedAt,
            endsAt: organizationTrial.trialEndsAt,
          }
        : null,
      ownerTrialEligibility: ownerTrialGrant
        ? {
            status: ownerTrialGrant.status,
            claimable: ownerTrialClaimable,
            boundOrganizationId: ownerTrialGrant.organizationId,
          }
        : null,
      paymentMethod: subscription?.providerPaymentMethod ?? null,
      invoices,
      scheduledChanges,
      offer: offerGrant?.billingOffer ?? null,
      experience,
    };
  }

  static async createSubscriptionCheckout(userId: string, organizationId: string, input: CheckoutInput) {
    const selectedPlan = getActiveBillingPlan(input.plan);
    const org = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    await prisma.organization.update({
      where: { id: organizationId },
      data: { selectedPostTrialPlan: selectedPlan.id as SaasPlan },
    });
    const workspaceBilling = org.billingModelVersion === "WORKSPACE_V2";
    const quantity = workspaceBilling
      ? await prisma.branch.count({
          where: { organizationId, billingStatus: { not: "ARCHIVED" } },
        })
      : 1;
    if (quantity < 1) throw new Error("At least one billable branch is required");
    const now = new Date();
    const trialEndsAt = workspaceBilling
      && org.ownerTrialGrant?.status === "ACTIVE"
      && org.ownerTrialGrant.trialEndsAt
      && org.ownerTrialGrant.trialEndsAt > now
        ? org.ownerTrialGrant.trialEndsAt
        : null;
    const returnPath = getSafeReturnPath(input.returnPath, organizationId);
    const openAuthorization = await prisma.organizationBillingChange.findFirst({
      where: {
        organizationId,
        type: "SUBSCRIPTION_AUTHORIZATION",
        operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
        toQuantity: quantity,
        organizationSubscription: {
          plan: selectedPlan.id as SaasPlan,
          quantity,
          status: { in: ["CREATED", "AUTHENTICATED"] },
        },
      },
      include: { organizationSubscription: true },
      orderBy: { sequence: "desc" },
    });
    if (openAuthorization?.organizationSubscription) {
      return this.toCheckoutPayload(org, openAuthorization.organizationSubscription, selectedPlan, openAuthorization);
    }
    const reservedOfferGrant = workspaceBilling && org.subscription?.status === "CREATED"
      ? await prisma.organizationOfferGrant.findFirst({
          where: {
            organizationId,
            status: "RESERVED",
            subscriptionId: org.subscription.razorpaySubscriptionId,
            OR: [{ eligibleFrom: null }, { eligibleFrom: { lte: now } }],
            AND: [{ OR: [{ eligibleUntil: null }, { eligibleUntil: { gt: now } }] }],
            billingOffer: {
              active: true,
              plan: selectedPlan.id as SaasPlan,
              OR: [{ validFrom: null }, { validFrom: { lte: now } }],
              AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
            },
          },
          include: { billingOffer: true },
          orderBy: { billingOffer: { priority: "desc" } },
        })
      : null;
    const offerGrant = reservedOfferGrant ?? (workspaceBilling
      ? await prisma.organizationOfferGrant.findFirst({
          where: {
            organizationId,
            status: "ELIGIBLE",
            OR: [{ eligibleFrom: null }, { eligibleFrom: { lte: now } }],
            AND: [{ OR: [{ eligibleUntil: null }, { eligibleUntil: { gt: now } }] }],
            billingOffer: {
              active: true,
              plan: selectedPlan.id as SaasPlan,
              OR: [{ validFrom: null }, { validFrom: { lte: now } }],
              AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
            },
          },
          include: { billingOffer: true },
          orderBy: { billingOffer: { priority: "desc" } },
        })
      : null);
    const razorpayPlan = await this.ensureRazorpayPlan(selectedPlan);
    const razorpay = getRazorpayClient();
    let createdGatewaySubscriptionId: string | null = null;
    const supersededSubscription = { current: null as OrganizationSubscription | null };
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
          if (
            existing.plan === selectedPlan.id
            && existing.quantity === quantity
            && CHECKOUT_REUSABLE_STATUSES.has(existing.status)
          ) {
            return existing;
          }

          if (existing.status === "CREATED") {
            const cancelledGatewaySubscription = await razorpay.cancelSubscription(
              existing.razorpaySubscriptionId,
              { cancel_at_cycle_end: false }
            );
            if (cancelledGatewaySubscription.id !== existing.razorpaySubscriptionId) {
              throw new Error("Razorpay subscription mismatch while replacing checkout");
            }
            const supersededAt = new Date();
            await tx.organizationBillingChange.updateMany({
              where: {
                organizationId,
                organizationSubscriptionId: existing.id,
                type: "SUBSCRIPTION_AUTHORIZATION",
                operationStatus: { in: [...ACTIVE_AUTHORIZATION_OPERATION_STATUSES] },
              },
              data: {
                status: "SUPERSEDED",
                operationStatus: "ABANDONED",
                lastError: "Superseded by a newer plan authorization request",
                resolvedAt: supersededAt,
              },
            });
            const previousReservedGrant = await tx.organizationOfferGrant.findFirst({
              where: {
                organizationId,
                status: "RESERVED",
                subscriptionId: existing.razorpaySubscriptionId,
              },
              include: { billingOffer: true },
            });
            if (previousReservedGrant && previousReservedGrant.id !== offerGrant?.id) {
              await tx.organizationOfferGrant.update({
                where: { id: previousReservedGrant.id },
                data: {
                  status: offerGrantIsEligibleAt(previousReservedGrant, now) ? "ELIGIBLE" : "EXPIRED",
                  reservedAt: null,
                  subscriptionId: null,
                },
              });
            }
            supersededSubscription.current = existing;
          } else if (!TERMINAL_STATUSES.has(existing.status)) {
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
          quantity,
          customer_notify: true,
          start_at: trialEndsAt ? Math.floor(trialEndsAt.getTime() / 1000) : undefined,
          offer_id: offerGrant?.billingOffer.razorpayOfferId,
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
          quantity,
          razorpayPlanId: razorpayPlan.razorpayPlanId,
          razorpaySubscriptionId: gatewaySubscription.id,
          razorpayCustomerId: gatewaySubscription.customer_id ?? null,
          status: mapSubscriptionStatus(gatewaySubscription.status),
          providerStartAt: timestampToDate(gatewaySubscription.start_at) ?? trialEndsAt,
          authorizationExpiresAt: timestampToDate(gatewaySubscription.expire_by) ?? null,
          providerPaymentMethod: "UNKNOWN" as const,
          billingOfferId: offerGrant?.billingOfferId ?? null,
          currentStart: timestampToDate(gatewaySubscription.current_start) ?? null,
          currentEnd: timestampToDate(gatewaySubscription.current_end) ?? null,
          chargeAt: timestampToDate(gatewaySubscription.charge_at) ?? null,
          endedAt: timestampToDate(gatewaySubscription.ended_at) ?? null,
          cancelAtCycleEnd: false,
          cancellationRequestedAt: null,
          cancellationScheduledAt: null,
          cancelledAt: null,
          createdByUserId: userId,
        };

        const stored = await (existing
          ? tx.organizationSubscription.update({
            where: { organizationId },
            data: recordData,
          })
          : tx.organizationSubscription.create({
            data: recordData,
          }));
        if (supersededSubscription.current) {
          await tx.organizationSubscriptionHistory.create({
            data: {
              organizationId,
              organizationSubscriptionId: stored.id,
              razorpaySubscriptionId: supersededSubscription.current.razorpaySubscriptionId,
              plan: supersededSubscription.current.plan,
              fromStatus: supersededSubscription.current.status,
              toStatus: "CANCELLED",
              source: "SYSTEM",
              event: "checkout_replaced",
              amountSubunits: supersededSubscription.current.amountSubunits,
              currency: supersededSubscription.current.currency,
            },
          });
        }
        await recordSubscriptionHistory(tx, stored, {
          source: "CHECKOUT",
          fromStatus: existing?.status ?? null,
        });
        if (offerGrant) {
          await tx.organizationOfferGrant.update({
            where: { id: offerGrant.id },
            data: {
              status: "RESERVED",
              reservedAt: new Date(),
              subscriptionId: gatewaySubscription.id,
            },
          });
        }
        return stored;
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
      const replacedSubscription = supersededSubscription.current;
      if (replacedSubscription) {
        try {
          await prisma.$transaction(async tx => {
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "Organization"
              WHERE "id" = ${organizationId}
              FOR UPDATE
            `;
            const current = await tx.organizationSubscription.findUnique({
              where: { id: replacedSubscription.id },
            });
            const reservedGrant = await tx.organizationOfferGrant.findFirst({
              where: {
                organizationId,
                status: "RESERVED",
                subscriptionId: replacedSubscription.razorpaySubscriptionId,
              },
              include: { billingOffer: true },
            });
            const compensationAt = new Date();
            if (reservedGrant) {
              await tx.organizationOfferGrant.update({
                where: { id: reservedGrant.id },
                data: {
                  status: offerGrantIsEligibleAt(reservedGrant, compensationAt) ? "ELIGIBLE" : "EXPIRED",
                  reservedAt: null,
                  subscriptionId: null,
                },
              });
            }
            if (
              !current
              || current.status !== "CREATED"
              || current.razorpaySubscriptionId !== replacedSubscription.razorpaySubscriptionId
            ) return;

            const cancelledAt = compensationAt;
            const stored = await tx.organizationSubscription.update({
              where: { id: current.id },
              data: {
                status: "CANCELLED",
                cancelAtCycleEnd: false,
                cancelledAt,
                endedAt: cancelledAt,
              },
            });
            await recordSubscriptionHistory(tx, stored, {
              source: "SYSTEM",
              fromStatus: current.status,
              event: "checkout_replacement_failed",
            });
          });
        } catch (reconciliationError) {
          console.error("[SAAS_SUBSCRIPTION_REPLACEMENT_RECONCILIATION_FAILED]", {
            organizationId,
            razorpaySubscriptionId: replacedSubscription.razorpaySubscriptionId,
            error: reconciliationError,
          });
        }
      }
      throw error;
    }

    const operation = await enqueueAuthorizationOperation({
      organizationId,
      subscriptionId: subscription.id,
      expectedProviderSubscriptionId: subscription.razorpaySubscriptionId,
      idempotencyPrefix: "subscription-authorization",
      fromPlan: org.subscription?.plan ?? null,
      toPlan: selectedPlan.id as SaasPlan,
      fromQuantity: org.subscription?.quantity ?? null,
      toQuantity: quantity,
      createdByUserId: userId,
      returnPath,
      now,
    });

    return this.toCheckoutPayload(org, subscription, selectedPlan, operation);
  }

  static async verifySubscriptionSuccess(
    userId: string,
    organizationId: string,
    input: VerifySubscriptionInput
  ) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    if (typeof input.changeId !== "string" || !input.changeId.trim()) {
      throw new Error("Missing billing change id");
    }
    const change = await prisma.organizationBillingChange.findFirst({
      where: {
        id: input.changeId.trim(),
        organizationId,
        type: "SUBSCRIPTION_AUTHORIZATION",
      },
    });
    if (!change) throw new Error("Billing operation not found");
    if (isProviderConfirmedOperationStatus(change.operationStatus)) {
      const current = await prisma.organizationSubscription.findUnique({ where: { organizationId } });
      if (!current) throw new Error("Subscription not found");
      return {
        verified: true as const,
        operation: serializeBillingOperation(change),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(current),
      };
    }
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
    const recoveryConfirmation = ["PENDING", "HALTED"].includes(subscription.status);
    if (change.organizationSubscriptionId !== subscription.id) {
      throw new Error("Billing operation subscription mismatch");
    }
    if (change.toPlan && change.toPlan !== subscription.plan) {
      throw new Error("Billing operation plan mismatch");
    }
    if (change.toQuantity && change.toQuantity !== subscription.quantity) {
      throw new Error("Billing operation quantity mismatch");
    }

    const verificationClaim = await prisma.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        operationStatus: {
          notIn: [...PROVIDER_CONFIRMED_OPERATION_STATUSES, "VERIFYING"],
        },
      },
      data: {
        operationStatus: "VERIFYING",
        verificationStartedAt: new Date(),
        failureCategory: null,
        failureCode: null,
        lastError: null,
      },
    });
    if (verificationClaim.count === 0) {
      const [currentOperation, currentSubscription] = await Promise.all([
        prisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }),
        prisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      ]);
      const providerConfirmed = isProviderConfirmedOperationStatus(currentOperation.operationStatus);
      return {
        verified: providerConfirmed,
        ...(providerConfirmed ? {} : { pending: true as const }),
        operation: serializeBillingOperation(currentOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(currentSubscription),
      };
    }

    let gatewaySubscription: RazorpaySubscription;
    let gatewayPayment: RazorpayPayment;
    try {
      [gatewaySubscription, gatewayPayment] = await Promise.all([
        getRazorpayClient().fetchSubscription(subscriptionId),
        getRazorpayClient().fetchPayment(paymentId),
      ]);
    } catch {
      await prisma.organizationBillingChange.updateMany({
        where: { id: change.id, operationStatus: "VERIFYING" },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          providerPaymentId: paymentId,
          failureCategory: "PROVIDER_CONFIRMATION_PENDING",
          failureCode: null,
          lastError: "Razorpay confirmation is delayed; the confirmed billing state is unchanged",
          resolvedAt: null,
        },
      });
      const [pendingOperation, currentSubscription] = await Promise.all([
        prisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }),
        prisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      ]);
      const providerConfirmed = isProviderConfirmedOperationStatus(pendingOperation.operationStatus);
      return {
        verified: providerConfirmed,
        ...(providerConfirmed ? {} : { pending: true as const }),
        operation: serializeBillingOperation(pendingOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(currentSubscription),
      };
    }

    if (gatewaySubscription.plan_id !== subscription.razorpayPlanId) {
      throw new Error("Razorpay subscription plan mismatch");
    }
    if (gatewayPayment.subscription_id && gatewayPayment.subscription_id !== subscriptionId) {
      throw new Error("Razorpay payment subscription mismatch");
    }
    if (!isSuccessfulPayment(gatewayPayment)) {
      throw new Error("Razorpay payment has not been authorized");
    }
    if (gatewayPayment.method !== "card") {
      await getRazorpayClient().cancelSubscription(subscriptionId, { cancel_at_cycle_end: false });
      await prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          providerPaymentMethod: gatewayPayment.method === "upi" ? "UPI" : "EMANDATE",
          status: "CANCELLED",
          cancelledAt: new Date(),
        },
      });
      await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: { notIn: [...PROVIDER_CONFIRMED_OPERATION_STATUSES] },
        },
        data: {
          status: "FAILED",
          operationStatus: "DECLINED",
          failureCategory: "UNSUPPORTED_PAYMENT_METHOD",
          failureCode: gatewayPayment.method,
          lastError: "V1 recurring subscriptions require card authorization",
          declinedAt: new Date(),
          resolvedAt: new Date(),
        },
      });
      throw new Error("V1 recurring subscriptions require card authorization");
    }

    const snapshot = subscriptionSnapshotData(gatewaySubscription);
    if (snapshot.status === "CREATED") {
      snapshot.status = "AUTHENTICATED";
    }

    const updated = await prisma.$transaction(async tx => {
      const stored = await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          ...snapshot,
          authPaymentId: paymentId,
          providerPaymentMethod: "CARD",
          lastReconciledAt: new Date(),
        },
      });
      await recordSubscriptionHistory(tx, stored, {
        source: "VERIFICATION",
        fromStatus: subscription.status,
        razorpayPaymentId: paymentId,
      });
      return stored;
    });

    if (gatewayPayment.status === "captured" && gatewayPayment.invoice_id) {
      await BillingReconciliationService.reconcileProviderSubscription(subscriptionId, { paymentId });
    }

    const reconciledSubscription = await prisma.organizationSubscription.findUnique({ where: { id: subscription.id } });
    const recoveryPaid = !recoveryConfirmation || Boolean(
      reconciledSubscription?.paidThrough
      && (!subscription.paidThrough || reconciledSubscription.paidThrough > subscription.paidThrough)
    );

    if (!recoveryPaid) {
      await prisma.organizationBillingChange.updateMany({
        where: { id: change.id, operationStatus: "VERIFYING" },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          providerPaymentId: paymentId,
          lastError: "Card update confirmed; awaiting captured renewal payment and paid-period confirmation",
        },
      });
      const awaitingOperation = await prisma.organizationBillingChange.findUniqueOrThrow({
        where: { id: change.id },
      });
      const providerConfirmed = isProviderConfirmedOperationStatus(awaitingOperation.operationStatus);
      return {
        verified: true as const,
        ...(providerConfirmed ? {} : { pending: true as const }),
        operation: serializeBillingOperation(awaitingOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(reconciledSubscription ?? updated),
      };
    }

    await prisma.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        operationStatus: { notIn: [...PROVIDER_CONFIRMED_OPERATION_STATUSES] },
      },
      data: {
        status: "APPLIED",
        operationStatus: "APPLIED",
        providerConfirmedAt: new Date(),
        appliedAt: new Date(),
        resolvedAt: new Date(),
        providerPaymentId: paymentId,
        lastError: null,
      },
    });
    const appliedOperation = await prisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: change.id },
    });

    return {
      verified: true,
      operation: serializeBillingOperation(appliedOperation),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
      subscription: serializeSubscription(reconciledSubscription ?? updated),
    };
  }

  static async cancelSubscription(
    userId: string,
    organizationId: string
  ) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);

    const razorpay = getRazorpayClient();
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Organization"
        WHERE "id" = ${organizationId}
        FOR UPDATE
      `;
      const subscription = await tx.organizationSubscription.findUnique({
        where: { organizationId },
      });
      if (!subscription) throw new Error("Subscription not found");
      if (TERMINAL_STATUSES.has(subscription.status)) {
        throw new Error("Subscription has already ended");
      }
      if (subscription.cancelAtCycleEnd) {
        return subscription;
      }
      if (subscription.status !== "ACTIVE") {
        throw new Error("Only an active subscription can be cancelled at the end of its billing cycle");
      }

      const gatewaySubscription = await razorpay.cancelSubscription(
        subscription.razorpaySubscriptionId,
        { cancel_at_cycle_end: true }
      );
      if (gatewaySubscription.id !== subscription.razorpaySubscriptionId) {
        throw new Error("Razorpay subscription mismatch during cancellation");
      }

      const snapshot = subscriptionSnapshotData(gatewaySubscription);
      const gatewayStatus = mapSubscriptionStatus(gatewaySubscription.status);
      const cancellationRequestedAt = new Date();
      const cancelledImmediately = TERMINAL_STATUSES.has(gatewayStatus);
      const stored = await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          ...snapshot,
          cancelAtCycleEnd: !cancelledImmediately,
          cancellationRequestedAt,
          cancellationScheduledAt:
            timestampToDate(gatewaySubscription.change_scheduled_at) ?? subscription.currentEnd,
          cancelledAt: cancelledImmediately
            ? timestampToDate(gatewaySubscription.ended_at) ?? cancellationRequestedAt
            : null,
        },
      });
      await recordSubscriptionHistory(tx, stored, {
        source: "CUSTOMER_CANCELLATION",
        fromStatus: subscription.status,
        event: "cancel_at_cycle_end",
      });
      return stored;
    }, { maxWait: 10_000, timeout: 30_000 });

    return {
      cancelled: TERMINAL_STATUSES.has(updated.status),
      scheduled: updated.cancelAtCycleEnd,
      subscription: serializeSubscription(updated),
    };
  }

  static async changeWorkspacePlan(
    userId: string,
    organizationId: string,
    planId: string,
    idempotencyKey: string,
    returnPath?: unknown
  ) {
    const selectedPlan = getActiveBillingPlan(planId);
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    if (organization.billingModelVersion !== "WORKSPACE_V2") {
      throw new Error("Workspace billing is not enabled for this organization");
    }
    const subscription = organization.subscription;
    if (!subscription) throw new Error("Subscription not found");
    if (subscription.plan === selectedPlan.id) {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { selectedPostTrialPlan: selectedPlan.id as SaasPlan },
      });
      return { unchanged: true, subscription: serializeSubscription(subscription) };
    }
    if (subscription.status === "CREATED") {
      return this.createSubscriptionCheckout(userId, organizationId, { plan: selectedPlan.id });
    }
    if (subscription.providerPaymentMethod !== "CARD") {
      throw new Error("V1 subscription changes require card authorization");
    }
    const trialActive = organization.ownerTrialGrant?.status === "ACTIVE"
      && organization.ownerTrialGrant.trialEndsAt != null
      && organization.ownerTrialGrant.trialEndsAt > new Date();
    const type = trialActive
      ? "TRIAL_SUBSCRIPTION_UPDATE"
      : subscription.plan === "BASIC" && selectedPlan.id === "PRO"
        ? "PLAN_UPGRADE"
        : "PLAN_DOWNGRADE";
    const change = await BillingMutationService.enqueue({
      organizationId,
      subscriptionId: subscription.id,
      idempotencyKey,
      type,
      fromPlan: subscription.plan,
      toPlan: selectedPlan.id as SaasPlan,
      fromQuantity: subscription.quantity,
      toQuantity: subscription.quantity,
      effectiveAt: type === "PLAN_DOWNGRADE" ? subscription.currentEnd : new Date(),
      createdByUserId: userId,
      returnPath: getSafeReturnPath(returnPath, organizationId),
    });
    await prisma.organization.update({
      where: { id: organizationId },
      data: { selectedPostTrialPlan: selectedPlan.id as SaasPlan },
    });
    const processed = await BillingMutationService.processNext(organizationId);
    const current = processed ?? change;
    return {
      change: current,
      operation: serializeBillingOperation(current),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
    };
  }

  static async scheduleWorkspaceCancellation(
    userId: string,
    organizationId: string,
    idempotencyKey: string,
    now = new Date()
  ) {
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    if (organization.billingModelVersion !== "WORKSPACE_V2") {
      return this.cancelSubscription(userId, organizationId);
    }
    const subscription = organization.subscription;
    if (!subscription) throw new Error("Subscription not found");
    const trialActive = organization.ownerTrialGrant?.status === "ACTIVE"
      && organization.ownerTrialGrant.trialEndsAt != null
      && organization.ownerTrialGrant.trialEndsAt > now;
    const boundary = trialActive
      ? organization.ownerTrialGrant!.trialEndsAt!
      : subscription.paidThrough ?? subscription.currentEnd;
    if (!boundary) throw new Error("Cancellation boundary is unavailable");
    const undoCutoffAt = new Date(boundary.getTime() - 24 * 60 * 60 * 1000);
    const change = await BillingMutationService.enqueue({
      organizationId,
      subscriptionId: subscription.id,
      idempotencyKey,
      type: "CANCELLATION",
      operationStatus: "SCHEDULED",
      effectiveAt: boundary,
      undoCutoffAt,
      createdByUserId: userId,
    });
    const late = now >= undoCutoffAt;
    const processed = late ? await BillingMutationService.processNext(organizationId, now) : null;
    return {
      cancelled: false,
      scheduled: true,
      undoable: !late,
      undoCutoffAt,
      effectiveAt: boundary,
      change: processed ?? change,
      subscription: serializeSubscription(subscription),
    };
  }

  static async undoWorkspaceCancellation(userId: string, organizationId: string, now = new Date()) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: { organizationId, type: "CANCELLATION", status: "QUEUED" },
      orderBy: { sequence: "desc" },
    });
    if (!change) throw new Error("Undoable cancellation not found");
    if (!change.undoCutoffAt || change.undoCutoffAt <= now) {
      throw new Error("The cancellation is no longer undoable");
    }
    await prisma.organizationBillingChange.update({
      where: { id: change.id },
      data: {
        status: "UNDONE",
        operationStatus: "ABANDONED",
        undoneAt: now,
        resolvedAt: now,
      },
    });
    return { undone: true };
  }

  static async getRecoveryCheckout(userId: string, organizationId: string, returnPath?: unknown) {
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const subscription = organization.subscription;
    if (!subscription || !["PENDING", "HALTED"].includes(subscription.status)) {
      throw new Error("Payment recovery is only available for pending or halted subscriptions");
    }
    const now = new Date();
    const operation = await enqueueAuthorizationOperation({
      organizationId,
      subscriptionId: subscription.id,
      expectedProviderSubscriptionId: subscription.razorpaySubscriptionId,
      idempotencyPrefix: "payment-recovery",
      fromPlan: subscription.plan,
      toPlan: subscription.plan,
      fromQuantity: subscription.quantity,
      toQuantity: subscription.quantity,
      returnPath: getSafeReturnPath(returnPath, organizationId),
      createdByUserId: userId,
      now,
    });
    const catalogPlan = getBillingPlan(subscription.plan);
    if (!catalogPlan) throw new Error("Subscription plan is no longer recognized");
    return this.toCheckoutPayload(
      organization,
      subscription,
      { ...catalogPlan, amount: subscription.amount },
      operation,
      { recovery: true }
    );
  }

  static async getBillingOperation(userId: string, organizationId: string, changeId: string) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: { id: changeId, organizationId },
    });
    if (!change) throw new Error("Billing operation not found");
    return {
      operation: serializeBillingOperation(change),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
    };
  }

  static async recordCheckoutEvent(
    userId: string,
    organizationId: string,
    changeId: string,
    input: CheckoutEventInput
  ) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const event = ["ABANDONED", "DECLINED", "FAILED", "AWAITING_PROVIDER_CONFIRMATION"]
      .includes(typeof input.event === "string" ? input.event : "")
      ? input.event as "ABANDONED" | "DECLINED" | "FAILED" | "AWAITING_PROVIDER_CONFIRMATION"
      : null;
    if (!event) throw new Error("Unsupported checkout event");
    const change = await prisma.organizationBillingChange.findFirst({
      where: { id: changeId, organizationId, type: "SUBSCRIPTION_AUTHORIZATION" },
    });
    if (!change) throw new Error("Billing operation not found");
    if (["APPLIED", "SCHEDULED"].includes(change.operationStatus)) {
      return { operation: serializeBillingOperation(change), ignored: true };
    }

    const allowedCurrentStatuses = event === "AWAITING_PROVIDER_CONFIRMATION"
      ? ["CHECKOUT_OPEN", "VERIFYING"]
      : ["CHECKOUT_OPEN"];
    if (!allowedCurrentStatuses.includes(change.operationStatus)) {
      return { operation: serializeBillingOperation(change), ignored: true };
    }

    const now = new Date();
    const terminal = event !== "AWAITING_PROVIDER_CONFIRMATION";
    const checkoutEventUpdate = await prisma.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        operationStatus: { in: allowedCurrentStatuses as ("CHECKOUT_OPEN" | "VERIFYING")[] },
      },
      data: {
        status: event === "ABANDONED"
          ? "UNDONE"
          : event === "AWAITING_PROVIDER_CONFIRMATION"
            ? "AWAITING_PAYMENT"
            : "FAILED",
        operationStatus: event,
        failureCategory: normalizedFailureCategory(input, event),
        failureCode: normalizedFailureCode(input),
        providerPaymentId: checkoutPaymentId(input.paymentId),
        lastError: event === "DECLINED"
          ? "Card authorization was declined; the confirmed billing state is unchanged"
          : event === "FAILED"
            ? "Checkout could not confirm card authorization; the confirmed billing state is unchanged"
            : event === "ABANDONED"
              ? "Checkout was closed before confirmation"
              : "Checkout outcome is awaiting provider confirmation",
        declinedAt: event === "DECLINED" ? now : null,
        abandonedAt: event === "ABANDONED" ? now : null,
        failedAt: event === "DECLINED" || event === "FAILED" ? now : null,
        undoneAt: event === "ABANDONED" ? now : null,
        resolvedAt: terminal ? now : null,
      },
    });
    const updated = await prisma.organizationBillingChange.findUnique({ where: { id: change.id } });
    if (!updated) throw new Error("Billing operation not found after checkout event");
    return {
      operation: serializeBillingOperation(updated),
      ...(checkoutEventUpdate.count === 0 ? { ignored: true as const } : {}),
    };
  }

  static async retryBillingOperation(userId: string, organizationId: string, changeId: string) {
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: { id: changeId, organizationId },
      include: { organizationSubscription: true },
    });
    if (!change) throw new Error("Billing operation not found");

    if (change.type === "SUBSCRIPTION_AUTHORIZATION") {
      const subscription = change.organizationSubscription;
      if (!subscription) throw new Error("Subscription not found");
      if (isProviderConfirmedOperationStatus(change.operationStatus)) {
        return { operation: serializeBillingOperation(change), reconciled: true };
      }
      const retryClaim = await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: {
            notIn: [...PROVIDER_CONFIRMED_OPERATION_STATUSES, "VERIFYING"],
          },
        },
        data: {
          operationStatus: "VERIFYING",
          verificationStartedAt: new Date(),
        },
      });
      if (retryClaim.count === 0) {
        const current = await prisma.organizationBillingChange.findUniqueOrThrow({
          where: { id: change.id },
        });
        return {
          operation: serializeBillingOperation(current),
          processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
          reconciled: isProviderConfirmedOperationStatus(current.operationStatus),
        };
      }
      let gateway: RazorpaySubscription;
      try {
        gateway = await getRazorpayClient().fetchSubscription(subscription.razorpaySubscriptionId);
      } catch {
        await prisma.organizationBillingChange.updateMany({
          where: { id: change.id, operationStatus: "VERIFYING" },
          data: {
            status: "AWAITING_PAYMENT",
            operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
            failureCategory: "PROVIDER_CONFIRMATION_PENDING",
            failureCode: null,
            lastError: "Razorpay confirmation is delayed; retry reconciliation shortly",
            resolvedAt: null,
          },
        });
        const pending = await prisma.organizationBillingChange.findUniqueOrThrow({
          where: { id: change.id },
        });
        return {
          operation: serializeBillingOperation(pending),
          processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
          reconciled: isProviderConfirmedOperationStatus(pending.operationStatus),
        };
      }
      const recoveryConfirmation = ["PENDING", "HALTED"].includes(subscription.status);
      const gatewayCardAuthorized = ["authenticated", "active"].includes(gateway.status.toLowerCase())
        && (subscription.providerPaymentMethod === "CARD" || gateway.payment_method?.toLowerCase() === "card");
      let confirmed = gatewayCardAuthorized;
      if (recoveryConfirmation && gateway.status.toLowerCase() === "active") {
        const reconciliation = await BillingReconciliationService.reconcileByOrganization(organizationId);
        confirmed = reconciliation.confirmedPaidPeriod
          && Boolean(reconciliation.subscription.paidThrough)
          && (!subscription.paidThrough || reconciliation.subscription.paidThrough! > subscription.paidThrough);
      }
      if (confirmed) {
        const now = new Date();
        await prisma.$transaction([
          prisma.organizationSubscription.update({
            where: { id: subscription.id },
            data: {
              providerPaymentMethod: "CARD",
              ...subscriptionSnapshotData(gateway),
              lastReconciledAt: now,
            },
          }),
          prisma.organizationBillingChange.updateMany({
            where: {
              id: change.id,
              operationStatus: { notIn: [...PROVIDER_CONFIRMED_OPERATION_STATUSES] },
            },
            data: {
              status: "APPLIED",
              operationStatus: "APPLIED",
              providerConfirmedAt: now,
              appliedAt: now,
              resolvedAt: now,
              failureCategory: null,
              failureCode: null,
              lastError: null,
            },
          }),
        ]);
        const applied = await prisma.organizationBillingChange.findUniqueOrThrow({
          where: { id: change.id },
        });
        return { operation: serializeBillingOperation(applied), reconciled: true };
      }
      const catalogPlan = getBillingPlan(subscription.plan);
      if (!catalogPlan) throw new Error("Subscription plan is no longer recognized");
      const selectedPlan = { ...catalogPlan, amount: subscription.amount };
      await prisma.organizationBillingChange.updateMany({
        where: { id: change.id, operationStatus: "VERIFYING" },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "CHECKOUT_OPEN",
          checkoutOpenedAt: new Date(),
          confirmationDeadlineAt: new Date(Date.now() + 15 * 60 * 1000),
          failureCategory: null,
          failureCode: null,
          lastError: null,
          failedAt: null,
          resolvedAt: null,
        },
      });
      const reopened = await prisma.organizationBillingChange.findUniqueOrThrow({
        where: { id: change.id },
      });
      if (reopened.operationStatus !== "CHECKOUT_OPEN") {
        return {
          operation: serializeBillingOperation(reopened),
          processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
          reconciled: isProviderConfirmedOperationStatus(reopened.operationStatus),
        };
      }
      return this.toCheckoutPayload(organization, subscription, selectedPlan, reopened, {
        recovery: recoveryConfirmation,
      });
    }

    const retried = await BillingMutationService.retry(change.id);
    const current = retried ?? await prisma.organizationBillingChange.findUnique({ where: { id: change.id } });
    if (!current) throw new Error("Billing operation not found after retry");
    return {
      operation: serializeBillingOperation(current),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
    };
  }

  static async reconcileMutation(userId: string, organizationId: string, changeId: string, paymentId?: string) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: { id: changeId, organizationId },
    });
    if (!change) throw new Error("Billing change not found");
    if (!["APPLIED", "SCHEDULED", "ABANDONED"].includes(change.operationStatus)) {
      const reconciliationClaim = await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: {
            notIn: [...PROVIDER_CONFIRMED_OPERATION_STATUSES, "ABANDONED", "VERIFYING"],
          },
        },
        data: { operationStatus: "VERIFYING", verificationStartedAt: new Date() },
      });
      if (reconciliationClaim.count === 0) {
        const current = await prisma.organizationBillingChange.findUnique({ where: { id: change.id } });
        return {
          reconciliation: null,
          pending: current ? !isProviderConfirmedOperationStatus(current.operationStatus) : true,
          operation: current ? serializeBillingOperation(current) : null,
        };
      }
    }
    let reconciliation: Awaited<ReturnType<typeof BillingReconciliationService.reconcileByOrganization>>;
    try {
      reconciliation = await BillingReconciliationService.reconcileByOrganization(organizationId, { paymentId });
      if (change.type === "SUBSCRIPTION_AUTHORIZATION") {
        await this.applyProviderConfirmedAuthorization(
          organizationId,
          reconciliation.subscription,
          reconciliation.payment,
          reconciliation.confirmedPaidPeriod
        );
      }
    } catch {
      await prisma.organizationBillingChange.updateMany({
        where: { id: change.id, operationStatus: "VERIFYING" },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          failureCategory: "PROVIDER_CONFIRMATION_PENDING",
          lastError: "Razorpay confirmation is delayed; the confirmed billing state is unchanged",
          resolvedAt: null,
        },
      });
      const pendingOperation = await prisma.organizationBillingChange.findUnique({ where: { id: change.id } });
      return {
        reconciliation: null,
        pending: pendingOperation ? !isProviderConfirmedOperationStatus(pendingOperation.operationStatus) : true,
        operation: pendingOperation ? serializeBillingOperation(pendingOperation) : null,
      };
    }
    const updated = await prisma.organizationBillingChange.findUnique({ where: { id: change.id } });
    return {
      reconciliation,
      operation: updated ? serializeBillingOperation(updated) : null,
    };
  }

  static async undoWorkspaceChange(userId: string, organizationId: string, changeId: string) {
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: { id: changeId, organizationId, status: { in: ["QUEUED", "SCHEDULED", "FAILED"] } },
    });
    if (!change) throw new Error("Undoable billing change not found");
    if (change.type === "CANCELLATION") return this.undoWorkspaceCancellation(userId, organizationId);
    if (change.status === "SCHEDULED" && organization.subscription?.providerPaymentMethod === "CARD") {
      await getRazorpayClient().cancelScheduledChanges(organization.subscription.razorpaySubscriptionId);
    }
    await prisma.organizationBillingChange.update({
      where: { id: change.id },
      data: {
        status: "UNDONE",
        operationStatus: "ABANDONED",
        undoneAt: new Date(),
        resolvedAt: new Date(),
      },
    });
    return { undone: true };
  }

  private static async applyProviderConfirmedAuthorization(
    organizationId: string,
    subscription: OrganizationSubscription,
    payment: RazorpayPayment | null,
    confirmedPaidPeriod: boolean
  ) {
    if (subscription.providerPaymentMethod !== "CARD") return;
    const providerAuthorizationConfirmed = ["AUTHENTICATED", "ACTIVE"].includes(subscription.status)
      && (!payment || ["authorized", "captured"].includes(payment.status));
    if (!providerAuthorizationConfirmed && !confirmedPaidPeriod) return;

    const change = await prisma.organizationBillingChange.findFirst({
      where: {
        organizationId,
        organizationSubscriptionId: subscription.id,
        type: "SUBSCRIPTION_AUTHORIZATION",
        operationStatus: { notIn: ["APPLIED", "SCHEDULED"] },
      },
      orderBy: { sequence: "desc" },
    });
    if (!change) return;

    const now = new Date();
    await prisma.$transaction([
      prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: payment?.id && !subscription.authPaymentId ? { authPaymentId: payment.id } : {},
      }),
      prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: { notIn: ["APPLIED", "SCHEDULED"] },
        },
        data: {
          status: "APPLIED",
          operationStatus: "APPLIED",
          providerPaymentId: payment?.id ?? change.providerPaymentId,
          providerConfirmedAt: now,
          appliedAt: now,
          resolvedAt: now,
          failureCategory: null,
          failureCode: null,
          lastError: null,
        },
      }),
    ]);
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
      const processed = await prisma.$transaction(async tx => {
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

      if (processed.organizationId && processed.razorpaySubscriptionId) {
        const organization = await prisma.organization.findUnique({
          where: { id: processed.organizationId },
          select: { billingModelVersion: true },
        });
        if (organization?.billingModelVersion === "WORKSPACE_V2") {
          const reconciliation = await BillingReconciliationService.reconcileProviderSubscription(
            processed.razorpaySubscriptionId,
            { paymentId: processed.razorpayPaymentId }
          );
          await this.applyProviderConfirmedAuthorization(
            processed.organizationId,
            reconciliation.subscription,
            reconciliation.payment,
            reconciliation.confirmedPaidPeriod
          );
        }
      }

      return processed;
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
    return prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(hashtext(${`lab-lords:razorpay-plan:${plan.id}`}))::text AS locked
      `;
      const existing = await tx.saasRazorpayPlan.findFirst({
        where: { plan: plan.id as SaasPlan, active: true },
        orderBy: { createdAt: "desc" },
      });

      const mappingMatchesCatalog = existing
        && existing.amount === plan.amount
        && existing.amountSubunits === amountSubunits
        && existing.currency === plan.currency
        && existing.period === plan.period
        && existing.interval === plan.interval;

      if (mappingMatchesCatalog) return existing;

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

      await tx.saasRazorpayPlan.updateMany({
        where: { plan: plan.id as SaasPlan, active: true },
        data: { active: false },
      });

      return tx.saasRazorpayPlan.create({
        data: {
          plan: plan.id as SaasPlan,
          amount: plan.amount ?? 0,
          amountSubunits,
          currency: plan.currency,
          period: plan.period,
          interval: plan.interval,
          razorpayPlanId: gatewayPlan.id,
          active: true,
        },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private static toCheckoutPayload(
    org: Awaited<ReturnType<typeof OrganizationService.getOrganizationForOwner>>,
    subscription: OrganizationSubscription,
    plan: BillingPlan,
    change: {
      id: string;
      organizationId: string;
      type: string;
      status: string;
      operationStatus: string;
      returnPath: string | null;
      confirmationDeadlineAt: Date | null;
      failureCategory: string | null;
      failureCode: string | null;
      providerPaymentId: string | null;
      lastError: string | null;
      effectiveAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    options: { recovery?: boolean } = {}
  ) {
    const now = new Date();
    const activeTrialEndsAt = org.ownerTrialGrant?.status === "ACTIVE"
      && org.ownerTrialGrant.organizationId === org.id
      && org.ownerTrialGrant.trialEndsAt
      && org.ownerTrialGrant.trialEndsAt > now
        ? org.ownerTrialGrant.trialEndsAt
        : null;
    const authorized = subscription.providerPaymentMethod === "CARD"
      && !["CREATED", "CANCELLED", "COMPLETED", "EXPIRED"].includes(subscription.status);
    const unitAmount = plan.amount ?? 0;
    const estimatedMonthlyTotal = unitAmount * subscription.quantity;
    const keyId = getRazorpayKeyId();
    const checkoutDescription = `${options.recovery ? "Update card for " : ""}${plan.shortName}: ${subscription.quantity} ${subscription.quantity === 1 ? "branch" : "branches"}`
      + ` x Rs.${unitAmount} = Rs.${estimatedMonthlyTotal}/month`
      + (activeTrialEndsAt ? `; starts ${formatCheckoutDate(activeTrialEndsAt)}` : "");
    return {
      keyId,
      testMode: keyId.startsWith("rzp_test_"),
      type: "subscription" as const,
      subscriptionId: subscription.razorpaySubscriptionId,
      ...(options.recovery ? { subscription_card_change: true as const } : {}),
      amount: subscription.amountSubunits,
      currency: subscription.currency,
      name: "Lab Lords",
      description: checkoutDescription,
      config: cardOnlyCheckoutConfig(),
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
        email: (org.contactEmail || org.owner?.email || "").trim() || undefined,
        contact: normalizeRazorpayContact(org.contactPhone),
      },
      summary: {
        plan: plan.id,
        unitAmount,
        quantity: subscription.quantity,
        estimatedMonthlyTotal,
        planFeeDueToday: activeTrialEndsAt ? 0 : estimatedMonthlyTotal,
        trialEndsAt: activeTrialEndsAt?.toISOString() ?? null,
        firstChargeAt: authorized ? subscription.chargeAt?.toISOString() ?? null : null,
      },
      notes: {
        app: "lab_lords",
        billing_type: "saas_subscription",
        organization_id: org.id,
        plan: plan.id,
      },
      subscription: serializeSubscription(subscription),
      changeId: change.id,
      processingUrl: `/org/${encodeURIComponent(org.id)}/billing/processing/${encodeURIComponent(change.id)}`,
      operation: serializeBillingOperation(change),
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
      const resolvedStatus = resolveWebhookStatus(
        subscription.status as SaasSubscriptionStatus,
        mapSubscriptionStatus(subscriptionEntity.status)
      );
      snapshot.status = resolvedStatus;
      if (resolvedStatus === "CANCELLED") {
        snapshot.cancelAtCycleEnd = false;
        snapshot.cancelledAt = timestampToDate(subscriptionEntity.ended_at) ?? new Date();
      }
      Object.assign(updateData, snapshot);
    }

    if (paymentId && event === "subscription.authenticated" && !subscription.authPaymentId) {
      updateData.authPaymentId = paymentId;
    }

    if (Object.keys(updateData).length > 0) {
      const stored = await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: updateData,
      });
      await recordSubscriptionHistory(tx, stored, {
        source: "WEBHOOK",
        fromStatus: subscription.status,
        event,
        razorpayPaymentId: paymentId,
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
