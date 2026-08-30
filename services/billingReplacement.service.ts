import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { BillingChangeInProgressError, BillingReplacementNotReadyError } from "@/lib/billingErrors";
import {
  getRazorpayClient,
  fromRazorpaySubunits,
  resolveRazorpayMode,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import { getBillingPlan } from "@/lib/billingPlans";
import { assertRazorpayBillingWritesEnabled } from "@/lib/billingFeature";
import { ensureRazorpayPlanCatalogEntry } from "@/services/razorpayPlanCatalog.service";
import { normalizeProviderPaymentMethod } from "@/services/billingPaymentMethod.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import {
  buildCommercialIntentSnapshot,
  captureProcessingCommercialIntent,
  readCommercialIntentSnapshot,
} from "@/services/billingCommercialEvidence.service";
import {
  addCalendarMonthsUtc,
  getReplacementChargeGraceEndsAt,
  getReplacementUndoCutoffAt,
  getSafeReplacementCycleBoundary,
  isReplacementAuthorizationReady,
  isReplacementMutationEligible,
  isReplacementPromotionReady,
  isSupportedRecurringPaymentMethod,
  normalizeReplacementPaymentMethod,
} from "@/services/billingReplacementPolicy";
import type {
  BillingChangeType,
  OrganizationBillingChange,
  OrganizationSubscription,
  Prisma,
  SaasSubscriptionStatus,
} from "@/app/generated/prisma/client";

const TERMINAL_PROVIDER_STATUSES = new Set(["cancelled", "completed", "expired"]);
const OPEN_CHANGE_STATUSES = ["QUEUED", "PROCESSING", "AWAITING_PAYMENT", "SCHEDULED"] as const;
const REPLACEMENT_PROVIDER_LEASE_MS = 2 * 60 * 1000;
const TRUSTWORTHY_REPLACEMENT_ACCESS_STATUSES = new Set(["AUTHENTICATED", "ACTIVE"]);
const IMMEDIATE_ACCESS_CHANGE_TYPES = new Set([
  "TRIAL_SUBSCRIPTION_UPDATE",
  "PLAN_UPGRADE",
  "QUANTITY_INCREASE",
  "BRANCH_REACTIVATION",
]);

export type ReplacementAccessAction = "GRANT" | "REVOKE" | "NONE";

export type ReplacementAccessDecisionInput = {
  changeType: string;
  changeStatus: string;
  failureCategory: string | null | undefined;
  sourcePlan: string;
  sourceQuantity: number;
  targetPlan: string;
  targetQuantity: number;
  candidatePlan: string;
  candidateQuantity: number;
  candidateStatus: string;
  candidatePaymentMethod: string | null | undefined;
  candidateProviderPlanId: string;
  targetProviderPlanId: string | null | undefined;
  accessGrantedAt: Date | null;
  accessRevokedAt: Date | null;
  effectiveAt: Date | null;
  accessGraceEndsAt: Date | null;
  now: Date;
};

type ReplacementAccessTrustInput = Pick<
  ReplacementAccessDecisionInput,
  | "changeStatus"
  | "failureCategory"
  | "candidateStatus"
  | "candidatePaymentMethod"
  | "effectiveAt"
  | "accessGraceEndsAt"
  | "now"
>;

function hasTrustworthyReplacementAccessState(input: ReplacementAccessTrustInput) {
  if (!OPEN_CHANGE_STATUSES.includes(
    input.changeStatus as typeof OPEN_CHANGE_STATUSES[number]
  ) || input.failureCategory === "MANUAL_REVIEW_REQUIRED") return false;
  if (!isSupportedRecurringPaymentMethod(input.candidatePaymentMethod)) return false;

  const candidateStatus = input.candidateStatus.trim().toUpperCase();
  if (TRUSTWORTHY_REPLACEMENT_ACCESS_STATUSES.has(candidateStatus)) return true;

  return candidateStatus === "PENDING"
    && normalizeReplacementPaymentMethod(input.candidatePaymentMethod) === "EMANDATE"
    && input.effectiveAt != null
    && input.now >= input.effectiveAt
    && input.accessGraceEndsAt != null
    && input.now < input.accessGraceEndsAt;
}

function planRank(plan: string) {
  if (plan === "PRO") return 2;
  if (plan === "BASIC") return 1;
  return 0;
}

function isImmediateAccessIncrease(input: Pick<
  ReplacementAccessDecisionInput,
  "changeType" | "sourcePlan" | "sourceQuantity" | "targetPlan" | "targetQuantity"
>) {
  if (!IMMEDIATE_ACCESS_CHANGE_TYPES.has(input.changeType)) return false;
  if (planRank(input.targetPlan) < planRank(input.sourcePlan)) return false;
  if (input.changeType === "TRIAL_SUBSCRIPTION_UPDATE") {
    return input.targetQuantity >= input.sourceQuantity
      && (
        planRank(input.targetPlan) > planRank(input.sourcePlan)
        || input.targetQuantity > input.sourceQuantity
      );
  }
  if (input.changeType === "PLAN_UPGRADE") {
    return planRank(input.targetPlan) > planRank(input.sourcePlan)
      && input.targetQuantity >= input.sourceQuantity;
  }
  return input.targetPlan === input.sourcePlan
    && input.targetQuantity > input.sourceQuantity;
}

/**
 * Decides whether complimentary replacement access may be changed. This is
 * deliberately independent from canonical billing promotion: authorization
 * can grant an upgrade/addition, while downgrades and removals wait for the
 * paid cutover.
 */
export function getReplacementAccessAction(
  input: ReplacementAccessDecisionInput
): ReplacementAccessAction {
  if (input.changeStatus === "APPLIED" || input.accessRevokedAt) return "NONE";
  if (!hasTrustworthyReplacementAccessState(input)) {
    return input.accessGrantedAt ? "REVOKE" : "NONE";
  }
  if (input.accessGrantedAt || !isImmediateAccessIncrease(input)) return "NONE";
  if (input.candidatePlan !== input.targetPlan
    || input.candidateQuantity !== input.targetQuantity
    || !input.targetProviderPlanId) return "NONE";
  return isReplacementAuthorizationReady({
    providerStatus: input.candidateStatus,
    paymentMethod: input.candidatePaymentMethod,
    providerPlanId: input.candidateProviderPlanId,
    providerQuantity: input.candidateQuantity,
    targetPlanId: input.targetProviderPlanId,
    targetQuantity: input.targetQuantity,
  }) ? "GRANT" : "NONE";
}

