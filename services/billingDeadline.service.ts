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
      lapsedAuthorizations,
      reconciledSubscriptions,
      errors,
    };
  }
}
