import { prisma } from "@/lib/prisma";
import { BillingMutationService } from "@/services/billingMutation.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { BranchService } from "@/services/branch.service";
import { OwnerTrialService } from "@/services/ownerTrial.service";
import { areRazorpayBillingWritesEnabled } from "@/lib/billingFeature";
import { isSupportedProviderPaymentMethod } from "@/services/billingPaymentMethod.service";
import { BillingReplacementService } from "@/services/billingReplacement.service";
import {
  cancelLapsedInitialAuthorization,
  isInitialAuthorizationDue,
} from "@/services/billing.service";

const RECONCILE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_AUTOMATIC_ATTEMPTS = 3;
export const REPLACEMENT_DEADLINE_PAGE_SIZE = 100;

const OPEN_REPLACEMENT_STATUSES = ["AWAITING_PAYMENT", "SCHEDULED"] as const;
const TERMINAL_REPLACEMENT_STATUSES = ["FAILED", "UNDONE", "SUPERSEDED"] as const;

export function isReplacementMandateConfirmed(change: {
  operationStatus: string;
  providerConfirmedAt: Date | null;
}) {
  return change.providerConfirmedAt != null
    && ["SCHEDULED", "APPLIED"].includes(change.operationStatus);
}

export async function recoverExpiredBillingMutationLease(
  organization: { id: string; billingMutationLeaseToken: string | null },
  now: Date
) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Organization" WHERE "id" = ${organization.id} FOR UPDATE
    `;
    const current = await tx.organization.findUnique({
      where: { id: organization.id },
      select: { billingMutationLeaseToken: true, billingMutationLeaseUntil: true },
    });
    if (!current
      || current.billingMutationLeaseToken !== organization.billingMutationLeaseToken
      || !current.billingMutationLeaseUntil
      || current.billingMutationLeaseUntil > now) {
      return false;
    }

    const processing = await tx.organizationBillingChange.findFirst({
      where: { organizationId: organization.id, status: "PROCESSING" },
      orderBy: { sequence: "asc" },
      select: { id: true, attemptCount: true, processingStartedAt: true },
    });
    if (processing) {
      await tx.organizationBillingChange.updateMany({
        where: {
          id: processing.id,
          status: "PROCESSING",
          attemptCount: processing.attemptCount,
          processingStartedAt: processing.processingStartedAt,
        },
        data: {
          status: "FAILED",
          operationStatus: "FAILED",
          failedAt: now,
          resolvedAt: null,
          failureCategory: "MANUAL_REVIEW_REQUIRED",
          failureCode: "PROVIDER_MUTATION_LEASE_EXPIRED",
          lastError: "Provider mutation lease expired with an unresolved outcome",
        },
      });
    }
    const released = await tx.organization.updateMany({
      where: {
        id: organization.id,
        billingMutationLeaseToken: organization.billingMutationLeaseToken,
        billingMutationLeaseUntil: { lte: now },
      },
      data: { billingMutationLeaseToken: null, billingMutationLeaseUntil: null },
    });
    return released.count === 1;
  });
}

export class BillingDeadlineService {
  static async run(now = new Date()) {
    const errors: Array<{ organizationId: string; message: string }> = [];
    const expiredTrials = await OwnerTrialService.expireDueTrials(now);

    const staleLeases = await prisma.organization.findMany({
      where: {
        billingModelVersion: "WORKSPACE_V2",
        billingMutationLeaseUntil: { lte: now },
      },
      select: { id: true, billingMutationLeaseToken: true },
    });
    let recoveredLeases = 0;
    for (const organization of staleLeases) {
      const recovered = await recoverExpiredBillingMutationLease(organization, now);
      if (recovered) recoveredLeases += 1;
    }

    const retryableFailures = await prisma.organizationBillingChange.findMany({
      where: {
        status: "FAILED",
        type: { notIn: ["SUBSCRIPTION_AUTHORIZATION", "UNSUPPORTED_METHOD_CANCELLATION"] },
        replacementSubscriptionId: null,
        failureCategory: { in: ["PROVIDER_REJECTED", "PRE_PROVIDER_FAILURE"] },
        attemptCount: { lt: MAX_AUTOMATIC_ATTEMPTS },
        organization: { billingModelVersion: "WORKSPACE_V2" },
      },
      orderBy: [{ organizationId: "asc" }, { sequence: "asc" }],
      distinct: ["organizationId"],
    });
    let retriedMutations = 0;
    for (const change of retryableFailures) {
      if (!areRazorpayBillingWritesEnabled(change.organizationId)) {
        continue;
      }
      try {
        await BillingMutationService.retry(change.id);
        retriedMutations += 1;
      } catch (error) {
        errors.push({
          organizationId: change.organizationId,
          message: error instanceof Error ? error.message : "Mutation retry failed",
        });
      }
    }

    const dueCancellations = await prisma.organizationBillingChange.findMany({
      where: {
        type: "CANCELLATION",
        status: "QUEUED",
        undoCutoffAt: { lte: now },
        organization: { billingModelVersion: "WORKSPACE_V2" },
      },
      select: { organizationId: true },
      distinct: ["organizationId"],
    });
    for (const { organizationId } of dueCancellations) {
      try {
        await BillingMutationService.processNext(organizationId, now);
      } catch (error) {
        errors.push({
          organizationId,
          message: error instanceof Error ? error.message : "Cancellation submission failed",
        });
      }
    }

    let reconciledReplacements = 0;
    let promotedReplacements = 0;
    let retriedReplacementCancellations = 0;
    let replacementCursor: string | undefined;
    while (true) {
      const replacementPage = await prisma.organizationBillingChange.findMany({
        where: {
          replacementSubscriptionId: { not: null },
          organization: { billingModelVersion: "WORKSPACE_V2" },
          OR: [
            {
              status: { in: [...OPEN_REPLACEMENT_STATUSES] },
              OR: [
                { failureCategory: null },
                { failureCategory: { not: "MANUAL_REVIEW_REQUIRED" } },
              ],
            },
            {
              status: { in: [...TERMINAL_REPLACEMENT_STATUSES] },
              failureCode: "CANDIDATE_CANCELLATION_PENDING",
              replacementSubscription: {
                is: { pendingReplacementOrganizationId: { not: null } },
              },
            },
          ],
        },
        include: { organizationSubscription: true, replacementSubscription: true },
        orderBy: { id: "asc" },
        take: REPLACEMENT_DEADLINE_PAGE_SIZE,
        ...(replacementCursor ? { cursor: { id: replacementCursor }, skip: 1 } : {}),
      });
      if (replacementPage.length === 0) break;

      for (const change of replacementPage) {
        const candidate = change.replacementSubscription;
        if (!candidate) continue;
        try {
          if (TERMINAL_REPLACEMENT_STATUSES.includes(
            change.status as typeof TERMINAL_REPLACEMENT_STATUSES[number]
          )) {
            if (change.failureCode === "CANDIDATE_CANCELLATION_PENDING"
              && candidate.pendingReplacementOrganizationId) {
              await BillingReplacementService.failReplacementCheckout(
                change.id,
                change.operationStatus === "ABANDONED" ? "ABANDONED" : "FAILED",
                now,
                change.lastError ?? "Retrying replacement candidate cancellation"
              );
              retriedReplacementCancellations += 1;
            }
            continue;
          }
          if (change.failureCategory === "MANUAL_REVIEW_REQUIRED") continue;

          const reconciliation = await BillingReconciliationService.reconcileProviderSubscription(
            candidate.razorpaySubscriptionId,
            { paymentId: change.providerPaymentId, now }
          );
          reconciledReplacements += 1;
          const providerTerminal = ["CANCELLED", "COMPLETED", "EXPIRED", "HALTED"]
            .includes(reconciliation.subscription.status);
          if (providerTerminal) {
            await BillingReplacementService.failReplacementCheckout(
              change.id,
              "FAILED",
              now,
              `Replacement mandate became ${reconciliation.subscription.status.toLowerCase()}`
            );
            continue;
          }

          const access = await BillingReplacementService.syncAuthorizedAccess(change.id, now);
          const refreshed = access.change;
          const mandateConfirmed = isReplacementMandateConfirmed(refreshed);
          if (refreshed.confirmationDeadlineAt
            && refreshed.confirmationDeadlineAt <= now
            && !mandateConfirmed) {
            await BillingReplacementService.failReplacementCheckout(
              change.id,
              "FAILED",
              now,
              "Replacement mandate was not confirmed before the cutover authorization deadline"
            );
            continue;
          }

          let sourceReconciled = false;
          if (mandateConfirmed
            && refreshed.undoCutoffAt
            && refreshed.undoCutoffAt <= now
            && change.organizationSubscription) {
            // scheduleSourceCancellation performs a fresh source reconciliation
            // immediately before its locked provider decision.
            await BillingReplacementService.scheduleSourceCancellation(change.id, now);
            sourceReconciled = true;
          }
          if (reconciliation.confirmedPaidPeriod
            && change.organizationSubscription
            && !sourceReconciled) {
            await BillingReconciliationService.reconcileProviderSubscription(
              change.organizationSubscription.razorpaySubscriptionId,
              { now }
            );
          }
          const promotion = await BillingReplacementService.promoteIfReady(change.id, now);
          if (promotion.promoted) promotedReplacements += 1;
        } catch (error) {
          errors.push({
            organizationId: change.organizationId,
            message: error instanceof Error ? error.message : "Replacement reconciliation failed",
          });
        }
      }

      if (replacementPage.length < REPLACEMENT_DEADLINE_PAGE_SIZE) break;
      replacementCursor = replacementPage.at(-1)!.id;
    }

    const dueBranchChanges = await prisma.organizationBillingChange.findMany({
      where: {
        type: "BRANCH_REMOVAL",
        status: "SCHEDULED",
        effectiveAt: { lte: now },
        organizationSubscriptionId: { not: null },
      },
      select: { organizationId: true },
      distinct: ["organizationId"],
    });
    for (const { organizationId } of dueBranchChanges) {
      try {
        await BillingReconciliationService.reconcileByOrganization(organizationId, { now });
      } catch (error) {
        errors.push({
          organizationId,
          message: error instanceof Error ? error.message : "Branch reduction reconciliation failed",
        });
      }
    }
    const archivedBranches = await BranchService.archiveDueBillingRemovals(now);

    const dueCheckoutConfirmations = await prisma.organizationBillingChange.findMany({
      where: {
        type: "SUBSCRIPTION_AUTHORIZATION",
        operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
        confirmationDeadlineAt: { lte: now },
        organization: { billingModelVersion: "WORKSPACE_V2" },
      },
      include: { organizationSubscription: true },
      orderBy: [{ organizationId: "asc" }, { sequence: "asc" }],
    });
    let confirmedCheckouts = 0;
    let timedOutCheckouts = 0;
    for (const change of dueCheckoutConfirmations) {
      const subscription = change.organizationSubscription;
      if (!subscription) {
        const failed = await prisma.organizationBillingChange.updateMany({
          where: {
            id: change.id,
            operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
          },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "SUBSCRIPTION_MISSING",
            lastError: "The provider subscription could not be found; start authorization again",
            failedAt: now,
            resolvedAt: now,
          },
        });
        timedOutCheckouts += failed.count;
        continue;
      }

      try {
        const reconciliation = await BillingReconciliationService.reconcileByOrganization(
          change.organizationId,
          { paymentId: change.providerPaymentId, now }
        );
        const paymentConfirmed = !reconciliation.payment
          || ["authorized", "captured"].includes(reconciliation.payment.status);
        const authorizationConfirmed = isSupportedProviderPaymentMethod(
          reconciliation.subscription.providerPaymentMethod
        )
          && ["AUTHENTICATED", "ACTIVE"].includes(reconciliation.subscription.status)
          && paymentConfirmed;
        const recoveryConfirmation = ["PENDING", "HALTED"].includes(subscription.status);
        const paidPeriodAdvanced = reconciliation.confirmedPaidPeriod
          && Boolean(reconciliation.subscription.paidThrough)
          && (!subscription.paidThrough || reconciliation.subscription.paidThrough! > subscription.paidThrough);
        const providerConfirmed = recoveryConfirmation ? paidPeriodAdvanced : authorizationConfirmed;

        const resolved = await prisma.organizationBillingChange.updateMany({
          where: {
            id: change.id,
            operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
          },
          data: providerConfirmed
            ? {
                status: "APPLIED",
                operationStatus: "APPLIED",
                providerPaymentId: reconciliation.payment?.id ?? change.providerPaymentId,
                providerConfirmedAt: now,
                appliedAt: now,
                resolvedAt: now,
                failureCategory: null,
                failureCode: null,
                lastError: null,
              }
            : {
                status: "FAILED",
                operationStatus: "FAILED",
                failureCategory: "CONFIRMATION_TIMEOUT",
                failureCode: null,
                lastError: "Razorpay did not confirm authorization before the deadline; start authorization again",
                failedAt: now,
                resolvedAt: now,
              },
        });
        if (providerConfirmed) {
          confirmedCheckouts += resolved.count;
          if (resolved.count > 0 && reconciliation.payment?.id && !reconciliation.subscription.authPaymentId) {
            await prisma.organizationSubscription.update({
              where: { id: reconciliation.subscription.id },
              data: { authPaymentId: reconciliation.payment.id },
            });
          }
        } else {
          timedOutCheckouts += resolved.count;
        }
      } catch (error) {
        const failed = await prisma.organizationBillingChange.updateMany({
          where: {
            id: change.id,
            operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
            confirmationDeadlineAt: { lte: now },
          },
          data: {
            status: "FAILED",
            operationStatus: "FAILED",
            failureCategory: "CONFIRMATION_TIMEOUT",
            lastError: "Razorpay confirmation could not be completed before the deadline; start authorization again",
            failedAt: now,
            resolvedAt: now,
          },
        });
        timedOutCheckouts += failed.count;
        errors.push({
          organizationId: change.organizationId,
          message: error instanceof Error ? error.message : "Checkout deadline reconciliation failed",
        });
      }
    }

    const deadlineSubscriptions = await prisma.organizationSubscription.findMany({
      where: {
        currentOrganizationId: { not: null },
        organization: { billingModelVersion: "WORKSPACE_V2" },
        paidThrough: null,
        status: { in: ["CREATED", "AUTHENTICATED", "ACTIVE"] },
        OR: [
          { authorizationExpiresAt: { lte: now } },
          { providerStartAt: { lte: now } },
        ],
        billingChanges: {
          none: {
            type: "SUBSCRIPTION_AUTHORIZATION",
            operationStatus: { in: ["CHECKOUT_OPEN", "VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"] },
            confirmationDeadlineAt: { gt: now },
          },
        },
      },
      select: {
        id: true,
        organizationId: true,
        status: true,
        authorizationExpiresAt: true,
        providerPaymentMethod: true,
        providerStartAt: true,
      },
    });
    let lapsedAuthorizations = 0;
    for (const subscription of deadlineSubscriptions) {
      if (!isInitialAuthorizationDue(subscription, now)) continue;
      try {
        const reconciled = await BillingReconciliationService.reconcileByOrganization(
          subscription.organizationId,
          { now }
        );
        if (!reconciled.subscription.paidThrough
          && areRazorpayBillingWritesEnabled(subscription.organizationId)) {
          const lapsed = await cancelLapsedInitialAuthorization(subscription.id, now, subscription);
          if (lapsed) lapsedAuthorizations += 1;
        }
      } catch (error) {
        errors.push({
          organizationId: subscription.organizationId,
          message: error instanceof Error ? error.message : "Authorization deadline reconciliation failed",
        });
      }
    }

    const staleBefore = new Date(now.getTime() - RECONCILE_AFTER_MS);
    const staleSubscriptions = await prisma.organizationSubscription.findMany({
      where: {
        currentOrganizationId: { not: null },
        organization: { billingModelVersion: "WORKSPACE_V2" },
        status: { in: ["ACTIVE", "PENDING", "HALTED", "PAUSED", "CANCELLED", "COMPLETED"] },
        OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: staleBefore } }],
        id: { notIn: deadlineSubscriptions.map(subscription => subscription.id) },
      },
      select: { organizationId: true },
      take: 100,
    });
    let reconciledSubscriptions = 0;
    for (const subscription of staleSubscriptions) {
      try {
        await BillingReconciliationService.reconcileByOrganization(subscription.organizationId, { now });
        reconciledSubscriptions += 1;
      } catch (error) {
        errors.push({
          organizationId: subscription.organizationId,
          message: error instanceof Error ? error.message : "Scheduled reconciliation failed",
        });
      }
    }

    return {
      expiredTrials: expiredTrials.count,
      recoveredLeases,
      retriedMutations,
      submittedCancellations: dueCancellations.length,
      archivedBranches: archivedBranches.archived,
      confirmedCheckouts,
      timedOutCheckouts,
      lapsedAuthorizations,
      reconciledSubscriptions,
      reconciledReplacements,
      promotedReplacements,
      retriedReplacementCancellations,
      errors,
    };
  }
}