export type AuthorizedReplacementOverrideInput = {
  changeType: string;
  changeStatus: string;
  failureCategory: string | null | undefined;
  sourceSubscriptionId: string;
  changeSourceSubscriptionId: string | null;
  candidateSubscriptionId: string;
  changeCandidateSubscriptionId: string | null;
  sourcePlan: string;
  sourceQuantity: number;
  candidatePlan: string;
  candidateQuantity: number;
  candidateStatus: string;
  candidatePaymentMethod: string | null | undefined;
  accessGrantedAt: Date | null;
  accessRevokedAt: Date | null;
  effectiveAt: Date | null;
  accessGraceEndsAt: Date | null;
  now: Date;
};

/** Returns the fail-closed read override represented by a granted change. */
export function deriveAuthorizedReplacementOverride(
  input: AuthorizedReplacementOverrideInput
) {
  if (!input.accessGrantedAt || input.accessRevokedAt) return null;
  if (input.changeSourceSubscriptionId !== input.sourceSubscriptionId
    || input.changeCandidateSubscriptionId !== input.candidateSubscriptionId) return null;
  if (!hasTrustworthyReplacementAccessState(input)) return null;
  if (!isSupportedRecurringPaymentMethod(input.candidatePaymentMethod)) return null;
  if (!isImmediateAccessIncrease({
    changeType: input.changeType,
    sourcePlan: input.sourcePlan,
    sourceQuantity: input.sourceQuantity,
    targetPlan: input.candidatePlan,
    targetQuantity: input.candidateQuantity,
  })) return null;
  return {
    plan: input.candidatePlan,
    accessGrantedAt: input.accessGrantedAt,
    accessRevokedAt: input.accessRevokedAt,
    graceEndsAt: normalizeReplacementPaymentMethod(input.candidatePaymentMethod) === "EMANDATE"
      ? input.accessGraceEndsAt
      : null,
  };
}

type ReplacementWithSource = OrganizationBillingChange & {
  organizationSubscription: (OrganizationSubscription & {
    billingOffer: {
      durationType: "SINGLE_USE" | "LIMITED_CYCLES";
      durationCycles: number;
    } | null;
  }) | null;
  replacementSubscription: OrganizationSubscription | null;
};

function dateFromTimestamp(value: number | null | undefined) {
  return value && value > 0 ? new Date(value * 1000) : null;
}

function timestamp(value: Date) {
  return Math.floor(value.getTime() / 1000);
}

function mapProviderStatus(value: string): SaasSubscriptionStatus {
  const normalized = value.trim().toUpperCase();
  return [
    "CREATED",
    "AUTHENTICATED",
    "ACTIVE",
    "PENDING",
    "PAUSED",
    "HALTED",
    "CANCELLED",
    "COMPLETED",
    "EXPIRED",
  ].includes(normalized)
    ? normalized as SaasSubscriptionStatus
    : "PENDING";
}

function getDefaultSubscriptionCycles() {
  const raw = process.env.RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES;
  if (raw == null || raw.trim() === "") return 120;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1200) {
    throw new Error("RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES must be an integer from 1 to 1200");
  }
  return parsed;
}

function intervalMonths(subscription: Pick<OrganizationSubscription, "period" | "interval">) {
  const period = subscription.period.trim().toLowerCase();
  if (period === "yearly" || period === "annual") return subscription.interval * 12;
  if (period !== "monthly") {
    throw new Error(`Replacement scheduling does not support the ${subscription.period} period`);
  }
  return subscription.interval;
}

function isSameProvisioningIntent(
  provider: RazorpaySubscription,
  input: {
    organizationId: string;
    changeId: string;
    sourceProviderSubscriptionId: string;
    providerMode: string;
    providerPlanId: string;
    quantity: number;
    startAt: number;
    expireBy: number;
  }
) {
  return provider.notes?.organization_id === input.organizationId
    && provider.notes?.billing_change_id === input.changeId
    && provider.notes?.replacement_source_subscription_id === input.sourceProviderSubscriptionId
    && provider.notes?.provider_mode === input.providerMode
    && provider.notes?.billing_type === "saas_subscription_replacement"
    && provider.plan_id === input.providerPlanId
    && (provider.quantity ?? 1) === input.quantity
    && provider.start_at === input.startAt
    && provider.expire_by === input.expireBy;
}

async function releaseLease(
  tx: Prisma.TransactionClient,
  organizationId: string,
  leaseToken: string
) {
  await tx.organization.updateMany({
    where: { id: organizationId, billingMutationLeaseToken: leaseToken },
    data: { billingMutationLeaseToken: null, billingMutationLeaseUntil: null },
  });
}

export class BillingReplacementService {
  static async assertNoOpenReplacement(
    tx: Prisma.TransactionClient,
    organizationId: string,
    allowedChangeId?: string
  ) {
    const existing = await tx.organizationBillingChange.findFirst({
      where: {
        organizationId,
        status: { in: [...OPEN_CHANGE_STATUSES] },
        type: {
          in: [
            "PAYMENT_METHOD_REPLACEMENT",
            "TRIAL_SUBSCRIPTION_UPDATE",
            "PLAN_UPGRADE",
            "PLAN_DOWNGRADE",
            "QUANTITY_INCREASE",
            "BRANCH_REMOVAL",
            "BRANCH_REACTIVATION",
          ],
        },
        OR: [
          { replacementSubscriptionId: { not: null } },
          { organizationSubscription: { providerPaymentMethod: { in: ["UPI", "EMANDATE"] } } },
          { type: "PAYMENT_METHOD_REPLACEMENT" },
        ],
        ...(allowedChangeId ? { id: { not: allowedChangeId } } : {}),
      },
      orderBy: { sequence: "asc" },
    });
    if (existing) throw new BillingChangeInProgressError(existing.id);

    const pending = await tx.organizationSubscription.findUnique({
      where: { pendingReplacementOrganizationId: organizationId },
      select: { replacementBillingChange: { select: { id: true } } },
    });
    const pendingChangeId = pending?.replacementBillingChange?.id;
    if (pending && pendingChangeId !== allowedChangeId) {
      throw new BillingChangeInProgressError(pendingChangeId ?? "pending-replacement");
    }
  }

