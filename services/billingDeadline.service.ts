import { prisma } from "@/lib/prisma";
import { BillingMutationService } from "@/services/billingMutation.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { BranchService } from "@/services/branch.service";
import { OwnerTrialService } from "@/services/ownerTrial.service";

const RECONCILE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_AUTOMATIC_ATTEMPTS = 3;

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
    for (const organization of staleLeases) {
      await prisma.$transaction([
        prisma.organizationBillingChange.updateMany({
          where: { organizationId: organization.id, status: "PROCESSING" },
          data: { status: "QUEUED", processingStartedAt: null, lastError: "Recovered expired mutation lease" },
        }),
        prisma.organization.update({
          where: { id: organization.id },
          data: { billingMutationLeaseToken: null, billingMutationLeaseUntil: null },
        }),
      ]);
    }

    const retryableFailures = await prisma.organizationBillingChange.findMany({
      where: {
        status: "FAILED",
        attemptCount: { lt: MAX_AUTOMATIC_ATTEMPTS },
        organization: { billingModelVersion: "WORKSPACE_V2" },
      },
      orderBy: [{ organizationId: "asc" }, { sequence: "asc" }],
      distinct: ["organizationId"],
    });
    for (const change of retryableFailures) {
      try {
        await BillingMutationService.retry(change.id);
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
        const cardAuthorizationConfirmed = reconciliation.subscription.providerPaymentMethod === "CARD"
          && ["AUTHENTICATED", "ACTIVE"].includes(reconciliation.subscription.status)
          && paymentConfirmed;
        const recoveryConfirmation = ["PENDING", "HALTED"].includes(subscription.status);
        const paidPeriodAdvanced = reconciliation.confirmedPaidPeriod
          && Boolean(reconciliation.subscription.paidThrough)
          && (!subscription.paidThrough || reconciliation.subscription.paidThrough! > subscription.paidThrough);
        const providerConfirmed = recoveryConfirmation ? paidPeriodAdvanced : cardAuthorizationConfirmed;

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
                lastError: "Razorpay did not confirm card authorization before the deadline; start authorization again",
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
        errors.push({
          organizationId: change.organizationId,
          message: error instanceof Error ? error.message : "Checkout deadline reconciliation failed",
        });
      }
    }

    const deadlineSubscriptions = await prisma.organizationSubscription.findMany({
      where: {
        organization: { billingModelVersion: "WORKSPACE_V2" },
        paidThrough: null,
        status: { in: ["CREATED", "AUTHENTICATED", "ACTIVE"] },
        OR: [
          { authorizationExpiresAt: { lte: now } },
          { providerStartAt: { lte: now } },
        ],
      },
      select: { id: true, organizationId: true, status: true },
    });
    let lapsedAuthorizations = 0;
    for (const subscription of deadlineSubscriptions) {
      try {
        const reconciled = await BillingReconciliationService.reconcileByOrganization(
          subscription.organizationId,
          { now }
        );
        if (!reconciled.subscription.paidThrough) {
          await prisma.organizationSubscription.update({
            where: { id: subscription.id },
            data: {
              authorizationLapsedAt: now,
              status: ["CREATED", "AUTHENTICATED"].includes(reconciled.subscription.status)
                ? "EXPIRED"
                : undefined,
            },
          });
          lapsedAuthorizations += 1;
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
        organization: { billingModelVersion: "WORKSPACE_V2" },
        status: { in: ["ACTIVE", "PENDING", "HALTED", "CANCELLED", "COMPLETED"] },
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
      recoveredLeases: staleLeases.length,
      retriedMutations: retryableFailures.length,
      submittedCancellations: dueCancellations.length,
      archivedBranches: archivedBranches.archived,
      confirmedCheckouts,
      timedOutCheckouts,
      lapsedAuthorizations,
      reconciledSubscriptions,
      errors,
    };
  }
}
