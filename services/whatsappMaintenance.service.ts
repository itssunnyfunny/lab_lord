import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { isWhatsAppDeliverySchemaAccessEnabled } from "@/lib/whatsappFeature";
import { WhatsAppValidationError } from "@/lib/whatsappHttp";
import { getWhatsAppRateCardStatus, readWhatsAppRateCard } from "@/lib/whatsappCost";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";
import { WhatsAppJobRunService, type WhatsAppJobCounts } from "@/services/whatsappJobRun.service";
import { WhatsAppServiceNoticeService } from "@/services/whatsappServiceNotice.service";
import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";

export const WHATSAPP_MAINTENANCE_BATCH_LIMIT = 100;
export const WHATSAPP_JOB_RUN_RETENTION_DAYS = 30;
export const WHATSAPP_REPORT_SNAPSHOT_RETENTION_DAYS = 400;
export const WHATSAPP_PENDING_SUBSCRIPTION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function batchLimit(value: number | undefined) {
  const limit = value ?? WHATSAPP_MAINTENANCE_BATCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WHATSAPP_MAINTENANCE_BATCH_LIMIT) {
    throw new WhatsAppValidationError();
  }
  return limit;
}

function safeMaintenanceError(error: unknown) {
  return error instanceof Error && error.name === "WhatsAppValidationError"
    ? "MAINTENANCE_INVALID_STATE"
    : "MAINTENANCE_FAILED";
}

async function reconcileStaleDispatchLeases(input: {
  now: Date;
  limit: number;
  counts: Record<string, number>;
}) {
  const deltas = await prisma.$transaction(async tx => {
    const committed = {
      batchesAtLimit: 0,
      staleMessageLeasesDetected: 0,
      staleClaimsRecovered: 0,
      stalePreSubmissionsRecovered: 0,
      staleSubmissionsMarkedUnknown: 0,
    };
    const staleMessageLeases = await tx.$queryRaw<Array<{
      id: string;
      organizationId: string;
      branchId: string | null;
      senderId: string;
      status: "CLAIMED" | "SUBMITTING";
      providerCallAdmittedAt: Date | null;
    }>>(Prisma.sql`
      SELECT
        "id",
        "organizationId",
        "branchId",
        "senderId",
        "status",
        "providerCallAdmittedAt"
      FROM "WhatsAppMessage"
      WHERE "status" IN (
        'CLAIMED'::"WhatsAppMessageStatus",
        'SUBMITTING'::"WhatsAppMessageStatus"
      )
        AND "leaseUntil" < ${input.now}
        AND "leaseToken" IS NOT NULL
      ORDER BY "leaseUntil" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    `);
    if (staleMessageLeases.length === input.limit) committed.batchesAtLimit += 1;

    for (const message of staleMessageLeases) {
      committed.staleMessageLeasesDetected += 1;
      if (message.status === "CLAIMED") {
        const recovered = await tx.whatsAppMessage.updateMany({
          where: {
            id: message.id,
            status: "CLAIMED",
            submissionStartedAt: null,
            leaseUntil: { lt: input.now },
            leaseToken: { not: null },
          },
          data: {
            status: "SCHEDULED",
            claimedAt: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });
        if (recovered.count !== 1) continue;
        committed.staleClaimsRecovered += 1;
        await WhatsAppIncidentService.createOrTouchInTransaction({
          tx,
          organizationId: message.organizationId,
          branchId: message.branchId,
          senderId: message.senderId,
          messageId: message.id,
          type: "DISPATCH_BACKLOG",
          severity: "WARNING",
          dedupeKey: `message:${message.id}:stale-dispatch-lease`,
          safeCode: "CLAIM_LEASE_STALE",
          details: { submitting: false },
          now: input.now,
        });
        continue;
      }

      if (!message.providerCallAdmittedAt) {
        const recovered = await tx.whatsAppMessage.updateMany({
          where: {
            id: message.id,
            status: "SUBMITTING",
            providerCallAdmittedAt: null,
            leaseUntil: { lt: input.now },
            leaseToken: { not: null },
          },
          data: {
            status: "SCHEDULED",
            claimedAt: null,
            submissionStartedAt: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });
        if (recovered.count !== 1) continue;
        committed.stalePreSubmissionsRecovered += 1;
        await WhatsAppIncidentService.createOrTouchInTransaction({
          tx,
          organizationId: message.organizationId,
          branchId: message.branchId,
          senderId: message.senderId,
          messageId: message.id,
          type: "DISPATCH_BACKLOG",
          severity: "WARNING",
          dedupeKey: `message:${message.id}:stale-dispatch-lease`,
          safeCode: "PRE_SUBMISSION_LEASE_STALE",
          details: { providerCallAdmitted: false, requeued: true },
          now: input.now,
        });
        continue;
      }

      const unknown = await tx.whatsAppMessage.updateMany({
        where: {
          id: message.id,
          status: "SUBMITTING",
          providerCallAdmittedAt: { not: null },
          leaseUntil: { lt: input.now },
          leaseToken: { not: null },
        },
        data: {
          status: "UNKNOWN",
          failureCode: "PROVIDER_UNKNOWN_OUTCOME",
          safeFailureMessage:
            "Provider acceptance could not be confirmed. Lab Lords will not retry automatically because that could send a duplicate message.",
          budgetState: "COMMITTED",
          leaseToken: null,
          leaseUntil: null,
        },
      });
      if (unknown.count !== 1) continue;
      committed.staleSubmissionsMarkedUnknown += 1;
      await WhatsAppSenderSafetyService.recordAmbiguousOutcomeInTransaction({
        tx,
        organizationId: message.organizationId,
        branchId: message.branchId,
        senderId: message.senderId,
        messageId: message.id,
        now: input.now,
      });
      await WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
        tx,
        organizationId: message.organizationId,
        senderId: message.senderId,
        now: input.now,
      });
    }
    return committed;
  }, { isolationLevel: "ReadCommitted" });
  input.counts.batchesAtLimit += deltas.batchesAtLimit;
  input.counts.staleMessageLeasesDetected += deltas.staleMessageLeasesDetected;
  input.counts.staleClaimsRecovered += deltas.staleClaimsRecovered;
  input.counts.stalePreSubmissionsRecovered += deltas.stalePreSubmissionsRecovered;
  input.counts.staleSubmissionsMarkedUnknown += deltas.staleSubmissionsMarkedUnknown;
}

