import { randomUUID } from "node:crypto";

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  configuredWhatsAppLiveAutomationCanaryOrganizationIds,
  configuredWhatsAppLiveDeliveryCanaryOrganizationIds,
  isWhatsAppReportPlannerEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import { WhatsAppJobRunService } from "@/services/whatsappJobRun.service";
import { WhatsAppReportService } from "@/services/whatsappReport.service";

export const MAX_WHATSAPP_REPORT_PLANNER_SUBSCRIPTIONS = 50;
export const DEFAULT_WHATSAPP_REPORT_PLANNER_SUBSCRIPTIONS = 20;
export const WHATSAPP_REPORT_PLANNER_LEASE_MS = 5 * 60 * 1_000;
const WHATSAPP_REPORT_PLANNER_REVISIT_MS = 10 * 60 * 1_000;

export type WhatsAppReportPlannerClaim = Readonly<{
  subscriptionId: string;
  leaseToken: string;
}>;

function safePlannerErrorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof code === "string" && /^[A-Z0-9][A-Z0-9._:-]{0,127}$/.test(code)
    ? code
    : "REPORT_PLANNER_FAILED";
}

function validLimit(value: number) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_WHATSAPP_REPORT_PLANNER_SUBSCRIPTIONS
  ) throw new Error("REPORT_PLANNER_LIMIT_INVALID");
  return value;
}

function liveOrganizationFilter(
  providerMode: "TEST" | "LIVE",
  env: Readonly<Record<string, string | undefined>>
) {
  if (providerMode === "TEST") return Prisma.sql``;
  const delivery = configuredWhatsAppLiveDeliveryCanaryOrganizationIds(env);
  const organizations = [...configuredWhatsAppLiveAutomationCanaryOrganizationIds(env)]
    .filter(organizationId => delivery.has(organizationId))
    .sort();
  return organizations.length === 0
    ? Prisma.sql`AND FALSE`
    : Prisma.sql`AND subscription."organizationId" IN (${Prisma.join(organizations)})`;
}