  /**
   * Provisions (or adopts) the provider candidate for a mutation already
   * claimed under BillingMutationService's organization lease.
   */
  static async provisionClaimedChange(
    changeId: string,
    leaseToken: string,
    now = new Date()
  ) {
    let change = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      include: {
        organizationSubscription: { include: { billingOffer: true } },
        replacementSubscription: true,
      },
    }) as ReplacementWithSource | null;
    if (!change || change.status !== "PROCESSING") {
      throw new Error("Claimed replacement billing change not found");
    }
    const organizationId = change.organizationId;
    const source = change.organizationSubscription;
    if (!source || source.currentOrganizationId !== change.organizationId) {
      throw new Error("Replacement source is no longer the current subscription");
    }
    if (!isReplacementMutationEligible({
      sourcePaymentMethod: source.providerPaymentMethod,
      mutationType: change.type,
    })) {
      throw new Error("This billing change does not require subscription replacement");
    }
    if (change.replacementSubscription) {
      await prisma.$transaction(tx => releaseLease(tx, organizationId, leaseToken));
      return { change, subscription: change.replacementSubscription, adopted: true };
    }

    assertRazorpayBillingWritesEnabled(change.organizationId);
    const providerMode = resolveRazorpayMode();
    if (source.providerMode !== providerMode) {
      throw new Error(`Subscription provider mode ${source.providerMode} cannot be replaced in ${providerMode} mode`);
    }
    const intendedPlan = change.toPlan ?? source.plan;
    const intendedQuantity = change.toQuantity ?? source.quantity;
    if (!Number.isInteger(intendedQuantity) || intendedQuantity < 1) {
      throw new Error("A replacement subscription must retain at least one billable branch");
    }
    let commercialIntent;
    if (change.commercialIntentVersion != null) {
      commercialIntent = readCommercialIntentSnapshot(change);
      if (commercialIntent.authorizedProviderMode !== providerMode
        || commercialIntent.authorizedRazorpaySubscriptionId
          !== source.razorpaySubscriptionId
        || commercialIntent.authorizedSourceRazorpayPlanId !== source.razorpayPlanId
        || commercialIntent.authorizedPlan !== intendedPlan
        || commercialIntent.authorizedQuantity !== intendedQuantity
        || commercialIntent.authorizedRazorpayOfferId != null) {
        throw new Error("The immutable commercial authorization does not match this replacement");
      }
    } else {
      const targetPlan = getBillingPlan(intendedPlan);
      if (!targetPlan?.amount) {
        throw new Error("Target billing plan is not available for replacement");
      }
      const mapping = await ensureRazorpayPlanCatalogEntry({
        plan: targetPlan.id,
        name: targetPlan.name,
        description: targetPlan.description,
        amount: targetPlan.amount,
        currency: targetPlan.currency,
        period: targetPlan.period,
        interval: targetPlan.interval,
      });
      if (mapping.providerMode !== providerMode) {
        throw new Error("Razorpay plan mapping belongs to the wrong provider mode");
      }
      commercialIntent = buildCommercialIntentSnapshot({
        providerMode,
        razorpaySubscriptionId: source.razorpaySubscriptionId,
        sourceRazorpayPlanId: source.razorpayPlanId,
        razorpayPlanId: mapping.razorpayPlanId,
        plan: mapping.plan,
        quantity: intendedQuantity,
        unitAmountSubunits: mapping.amountSubunits,
        currency: mapping.currency,
        period: mapping.period,
        interval: mapping.interval,
        offer: null,
        capturedAt: now,
      });
      change = await captureProcessingCommercialIntent({
        change,
        leaseToken,
        intent: commercialIntent,
      }) as ReplacementWithSource;
    }
    const targetPlanId = commercialIntent.authorizedPlan;
    const targetQuantity = commercialIntent.authorizedQuantity;
    const targetProviderPlanId = commercialIntent.authorizedRazorpayPlanId;
    const targetAmountSubunits = commercialIntent.authorizedUnitAmountSubunits;
    const targetCurrency = commercialIntent.authorizedCurrency;
    const targetPeriod = commercialIntent.authorizedPeriod;
    const targetInterval = commercialIntent.authorizedInterval;
    const targetAmount = fromRazorpaySubunits(targetAmountSubunits, targetCurrency);

    const razorpay = getRazorpayClient();
    const providerSource = await razorpay.fetchSubscription(source.razorpaySubscriptionId);
    if (providerSource.id !== source.razorpaySubscriptionId) {
      throw new Error("Razorpay source subscription mismatch during replacement");
    }
    const providerBoundary = dateFromTimestamp(providerSource.current_end);
    const futureStartBoundary = dateFromTimestamp(providerSource.start_at) ?? source.providerStartAt;
    const currentBoundary = providerBoundary
      ?? source.currentEnd
      ?? source.paidThrough
      ?? futureStartBoundary;
    if (!currentBoundary) throw new Error("A current billing-cycle boundary is required for replacement");

    const cadenceMonths = intervalMonths(source);
    let discountSafeBoundary = currentBoundary;
    if (source.billingOffer?.durationType === "LIMITED_CYCLES") {
      const confirmedRenewals = Math.max(providerSource.paid_count ?? 0, 0);
      const discountedRenewalsRemaining = Math.max(
        source.billingOffer.durationCycles - confirmedRenewals,
        0
      );
      if (discountedRenewalsRemaining > 1) {
        discountSafeBoundary = addCalendarMonthsUtc(
          currentBoundary,
          discountedRenewalsRemaining * cadenceMonths
        );
      } else if (discountedRenewalsRemaining === 1) {
        discountSafeBoundary = addCalendarMonthsUtc(currentBoundary, cadenceMonths);
      }
    }
    const effectiveAt = getSafeReplacementCycleBoundary({
      now,
      currentCycleEnd: discountSafeBoundary,
      intervalMonths: cadenceMonths,
    });
    const undoCutoffAt = getReplacementUndoCutoffAt(effectiveAt);
    const accessGraceEndsAt = getReplacementChargeGraceEndsAt(effectiveAt);
    const providerIntent = {
      organizationId: change.organizationId,
      changeId: change.id,
      sourceProviderSubscriptionId: source.razorpaySubscriptionId,
      providerMode,
      providerPlanId: targetProviderPlanId,
      quantity: targetQuantity,
      startAt: timestamp(effectiveAt),
      expireBy: timestamp(undoCutoffAt),
    };

    let providerCandidate: RazorpaySubscription | null = null;
    let adopted = false;
    if (razorpay.listSubscriptions) {
      const matches: RazorpaySubscription[] = [];
      for (let skip = 0; ; skip += 100) {
        const page = await razorpay.listSubscriptions({ count: 100, skip });
        matches.push(...page.items.filter(candidate => isSameProvisioningIntent(candidate, providerIntent)));
        if (page.items.length < 100) break;
      }
      const liveMatches = matches
        .filter(candidate => isSameProvisioningIntent(candidate, providerIntent))
        .filter(candidate => !TERMINAL_PROVIDER_STATUSES.has(candidate.status.toLowerCase()))
        .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0));
      const ambiguousMatches = liveMatches.filter(candidate =>
        candidate.status.toLowerCase() !== "created"
        || (candidate.paid_count ?? 0) > 0
      );
      if (ambiguousMatches.length > 0) {
        await prisma.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            lastError: "An authorized or charged Razorpay replacement candidate requires manual review",
          },
        });
        throw new Error("A live replacement subscription requires manual review");
      }
      providerCandidate = liveMatches[0] ?? null;
      adopted = providerCandidate != null;
      for (const duplicate of liveMatches.slice(1)) {
        await razorpay.cancelSubscription(duplicate.id, { cancel_at_cycle_end: false });
      }
    }

    if (!providerCandidate) {
      providerCandidate = await razorpay.createSubscription({
        plan_id: targetProviderPlanId,
        total_count: Math.max(providerSource.remaining_count ?? getDefaultSubscriptionCycles(), 1),
        quantity: targetQuantity,
        customer_notify: true,
        start_at: providerIntent.startAt,
        expire_by: providerIntent.expireBy,
        notes: {
          app: "lab_lords",
          billing_type: "saas_subscription_replacement",
          organization_id: change.organizationId,
          provider_mode: providerMode,
          billing_change_id: change.id,
          replacement_source_subscription_id: source.razorpaySubscriptionId,
          plan: targetPlanId,
        },
      });
    }
    if (!isSameProvisioningIntent(providerCandidate, providerIntent)) {
      throw new Error("Razorpay replacement does not match the expected plan and branch quantity");
    }

    const stored = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${change.organizationId} FOR UPDATE
        `;
        const leaseOwner = await tx.organization.findFirst({
          where: { id: change.organizationId, billingMutationLeaseToken: leaseToken },
          select: { id: true },
        });
        if (!leaseOwner) throw new Error("Billing mutation lease was lost while saving replacement");
        await this.assertNoOpenReplacement(tx, change.organizationId, change.id);

        const current = await tx.organizationSubscription.findUnique({
          where: { currentOrganizationId: change.organizationId },
        });
        if (current?.id !== source.id || current.razorpaySubscriptionId !== source.razorpaySubscriptionId) {
          throw new Error("Current subscription changed while replacement was being created");
        }
        const latestChange = await tx.organizationBillingChange.findUnique({ where: { id: change.id } });
        if (!latestChange || latestChange.status !== "PROCESSING" || latestChange.replacementSubscriptionId) {
          throw new Error("Replacement billing change changed while provider subscription was being created");
        }

        const candidate = await tx.organizationSubscription.create({
          data: {
            organizationId: change.organizationId,
            pendingReplacementOrganizationId: change.organizationId,
            replacesSubscriptionId: source.id,
            providerMode,
            plan: targetPlanId,
            amount: targetAmount,
            amountSubunits: targetAmountSubunits,
            currency: targetCurrency,
            period: targetPeriod,
            interval: targetInterval,
            totalCount: providerCandidate!.total_count,
            quantity: targetQuantity,
            razorpayPlanId: targetProviderPlanId,
            razorpaySubscriptionId: providerCandidate!.id,
            razorpayCustomerId: providerCandidate!.customer_id ?? null,
            status: mapProviderStatus(providerCandidate!.status),
            providerStartAt: dateFromTimestamp(providerCandidate!.start_at) ?? effectiveAt,
            authorizationExpiresAt: dateFromTimestamp(providerCandidate!.expire_by) ?? undoCutoffAt,
            providerPaymentMethod: normalizeProviderPaymentMethod(providerCandidate!.payment_method),
            currentStart: dateFromTimestamp(providerCandidate!.current_start),
            currentEnd: dateFromTimestamp(providerCandidate!.current_end),
            chargeAt: dateFromTimestamp(providerCandidate!.charge_at),
            endedAt: dateFromTimestamp(providerCandidate!.ended_at),
            createdByUserId: change.createdByUserId,
          },
        });
        const updatedChange = await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            replacementSubscriptionId: candidate.id,
            status: "AWAITING_PAYMENT",
            operationStatus: "CHECKOUT_OPEN",
            effectiveAt,
            undoCutoffAt,
            accessGraceEndsAt,
            confirmationDeadlineAt: undoCutoffAt,
            checkoutOpenedAt: now,
            processingStartedAt: null,
            lastError: null,
          },
        });
        await releaseLease(tx, change.organizationId, leaseToken);
        return { change: updatedChange, subscription: candidate };
    });
    return { ...stored, adopted };
  }

  /**
   * Applies or revokes the temporary access attached to an authorized
   * replacement. Call this after a server-side provider refresh of the
   * candidate; it never changes the current subscription slot or its billing
   * facts.
   */
  static async syncAuthorizedAccess(changeId: string, now = new Date()) {
    return prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: {
          organizationSubscription: true,
          replacementSubscription: true,
          branch: true,
        },
      });
      const source = change?.organizationSubscription;
      const candidate = change?.replacementSubscription;
      if (!change || !source || !candidate) {
        throw new Error("Replacement billing change not found");
      }

      const targetPlan = change.toPlan ?? source.plan;
      const targetQuantity = change.toQuantity ?? source.quantity;
      const targetMapping = await tx.saasRazorpayPlan.findFirst({
        where: {
          providerMode: candidate.providerMode,
          plan: targetPlan,
          razorpayPlanId: candidate.razorpayPlanId,
        },
        select: { razorpayPlanId: true },
      });
      const authorizationReady = Boolean(targetMapping) && isReplacementAuthorizationReady({
        providerStatus: candidate.status,
        paymentMethod: candidate.providerPaymentMethod,
        providerPlanId: candidate.razorpayPlanId,
        providerQuantity: candidate.quantity,
        targetPlanId: targetMapping?.razorpayPlanId ?? "",
        targetQuantity,
      });
      let decisionChange = change;
      if (authorizationReady
        && !["FAILED", "UNDONE", "SUPERSEDED", "APPLIED"].includes(change.status)
        && change.operationStatus !== "SCHEDULED") {
        decisionChange = await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            status: "SCHEDULED",
            operationStatus: "SCHEDULED",
            providerConfirmedAt: change.providerConfirmedAt ?? now,
            failureCategory: null,
            failureCode: null,
            lastError: null,
          },
          include: {
            organizationSubscription: true,
            replacementSubscription: true,
            branch: true,
          },
        });
      }
      const action = getReplacementAccessAction({
        changeType: decisionChange.type,
        changeStatus: decisionChange.status,
        failureCategory: decisionChange.failureCategory,
        sourcePlan: source.plan,
        sourceQuantity: source.quantity,
        targetPlan,
        targetQuantity,
        candidatePlan: candidate.plan,
        candidateQuantity: candidate.quantity,
        candidateStatus: candidate.status,
        candidatePaymentMethod: candidate.providerPaymentMethod,
        candidateProviderPlanId: candidate.razorpayPlanId,
        targetProviderPlanId: targetMapping?.razorpayPlanId,
        accessGrantedAt: decisionChange.accessGrantedAt,
        accessRevokedAt: decisionChange.accessRevokedAt,
        effectiveAt: decisionChange.effectiveAt,
        accessGraceEndsAt: decisionChange.accessGraceEndsAt,
        now,
      });

      if (action === "NONE") return { action, change: decisionChange, subscription: candidate };

      if (action === "GRANT") {
        if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(change.type)
          && (!change.branch || change.branch.billingStatus !== "PENDING_ACTIVATION")) {
          return { action: "NONE" as const, change, subscription: candidate };
        }
        const granted = await tx.organizationBillingChange.updateMany({
          where: { id: change.id, accessGrantedAt: null, accessRevokedAt: null },
          data: { accessGrantedAt: now },
        });
        if (granted.count === 0) {
          const latest = await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
          return { action: "NONE" as const, change: latest, subscription: candidate };
        }
        if (change.branch && ["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "ACTIVE", billingActivatedAt: now, billingArchivedAt: null },
          });
        }
        if (change.branch && change.type === "BRANCH_REACTIVATION") {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: {
              billingStatus: "ACTIVE",
              billingActivatedAt: now,
              billingArchivedAt: null,
            },
          });
        }
        const updated = await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
        return { action, change: updated, subscription: candidate };
      }

      const revoked = await tx.organizationBillingChange.updateMany({
        where: { id: change.id, accessGrantedAt: { not: null }, accessRevokedAt: null },
        data: { accessRevokedAt: now },
      });
      if (revoked.count > 0 && change.branch?.billingStatus === "ACTIVE") {
        if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
          });
        }
        if (change.type === "BRANCH_REACTIVATION") {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
          });
        }
      }
      const updated = await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
      return { action, change: updated, subscription: candidate };
    });
  }

  /**
   * Terminalizes a replacement Checkout without touching the source
   * subscription. The local failure/access update is persisted first so a
   * provider cancellation outage cannot leave complimentary access enabled;
   * retries continue cancelling while the candidate still occupies the
   * pending slot.
   */
  static async failReplacementCheckout(
    changeId: string,
    event: "ABANDONED" | "DECLINED" | "FAILED",
    now = new Date(),
    reason?: string
  ) {
    const claimed = await prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: {
          organizationSubscription: true,
          replacementSubscription: true,
          branch: true,
        },
      });
      const candidate = change?.replacementSubscription;
      if (!change || !candidate) throw new Error("Replacement billing change not found");
      if (change.operationStatus === "APPLIED") {
        return { change, candidate, cancelCandidate: false };
      }

      const terminalStatus = event === "ABANDONED" ? "UNDONE" as const : "FAILED" as const;
      const alreadyTerminal = ["FAILED", "UNDONE", "SUPERSEDED"].includes(change.status);
      const revokeAccess = Boolean(change.accessGrantedAt && !change.accessRevokedAt);
      const candidateAlreadyArchived = candidate.pendingReplacementOrganizationId == null;
      const candidateAlreadyTerminal = TERMINAL_PROVIDER_STATUSES.has(candidate.status.toLowerCase());
      const cancellationPending = !candidateAlreadyArchived && !candidateAlreadyTerminal;
      const sourceCancellationCommitted = Boolean(
        change.organizationSubscription?.cancelAtCycleEnd
        || change.organizationSubscription?.cancellationScheduledAt
      );
      if (!alreadyTerminal) {
        await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            status: terminalStatus,
            operationStatus: event,
            failureCategory: sourceCancellationCommitted
              ? "MANUAL_REVIEW_REQUIRED"
              : event === "ABANDONED"
                ? "CHECKOUT_ABANDONED"
                : "PROVIDER_AUTHORIZATION_FAILED",
            failureCode: cancellationPending ? "CANDIDATE_CANCELLATION_PENDING" : null,
            lastError: sourceCancellationCommitted
              ? "The replacement failed after source cancellation was scheduled; manual recovery is required"
              : reason ?? (event === "ABANDONED"
                ? "Replacement checkout was closed before mandate authorization"
                : "Replacement mandate authorization failed"),
            abandonedAt: event === "ABANDONED" ? now : undefined,
            undoneAt: event === "ABANDONED" ? now : undefined,
            declinedAt: event === "DECLINED" ? now : undefined,
            failedAt: event === "ABANDONED" ? undefined : now,
            resolvedAt: now,
            accessRevokedAt: revokeAccess ? now : undefined,
          },
        });
      } else if (revokeAccess) {
        await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: { accessRevokedAt: now },
        });
      }
      if (revokeAccess && change.branch?.billingStatus === "ACTIVE") {
        if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
          });
        }
        if (change.type === "BRANCH_REACTIVATION") {
          await tx.branch.update({
            where: { id: change.branch.id },
            data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
          });
        }
      }
      let updated = alreadyTerminal && !revokeAccess
        ? change
        : await tx.organizationBillingChange.findUniqueOrThrow({ where: { id: change.id } });
      if (!candidateAlreadyArchived && candidateAlreadyTerminal) {
        await tx.organizationSubscription.update({
          where: { id: candidate.id },
          data: {
            pendingReplacementOrganizationId: null,
            cancelledAt: candidate.cancelledAt ?? now,
            endedAt: candidate.endedAt ?? now,
          },
        });
        if (updated.failureCode === "CANDIDATE_CANCELLATION_PENDING") {
          updated = await tx.organizationBillingChange.update({
            where: { id: change.id },
            data: { failureCode: null },
          });
        }
      }
      return {
        change: updated,
        candidate,
        cancelCandidate: !candidateAlreadyArchived && !candidateAlreadyTerminal,
      };
    });

    if (!claimed.cancelCandidate) return claimed.change;
    assertRazorpayBillingWritesEnabled(claimed.change.organizationId);
    const cancelled = await getRazorpayClient().cancelSubscription(
      claimed.candidate.razorpaySubscriptionId,
      { cancel_at_cycle_end: false }
    );
    if (cancelled.id !== claimed.candidate.razorpaySubscriptionId) {
      throw new Error("Razorpay replacement mismatch while failing replacement checkout");
    }

    return prisma.$transaction(async tx => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${claimed.change.organizationId} FOR UPDATE
      `;
      const latest = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { replacementSubscription: true },
      });
      if (!latest?.replacementSubscription) throw new Error("Replacement billing change not found");
      if (latest.status === "APPLIED") return latest;
      await tx.organizationSubscription.update({
        where: { id: latest.replacementSubscription.id },
        data: {
          pendingReplacementOrganizationId: null,
          status: mapProviderStatus(cancelled.status),
          cancelledAt: now,
          endedAt: dateFromTimestamp(cancelled.ended_at) ?? now,
        },
      });
      return tx.organizationBillingChange.update({
        where: { id: latest.id },
        data: { failureCode: null },
      });
    });
  }

  static async scheduleSourceCancellation(changeId: string, now = new Date()) {
    const snapshot = await prisma.organizationBillingChange.findUnique({
      where: { id: changeId },
      include: { organizationSubscription: true },
    });
    if (!snapshot?.organizationSubscription) {
      throw new Error("Replacement source subscription not found");
    }
    // The source boundary may have advanced since the candidate was created.
    // Fetch provider truth immediately before the cancellation decision.
    await BillingReconciliationService.reconcileProviderSubscription(
      snapshot.organizationSubscription.razorpaySubscriptionId,
      { now }
    );

    const leaseToken = crypto.randomUUID();
    const claim = await prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: initial.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization.billingMutationLeaseToken) {
        throw new Error("Another billing operation is still processing; retry shortly");
      }
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { organizationSubscription: true, replacementSubscription: true },
      });
      const source = change?.organizationSubscription;
      const candidate = change?.replacementSubscription;
      if (!change || !source || !candidate) throw new Error("Replacement billing change not found");
      if (["FAILED", "UNDONE", "SUPERSEDED"].includes(change.status) || change.accessRevokedAt) {
        return { skipped: "REPLACEMENT_TERMINAL" as const };
      }
      if (["CANCELLED", "COMPLETED", "EXPIRED"].includes(source.status)) {
        return { skipped: "SOURCE_ALREADY_ENDED" as const };
      }
      if (source.cancelAtCycleEnd
        && source.cancellationScheduledAt
        && change.effectiveAt
        && source.cancellationScheduledAt.getTime() === change.effectiveAt.getTime()) {
        return { skipped: "ALREADY_SCHEDULED" as const };
      }
      if (!change.undoCutoffAt || now < change.undoCutoffAt) {
        return { skipped: "UNDO_WINDOW_OPEN" as const };
      }
      if (!change.effectiveAt) throw new Error("Replacement effective date is missing");
      if (now >= change.effectiveAt) {
        const revokeAccess = Boolean(change.accessGrantedAt && !change.accessRevokedAt);
        await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            lastError: "Source cancellation was not submitted before the replacement effective date",
            failedAt: now,
            accessRevokedAt: revokeAccess ? now : undefined,
          },
        });
        if (revokeAccess && change.branchId) {
          if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
            });
          }
          if (change.type === "BRANCH_REACTIVATION") {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
          }
        }
        return { skipped: "MANUAL_REVIEW_REQUIRED" as const };
      }
      const targetPlan = change.toPlan ?? source.plan;
      const targetQuantity = change.toQuantity ?? source.quantity;
      if (candidate.plan !== targetPlan || !isReplacementAuthorizationReady({
        providerStatus: candidate.status,
        paymentMethod: candidate.providerPaymentMethod,
        providerPlanId: candidate.razorpayPlanId,
        providerQuantity: candidate.quantity,
        targetPlanId: candidate.razorpayPlanId,
        targetQuantity,
      })) throw new BillingReplacementNotReadyError();
      if (!source.currentEnd || source.currentEnd.getTime() !== change.effectiveAt.getTime()) {
        return { skipped: "SOURCE_BOUNDARY_NOT_REACHED" as const };
      }
      if (source.currentOrganizationId !== change.organizationId
        || candidate.pendingReplacementOrganizationId !== change.organizationId) {
        throw new Error("Replacement slots changed before source cancellation");
      }
      await tx.organization.update({
        where: { id: change.organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + REPLACEMENT_PROVIDER_LEASE_MS),
        },
      });
      return { skipped: null, change, source, candidate };
    });
    if (claim.skipped) {
      return {
        scheduled: ["SOURCE_ALREADY_ENDED", "ALREADY_SCHEDULED"].includes(claim.skipped),
        reason: claim.skipped,
      };
    }

    assertRazorpayBillingWritesEnabled(claim.change.organizationId);
    try {
      const provider = await getRazorpayClient().cancelSubscription(
        claim.source.razorpaySubscriptionId,
        { cancel_at_cycle_end: true }
      );
      if (provider.id !== claim.source.razorpaySubscriptionId) {
        throw new Error("Razorpay source mismatch while scheduling replacement cutover");
      }
      const providerStatus = provider.status.toLowerCase();
      const providerScheduledAt = dateFromTimestamp(provider.change_scheduled_at);
      const providerEnded = TERMINAL_PROVIDER_STATUSES.has(providerStatus);
      if (!providerEnded && (
        provider.has_scheduled_changes !== true
        || !providerScheduledAt
        || providerScheduledAt.getTime() !== claim.change.effectiveAt!.getTime()
      )) {
        throw new Error("Razorpay did not confirm the expected cycle-end source cancellation");
      }
      await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${claim.change.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: claim.change.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Billing mutation lease was lost during replacement cutover");
        }
        const latest = await tx.organizationBillingChange.findUnique({
          where: { id: changeId },
          include: { organizationSubscription: true, replacementSubscription: true },
        });
        if (!latest?.organizationSubscription || !latest.replacementSubscription
          || latest.organizationSubscription.id !== claim.source.id
          || latest.replacementSubscription.id !== claim.candidate.id
          || latest.status === "APPLIED") {
          throw new Error("Replacement changed during source cancellation");
        }
        await tx.organizationSubscription.update({
          where: { id: claim.source.id },
          data: {
            cancelAtCycleEnd: true,
            cancellationRequestedAt: now,
            cancellationScheduledAt: providerScheduledAt ?? claim.change.effectiveAt,
            lastReconciledAt: now,
          },
        });
        await tx.organizationBillingChange.update({
          where: { id: claim.change.id },
          data: { status: "SCHEDULED", operationStatus: "SCHEDULED", providerConfirmedAt: now },
        });
        await releaseLease(tx, claim.change.organizationId, leaseToken);
      });
      return { scheduled: true, reason: null };
    } catch (error) {
      await prisma.$transaction(async tx => {
        await tx.organizationBillingChange.updateMany({
          where: { id: claim.change.id, status: { not: "APPLIED" } },
          data: { lastError: error instanceof Error ? error.message : "Source cancellation failed" },
        });
        await releaseLease(tx, claim.change.organizationId, leaseToken);
      });
      throw error;
    }
  }

  static async promoteIfReady(changeId: string, now = new Date()) {
    return prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { organizationSubscription: true, replacementSubscription: true },
      });
      const source = change?.organizationSubscription;
      const candidate = change?.replacementSubscription;
      if (!change || !source || !candidate) throw new Error("Replacement billing change not found");
      if (change.status === "APPLIED") return { promoted: true, change, subscription: candidate };
      if (["FAILED", "UNDONE", "SUPERSEDED"].includes(change.status)) {
        return { promoted: false, manualReview: false, change, subscription: candidate };
      }
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: change.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization.billingMutationLeaseToken) {
        return {
          promoted: false,
          manualReview: false,
          deferredByLease: true,
          change,
          subscription: candidate,
        };
      }

      const hasPaidPeriod = Boolean(
        candidate.paidThrough
        && candidate.lastConfirmedInvoiceId
        && candidate.lastConfirmedPaymentId
        && candidate.currentStart
        && candidate.currentEnd
        && candidate.currentStart <= now
        && candidate.currentEnd > now
        && candidate.paidThrough.getTime() >= candidate.currentEnd.getTime()
      );
      const targetPlan = change.toPlan ?? source.plan;
      const targetMapping = await tx.saasRazorpayPlan.findFirst({
        where: {
          providerMode: candidate.providerMode,
          plan: targetPlan,
          razorpayPlanId: candidate.razorpayPlanId,
        },
      });
      if (!targetMapping) throw new Error("Replacement plan mapping not found");

      if (hasPaidPeriod && !["CANCELLED", "COMPLETED", "EXPIRED"].includes(source.status)) {
        const revokeAccess = Boolean(change.accessGrantedAt && !change.accessRevokedAt);
        const failed = await tx.organizationBillingChange.update({
          where: { id: change.id },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "MANUAL_REVIEW_REQUIRED",
            lastError: "Both source and replacement may have charged during cutover",
            failedAt: now,
            accessRevokedAt: revokeAccess ? now : undefined,
          },
        });
        if (revokeAccess && change.branchId) {
          if (["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE"].includes(change.type)) {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
            });
          }
          if (change.type === "BRANCH_REACTIVATION") {
            await tx.branch.updateMany({
              where: { id: change.branchId, billingStatus: "ACTIVE" },
              data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
          }
        }
        return { promoted: false, manualReview: true, change: failed, subscription: candidate };
      }

      const ready = isReplacementPromotionReady({
        sourceStatus: source.status,
        providerStatus: candidate.status,
        paymentMethod: candidate.providerPaymentMethod,
        providerPlanId: candidate.razorpayPlanId,
        providerQuantity: candidate.quantity,
        targetPlanId: targetMapping.razorpayPlanId,
        targetQuantity: change.toQuantity ?? source.quantity,
        confirmedPaidPeriod: hasPaidPeriod,
      });
      if (!ready) return { promoted: false, manualReview: false, change, subscription: candidate };
      if (source.currentOrganizationId !== change.organizationId
        || candidate.pendingReplacementOrganizationId !== change.organizationId) {
        throw new Error("Replacement subscription slots changed before promotion");
      }

      await tx.organizationSubscription.update({
        where: { id: source.id },
        data: { currentOrganizationId: null },
      });
      const promoted = await tx.organizationSubscription.update({
        where: { id: candidate.id },
        data: {
          pendingReplacementOrganizationId: null,
          currentOrganizationId: change.organizationId,
        },
      });
      if (change.branchId
        && ["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(change.type)) {
        await tx.branch.update({
          where: { id: change.branchId },
          data: { billingStatus: "ACTIVE", billingActivatedAt: now, billingArchivedAt: null },
        });
      }
      if (change.branchId && change.type === "BRANCH_REMOVAL") {
        await tx.branch.update({
          where: { id: change.branchId },
          data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
        });
      }
      const applied = await tx.organizationBillingChange.update({
        where: { id: change.id },
        data: {
          status: "APPLIED",
          operationStatus: "APPLIED",
          providerConfirmedAt: now,
          appliedAt: now,
          resolvedAt: now,
          accessRevokedAt: change.accessGrantedAt ? now : undefined,
          lastError: null,
        },
      });
      await tx.organizationSubscriptionHistory.upsert({
        where: { dedupeKey: `replacement-promoted:${candidate.razorpaySubscriptionId}` },
        create: {
          organizationId: change.organizationId,
          organizationSubscriptionId: candidate.id,
          razorpaySubscriptionId: candidate.razorpaySubscriptionId,
          razorpayPaymentId: candidate.lastConfirmedPaymentId,
          plan: candidate.plan,
          fromStatus: source.status,
          toStatus: candidate.status,
          source: "SYSTEM",
          event: "replacement_promoted",
          amountSubunits: candidate.amountSubunits,
          quantity: candidate.quantity,
          unitAmountSubunits: candidate.amountSubunits,
          totalAmountSubunits: candidate.amountSubunits * candidate.quantity,
          paidThrough: candidate.paidThrough,
          dedupeKey: `replacement-promoted:${candidate.razorpaySubscriptionId}`,
          currency: candidate.currency,
        },
        update: { paidThrough: candidate.paidThrough },
      });
      return { promoted: true, change: applied, subscription: promoted };
    });
  }

  static async undoReplacement(
    changeId: string,
    now = new Date(),
    options: { branchDisposition?: "RESTORE" | "ARCHIVE" } = {}
  ) {
    const leaseToken = crypto.randomUUID();
    const claim = await prisma.$transaction(async tx => {
      const initial = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        select: { organizationId: true },
      });
      if (!initial) throw new Error("Replacement billing change not found");
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${initial.organizationId} FOR UPDATE
      `;
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: initial.organizationId },
        select: { billingMutationLeaseToken: true },
      });
      if (organization.billingMutationLeaseToken) {
        throw new Error("Another billing operation is still processing; retry shortly");
      }
      const change = await tx.organizationBillingChange.findUnique({
        where: { id: changeId },
        include: { replacementSubscription: true },
      });
      const candidate = change?.replacementSubscription;
      if (!change || !candidate) throw new Error("Replacement billing change not found");
      if (change.status === "APPLIED") throw new Error("The replacement has already been applied");
      if (change.undoCutoffAt && now >= change.undoCutoffAt) {
        throw new Error("The replacement can no longer be undone");
      }
      if (candidate.pendingReplacementOrganizationId !== change.organizationId) {
        throw new Error("The replacement is no longer pending for this workspace");
      }
      await tx.organization.update({
        where: { id: change.organizationId },
        data: {
          billingMutationLeaseToken: leaseToken,
          billingMutationLeaseUntil: new Date(now.getTime() + REPLACEMENT_PROVIDER_LEASE_MS),
        },
      });
      return { change, candidate };
    });
    assertRazorpayBillingWritesEnabled(claim.change.organizationId);
    try {
      const cancelled = await getRazorpayClient().cancelSubscription(
        claim.candidate.razorpaySubscriptionId,
        { cancel_at_cycle_end: false }
      );
      if (cancelled.id !== claim.candidate.razorpaySubscriptionId) {
        throw new Error("Razorpay replacement mismatch while undoing replacement");
      }
      return await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Organization" WHERE "id" = ${claim.change.organizationId} FOR UPDATE
        `;
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: claim.change.organizationId },
          select: { billingMutationLeaseToken: true },
        });
        if (organization.billingMutationLeaseToken !== leaseToken) {
          throw new Error("Billing mutation lease was lost while undoing replacement");
        }
        const latest = await tx.organizationBillingChange.findUnique({
          where: { id: claim.change.id },
          include: { replacementSubscription: true },
        });
        if (!latest?.replacementSubscription || latest.status === "APPLIED"
          || latest.replacementSubscription.id !== claim.candidate.id) {
          throw new Error("Replacement changed before undo completed");
        }
        await tx.organizationSubscription.update({
          where: { id: claim.candidate.id },
          data: {
            pendingReplacementOrganizationId: null,
            status: mapProviderStatus(cancelled.status),
            cancelledAt: now,
            endedAt: dateFromTimestamp(cancelled.ended_at) ?? now,
          },
        });
        if (claim.change.branchId
          && ["TRIAL_SUBSCRIPTION_UPDATE", "QUANTITY_INCREASE", "BRANCH_REACTIVATION"].includes(
            claim.change.type
          )) {
          await tx.branch.update({
            where: { id: claim.change.branchId },
            data: options.branchDisposition === "ARCHIVE"
              ? {
                  billingStatus: "ARCHIVED",
                  billingActivatedAt: null,
                  billingArchivedAt: now,
                }
              : claim.change.type === "BRANCH_REACTIVATION"
              ? { billingStatus: "ARCHIVED", billingArchivedAt: now }
              : { billingStatus: "PENDING_ACTIVATION", billingActivatedAt: null },
          });
        }
        const undone = await tx.organizationBillingChange.update({
          where: { id: claim.change.id },
          data: {
            status: "UNDONE",
            operationStatus: "ABANDONED",
            undoneAt: now,
            abandonedAt: now,
            resolvedAt: now,
            accessRevokedAt: latest.accessGrantedAt ? now : undefined,
            lastError: null,
          },
        });
        await releaseLease(tx, claim.change.organizationId, leaseToken);
        return undone;
      });
    } catch (error) {
      await prisma.$transaction(tx => releaseLease(
        tx,
        claim.change.organizationId,
        leaseToken
      ));
      throw error;
    }
  }
}

export function isReplacementChangeType(type: BillingChangeType) {
  return [
    "PAYMENT_METHOD_REPLACEMENT",
    "TRIAL_SUBSCRIPTION_UPDATE",
    "PLAN_UPGRADE",
    "PLAN_DOWNGRADE",
    "QUANTITY_INCREASE",
    "BRANCH_REMOVAL",
    "BRANCH_REACTIVATION",
  ].includes(type);
}
