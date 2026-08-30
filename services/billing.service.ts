import { prisma } from "@/lib/prisma";
import crypto from "node:crypto";
import { BILLING_PLANS, getActiveBillingPlan, getBillingPlan, publicBillingPlans, type BillingPlan } from "@/lib/billingPlans";
import {
  getRazorpayClient,
  getRazorpayKeyId,
  resolveRazorpayMode,
  sha256Hex,
  toRazorpaySubunits,
  verifyRazorpaySubscriptionSignature,
  verifyRazorpayWebhookSignature,
  type RazorpayPayment,
  type RazorpayInvoice,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import { OrganizationService } from "@/services/organization.service";
import { EntitlementService } from "@/services/entitlement.service";
import {
  BillingReconciliationService,
  type BillingCommercialEvidenceKind,
} from "@/services/billingReconciliation.service";
import {
  BillingMutationService,
  isSafeFailedBillingMutationForLocalUndo,
} from "@/services/billingMutation.service";
import { recordBillingMutationAudit } from "@/services/billingMutationAudit.service";
import { BillingExperienceService } from "@/services/billingExperience.service";
import { ensureRazorpayPlanCatalogEntry } from "@/services/razorpayPlanCatalog.service";
import { BillingReplacementService } from "@/services/billingReplacement.service";
import { isReplacementMutationEligible } from "@/services/billingReplacementPolicy";
import {
  buildCommercialIntentSnapshot,
  commercialEvidenceMessage,
  validateExactCommercialEvidence,
  type CommercialEvidenceMismatchCode,
} from "@/services/billingCommercialEvidence.service";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
} from "@/lib/billingErrors";
import {
  isSupportedProviderPaymentMethod,
  normalizeProviderPaymentMethod,
} from "@/services/billingPaymentMethod.service";
import {
  areRazorpayMultiMethodSubscriptionsEnabled,
  assertRazorpayBillingWritesEnabled,
  getRazorpayCheckoutMethodAvailability,
} from "@/lib/billingFeature";
import type {
  OrganizationBillingChange,
  OrganizationSubscription,
  OrganizationSubscriptionHistory,
  Prisma,
} from "@/app/generated/prisma/client";
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
const CHECKOUT_BILLING_CHANGE_TYPES = [
  "SUBSCRIPTION_AUTHORIZATION",
  "PAYMENT_METHOD_REPLACEMENT",
  "TRIAL_SUBSCRIPTION_UPDATE",
  "PLAN_UPGRADE",
  "PLAN_DOWNGRADE",
  "QUANTITY_INCREASE",
  "BRANCH_REMOVAL",
  "BRANCH_REACTIVATION",
] as const;
const PROVIDER_CONFIRMED_OPERATION_STATUSES = ["APPLIED", "SCHEDULED"] as const;
const TERMINAL_CHECKOUT_OPERATION_STATUSES = [
  "APPLIED",
  "SCHEDULED",
  "ABANDONED",
  "DECLINED",
  "FAILED",
] as const;
const CHECKOUT_MUTATION_LEASE_MS = 2 * 60 * 1000;
const CHECKOUT_MUTATION_WAIT_MS = 15 * 1000;
const CHECKOUT_MUTATION_POLL_MS = 100;
const EMANDATE_AUTHORIZATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_STATUSES = new Set<SaasSubscriptionStatus>([
  "CREATED",
  "AUTHENTICATED",
  "ACTIVE",
  "PENDING",
  "HALTED",
  "PAUSED",
  "CANCELLED",
  "COMPLETED",
  "EXPIRED",
]);
function razorpayTestMode() {
  return resolveRazorpayMode() === "TEST";
}

async function claimCheckoutMutationLease(organizationId: string) {
  const deadline = Date.now() + CHECKOUT_MUTATION_WAIT_MS;
  while (Date.now() < deadline) {
    const leaseToken = crypto.randomUUID();
    const now = new Date();
    const claimed = await prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
      `;
      if (locked.length === 0) throw new Error("Organization not found");
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { billingMutationLeaseToken: true, billingMutationLeaseUntil: true },
      });
      if (
        organization.billingMutationLeaseToken
        || (organization.billingMutationLeaseUntil && organization.billingMutationLeaseUntil > now)
      ) {
        return false;
      }
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + CHECKOUT_MUTATION_LEASE_MS),
        },
      });
      return true;
    });
    if (claimed) return leaseToken;
    await new Promise(resolve => setTimeout(resolve, CHECKOUT_MUTATION_POLL_MS));
  }
  throw new Error("Another billing operation is still processing; retry shortly");
}

async function releaseCheckoutMutationLease(organizationId: string, leaseToken: string) {
  await prisma.organization.updateMany({
    where: { id: organizationId, billingMutationLeaseToken: leaseToken },
    data: { billingMutationLeaseToken: null, billingMutationLeaseUntil: null },
  });
}

function assertSubscriptionProviderMode(
  subscription: Pick<OrganizationSubscription, "providerMode"> | null | undefined,
  providerMode: ReturnType<typeof resolveRazorpayMode>
) {
  if (subscription && subscription.providerMode !== providerMode) {
    throw new Error(
      `This subscription belongs to Razorpay ${subscription.providerMode} mode and cannot be used in ${providerMode} mode`
    );
  }
}

async function reconcileLocallyCancelledCheckout(
  organizationId: string,
  razorpaySubscriptionId: string,
  event: "checkout_replacement_failed" | "checkout_persistence_failed"
) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
    `;
    const now = new Date();
    const reservedGrant = await tx.organizationOfferGrant.findFirst({
      where: {
        organizationId,
        status: "RESERVED",
        subscriptionId: razorpaySubscriptionId,
      },
      include: { billingOffer: true },
    });
    if (reservedGrant) {
      await tx.organizationOfferGrant.update({
        where: { id: reservedGrant.id },
        data: {
          status: offerGrantIsEligibleAt(reservedGrant, now) ? "ELIGIBLE" : "EXPIRED",
          reservedAt: null,
          subscriptionId: null,
        },
      });
    }

    const current = await tx.organizationSubscription.findFirst({
      where: { organizationId, razorpaySubscriptionId },
    });
    if (!current || TERMINAL_STATUSES.has(current.status)) return;
    const stored = await tx.organizationSubscription.update({
      where: { id: current.id },
      data: {
        status: "CANCELLED",
        cancelAtCycleEnd: false,
        cancelledAt: now,
        endedAt: now,
      },
    });
    await recordSubscriptionHistory(tx, stored, {
      source: "SYSTEM",
      fromStatus: current.status,
      event,
    });
  });
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

function safeRazorpayHostedUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:"
      || !(hostname === "rzp.io" || hostname === "razorpay.com" || hostname.endsWith(".razorpay.com"))) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
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

function isTerminalCheckoutOperationStatus(status: string) {
  return TERMINAL_CHECKOUT_OPERATION_STATUSES.includes(
    status as (typeof TERMINAL_CHECKOUT_OPERATION_STATUSES)[number]
  );
}

async function expireOverdueAuthorizationOperations(organizationId: string, now = new Date()) {
  return prisma.organizationBillingChange.updateMany({
    where: {
      organizationId,
      type: "SUBSCRIPTION_AUTHORIZATION",
      operationStatus: { in: [...ACTIVE_AUTHORIZATION_OPERATION_STATUSES] },
      confirmationDeadlineAt: { lte: now },
    },
    data: {
      status: "FAILED",
      operationStatus: "FAILED",
      failureCategory: "CONFIRMATION_TIMEOUT",
      lastError: "Razorpay did not confirm payment authorization before the deadline; start authorization again",
      failedAt: now,
      resolvedAt: now,
    },
  });
}