export class WhatsAppReportPlannerService {
  static async claimNextSubscription(input: {
    now: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }): Promise<WhatsAppReportPlannerClaim | null> {
    if (!isWhatsAppReportPlannerEnabled(input.env)) return null;
    const env = input.env ?? process.env;
    const providerMode = resolveWhatsAppProviderMode(env);
    const organizationFilter = liveOrganizationFilter(providerMode, env);
    const leaseToken = randomUUID();
    const leaseUntil = new Date(input.now.getTime() + WHATSAPP_REPORT_PLANNER_LEASE_MS);
    const revisitBefore = new Date(input.now.getTime() - WHATSAPP_REPORT_PLANNER_REVISIT_MS);
    return prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH ranked AS MATERIALIZED (
          SELECT
            subscription."id",
            subscription."organizationId",
            subscription."lastPlannedAt",
            ROW_NUMBER() OVER (
              PARTITION BY subscription."organizationId"
              ORDER BY subscription."lastPlannedAt" ASC NULLS FIRST, subscription."id" ASC
            ) AS tenant_rank
          FROM "WhatsAppReportSubscription" AS subscription
          INNER JOIN "WhatsAppSender" AS sender
            ON sender."id" = subscription."senderId"
            AND sender."organizationId" = subscription."organizationId"
            AND sender."provider" = 'META_CLOUD'::"WhatsAppProvider"
            AND sender."providerMode" = ${providerMode}::"WhatsAppProviderMode"
            AND sender."status" = 'ACTIVE'::"WhatsAppSenderStatus"
          WHERE subscription."status" = 'ACTIVE'::"WhatsAppReportSubscriptionStatus"
            AND subscription."activatedAt" IS NOT NULL
            AND (
              subscription."plannerLeaseUntil" IS NULL
              OR subscription."plannerLeaseUntil" <= ${input.now}
            )
            AND (
              subscription."lastPlannedAt" IS NULL
              OR subscription."lastPlannedAt" <= ${revisitBefore}
            )
            ${organizationFilter}
        ), candidate AS (
          SELECT subscription."id"
          FROM "WhatsAppReportSubscription" AS subscription
          INNER JOIN ranked ON ranked."id" = subscription."id"
          WHERE ranked.tenant_rank = 1
          ORDER BY ranked."lastPlannedAt" ASC NULLS FIRST,
            ranked."organizationId" ASC,
            subscription."id" ASC
          FOR UPDATE OF subscription SKIP LOCKED
          LIMIT 1
        )
        UPDATE "WhatsAppReportSubscription" AS subscription
        SET "plannerLeaseToken" = ${leaseToken},
            "plannerLeaseUntil" = ${leaseUntil},
            "lastPlannerErrorCode" = NULL,
            "updatedAt" = ${input.now}
        FROM candidate
        WHERE subscription."id" = candidate."id"
        RETURNING subscription."id"
      `);
      const subscriptionId = rows[0]?.id;
      return subscriptionId ? { subscriptionId, leaseToken } : null;
    }, { isolationLevel: "ReadCommitted" });
  }

  static async failClaim(input: {
    claim: WhatsAppReportPlannerClaim;
    now: Date;
    code: string;
  }) {
    const code = /^[A-Z0-9][A-Z0-9._:-]{0,127}$/.test(input.code)
      ? input.code
      : "REPORT_PLANNER_FAILED";
    return prisma.whatsAppReportSubscription.updateMany({
      where: {
        id: input.claim.subscriptionId,
        plannerLeaseToken: input.claim.leaseToken,
      },
      data: {
        plannerLeaseToken: null,
        plannerLeaseUntil: null,
        lastPlannedAt: input.now,
        lastPlannerErrorCode: code,
      },
    });
  }

  static async planClaim(input: {
    claim: WhatsAppReportPlannerClaim;
    now: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    return prisma.$transaction(tx =>
      WhatsAppReportService.planClaimedSubscriptionInTransaction({
        tx,
        subscriptionId: input.claim.subscriptionId,
        leaseToken: input.claim.leaseToken,
        now: input.now,
        env: input.env,
      }),
    { isolationLevel: "Serializable" });
  }

  static async run(input: {
    now?: Date;
    limit?: number;
    invocationId?: string;
    env?: Readonly<Record<string, string | undefined>>;
  } = {}) {
    const now = input.now ?? new Date();
    const limit = validLimit(
      input.limit ?? DEFAULT_WHATSAPP_REPORT_PLANNER_SUBSCRIPTIONS
    );
    if (!isWhatsAppReportPlannerEnabled(input.env)) {
      return {
        held: true as const,
        claimedSubscriptions: 0,
        completedSubscriptions: 0,
        failedSubscriptions: 0,
        queuedMessages: 0,
        dedupedMessages: 0,
        missedReports: 0,
        staleSubscriptions: 0,
        skippedSubscriptions: 0,
        limitReached: false,
      };
    }
    const providerMode = resolveWhatsAppProviderMode(input.env);
    const invocationId = input.invocationId ?? `report-planner:${randomUUID()}`;
    const started = await WhatsAppJobRunService.start({
      jobType: "REPORT_PLANNER",
      invocationId,
      providerMode,
      counts: {},
      now,
    });
    if (!started.created) {
      return {
        held: started.run.status === "HELD",
        replayed: true as const,
        jobRunId: started.run.id,
        status: started.run.status,
      };
    }

    let claimedSubscriptions = 0;
    let completedSubscriptions = 0;
    let failedSubscriptions = 0;
    let queuedMessages = 0;
    let dedupedMessages = 0;
    let missedReports = 0;
    let staleSubscriptions = 0;
    let skippedSubscriptions = 0;
    let fatalErrorCode: string | null = null;
    try {
      for (; claimedSubscriptions < limit;) {
        const claim = await this.claimNextSubscription({ now, env: input.env });
        if (!claim) break;
        claimedSubscriptions += 1;
        try {
          const result = await this.planClaim({ claim, now, env: input.env });
          completedSubscriptions += 1;
          if (result.outcome === "QUEUED") queuedMessages += 1;
          else if (result.outcome === "DEDUPED") dedupedMessages += 1;
          else if (result.outcome === "MISSED") missedReports += 1;
          else if (result.outcome === "STALE") staleSubscriptions += 1;
          else skippedSubscriptions += 1;
        } catch (error) {
          failedSubscriptions += 1;
          try {
            await this.failClaim({
              claim,
              now,
              code: safePlannerErrorCode(error),
            });
          } catch {
            // A stale worker must never clear a newer lease.
          }
        }
      }
    } catch (error) {
      fatalErrorCode = safePlannerErrorCode(error);
    }
    const counts = {
      claimedSubscriptions,
      completedSubscriptions,
      failedSubscriptions,
      queuedMessages,
      dedupedMessages,
      missedReports,
      staleSubscriptions,
      skippedSubscriptions,
      fatalFailures: fatalErrorCode ? 1 : 0,
    };
    const status = failedSubscriptions === 0 && !fatalErrorCode
      ? "SUCCEEDED" as const
      : completedSubscriptions > 0 || claimedSubscriptions > failedSubscriptions
        ? "PARTIAL" as const
        : "FAILED" as const;
    const finished = await WhatsAppJobRunService.finish({
      runId: started.run.id,
      status,
      counts,
      safeErrorCode: fatalErrorCode
        ?? (failedSubscriptions > 0 ? "REPORT_PLANNER_PARTIAL_FAILURE" : null),
      now: new Date(),
    });
    return {
      held: false as const,
      replayed: false as const,
      jobRunId: finished.run.id,
      status: finished.run.status,
      ...counts,
      limitReached: claimedSubscriptions >= limit,
    };
  }
}