export class WhatsAppMaintenanceService {
  static async run(input: {
    invocationId: string;
    limit?: number;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    if (!isWhatsAppDeliverySchemaAccessEnabled(input.env)) {
      return { held: true as const, replayed: false as const, status: "HELD" as const, counts: {} };
    }
    const now = input.now ?? new Date();
    const limit = batchLimit(input.limit);
    const started = await WhatsAppJobRunService.start({
      jobType: "MAINTENANCE",
      invocationId: input.invocationId,
      now,
    });
    if (!started.created) {
      return {
        held: started.run.status === "HELD",
        replayed: true as const,
        status: started.run.status,
        counts: started.run.counts,
      };
    }
    const counts: Record<string, number> = {
      subscriptionsExpired: 0,
      reportLeasesCleared: 0,
      healthLeasesCleared: 0,
      staleMessageLeasesDetected: 0,
      staleClaimsRecovered: 0,
      stalePreSubmissionsRecovered: 0,
      staleSubmissionsMarkedUnknown: 0,
      staleJobRunsFailed: 0,
      rateCardIncidents: 0,
      rateCardIncidentsResolved: 0,
      orphanEventsDeleted: 0,
      oldJobRunsDeleted: 0,
      oldSnapshotsDeleted: 0,
      noticesReconciled: 0,
      batchesAtLimit: 0,
    };
    try {
      await reconcileStaleDispatchLeases({ now, limit, counts });
      await prisma.$transaction(async tx => {
        const oldPendingCutoff = new Date(now.getTime() - WHATSAPP_PENDING_SUBSCRIPTION_MAX_AGE_MS);
        const pending = await tx.whatsAppReportSubscription.findMany({
          where: {
            status: "PENDING_CONFIRMATION",
            OR: [
              { confirmationExpiresAt: { lte: now } },
              { confirmationExpiresAt: null, createdAt: { lte: oldPendingCutoff } },
            ],
          },
          orderBy: [{ confirmationExpiresAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          take: limit,
          select: { id: true },
        });
        if (pending.length === limit) counts.batchesAtLimit += 1;
        if (pending.length > 0) {
          const expired = await tx.whatsAppReportSubscription.updateMany({
            where: { id: { in: pending.map(item => item.id) }, status: "PENDING_CONFIRMATION" },
            data: {
              status: "EXPIRED",
              confirmationCodeHash: null,
              confirmationExpiresAt: null,
              plannerLeaseToken: null,
              plannerLeaseUntil: null,
            },
          });
          counts.subscriptionsExpired = expired.count;
        }

        const staleReportLeases = await tx.whatsAppReportSubscription.findMany({
          where: { plannerLeaseUntil: { lt: now }, plannerLeaseToken: { not: null } },
          orderBy: [{ plannerLeaseUntil: "asc" }, { id: "asc" }],
          take: limit,
          select: {
            id: true,
            organizationId: true,
            branchId: true,
            senderId: true,
          },
        });
        if (staleReportLeases.length === limit) counts.batchesAtLimit += 1;
        for (const subscription of staleReportLeases) {
          const cleared = await tx.whatsAppReportSubscription.updateMany({
            where: {
              id: subscription.id,
              plannerLeaseUntil: { lt: now },
              plannerLeaseToken: { not: null },
            },
            data: {
              plannerLeaseToken: null,
              plannerLeaseUntil: null,
              lastPlannerErrorCode: "STALE_LEASE_RECLAIMED",
            },
          });
          if (cleared.count !== 1) continue;
          counts.reportLeasesCleared += 1;
          await WhatsAppIncidentService.createOrTouchInTransaction({
            tx,
            organizationId: subscription.organizationId,
            branchId: subscription.branchId,
            senderId: subscription.senderId,
            type: "PLANNER_STALE",
            severity: "WARNING",
            dedupeKey: `report-subscription:${subscription.id}:stale-lease`,
            safeCode: "REPORT_PLANNER_LEASE_STALE",
            details: { leaseReclaimed: true },
            now,
          });
        }

        const staleHealthLeases = await tx.whatsAppSender.findMany({
          where: { healthLeaseUntil: { lt: now }, healthLeaseToken: { not: null } },
          orderBy: [{ healthLeaseUntil: "asc" }, { id: "asc" }],
          take: limit,
          select: { id: true, organizationId: true },
        });
        if (staleHealthLeases.length === limit) counts.batchesAtLimit += 1;
        for (const sender of staleHealthLeases) {
          const cleared = await tx.whatsAppSender.updateMany({
            where: { id: sender.id, healthLeaseUntil: { lt: now }, healthLeaseToken: { not: null } },
            data: {
              healthLeaseToken: null,
              healthLeaseUntil: null,
              lastErrorCode: "HEALTH_LEASE_STALE",
            },
          });
          if (cleared.count !== 1) continue;
          counts.healthLeasesCleared += 1;
          await WhatsAppIncidentService.createOrTouchInTransaction({
            tx,
            organizationId: sender.organizationId,
            senderId: sender.id,
            type: "PLANNER_STALE",
            severity: "WARNING",
            dedupeKey: `sender:${sender.id}:health-stale-lease`,
            safeCode: "HEALTH_LEASE_STALE",
            details: { leaseReclaimed: true },
            now,
          });
        }

        const staleJobCutoff = new Date(now.getTime() - 60 * 60 * 1_000);
        const staleJobs = await tx.whatsAppJobRun.findMany({
          where: {
            id: { not: started.run.id },
            status: "RUNNING",
            startedAt: { lt: staleJobCutoff },
          },
          orderBy: [{ startedAt: "asc" }, { id: "asc" }],
          take: limit,
          select: { id: true, startedAt: true },
        });
        if (staleJobs.length === limit) counts.batchesAtLimit += 1;
        for (const job of staleJobs) {
          const durationMs = Math.min(
            2_147_483_647,
            Math.max(0, now.getTime() - job.startedAt.getTime())
          );
          const failed = await tx.whatsAppJobRun.updateMany({
            where: { id: job.id, status: "RUNNING", startedAt: { lt: staleJobCutoff } },
            data: {
              status: "FAILED",
              finishedAt: now,
              durationMs,
              safeErrorCode: "JOB_RUN_STALE",
            },
          });
          counts.staleJobRunsFailed += failed.count;
        }

        let expiredRateCardVersion: string | null = null;
        let rateCardCurrent = false;
        try {
          const card = readWhatsAppRateCard(input.env);
          const status = getWhatsAppRateCardStatus(card, now);
          if (status === "EXPIRED") {
            expiredRateCardVersion = card.version;
          } else if (status === "VALID" || status === "EXPIRING") {
            rateCardCurrent = true;
          }
        } catch {
          // Missing or malformed configuration is not enough evidence to call a
          // known historical rate card expired.
        }
        if (expiredRateCardVersion) {
          const senders = await tx.whatsAppSender.findMany({
            where: { status: "ACTIVE" },
            orderBy: [{ id: "asc" }],
            take: limit,
            select: { id: true, organizationId: true },
          });
          if (senders.length === limit) counts.batchesAtLimit += 1;
          for (const sender of senders) {
            await WhatsAppIncidentService.createOrTouchInTransaction({
              tx,
              organizationId: sender.organizationId,
              senderId: sender.id,
              type: "RATE_CARD_EXPIRED",
              severity: "CRITICAL",
              dedupeKey: `sender:${sender.id}:rate-card`,
              safeCode: "RATE_CARD_EXPIRED",
              details: { rateCardVersion: expiredRateCardVersion },
              now,
            });
            counts.rateCardIncidents += 1;
          }
        } else if (rateCardCurrent) {
          const staleRateIncidents = await tx.whatsAppOperationalIncident.findMany({
            where: {
              type: "RATE_CARD_EXPIRED",
              status: { not: "RESOLVED" },
            },
            orderBy: [{ lastSeenAt: "asc" }, { id: "asc" }],
            take: limit,
            select: { dedupeKey: true },
          });
          if (staleRateIncidents.length === limit) counts.batchesAtLimit += 1;
          for (const incident of staleRateIncidents) {
            const resolved = await WhatsAppIncidentService.resolveInTransaction({
              tx,
              dedupeKey: incident.dedupeKey,
              resolutionCode: "RATE_CARD_CURRENT",
              now,
            });
            counts.rateCardIncidentsResolved += resolved.count;
          }
        }

        const orphanEvents = await tx.whatsAppMessageEvent.findMany({
          where: { messageId: null, expiresAt: { lte: now } },
          orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
          take: limit,
          select: { id: true },
        });
        if (orphanEvents.length === limit) counts.batchesAtLimit += 1;
        if (orphanEvents.length > 0) {
          const deleted = await tx.whatsAppMessageEvent.deleteMany({
            where: { id: { in: orphanEvents.map(item => item.id) }, messageId: null, expiresAt: { lte: now } },
          });
          counts.orphanEventsDeleted = deleted.count;
        }

        const jobCutoff = new Date(now.getTime() - WHATSAPP_JOB_RUN_RETENTION_DAYS * 86_400_000);
        const oldJobRuns = await tx.whatsAppJobRun.findMany({
          where: {
            createdAt: { lt: jobCutoff },
            id: { not: started.run.id },
            status: { not: "RUNNING" },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit,
          select: { id: true },
        });
        if (oldJobRuns.length === limit) counts.batchesAtLimit += 1;
        if (oldJobRuns.length > 0) {
          const deleted = await tx.whatsAppJobRun.deleteMany({
            where: { id: { in: oldJobRuns.map(item => item.id) }, createdAt: { lt: jobCutoff } },
          });
          counts.oldJobRunsDeleted = deleted.count;
        }

        const snapshotCutoff = new Date(
          now.getTime() - WHATSAPP_REPORT_SNAPSHOT_RETENTION_DAYS * 86_400_000
        );
        const snapshots = await tx.whatsAppDailyReportSnapshot.findMany({
          where: { createdAt: { lt: snapshotCutoff }, messages: { none: {} } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit,
          select: { id: true },
        });
        if (snapshots.length === limit) counts.batchesAtLimit += 1;
        if (snapshots.length > 0) {
          const deleted = await tx.whatsAppDailyReportSnapshot.deleteMany({
            where: {
              id: { in: snapshots.map(item => item.id) },
              createdAt: { lt: snapshotCutoff },
              messages: { none: {} },
            },
          });
          counts.oldSnapshotsDeleted = deleted.count;
        }

        const notices = await tx.whatsAppServiceNotice.findMany({
          where: { status: { in: ["QUEUED", "PARTIAL"] } },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit,
          select: { id: true },
        });
        if (notices.length === limit) counts.batchesAtLimit += 1;
        for (const notice of notices) {
          await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
            tx,
            noticeId: notice.id,
            now,
          });
          counts.noticesReconciled += 1;
        }
      }, { isolationLevel: "Serializable" });

      await WhatsAppJobRunService.finish({
        runId: started.run.id,
        status: "SUCCEEDED",
        counts: counts as WhatsAppJobCounts,
        now: new Date(),
      });
      return {
        held: false as const,
        replayed: false as const,
        status: "SUCCEEDED" as const,
        counts,
        limitReached: counts.batchesAtLimit > 0,
      };
    } catch (error) {
      await WhatsAppJobRunService.finish({
        runId: started.run.id,
        status: "FAILED",
        counts: counts as WhatsAppJobCounts,
        safeErrorCode: safeMaintenanceError(error),
        now: new Date(),
      });
      throw error;
    }
  }
}