function providerFailedCheckoutEvent(payment: RazorpayPayment): "ABANDONED" | "DECLINED" | "FAILED" {
  const reason = payment.error_reason?.toLowerCase() ?? "";
  const source = payment.error_source?.toLowerCase() ?? "";
  if (reason === "payment_cancelled") return "ABANDONED";
  if (
    source === "customer"
    || reason.includes("declin")
    || reason.includes("incorrect")
    || reason.includes("insufficient")
    || reason.includes("not_authorized")
  ) {
    return "DECLINED";
  }
  return "FAILED";
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
      include: { billingOffer: true },
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
    if (active?.commercialIntentVersion === 1) {
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
    const commercialIntent = buildCommercialIntentSnapshot({
      providerMode: currentSubscription.providerMode,
      razorpaySubscriptionId: currentSubscription.razorpaySubscriptionId,
      sourceRazorpayPlanId: currentSubscription.razorpayPlanId,
      razorpayPlanId: currentSubscription.razorpayPlanId,
      plan: input.toPlan,
      quantity: input.toQuantity,
      unitAmountSubunits: currentSubscription.amountSubunits,
      currency: currentSubscription.currency,
      period: currentSubscription.period,
      interval: currentSubscription.interval,
      offer: currentSubscription.billingOffer,
      capturedAt: input.now,
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
        ...commercialIntent,
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
  if (["HALTED", "PAUSED"].includes(current) && incoming === "PENDING") return current;
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
  const data: Prisma.OrganizationSubscriptionUncheckedUpdateInput = {
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

async function quarantineCommercialEvidenceMismatch(input: {
  change: OrganizationBillingChange;
  verificationStartedAt: Date;
  code: CommercialEvidenceMismatchCode;
  paymentId: string;
}) {
  const failedAt = new Date();
  return prisma.$transaction(async tx => {
    const persisted = await tx.organizationBillingChange.updateMany({
      where: {
        id: input.change.id,
        operationStatus: "VERIFYING",
        attemptCount: input.change.attemptCount,
        verificationStartedAt: input.verificationStartedAt,
      },
      data: {
        status: "FAILED",
        operationStatus: "FAILED",
        failedAt,
        resolvedAt: null,
        providerPaymentId: input.paymentId,
        failureCategory: "MANUAL_REVIEW_REQUIRED",
        failureCode: input.code,
        lastError: commercialEvidenceMessage(input.code),
      },
    });
    if (persisted.count === 1) {
      await recordBillingMutationAudit(tx, {
        changeId: input.change.id,
        organizationId: input.change.organizationId,
        organizationSubscriptionId: input.change.organizationSubscriptionId,
        attemptCount: input.change.attemptCount,
        outcome: "MANUAL_REVIEW_REQUIRED",
        failureCode: input.code,
      });
    }
    return persisted.count === 1;
  });
}

function assertMatchingProviderSubscription(
  expectedSubscriptionId: string,
  subscription: RazorpaySubscription,
  context: string
) {
  if (subscription.id !== expectedSubscriptionId) {
    throw new Error(`Razorpay subscription mismatch while ${context}`);
  }
}

function assertTerminalProviderSubscription(subscription: RazorpaySubscription, context: string) {
  const status = mapSubscriptionStatus(subscription.status);
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(`Razorpay subscription remained ${status.toLowerCase()} while ${context}`);
  }
  return status;
}

async function retireInitialProviderCheckout(
  razorpay: ReturnType<typeof getRazorpayClient>,
  subscription: OrganizationSubscription
) {
  let providerSubscription: RazorpaySubscription;
  let cancelled = false;

  if (subscription.status === "CREATED") {
    providerSubscription = await razorpay.cancelSubscription(subscription.razorpaySubscriptionId, {
      cancel_at_cycle_end: false,
    });
    cancelled = true;
  } else {
    providerSubscription = await razorpay.fetchSubscription(subscription.razorpaySubscriptionId);
    assertMatchingProviderSubscription(
      subscription.razorpaySubscriptionId,
      providerSubscription,
      "checking a retired checkout"
    );
    if (!TERMINAL_STATUSES.has(mapSubscriptionStatus(providerSubscription.status))) {
      providerSubscription = await razorpay.cancelSubscription(subscription.razorpaySubscriptionId, {
        cancel_at_cycle_end: false,
      });
      cancelled = true;
    }
  }

  assertMatchingProviderSubscription(
    subscription.razorpaySubscriptionId,
    providerSubscription,
    "retiring a checkout"
  );
  assertTerminalProviderSubscription(providerSubscription, "retiring a checkout");
  return { providerSubscription, cancelled };
}

function serializeSubscription(subscription: OrganizationSubscription | null | undefined) {
  if (!subscription) return null;
  const plan = getBillingPlan(subscription.plan);
  return {
    id: subscription.id,
    organizationId: subscription.organizationId,
    position: subscription.currentOrganizationId
      ? "CURRENT" as const
      : subscription.pendingReplacementOrganizationId
        ? "PENDING_REPLACEMENT" as const
        : "ARCHIVED" as const,
    replacesSubscriptionId: subscription.replacesSubscriptionId,
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

export async function cancelLapsedInitialAuthorization(
  subscriptionId: string,
  now = new Date(),
  deadlineSnapshot?: Pick<
    OrganizationSubscription,
    "authorizationExpiresAt" | "providerPaymentMethod" | "providerStartAt"
  >
) {
  const initial = await prisma.organizationSubscription.findUnique({
    where: { id: subscriptionId },
    select: { organizationId: true },
  });
  if (!initial) return null;
  assertRazorpayBillingWritesEnabled(initial.organizationId);

  const leaseToken = await claimCheckoutMutationLease(initial.organizationId);
  try {
    const subscription = await prisma.organizationSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!subscription || subscription.organizationId !== initial.organizationId) return null;
    const authorizationDue = isInitialAuthorizationDue(subscription, now)
      || Boolean(deadlineSnapshot && isInitialAuthorizationDue(deadlineSnapshot, now));
    if (!authorizationDue || subscription.paidThrough) return null;

    const razorpay = getRazorpayClient();
    let providerSubscription = await razorpay.fetchSubscription(subscription.razorpaySubscriptionId);
    assertMatchingProviderSubscription(
      subscription.razorpaySubscriptionId,
      providerSubscription,
      "checking a lapsed authorization"
    );
    if (!TERMINAL_STATUSES.has(mapSubscriptionStatus(providerSubscription.status))) {
      providerSubscription = await razorpay.cancelSubscription(subscription.razorpaySubscriptionId, {
        cancel_at_cycle_end: false,
      });
    }
    assertMatchingProviderSubscription(
      subscription.razorpaySubscriptionId,
      providerSubscription,
      "cancelling a lapsed authorization"
    );
    const terminalStatus = assertTerminalProviderSubscription(
      providerSubscription,
      "cancelling a lapsed authorization"
    );

    return await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const latest = await tx.organizationSubscription.findUnique({
        where: { id: subscription.id },
      });
      if (!latest || latest.razorpaySubscriptionId !== subscription.razorpaySubscriptionId) {
        throw new Error("Subscription identity changed while expiring authorization");
      }

      const stored = await tx.organizationSubscription.update({
        where: { id: latest.id },
        data: {
          ...subscriptionSnapshotData(providerSubscription),
          status: terminalStatus,
          authorizationLapsedAt: now,
          lastReconciledAt: now,
          cancelAtCycleEnd: false,
          cancellationRequestedAt: terminalStatus === "CANCELLED"
            ? latest.cancellationRequestedAt ?? now
            : latest.cancellationRequestedAt,
          cancelledAt: terminalStatus === "CANCELLED"
            ? timestampToDate(providerSubscription.ended_at) ?? now
            : latest.cancelledAt,
          endedAt: timestampToDate(providerSubscription.ended_at) ?? latest.endedAt ?? now,
        },
      });
      await recordSubscriptionHistory(tx, stored, {
        source: "SYSTEM",
        fromStatus: latest.status,
        event: "authorization_lapsed_provider_terminal",
      });
      return stored;
    });
  } finally {
    await releaseCheckoutMutationLease(initial.organizationId, leaseToken);
  }
}

export function isInitialAuthorizationDue(
  subscription: Pick<
    OrganizationSubscription,
    "authorizationExpiresAt" | "providerPaymentMethod" | "providerStartAt"
  >,
  now = new Date()
) {
  if (subscription.authorizationExpiresAt && subscription.authorizationExpiresAt <= now) {
    return true;
  }
  if (!subscription.providerStartAt) return false;

  const confirmationWindowMs = subscription.providerPaymentMethod === "EMANDATE"
    ? EMANDATE_AUTHORIZATION_WINDOW_MS
    : 0;
  return subscription.providerStartAt.getTime() + confirmationWindowMs <= now.getTime();
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
    await expireOverdueAuthorizationOperations(organizationId);
    const providerMode = resolveRazorpayMode();
    const [subscription, pendingReplacement, history, entitlements, invoices, scheduledChanges, ownerTrialGrant, offerGrant, experience] = await Promise.all([
      prisma.organizationSubscription.findUnique({ where: { currentOrganizationId: organizationId } }),
      prisma.organizationSubscription.findUnique({ where: { pendingReplacementOrganizationId: organizationId } }),
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
        where: {
          organizationId,
          status: { in: ["ELIGIBLE", "RESERVED"] },
          billingOffer: { providerMode },
        },
        include: { billingOffer: true },
        orderBy: { billingOffer: { priority: "desc" } },
      }),
      BillingExperienceService.getBillingExperience(organizationId, userId),
    ]);
    assertSubscriptionProviderMode(subscription, providerMode);
    assertSubscriptionProviderMode(pendingReplacement, providerMode);

    const organizationTrial = organization.ownerTrialGrant;
    const ownerTrialClaimable = ownerTrialGrant?.status === "AVAILABLE"
      && !subscription
      && history.length === 0;

    return {
      billingModelVersion: organization.billingModelVersion,
      razorpayTestMode: razorpayTestMode(),
      multiMethodSubscriptionsEnabled: areRazorpayMultiMethodSubscriptionsEnabled(),
      checkoutMethodAvailability: getRazorpayCheckoutMethodAvailability(),
      plans: publicBillingPlans(),
      current: serializeSubscription(subscription),
      pendingReplacement: serializeSubscription(pendingReplacement),
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
    assertRazorpayBillingWritesEnabled(organizationId);
    const selectedPlan = getActiveBillingPlan(input.plan);
    const org = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const now = new Date();
    await expireOverdueAuthorizationOperations(organizationId, now);
    const providerMode = resolveRazorpayMode();
    assertSubscriptionProviderMode(org.subscription, providerMode);
    const workspaceBilling = org.billingModelVersion === "WORKSPACE_V2";
    const quantity = workspaceBilling
      ? await prisma.branch.count({
          where: { organizationId, billingStatus: { not: "ARCHIVED" } },
        })
      : 1;
    if (quantity < 1) throw new Error("At least one billable branch is required");
    const razorpayPlan = await ensureRazorpayPlanCatalogEntry({
      plan: selectedPlan.id as SaasPlan,
      name: selectedPlan.name,
      description: selectedPlan.description,
      amount: selectedPlan.amount ?? 0,
      currency: selectedPlan.currency,
      period: selectedPlan.period,
      interval: selectedPlan.interval,
    });
    if (razorpayPlan.providerMode !== providerMode) {
      throw new Error("Razorpay plan catalog mode mismatch");
    }
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
        commercialIntentVersion: 1,
        organizationSubscription: {
          providerMode,
          plan: selectedPlan.id as SaasPlan,
          razorpayPlanId: razorpayPlan.razorpayPlanId,
          quantity,
          status: { in: ["CREATED", "AUTHENTICATED"] },
        },
      },
      include: { organizationSubscription: true },
      orderBy: { sequence: "desc" },
    });
    if (openAuthorization?.organizationSubscription) {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { selectedPostTrialPlan: selectedPlan.id as SaasPlan },
      });
      return this.toCheckoutPayload(org, openAuthorization.organizationSubscription, selectedPlan, openAuthorization);
    }
    const leaseToken = await claimCheckoutMutationLease(organizationId);
    const razorpay = getRazorpayClient();
    let cancelledProviderSubscriptionId: string | null = null;
    let retiredProviderSubscription: RazorpaySubscription | null = null;
    let createdGatewaySubscriptionId: string | null = null;
    let persistedGatewaySubscription = false;

    try {
      const existing = await prisma.organizationSubscription.findUnique({ where: { currentOrganizationId: organizationId } });
      assertSubscriptionProviderMode(existing, providerMode);

      const authorization = await prisma.organizationBillingChange.findFirst({
        where: {
          organizationId,
          type: "SUBSCRIPTION_AUTHORIZATION",
          operationStatus: { in: [...ACTIVE_AUTHORIZATION_OPERATION_STATUSES] },
          toQuantity: quantity,
          commercialIntentVersion: 1,
          organizationSubscription: {
            providerMode,
            plan: selectedPlan.id as SaasPlan,
            razorpayPlanId: razorpayPlan.razorpayPlanId,
            quantity,
            status: { in: ["CREATED", "AUTHENTICATED"] },
          },
        },
        include: { organizationSubscription: true },
        orderBy: { sequence: "desc" },
      });
      if (authorization?.organizationSubscription) {
        await prisma.organization.update({
          where: { id: organizationId },
          data: { selectedPostTrialPlan: selectedPlan.id as SaasPlan },
        });
        return this.toCheckoutPayload(org, authorization.organizationSubscription, selectedPlan, authorization);
      }

      if (existing) {
        if (
          existing.plan === selectedPlan.id
          && existing.razorpayPlanId === razorpayPlan.razorpayPlanId
          && existing.quantity === quantity
          && CHECKOUT_REUSABLE_STATUSES.has(existing.status)
        ) {
          await prisma.organization.update({
            where: { id: organizationId },
            data: { selectedPostTrialPlan: selectedPlan.id as SaasPlan },
          });
          const operation = await enqueueAuthorizationOperation({
            organizationId,
            subscriptionId: existing.id,
            expectedProviderSubscriptionId: existing.razorpaySubscriptionId,
            idempotencyPrefix: "subscription-authorization",
            fromPlan: existing.plan,
            toPlan: selectedPlan.id as SaasPlan,
            fromQuantity: existing.quantity,
            toQuantity: quantity,
            createdByUserId: userId,
            returnPath,
            now: new Date(),
          });
          return this.toCheckoutPayload(org, existing, selectedPlan, operation);
        }
        if (existing.status !== "CREATED" && !TERMINAL_STATUSES.has(existing.status)) {
          if (existing.plan === selectedPlan.id) {
            throw new Error(`This organization already has a ${existing.status.toLowerCase()} ${selectedPlan.shortName} subscription`);
          }
          throw new Error("Cancel or complete the current subscription before changing plans");
        }
      }

      const checkoutNow = new Date();
      const reservedOfferGrant = workspaceBilling && existing?.status === "CREATED"
        ? await prisma.organizationOfferGrant.findFirst({
            where: {
              organizationId,
              status: "RESERVED",
              subscriptionId: existing.razorpaySubscriptionId,
              OR: [{ eligibleFrom: null }, { eligibleFrom: { lte: checkoutNow } }],
              AND: [{ OR: [{ eligibleUntil: null }, { eligibleUntil: { gt: checkoutNow } }] }],
              billingOffer: {
                providerMode,
                active: true,
                plan: selectedPlan.id as SaasPlan,
                OR: [{ validFrom: null }, { validFrom: { lte: checkoutNow } }],
                AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: checkoutNow } }] }],
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
              OR: [{ eligibleFrom: null }, { eligibleFrom: { lte: checkoutNow } }],
              AND: [{ OR: [{ eligibleUntil: null }, { eligibleUntil: { gt: checkoutNow } }] }],
              billingOffer: {
                providerMode,
                active: true,
                plan: selectedPlan.id as SaasPlan,
                OR: [{ validFrom: null }, { validFrom: { lte: checkoutNow } }],
                AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: checkoutNow } }] }],
              },
            },
            include: { billingOffer: true },
            orderBy: { billingOffer: { priority: "desc" } },
          })
        : null);

      if (existing && ["CREATED", "EXPIRED"].includes(existing.status)) {
        const retired = await retireInitialProviderCheckout(razorpay, existing);
        retiredProviderSubscription = retired.providerSubscription;
        if (retired.cancelled) {
          cancelledProviderSubscriptionId = existing.razorpaySubscriptionId;
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
          provider_mode: providerMode,
          plan: selectedPlan.id,
        },
      });
      createdGatewaySubscriptionId = gatewaySubscription.id;
      if (gatewaySubscription.plan_id !== razorpayPlan.razorpayPlanId) {
        throw new Error("Razorpay subscription plan mismatch during checkout creation");
      }

      const subscription = await prisma.$transaction(async tx => {
        const leaseOwner = await tx.organization.findFirst({
          where: { id: organizationId, billingMutationLeaseToken: leaseToken },
          select: { id: true },
        });
        if (!leaseOwner) throw new Error("Billing mutation lease expired before checkout could be saved");
        await tx.organization.update({
          where: { id: organizationId },
          data: { selectedPostTrialPlan: selectedPlan.id as SaasPlan },
        });
        const current = await tx.organizationSubscription.findUnique({ where: { currentOrganizationId: organizationId } });
        if ((current?.id ?? null) !== (existing?.id ?? null)
          || (current?.razorpaySubscriptionId ?? null) !== (existing?.razorpaySubscriptionId ?? null)) {
          throw new Error("Subscription changed while checkout was being created");
        }

        if (existing?.status === "CREATED") {
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
                status: offerGrantIsEligibleAt(previousReservedGrant, checkoutNow) ? "ELIGIBLE" : "EXPIRED",
                reservedAt: null,
                subscriptionId: null,
              },
            });
          }
        }

        const recordData = {
          organizationId,
          currentOrganizationId: organizationId,
          providerMode,
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
          authPaymentId: null,
          providerStartAt: timestampToDate(gatewaySubscription.start_at) ?? trialEndsAt,
          authorizationExpiresAt: timestampToDate(gatewaySubscription.expire_by) ?? null,
          providerPaymentMethod: "UNKNOWN" as const,
          paidThrough: null,
          lastConfirmedInvoiceId: null,
          lastConfirmedPaymentId: null,
          lastPaymentConfirmedAt: null,
          authorizationLapsedAt: null,
          billingOfferId: offerGrant?.billingOfferId ?? null,
          lastReconciledAt: null,
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
        let archivedSubscription = current;
        if (current) {
          const retiredStatus = retiredProviderSubscription
            ? mapSubscriptionStatus(retiredProviderSubscription.status)
            : current.status;
          archivedSubscription = await tx.organizationSubscription.update({
            where: { id: current.id },
            data: {
              ...(retiredProviderSubscription
                ? subscriptionSnapshotData(retiredProviderSubscription)
                : {}),
              status: retiredStatus,
              currentOrganizationId: null,
              cancelAtCycleEnd: false,
              lastReconciledAt: retiredProviderSubscription ? checkoutNow : current.lastReconciledAt,
              cancelledAt: retiredStatus === "CANCELLED"
                ? timestampToDate(retiredProviderSubscription?.ended_at) ?? checkoutNow
                : current.cancelledAt,
              endedAt: retiredProviderSubscription
                ? timestampToDate(retiredProviderSubscription.ended_at) ?? current.endedAt ?? checkoutNow
                : current.endedAt,
            },
          });
        }
        const stored = await tx.organizationSubscription.create({
          data: {
            ...recordData,
            replacesSubscriptionId: current?.id ?? null,
          },
        });

        if (existing && archivedSubscription) {
          await recordSubscriptionHistory(tx, archivedSubscription, {
            source: "SYSTEM",
            fromStatus: existing.status,
            event: "checkout_replaced",
          });
        }
        await recordSubscriptionHistory(tx, stored, {
          source: "CHECKOUT",
          fromStatus: existing?.status ?? null,
        });
        if (offerGrant) {
          await tx.organizationOfferGrant.update({
            where: { id: offerGrant.id },
            data: { status: "RESERVED", reservedAt: new Date(), subscriptionId: gatewaySubscription.id },
          });
        }
        return stored;
      });
      persistedGatewaySubscription = true;

      const operation = await enqueueAuthorizationOperation({
        organizationId,
        subscriptionId: subscription.id,
        expectedProviderSubscriptionId: subscription.razorpaySubscriptionId,
        idempotencyPrefix: "subscription-authorization",
        fromPlan: existing?.plan ?? null,
        toPlan: selectedPlan.id as SaasPlan,
        fromQuantity: existing?.quantity ?? null,
        toQuantity: quantity,
        createdByUserId: userId,
        returnPath,
        now: new Date(),
      });
      return this.toCheckoutPayload(org, subscription, selectedPlan, operation);
    } catch (error) {
      if (createdGatewaySubscriptionId) {
        try {
          await razorpay.cancelSubscription(createdGatewaySubscriptionId, { cancel_at_cycle_end: false });
          if (persistedGatewaySubscription) {
            await reconcileLocallyCancelledCheckout(
              organizationId,
              createdGatewaySubscriptionId,
              "checkout_persistence_failed"
            );
          }
        } catch (compensationError) {
          console.error("[SAAS_SUBSCRIPTION_COMPENSATION_FAILED]", {
            organizationId,
            razorpaySubscriptionId: createdGatewaySubscriptionId,
            error: compensationError,
          });
        }
      }
      if (cancelledProviderSubscriptionId && !persistedGatewaySubscription) {
        try {
          await reconcileLocallyCancelledCheckout(
            organizationId,
            cancelledProviderSubscriptionId,
            "checkout_replacement_failed"
          );
        } catch (reconciliationError) {
          console.error("[SAAS_SUBSCRIPTION_REPLACEMENT_RECONCILIATION_FAILED]", {
            organizationId,
            razorpaySubscriptionId: cancelledProviderSubscriptionId,
            error: reconciliationError,
          });
        }
      }
      throw error;
    } finally {
      await releaseCheckoutMutationLease(organizationId, leaseToken);
    }
  }

  static async verifySubscriptionSuccess(
    userId: string,
    organizationId: string,
    input: VerifySubscriptionInput
  ) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const providerMode = resolveRazorpayMode();
    if (typeof input.changeId !== "string" || !input.changeId.trim()) {
      throw new Error("Missing billing change id");
    }
    let change = await prisma.organizationBillingChange.findFirst({
      where: {
        id: input.changeId.trim(),
        organizationId,
        type: { in: [...CHECKOUT_BILLING_CHANGE_TYPES] },
      },
      include: { replacementSubscription: true },
    });
    if (!change) throw new Error("Billing operation not found");
    if (isProviderConfirmedOperationStatus(change.operationStatus)) {
      const confirmedSubscription = change.replacementSubscription
        ?? await prisma.organizationSubscription.findUnique({ where: { currentOrganizationId: organizationId } });
      if (!confirmedSubscription) throw new Error("Subscription not found");
      assertSubscriptionProviderMode(confirmedSubscription, providerMode);
      return {
        verified: true as const,
        operation: serializeBillingOperation(change),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(confirmedSubscription),
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
    const verifiedCallbackAt = new Date();

    const subscription = await prisma.organizationSubscription.findFirst({
      where: { organizationId, razorpaySubscriptionId: subscriptionId },
    });
    if (!subscription) throw new Error("Subscription does not belong to this organization");
    assertSubscriptionProviderMode(subscription, providerMode);
    const expectedOperationSubscriptionId = change.replacementSubscriptionId
      ?? change.organizationSubscriptionId;
    if (expectedOperationSubscriptionId !== subscription.id) {
      throw new Error("Billing operation subscription mismatch");
    }
    if (change.toPlan && change.toPlan !== subscription.plan) {
      throw new Error("Billing operation plan mismatch");
    }
    if (change.toQuantity && change.toQuantity !== subscription.quantity) {
      throw new Error("Billing operation quantity mismatch");
    }

    const verificationAttempt = change.attemptCount;
    const verificationClaim = await prisma.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        attemptCount: verificationAttempt,
        operationStatus: {
          in: ["CHECKOUT_OPEN", "AWAITING_PROVIDER_CONFIRMATION", "DECLINED", "ABANDONED"],
        },
        OR: [
          { failureCategory: null },
          { failureCategory: { not: "MANUAL_REVIEW_REQUIRED" } },
        ],
      },
      data: {
        operationStatus: "VERIFYING",
        verificationStartedAt: verifiedCallbackAt,
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
    const claimedChange = await prisma.organizationBillingChange.findUniqueOrThrow({
      where: { id: change.id },
    });
    change = {
      ...claimedChange,
      replacementSubscription: change.replacementSubscription,
    };
    if (change.operationStatus !== "VERIFYING"
      || change.attemptCount !== verificationAttempt
      || change.verificationStartedAt?.getTime() !== verifiedCallbackAt.getTime()) {
      throw new Error("Billing verification claim changed before provider confirmation");
    }
    const replacementCheckout = change.replacementSubscriptionId != null;
    const recoveryConfirmation = !replacementCheckout
      && ["PENDING", "HALTED"].includes(subscription.status);

    let gatewaySubscription: RazorpaySubscription;
    let gatewayPayment: RazorpayPayment;
    try {
      [gatewaySubscription, gatewayPayment] = await Promise.all([
        getRazorpayClient().fetchSubscription(subscriptionId),
        getRazorpayClient().fetchPayment(paymentId),
      ]);
    } catch {
      await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: "VERIFYING",
          attemptCount: change.attemptCount,
          verificationStartedAt: verifiedCallbackAt,
        },
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

    if (typeof gatewayPayment.status === "string"
      && gatewayPayment.status.toLowerCase() === "captured"
      && gatewayPayment.invoice_id) {
      const reconciliation = await BillingReconciliationService.reconcileProviderSubscription(
        subscriptionId,
        {
          paymentId,
          now: verifiedCallbackAt,
          commercialIntentChangeId: change.id,
          expectedAttemptCount: change.attemptCount,
          expectedVerificationStartedAt: verifiedCallbackAt,
        }
      );
      if (replacementCheckout) {
        await BillingReplacementService.syncAuthorizedAccess(change.id, verifiedCallbackAt);
      }
      const [settledOperation, settledSubscription] = await Promise.all([
        prisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }),
        prisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      ]);
      const providerConfirmed = isProviderConfirmedOperationStatus(settledOperation.operationStatus)
        || reconciliation.evidenceKind === "EXACT_SETTLEMENT";
      return {
        verified: providerConfirmed,
        ...(replacementCheckout ? { pending: true as const } : {}),
        operation: serializeBillingOperation(settledOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(settledSubscription),
      };
    }

    const commercialEvidence = validateExactCommercialEvidence({
      intent: change,
      organizationId,
      providerMode,
      localSubscription: subscription,
      providerSubscription: gatewaySubscription,
      payment: gatewayPayment,
      expectedPaymentId: paymentId,
      invoice: null,
      providerPlan: null,
      now: verifiedCallbackAt,
    });
    if (commercialEvidence.kind === "MISMATCH") {
      const quarantined = await quarantineCommercialEvidenceMismatch({
        change,
        verificationStartedAt: verifiedCallbackAt,
        code: commercialEvidence.code,
        paymentId,
      });
      if (quarantined) {
        throw new BillingManualReviewRequiredError(
          change.id,
          commercialEvidenceMessage(commercialEvidence.code)
        );
      }
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
    if (commercialEvidence.kind === "PENDING") {
      await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: "VERIFYING",
          attemptCount: change.attemptCount,
          verificationStartedAt: verifiedCallbackAt,
        },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          providerPaymentId: paymentId,
          failureCategory: "PROVIDER_CONFIRMATION_PENDING",
          failureCode: null,
          lastError: "Razorpay authorization remains pending; the confirmed billing state is unchanged",
          resolvedAt: null,
        },
      });
      const [pendingOperation, currentSubscription] = await Promise.all([
        prisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }),
        prisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      ]);
      return {
        verified: false as const,
        pending: true as const,
        operation: serializeBillingOperation(pendingOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(currentSubscription),
      };
    }
    const paymentMethod = normalizeProviderPaymentMethod(gatewayPayment.method);
    if (!isSupportedProviderPaymentMethod(paymentMethod)) {
      await prisma.$transaction(async tx => {
        const persisted = await tx.organizationBillingChange.updateMany({
          where: {
            id: change.id,
            operationStatus: "VERIFYING",
            attemptCount: change.attemptCount,
            verificationStartedAt: verifiedCallbackAt,
          },
          data: {
            status: "AWAITING_PAYMENT",
            operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
            providerPaymentId: paymentId,
            failureCategory: "UNKNOWN_PAYMENT_METHOD",
            failureCode: "UNKNOWN",
            lastError: "Razorpay returned an unrecognized recurring payment method; access remains unchanged",
            resolvedAt: null,
          },
        });
        if (persisted.count !== 1) return;
        await tx.organizationSubscription.update({
          where: { id: subscription.id },
          data: {
            providerPaymentMethod: "UNKNOWN",
            lastReconciledAt: verifiedCallbackAt,
          },
        });
      });
      const [pendingOperation, currentSubscription] = await Promise.all([
        prisma.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } }),
        prisma.organizationSubscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      ]);
      return {
        verified: true as const,
        pending: true as const,
        operation: serializeBillingOperation(pendingOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(currentSubscription),
      };
    }

    const snapshot = subscriptionSnapshotData(gatewaySubscription);
    const delayedEMandateAuthorization = paymentMethod === "EMANDATE"
      && snapshot.status === "CREATED";
    if (snapshot.status === "CREATED" && !delayedEMandateAuthorization) {
      snapshot.status = "AUTHENTICATED";
    }

    const updated = await prisma.$transaction(async tx => {
      const fenced = await tx.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: "VERIFYING",
          attemptCount: change.attemptCount,
          verificationStartedAt: verifiedCallbackAt,
        },
        data: { providerPaymentId: paymentId },
      });
      if (fenced.count !== 1) return null;
      const stored = await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          ...snapshot,
          authPaymentId: paymentId,
          providerPaymentMethod: paymentMethod,
          confirmedCommercialIntentChangeId: change.id,
          lastReconciledAt: verifiedCallbackAt,
        },
      });
      await recordSubscriptionHistory(tx, stored, {
        source: "VERIFICATION",
        fromStatus: subscription.status,
        razorpayPaymentId: paymentId,
      });
      return stored;
    });
    if (!updated) {
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

    if (delayedEMandateAuthorization) {
      const existingDeadline = change.failureCode === "EMANDATE_AUTHORIZATION_PENDING"
        ? change.confirmationDeadlineAt
        : null;
      const confirmationDeadlineAt = existingDeadline
        ?? new Date(verifiedCallbackAt.getTime() + EMANDATE_AUTHORIZATION_WINDOW_MS);
      await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: "VERIFYING",
          attemptCount: change.attemptCount,
          verificationStartedAt: verifiedCallbackAt,
        },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          providerPaymentId: paymentId,
          confirmationDeadlineAt,
          failureCategory: "PROVIDER_CONFIRMATION_PENDING",
          failureCode: "EMANDATE_AUTHORIZATION_PENDING",
          lastError: "eMandate registration is still being confirmed by Razorpay; access remains unchanged",
          resolvedAt: null,
        },
      });
      const pendingOperation = await prisma.organizationBillingChange.findUniqueOrThrow({
        where: { id: change.id },
      });
      if (replacementCheckout) {
        await BillingReplacementService.syncAuthorizedAccess(change.id, verifiedCallbackAt);
      }
      return {
        verified: true as const,
        pending: true as const,
        operation: serializeBillingOperation(pendingOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(updated),
      };
    }

    if (replacementCheckout) {
      await BillingReplacementService.syncAuthorizedAccess(change.id, verifiedCallbackAt);
      const replacementOperation = await prisma.organizationBillingChange.findUniqueOrThrow({
        where: { id: change.id },
      });
      const replacementSubscription = await prisma.organizationSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
      });
      return {
        verified: true as const,
        pending: true as const,
        operation: serializeBillingOperation(replacementOperation),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        subscription: serializeSubscription(replacementSubscription),
      };
    }

    const reconciledSubscription = await prisma.organizationSubscription.findUnique({ where: { id: subscription.id } });
    const recoveryPaid = !recoveryConfirmation || Boolean(
      reconciledSubscription?.paidThrough
      && (!subscription.paidThrough || reconciledSubscription.paidThrough > subscription.paidThrough)
    );

    if (!recoveryPaid) {
      await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: "VERIFYING",
          attemptCount: change.attemptCount,
          verificationStartedAt: verifiedCallbackAt,
        },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          providerPaymentId: paymentId,
          lastError: "Payment authorization confirmed; awaiting captured renewal payment and paid-period confirmation",
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

    const appliedResult = await prisma.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        operationStatus: "VERIFYING",
        attemptCount: change.attemptCount,
        verificationStartedAt: verifiedCallbackAt,
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
    const providerConfirmed = isProviderConfirmedOperationStatus(appliedOperation.operationStatus);

    return {
      verified: appliedResult.count === 1 || providerConfirmed,
      ...(providerConfirmed ? {} : { pending: true as const }),
      operation: serializeBillingOperation(appliedOperation),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
      subscription: serializeSubscription(reconciledSubscription ?? updated),
    };
  }

  static async cancelSubscription(
    userId: string,
    organizationId: string
  ) {
    assertRazorpayBillingWritesEnabled(organizationId);
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const providerMode = resolveRazorpayMode();
    const leaseToken = await claimCheckoutMutationLease(organizationId);
    const razorpay = getRazorpayClient();
    let providerCancellationSubmitted = false;
    try {
      const subscription = await prisma.organizationSubscription.findUnique({ where: { currentOrganizationId: organizationId } });
      if (!subscription) throw new Error("Subscription not found");
      assertSubscriptionProviderMode(subscription, providerMode);
      if (TERMINAL_STATUSES.has(subscription.status)) {
        throw new Error("Subscription has already ended");
      }
      if (subscription.cancelAtCycleEnd) {
        return {
          cancelled: TERMINAL_STATUSES.has(subscription.status),
          scheduled: subscription.cancelAtCycleEnd,
          subscription: serializeSubscription(subscription),
        };
      }
      if (subscription.status !== "ACTIVE") {
        throw new Error("Only an active subscription can be cancelled at the end of its billing cycle");
      }

      const gatewaySubscription = await razorpay.cancelSubscription(
        subscription.razorpaySubscriptionId,
        { cancel_at_cycle_end: true }
      );
      providerCancellationSubmitted = true;
      if (gatewaySubscription.id !== subscription.razorpaySubscriptionId) {
        throw new Error("Razorpay subscription mismatch during cancellation");
      }

      const updated = await prisma.$transaction(async tx => {
        const leaseOwner = await tx.organization.findFirst({
          where: { id: organizationId, billingMutationLeaseToken: leaseToken },
          select: { id: true },
        });
        if (!leaseOwner) throw new Error("Billing mutation lease expired before cancellation could be saved");
        const current = await tx.organizationSubscription.findUnique({ where: { currentOrganizationId: organizationId } });
        if (!current || current.id !== subscription.id
          || current.razorpaySubscriptionId !== subscription.razorpaySubscriptionId) {
          throw new Error("Subscription changed while cancellation was being submitted");
        }
        assertSubscriptionProviderMode(current, providerMode);
        const snapshot = subscriptionSnapshotData(gatewaySubscription);
        const gatewayStatus = mapSubscriptionStatus(gatewaySubscription.status);
        const cancellationRequestedAt = new Date();
        const cancelledImmediately = TERMINAL_STATUSES.has(gatewayStatus);
        const stored = await tx.organizationSubscription.update({
          where: { id: current.id },
          data: {
            ...snapshot,
            cancelAtCycleEnd: !cancelledImmediately,
            cancellationRequestedAt,
            cancellationScheduledAt:
              timestampToDate(gatewaySubscription.change_scheduled_at) ?? current.currentEnd,
            cancelledAt: cancelledImmediately
              ? timestampToDate(gatewaySubscription.ended_at) ?? cancellationRequestedAt
              : null,
          },
        });
        await recordSubscriptionHistory(tx, stored, {
          source: "CUSTOMER_CANCELLATION",
          fromStatus: current.status,
          event: "cancel_at_cycle_end",
        });
        return stored;
      });

      return {
        cancelled: TERMINAL_STATUSES.has(updated.status),
        scheduled: updated.cancelAtCycleEnd,
        subscription: serializeSubscription(updated),
      };
    } catch (error) {
      if (providerCancellationSubmitted) {
        try {
          const current = await prisma.organizationSubscription.findUnique({ where: { currentOrganizationId: organizationId } });
          if (current && current.providerMode === providerMode && !current.cancelAtCycleEnd) {
            await razorpay.cancelScheduledChanges(current.razorpaySubscriptionId);
          }
        } catch (compensationError) {
          console.error("[SAAS_CANCELLATION_COMPENSATION_FAILED]", {
            organizationId,
            error: compensationError,
          });
        }
      }
      throw error;
    } finally {
      await releaseCheckoutMutationLease(organizationId, leaseToken);
    }
  }

  static async changeWorkspacePlan(
    userId: string,
    organizationId: string,
    planId: string,
    idempotencyKey: string,
    returnPath?: unknown
  ) {
    assertRazorpayBillingWritesEnabled(organizationId);
    const selectedPlan = getActiveBillingPlan(planId);
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    if (organization.billingModelVersion !== "WORKSPACE_V2") {
      throw new Error("Workspace billing is not enabled for this organization");
    }
    const subscription = organization.subscription;
    if (!subscription) throw new Error("Subscription not found");
    assertSubscriptionProviderMode(subscription, resolveRazorpayMode());
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
    const trialActive = organization.ownerTrialGrant?.status === "ACTIVE"
      && organization.ownerTrialGrant.trialEndsAt != null
      && organization.ownerTrialGrant.trialEndsAt > new Date();
    const type = trialActive
      ? "TRIAL_SUBSCRIPTION_UPDATE"
      : subscription.plan === "BASIC" && selectedPlan.id === "PRO"
        ? "PLAN_UPGRADE"
        : "PLAN_DOWNGRADE";
    const replacementRequired = isReplacementMutationEligible({
      sourcePaymentMethod: subscription.providerPaymentMethod,
      mutationType: type,
    });
    if (replacementRequired && !areRazorpayMultiMethodSubscriptionsEnabled()) {
      throw new Error("This payment method requires a replacement mandate; multi-method billing is not enabled yet");
    }
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
    const processed = change.status === "FAILED"
      && !change.replacementSubscriptionId
      && change.failureCategory !== "MANUAL_REVIEW_REQUIRED"
      ? await BillingMutationService.retry(change.id)
      : await BillingMutationService.processNext(organizationId);
    const current = processed ?? change;
    if (replacementRequired) {
      const replacementChange = await prisma.organizationBillingChange.findUnique({
        where: { id: current.id },
        include: { replacementSubscription: true },
      });
      if (!replacementChange?.replacementSubscription
        && ["QUEUED", "PROCESSING"].includes(replacementChange?.status ?? current.status)) {
        return {
          change: replacementChange ?? current,
          operation: serializeBillingOperation(replacementChange ?? current),
          processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(current.id)}`,
        };
      }
      if (!replacementChange?.replacementSubscription) {
        throw new Error(replacementChange?.lastError ?? "Replacement checkout could not be prepared");
      }
      if (replacementChange.status !== "AWAITING_PAYMENT"
        || replacementChange.operationStatus !== "CHECKOUT_OPEN"
        || replacementChange.failureCode === "CANDIDATE_CANCELLATION_PENDING"
        || replacementChange.failureCategory === "MANUAL_REVIEW_REQUIRED") {
        return {
          change: replacementChange,
          operation: serializeBillingOperation(replacementChange),
          processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(replacementChange.id)}`,
        };
      }
      return this.toCheckoutPayload(
        organization,
        replacementChange.replacementSubscription,
        selectedPlan,
        replacementChange,
        { purpose: "REPLACEMENT" }
      );
    }
    return {
      change: current,
      operation: serializeBillingOperation(current),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
    };
  }

  static async createPaymentMethodReplacement(
    userId: string,
    organizationId: string,
    idempotencyKey: string,
    returnPath?: unknown
  ) {
    assertRazorpayBillingWritesEnabled(organizationId);
    if (!areRazorpayMultiMethodSubscriptionsEnabled()) {
      throw new Error("Multi-method billing is not enabled yet");
    }
    const organization = await OrganizationService.getOrganizationForOwnerAccess(
      organizationId,
      userId
    );
    const subscription = organization.subscription;
    if (!subscription) throw new Error("Subscription not found");
    assertSubscriptionProviderMode(subscription, resolveRazorpayMode());
    if (!isSupportedProviderPaymentMethod(subscription.providerPaymentMethod)
      || ["CREATED", "CANCELLED", "COMPLETED", "EXPIRED"].includes(subscription.status)) {
      throw new Error("An active recurring mandate is required before changing payment method");
    }
    const plan = getActiveBillingPlan(subscription.plan);
    const change = await BillingMutationService.enqueue({
      organizationId,
      subscriptionId: subscription.id,
      idempotencyKey,
      type: "PAYMENT_METHOD_REPLACEMENT",
      fromPlan: subscription.plan,
      toPlan: subscription.plan,
      fromQuantity: subscription.quantity,
      toQuantity: subscription.quantity,
      createdByUserId: userId,
      returnPath: getSafeReturnPath(returnPath, organizationId),
    });
    const processed = change.status === "FAILED"
      && !change.replacementSubscriptionId
      && change.failureCategory !== "MANUAL_REVIEW_REQUIRED"
      ? await BillingMutationService.retry(change.id)
      : await BillingMutationService.processNext(organizationId);
    const replacementChange = await prisma.organizationBillingChange.findUnique({
      where: { id: processed?.id ?? change.id },
      include: { replacementSubscription: true },
    });
    if (!replacementChange?.replacementSubscription
      && ["QUEUED", "PROCESSING"].includes(replacementChange?.status ?? change.status)) {
      return {
        change: replacementChange ?? change,
        operation: serializeBillingOperation(replacementChange ?? change),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
      };
    }
    if (!replacementChange?.replacementSubscription) {
      throw new Error(replacementChange?.lastError ?? "Payment-method checkout could not be prepared");
    }
    if (replacementChange.status !== "AWAITING_PAYMENT"
      || replacementChange.operationStatus !== "CHECKOUT_OPEN"
      || replacementChange.failureCode === "CANDIDATE_CANCELLATION_PENDING"
      || replacementChange.failureCategory === "MANUAL_REVIEW_REQUIRED") {
      return {
        change: replacementChange,
        operation: serializeBillingOperation(replacementChange),
        processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(replacementChange.id)}`,
      };
    }
    return this.toCheckoutPayload(
      organization,
      replacementChange.replacementSubscription,
      plan,
      replacementChange,
      { purpose: "REPLACEMENT" }
    );
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
    assertRazorpayBillingWritesEnabled(organizationId);
    const subscription = organization.subscription;
    if (!subscription) throw new Error("Subscription not found");
    assertSubscriptionProviderMode(subscription, resolveRazorpayMode());
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
    assertRazorpayBillingWritesEnabled(organizationId);
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const subscription = organization.subscription;
    if (!subscription || !["PENDING", "HALTED"].includes(subscription.status)) {
      throw new Error("Payment recovery is only available for pending or halted subscriptions");
    }
    assertSubscriptionProviderMode(subscription, resolveRazorpayMode());
    let hostedRecoveryUrl: string | null = null;
    if (areRazorpayMultiMethodSubscriptionsEnabled()) {
      const gateway = await getRazorpayClient().fetchSubscription(subscription.razorpaySubscriptionId);
      if (gateway.id !== subscription.razorpaySubscriptionId) {
        throw new Error("Razorpay recovery subscription mismatch");
      }
      hostedRecoveryUrl = safeRazorpayHostedUrl(gateway.short_url);
      if (!hostedRecoveryUrl && subscription.providerPaymentMethod !== "CARD") {
        return this.createPaymentMethodReplacement(
          userId,
          organizationId,
          `payment-recovery-replacement:${subscription.razorpaySubscriptionId}`,
          returnPath
        );
      }
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
    const checkout = this.toCheckoutPayload(
      organization,
      subscription,
      { ...catalogPlan, amount: subscription.amount },
      operation,
      { recovery: true }
    );
    if (hostedRecoveryUrl) {
      const { subscription_card_change: _cardFallback, ...methodNeutralCheckout } = checkout;
      void _cardFallback;
      return { ...methodNeutralCheckout, hostedRecoveryUrl };
    }
    return checkout;
  }

  static async getBillingOperation(userId: string, organizationId: string, changeId: string) {
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    await expireOverdueAuthorizationOperations(organizationId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: { id: changeId, organizationId },
      include: { organizationSubscription: true, replacementSubscription: true },
    });
    if (!change) throw new Error("Billing operation not found");
    assertSubscriptionProviderMode(change.organizationSubscription, resolveRazorpayMode());
    assertSubscriptionProviderMode(change.replacementSubscription, resolveRazorpayMode());
    const replacementPlan = change.replacementSubscription
      ? getBillingPlan(change.replacementSubscription.plan)
      : null;
    return {
      operation: serializeBillingOperation(change),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
      ...(change.operationStatus === "CHECKOUT_OPEN"
        && change.replacementSubscription
        && replacementPlan
        ? {
            checkout: this.toCheckoutPayload(
              organization,
              change.replacementSubscription,
              replacementPlan,
              change,
              { purpose: "REPLACEMENT" }
            ),
          }
        : {}),
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
      where: {
        id: changeId,
        organizationId,
        type: { in: [...CHECKOUT_BILLING_CHANGE_TYPES] },
      },
      include: { organizationSubscription: true, replacementSubscription: true },
    });
    if (!change) throw new Error("Billing operation not found");
    assertSubscriptionProviderMode(change.organizationSubscription, resolveRazorpayMode());
    assertSubscriptionProviderMode(change.replacementSubscription, resolveRazorpayMode());
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
    if (change.replacementSubscriptionId && terminal) {
      // Browser events are hints only. A delayed success callback can race an
      // abandon/decline event, so never cancel or terminalize a provider
      // mandate until Razorpay has been fetched and reconciled server-side.
      await prisma.organizationBillingChange.updateMany({
        where: { id: change.id, operationStatus: "CHECKOUT_OPEN" },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
          failureCategory: normalizedFailureCategory(input, event),
          failureCode: normalizedFailureCode(input),
          providerPaymentId: checkoutPaymentId(input.paymentId),
          lastError: "Checkout reported an incomplete authorization; Razorpay confirmation is still being verified",
          resolvedAt: null,
        },
      });
      try {
        await BillingReconciliationService.reconcileProviderSubscription(
          change.replacementSubscription!.razorpaySubscriptionId,
          { paymentId: checkoutPaymentId(input.paymentId) ?? undefined, now }
        );
        await BillingReplacementService.syncAuthorizedAccess(change.id, now);
      } catch {
        // Provider confirmation is deliberately best-effort here. The durable
        // deadline/reconciliation worker will retry without trusting the client.
      }
      const refreshed = await prisma.organizationBillingChange.findUniqueOrThrow({
        where: { id: change.id },
      });
      return { operation: serializeBillingOperation(refreshed) };
    }
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
          ? "Payment authorization was declined; the confirmed billing state is unchanged"
          : event === "FAILED"
            ? "Checkout could not confirm payment authorization; the confirmed billing state is unchanged"
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
      include: { organizationSubscription: true, replacementSubscription: true },
    });
    if (!change) throw new Error("Billing operation not found");
    if (change.failureCategory === "MANUAL_REVIEW_REQUIRED"
      || change.type === "COMMERCIAL_RECONCILIATION") {
      // Manual resolution is reconciliation-only. It may adopt exact provider
      // facts locally, but it must never reopen Checkout or issue a mutation.
      return this.reconcileMutation(
        userId,
        organizationId,
        change.id,
        change.providerPaymentId ?? undefined
      );
    }

    if (change.replacementSubscription) {
      assertRazorpayBillingWritesEnabled(organizationId);
      assertSubscriptionProviderMode(change.replacementSubscription, resolveRazorpayMode());
      if (change.status === "APPLIED") {
        return { operation: serializeBillingOperation(change), reconciled: true };
      }
      if (change.failureCode === "CANDIDATE_CANCELLATION_PENDING") {
        throw new Error("The failed replacement mandate is still being cancelled; retry after provider confirmation");
      }
      if (["UNDONE", "SUPERSEDED"].includes(change.status)) {
        throw new Error("The replacement mandate was discarded and cannot be retried");
      }
      if (change.undoCutoffAt && change.undoCutoffAt <= new Date()) {
        throw new Error("The replacement authorization window has closed");
      }
      if (change.replacementSubscription.pendingReplacementOrganizationId !== organizationId) {
        throw new Error("The replacement mandate is no longer pending for this workspace");
      }
      if (change.status === "SCHEDULED" || change.providerConfirmedAt) {
        return this.getBillingOperation(userId, organizationId, change.id);
      }
      const gateway = await getRazorpayClient().fetchSubscription(
        change.replacementSubscription.razorpaySubscriptionId
      );
      if (["cancelled", "completed", "expired"].includes(gateway.status.toLowerCase())) {
        throw new Error("The replacement mandate is no longer reusable; discard it and start again");
      }
      await BillingReconciliationService.reconcileProviderSubscription(
        change.replacementSubscription.razorpaySubscriptionId,
        { now: new Date(), commercialIntentChangeId: change.id }
      );
      const synchronized = await BillingReplacementService.syncAuthorizedAccess(change.id);
      if (["SCHEDULED", "APPLIED"].includes(synchronized.change.status)) {
        return this.getBillingOperation(userId, organizationId, change.id);
      }
      await prisma.organizationBillingChange.update({
        where: { id: change.id },
        data: {
          status: "AWAITING_PAYMENT",
          operationStatus: "CHECKOUT_OPEN",
          failureCategory: null,
          failureCode: null,
          failedAt: null,
          declinedAt: null,
          abandonedAt: null,
          resolvedAt: null,
          lastError: null,
          checkoutOpenedAt: new Date(),
        },
      });
      return this.getBillingOperation(userId, organizationId, change.id);
    }

    if (change.type === "SUBSCRIPTION_AUTHORIZATION") {
      assertRazorpayBillingWritesEnabled(organizationId);
      const subscription = change.organizationSubscription;
      if (!subscription) throw new Error("Subscription not found");
      assertSubscriptionProviderMode(subscription, resolveRazorpayMode());
      if (isProviderConfirmedOperationStatus(change.operationStatus)) {
        return { operation: serializeBillingOperation(change), reconciled: true };
      }
      const retryVerificationStartedAt = new Date();
      const retryClaim = await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          attemptCount: change.attemptCount,
          operationStatus: {
            notIn: [...PROVIDER_CONFIRMED_OPERATION_STATUSES, "VERIFYING"],
          },
        },
        data: {
          operationStatus: "VERIFYING",
          verificationStartedAt: retryVerificationStartedAt,
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
      let reconciliation: Awaited<ReturnType<
        typeof BillingReconciliationService.reconcileProviderSubscription
      >>;
      try {
        reconciliation = await BillingReconciliationService.reconcileProviderSubscription(
          subscription.razorpaySubscriptionId,
          {
            paymentId: change.providerPaymentId,
            commercialIntentChangeId: change.id,
            expectedAttemptCount: change.attemptCount,
            expectedVerificationStartedAt: retryVerificationStartedAt,
          }
        );
      } catch (error) {
        if (error instanceof BillingManualReviewRequiredError) throw error;
        await prisma.organizationBillingChange.updateMany({
          where: {
            id: change.id,
            operationStatus: "VERIFYING",
            attemptCount: change.attemptCount,
            verificationStartedAt: retryVerificationStartedAt,
          },
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
      if (["AUTHORIZATION_ONLY", "EXACT_SETTLEMENT"].includes(reconciliation.evidenceKind)) {
        await this.applyProviderConfirmedAuthorization(
          reconciliation.commercialIntentChangeId,
          reconciliation.subscription,
          reconciliation.payment,
          reconciliation.evidenceKind
        );
        const applied = await prisma.organizationBillingChange.findUniqueOrThrow({
          where: { id: change.id },
        });
        if (isProviderConfirmedOperationStatus(applied.operationStatus)) {
          return { operation: serializeBillingOperation(applied), reconciled: true };
        }
      } else if (reconciliation.evidenceKind === "DEFINITELY_REJECTED"
        && reconciliation.payment) {
        await this.applyProviderFailedAuthorization(
          reconciliation.commercialIntentChangeId,
          reconciliation.subscription,
          reconciliation.payment,
          reconciliation.evidenceKind
        );
      }
      const catalogPlan = getBillingPlan(subscription.plan);
      if (!catalogPlan) throw new Error("Subscription plan is no longer recognized");
      const selectedPlan = { ...catalogPlan, amount: subscription.amount };
      await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          OR: [
            {
              operationStatus: "VERIFYING",
              attemptCount: change.attemptCount,
              verificationStartedAt: retryVerificationStartedAt,
            },
            ...(reconciliation.evidenceKind === "DEFINITELY_REJECTED"
              ? [{
                  operationStatus: {
                    in: ["DECLINED", "FAILED"] as ("DECLINED" | "FAILED")[],
                  },
                }]
              : []),
          ],
          AND: [{
            OR: [
              { failureCategory: null },
              { failureCategory: { not: "MANUAL_REVIEW_REQUIRED" } },
            ],
          }],
        },
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

    const safeProviderRetry = isSafeFailedBillingMutationForLocalUndo(change.failureCategory);
    const retried = await BillingMutationService.retry(change.id);
    const current = retried ?? await prisma.organizationBillingChange.findUnique({ where: { id: change.id } });
    if (!current) throw new Error("Billing operation not found after retry");
    return {
      operation: serializeBillingOperation(current),
      processingUrl: `/org/${encodeURIComponent(organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
      resolutionOutcome: safeProviderRetry
        ? "SAFE_RETRY_SUBMITTED" as const
        : "PROVIDER_STATE_ADOPTED" as const,
    };
  }

  static async reconcileMutation(userId: string, organizationId: string, changeId: string, paymentId?: string) {
    await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    await expireOverdueAuthorizationOperations(organizationId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: { id: changeId, organizationId },
      include: { organizationSubscription: true, replacementSubscription: true },
    });
    if (!change) throw new Error("Billing change not found");
    assertSubscriptionProviderMode(change.organizationSubscription, resolveRazorpayMode());
    assertSubscriptionProviderMode(change.replacementSubscription, resolveRazorpayMode());
    const manualReview = change.failureCategory === "MANUAL_REVIEW_REQUIRED"
      || change.type === "COMMERCIAL_RECONCILIATION";
    if (isTerminalCheckoutOperationStatus(change.operationStatus) && !manualReview) {
      return {
        reconciliation: null,
        pending: false,
        operation: serializeBillingOperation(change),
      };
    }

    let verificationStartedAt: Date | null = null;
    if (!manualReview) {
      verificationStartedAt = new Date();
      const providerCooldownBefore = new Date(verificationStartedAt.getTime() - 8_000);
      const reconciliationClaim = await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: {
            notIn: [...TERMINAL_CHECKOUT_OPERATION_STATUSES],
          },
          OR: [
            {
              operationStatus: { not: "VERIFYING" },
              OR: [
                { verificationStartedAt: null },
                { verificationStartedAt: { lte: providerCooldownBefore } },
              ],
            },
            {
              operationStatus: "VERIFYING",
              verificationStartedAt: { lte: providerCooldownBefore },
            },
          ],
        },
        data: { operationStatus: "VERIFYING", verificationStartedAt },
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
    let reconciliation: Awaited<ReturnType<typeof BillingReconciliationService.reconcileProviderSubscription>>;
    try {
      reconciliation = change.replacementSubscription
        ? await BillingReconciliationService.reconcileProviderSubscription(
            change.replacementSubscription.razorpaySubscriptionId,
            {
              paymentId: paymentId ?? change.providerPaymentId,
              commercialIntentChangeId: change.id,
              ...(verificationStartedAt
                ? {
                    expectedAttemptCount: change.attemptCount,
                    expectedVerificationStartedAt: verificationStartedAt,
                  }
                : {}),
            }
          )
        : await BillingReconciliationService.reconcileByOrganization(organizationId, {
            paymentId: paymentId ?? change.providerPaymentId,
            commercialIntentChangeId: change.id,
            ...(verificationStartedAt
              ? {
                  expectedAttemptCount: change.attemptCount,
                  expectedVerificationStartedAt: verificationStartedAt,
                }
              : {}),
          });
      if (manualReview
        && !["AUTHORIZATION_ONLY", "EXACT_SETTLEMENT"].includes(reconciliation.evidenceKind)) {
        const retained = await this.retainManualReviewAfterReconciliationFailure(
          change.id,
          new Error(reconciliation.evidenceKind === "DEFINITELY_REJECTED"
            ? "Provider authorization was rejected; replacement cleanup still requires manual review"
            : "Provider evidence is still pending")
        );
        throw new BillingManualReviewRequiredError(retained.id);
      }
      if (change.replacementSubscription) {
        const now = new Date();
        if (["AUTHORIZATION_ONLY", "EXACT_SETTLEMENT"].includes(reconciliation.evidenceKind)) {
          const synchronized = await BillingReplacementService.syncAuthorizedAccess(
            change.id,
            now,
            { resolveManualReview: manualReview }
          );
          if (manualReview && !["SCHEDULED", "APPLIED"].includes(synchronized.change.status)) {
            const retained = await this.retainManualReviewAfterReconciliationFailure(
              change.id,
              new Error("Provider evidence was exact, but the manual-review state changed before adoption")
            );
            throw new BillingManualReviewRequiredError(retained.id);
          }
        }
        if (!manualReview && change.undoCutoffAt && now >= change.undoCutoffAt) {
          await BillingReplacementService.scheduleSourceCancellation(change.id, now);
        }
        if (reconciliation.confirmedPaidPeriod && change.organizationSubscription) {
          await BillingReconciliationService.reconcileProviderSubscription(
            change.organizationSubscription.razorpaySubscriptionId,
            { now }
          );
        }
        const promotion = await BillingReplacementService.promoteIfReady(change.id, now);
        const replacementOperation = await prisma.organizationBillingChange.findUnique({
          where: { id: change.id },
        });
        return {
          reconciliation,
          pending: !promotion.promoted,
          operation: replacementOperation ? serializeBillingOperation(replacementOperation) : null,
          ...(manualReview ? { resolutionOutcome: "PROVIDER_STATE_ADOPTED" as const } : {}),
        };
      }
      if (change.type === "SUBSCRIPTION_AUTHORIZATION") {
        if (reconciliation.evidenceKind === "DEFINITELY_REJECTED" && reconciliation.payment) {
          await this.applyProviderFailedAuthorization(
            reconciliation.commercialIntentChangeId,
            reconciliation.subscription,
            reconciliation.payment,
            reconciliation.evidenceKind
          );
        } else if (["AUTHORIZATION_ONLY", "EXACT_SETTLEMENT"].includes(reconciliation.evidenceKind)) {
          await this.applyProviderConfirmedAuthorization(
            reconciliation.commercialIntentChangeId,
            reconciliation.subscription,
            reconciliation.payment,
            reconciliation.evidenceKind
          );
        }
      }
    } catch (error) {
      if (error instanceof BillingManualReviewRequiredError) throw error;
      if (manualReview) {
        const retained = await this.retainManualReviewAfterReconciliationFailure(change.id, error);
        if (retained.failureCategory !== "MANUAL_REVIEW_REQUIRED") {
          return {
            reconciliation: null,
            pending: !isProviderConfirmedOperationStatus(retained.operationStatus),
            operation: serializeBillingOperation(retained),
          };
        }
        throw new BillingManualReviewRequiredError(
          retained.id,
          "Provider reconciliation is unavailable; manual billing review is still required"
        );
      }
      await prisma.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          operationStatus: "VERIFYING",
          attemptCount: change.attemptCount,
          verificationStartedAt,
        },
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

    // A normal provider response can still say that authorization has not
    // happened yet. Never strand the operation in the transient VERIFYING
    // state; only a subsequent callback/webhook/provider result can advance it.
    await prisma.organizationBillingChange.updateMany({
      where: {
        id: change.id,
        operationStatus: "VERIFYING",
        attemptCount: change.attemptCount,
        verificationStartedAt,
      },
      data: {
        status: "AWAITING_PAYMENT",
        operationStatus: "AWAITING_PROVIDER_CONFIRMATION",
        failureCategory: "PROVIDER_CONFIRMATION_PENDING",
        lastError: "Razorpay has not confirmed payment authorization yet; the confirmed billing state is unchanged",
        resolvedAt: null,
      },
    });
    const updated = await prisma.organizationBillingChange.findUnique({ where: { id: change.id } });
    return {
      reconciliation,
      operation: updated ? serializeBillingOperation(updated) : null,
      ...(manualReview ? { resolutionOutcome: "PROVIDER_STATE_ADOPTED" as const } : {}),
    };
  }

  static async undoWorkspaceChange(userId: string, organizationId: string, changeId: string) {
    const organization = await OrganizationService.getOrganizationForOwnerAccess(organizationId, userId);
    const change = await prisma.organizationBillingChange.findFirst({
      where: {
        id: changeId,
        organizationId,
        status: { in: ["QUEUED", "PROCESSING", "AWAITING_PAYMENT", "SCHEDULED", "FAILED"] },
      },
    });
    if (!change) throw new Error("Undoable billing change not found");
    if (change.status === "PROCESSING") {
      throw new BillingChangeInProgressError(
        change.id,
        "The provider mutation is still processing and cannot be undone"
      );
    }
    if (!change.replacementSubscriptionId
      && (change.status === "AWAITING_PAYMENT"
        || change.failureCategory === "MANUAL_REVIEW_REQUIRED"
        || (change.status === "FAILED"
          && !isSafeFailedBillingMutationForLocalUndo(change.failureCategory)))) {
      throw new BillingChangeInProgressError(
        change.id,
        "The provider mutation outcome must be reconciled before it can be undone"
      );
    }
    if (change.type === "CANCELLATION") return this.undoWorkspaceCancellation(userId, organizationId);
    if (change.replacementSubscriptionId) {
      await BillingReplacementService.undoReplacement(change.id);
      return { undone: true, replayed: null };
    }
    if (change.status === "SCHEDULED" && organization.subscription?.providerPaymentMethod === "CARD") {
      const result = await BillingMutationService.undoScheduledProviderChange(change.id);
      return { undone: true, replayed: result.replayed, replayError: result.replayError };
    }
    await prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
      `;
      const currentOrganization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { ownerId: true, billingMutationLeaseToken: true },
      });
      if (!currentOrganization || currentOrganization.ownerId !== userId) {
        throw new Error("Unauthorized");
      }
      if (currentOrganization?.billingMutationLeaseToken) {
        throw new BillingChangeInProgressError(
          change.id,
          "A provider mutation is still processing and cannot be undone"
        );
      }
      const current = await tx.organizationBillingChange.findFirst({
        where: { id: change.id, organizationId },
      });
      if (!current || current.status !== change.status
        || current.updatedAt.getTime() !== change.updatedAt.getTime()) {
        throw new BillingChangeInProgressError(
          change.id,
          "The billing change moved while the undo was being claimed"
        );
      }
      if (current.status === "PROCESSING"
        || current.status === "AWAITING_PAYMENT"
        || current.failureCategory === "MANUAL_REVIEW_REQUIRED"
        || (current.status === "FAILED"
          && !isSafeFailedBillingMutationForLocalUndo(current.failureCategory))) {
        throw new BillingChangeInProgressError(
          change.id,
          "The provider mutation outcome must be reconciled before it can be undone"
        );
      }
      const undoneAt = new Date();
      const undone = await tx.organizationBillingChange.updateMany({
        where: { id: current.id, status: current.status, updatedAt: current.updatedAt },
        data: {
          status: "UNDONE",
          operationStatus: "ABANDONED",
          undoneAt,
          resolvedAt: undoneAt,
        },
      });
      if (undone.count !== 1) {
        throw new BillingChangeInProgressError(
          change.id,
          "The billing change moved while the undo was being finalized"
        );
      }
    });
    return { undone: true };
  }

  private static async retainManualReviewAfterReconciliationFailure(
    changeId: string,
    error: unknown
  ) {
    return prisma.$transaction(async tx => {
      const current = await tx.organizationBillingChange.findUnique({ where: { id: changeId } });
      if (!current) throw new Error("Billing change not found during manual reconciliation");
      if (current.failureCategory !== "MANUAL_REVIEW_REQUIRED") return current;
      const retained = await tx.organizationBillingChange.updateMany({
        where: {
          id: current.id,
          status: current.status,
          operationStatus: current.operationStatus,
          updatedAt: current.updatedAt,
          failureCategory: "MANUAL_REVIEW_REQUIRED",
        },
        data: {
          lastError: error instanceof Error
            ? `Manual reconciliation could not confirm provider state: ${error.message}`
            : "Manual reconciliation could not confirm provider state",
          resolvedAt: null,
        },
      });
      if (retained.count === 1) {
        await recordBillingMutationAudit(tx, {
          changeId: current.id,
          organizationId: current.organizationId,
          organizationSubscriptionId: current.organizationSubscriptionId,
          attemptCount: current.attemptCount,
          outcome: "MANUAL_REVIEW_RETAINED",
          failureCode: current.failureCode,
        });
      }
      return tx.organizationBillingChange.findUniqueOrThrow({ where: { id: current.id } });
    });
  }

  private static async applyProviderConfirmedAuthorization(
    commercialIntentChangeId: string | null,
    subscription: OrganizationSubscription,
    payment: RazorpayPayment | null,
    evidenceKind: BillingCommercialEvidenceKind
  ) {
    if (!commercialIntentChangeId
      || !payment
      || !["AUTHORIZATION_ONLY", "EXACT_SETTLEMENT"].includes(evidenceKind)) return false;
    if (!isSupportedProviderPaymentMethod(subscription.providerPaymentMethod)) return;
    const providerAuthorizationConfirmed = ["AUTHENTICATED", "ACTIVE"].includes(subscription.status)
      && typeof payment.status === "string"
      && ["authorized", "captured"].includes(payment.status.toLowerCase());
    if (!providerAuthorizationConfirmed) return false;

    const change = await prisma.organizationBillingChange.findFirst({
      where: {
        id: commercialIntentChangeId,
        organizationId: subscription.organizationId,
        organizationSubscriptionId: subscription.id,
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: { notIn: ["UNDONE", "SUPERSEDED"] },
      },
    });
    if (!change) return false;
    if (isProviderConfirmedOperationStatus(change.operationStatus)) return true;

    const now = new Date();
    return prisma.$transaction(async tx => {
      const applied = await tx.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          status: change.status,
          operationStatus: change.operationStatus,
          updatedAt: change.updatedAt,
          NOT: { status: { in: ["UNDONE", "SUPERSEDED"] } },
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
      });
      if (applied.count !== 1) return false;
      if (!subscription.authPaymentId) {
        await tx.organizationSubscription.update({
          where: { id: subscription.id },
          data: { authPaymentId: payment.id },
        });
      }
      if (change.failureCategory === "MANUAL_REVIEW_REQUIRED") {
        await recordBillingMutationAudit(tx, {
          changeId: change.id,
          organizationId: change.organizationId,
          organizationSubscriptionId: change.organizationSubscriptionId,
          attemptCount: change.attemptCount,
          outcome: "PROVIDER_STATE_ADOPTED",
        });
      }
      return true;
    });
  }

  private static async applyProviderFailedAuthorization(
    commercialIntentChangeId: string | null,
    subscription: OrganizationSubscription,
    payment: RazorpayPayment,
    evidenceKind: BillingCommercialEvidenceKind
  ) {
    if (!commercialIntentChangeId
      || evidenceKind !== "DEFINITELY_REJECTED"
      || typeof payment.status !== "string"
      || payment.status.toLowerCase() !== "failed") return false;
    const change = await prisma.organizationBillingChange.findFirst({
      where: {
        id: commercialIntentChangeId,
        organizationId: subscription.organizationId,
        organizationSubscriptionId: subscription.id,
        type: "SUBSCRIPTION_AUTHORIZATION",
        status: { notIn: ["UNDONE", "SUPERSEDED"] },
      },
    });
    if (!change) return false;

    const event = providerFailedCheckoutEvent(payment);
    const now = new Date();
    const failureInput: CheckoutEventInput = {
      event,
      failureCategory: payment.error_reason ?? undefined,
      failureCode: payment.error_code ?? undefined,
      reason: payment.error_reason ?? undefined,
      source: payment.error_source ?? undefined,
      step: payment.error_step ?? undefined,
      paymentId: payment.id,
    };
    return prisma.$transaction(async tx => {
      const resolved = await tx.organizationBillingChange.updateMany({
        where: {
          id: change.id,
          status: change.status,
          operationStatus: change.operationStatus,
          updatedAt: change.updatedAt,
          NOT: { status: { in: ["UNDONE", "SUPERSEDED"] } },
        },
        data: {
          status: event === "ABANDONED" ? "UNDONE" : "FAILED",
          operationStatus: event,
          providerPaymentId: payment.id,
          failureCategory: normalizedFailureCategory(failureInput, event),
          failureCode: normalizedFailureCode(failureInput),
          lastError: event === "ABANDONED"
            ? "Checkout was cancelled before payment authorization"
            : event === "DECLINED"
              ? "Payment authorization was declined; the confirmed billing state is unchanged"
              : "Razorpay reported that payment authorization failed; the confirmed billing state is unchanged",
          declinedAt: event === "DECLINED" ? now : null,
          abandonedAt: event === "ABANDONED" ? now : null,
          failedAt: event === "DECLINED" || event === "FAILED" ? now : null,
          undoneAt: event === "ABANDONED" ? now : null,
          resolvedAt: now,
        },
      });
      if (resolved.count === 1 && change.failureCategory === "MANUAL_REVIEW_REQUIRED") {
        await recordBillingMutationAudit(tx, {
          changeId: change.id,
          organizationId: change.organizationId,
          organizationSubscriptionId: change.organizationSubscriptionId,
          attemptCount: change.attemptCount,
          outcome: "PROVIDER_STATE_ADOPTED",
        });
      }
      return resolved.count === 1;
    });
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
            processingError: null,
          },
        });

        return {
          ok: true,
          ...result,
        };
      }, { maxWait: 10_000, timeout: 30_000 });

      if ("duplicate" in processed && processed.duplicate) {
        return processed;
      }

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
          const replacementChange = await prisma.organizationBillingChange.findUnique({
            where: { replacementSubscriptionId: reconciliation.subscription.id },
            include: { organizationSubscription: true },
          });
          if (replacementChange) {
            const now = new Date();
            if (reconciliation.payment?.status === "failed") {
              await BillingReplacementService.failReplacementCheckout(
                replacementChange.id,
                "FAILED",
                now,
                reconciliation.payment.error_description ?? "Razorpay reported a failed replacement payment"
              );
            } else {
              await BillingReplacementService.syncAuthorizedAccess(replacementChange.id, now);
              if (replacementChange.undoCutoffAt && now >= replacementChange.undoCutoffAt) {
                await BillingReplacementService.scheduleSourceCancellation(replacementChange.id, now);
              }
              if (reconciliation.confirmedPaidPeriod && replacementChange.organizationSubscription) {
                await BillingReconciliationService.reconcileProviderSubscription(
                  replacementChange.organizationSubscription.razorpaySubscriptionId,
                  { now }
                );
              }
              await BillingReplacementService.promoteIfReady(replacementChange.id, now);
            }
          } else if (reconciliation.evidenceKind === "DEFINITELY_REJECTED"
            && reconciliation.payment) {
            await this.applyProviderFailedAuthorization(
              reconciliation.commercialIntentChangeId,
              reconciliation.subscription,
              reconciliation.payment,
              reconciliation.evidenceKind
            );
          } else if (["AUTHORIZATION_ONLY", "EXACT_SETTLEMENT"].includes(
            reconciliation.evidenceKind
          )) {
            await this.applyProviderConfirmedAuthorization(
              reconciliation.commercialIntentChangeId,
              reconciliation.subscription,
              reconciliation.payment,
              reconciliation.evidenceKind
            );
          }
        }
      }

      await prisma.razorpayWebhookEvent.updateMany({
        where: {
          eventId: safeEventId,
          payloadHash,
          processedAt: null,
        },
        data: {
          processedAt: new Date(),
          processingError: null,
        },
      });

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
    options: { recovery?: boolean; purpose?: "INITIAL" | "REPLACEMENT" } = {}
  ) {
    const now = new Date();
    const activeTrialEndsAt = org.ownerTrialGrant?.status === "ACTIVE"
      && org.ownerTrialGrant.organizationId === org.id
      && org.ownerTrialGrant.trialEndsAt
      && org.ownerTrialGrant.trialEndsAt > now
        ? org.ownerTrialGrant.trialEndsAt
        : null;
    const authorized = isSupportedProviderPaymentMethod(subscription.providerPaymentMethod)
      && !["CREATED", "CANCELLED", "COMPLETED", "EXPIRED"].includes(subscription.status);
    const unitAmount = plan.amount ?? 0;
    const estimatedMonthlyTotal = unitAmount * subscription.quantity;
    const keyId = getRazorpayKeyId();
    const checkoutDescription = `${options.recovery ? "Recover payment for " : ""}${plan.shortName}: ${subscription.quantity} ${subscription.quantity === 1 ? "branch" : "branches"}`
      + ` x Rs.${unitAmount} = Rs.${estimatedMonthlyTotal}/month`
      + (activeTrialEndsAt ? `; starts ${formatCheckoutDate(activeTrialEndsAt)}` : "");
    return {
      purpose: options.recovery
        ? "RECOVERY" as const
        : options.purpose ?? "INITIAL" as const,
      keyId,
      testMode: keyId.startsWith("rzp_test_"),
      type: "subscription" as const,
      subscriptionId: subscription.razorpaySubscriptionId,
      ...(options.recovery ? { subscription_card_change: true as const } : {}),
      amount: subscription.amountSubunits,
      currency: subscription.currency,
      name: "Lab Lords",
      description: checkoutDescription,
      ...(areRazorpayMultiMethodSubscriptionsEnabled()
        ? {}
        : { config: cardOnlyCheckoutConfig() }),
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
    const providerMode = resolveRazorpayMode();
    const event = typeof payload.event === "string" ? payload.event : "unknown";
    const payloadRoot = isRecord(payload.payload) ? payload.payload : {};
    const subscriptionEntity = getWebhookEntity<RazorpaySubscription>(payloadRoot, "subscription");
    const paymentEntity = getWebhookEntity<RazorpayPayment>(payloadRoot, "payment");
    const invoiceEntity = getWebhookEntity<RazorpayInvoice>(payloadRoot, "invoice");
    const subscriptionId = subscriptionEntity?.id
      ?? paymentEntity?.subscription_id
      ?? invoiceEntity?.subscription_id
      ?? null;
    const paymentId = paymentEntity?.id ?? invoiceEntity?.payment_id ?? null;

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
    assertSubscriptionProviderMode(subscription, providerMode);

    const updateData: Prisma.OrganizationSubscriptionUpdateInput = {};
    if (subscriptionEntity) {
      const snapshot = subscriptionSnapshotData(subscriptionEntity);
      // A signed webhook is a reconciliation trigger, not sufficient proof of
      // a seat change. Quantity is accepted only after a provider fetch checks
      // the matching serialized billing operation.
      delete snapshot.quantity;
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
