import {
  Prisma,
  type WhatsAppSenderPauseReason,
  type WhatsAppSenderSafetyState,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertWhatsAppDeliverySchemaAccessEnabled,
  assertWhatsAppIntegrationEnabled,
} from "@/lib/whatsappFeature";
import {
  getWhatsAppRateCardStatus,
  readWhatsAppRateCard,
} from "@/lib/whatsappCost";
import {
  hasCompleteManagedWhatsAppTemplateCatalog,
  WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
} from "@/lib/whatsappManagedTemplates";
import {
  advanceWhatsAppSenderSafetyWindow,
  isReviewedWhatsAppSenderWideFailure,
  isWhatsAppSenderHealthFresh,
  WHATSAPP_AMBIGUOUS_OUTCOME_THRESHOLD,
  WHATSAPP_DEFINITE_FAILURE_THRESHOLD,
  type WhatsAppDefiniteFailureEvidence,
} from "@/lib/whatsappSenderSafety";
import {
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

async function assertSenderScope(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  senderId: string;
}) {
  if (!ID_PATTERN.test(input.organizationId) || !ID_PATTERN.test(input.senderId)) {
    throw new WhatsAppValidationError();
  }
  const sender = await input.tx.whatsAppSender.findFirst({
    where: { id: input.senderId, organizationId: input.organizationId },
    select: { id: true, status: true },
  });
  if (!sender) throw new WhatsAppResourceNotFoundError();
  return sender;
}

async function lockSafetyState(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  senderId: string;
}) {
  await assertSenderScope(input);
  await input.tx.whatsAppSenderSafetyState.upsert({
    where: { senderId: input.senderId },
    create: { senderId: input.senderId },
    update: {},
  });
  await input.tx.$queryRaw(Prisma.sql`
    SELECT "senderId"
    FROM "WhatsAppSenderSafetyState"
    WHERE "senderId" = ${input.senderId}
    FOR UPDATE
  `);
  const state = await input.tx.whatsAppSenderSafetyState.findUnique({
    where: { senderId: input.senderId },
  });
  if (!state) throw new WhatsAppResourceNotFoundError();
  return state;
}

async function applyAutomaticPause(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  senderId: string;
  reason: WhatsAppSenderPauseReason;
  now: Date;
}) {
  const current = await input.tx.whatsAppSenderSafetyState.findUnique({
    where: { senderId: input.senderId },
  });
  if (!current) throw new WhatsAppResourceNotFoundError();
  return requestPauseWithLockedState({
    ...input,
    current,
    pausedByUserId: null,
  });
}

async function finalizeRequestedPauseWithLockedState(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  senderId: string;
  current: WhatsAppSenderSafetyState;
  now: Date;
}) {
  if (input.current.pausedAt || !input.current.pauseRequestedAt) {
    return {
      changed: false as const,
      pausePending: false,
      state: input.current,
    };
  }
  const activeAdmissions = await input.tx.whatsAppMessage.count({
    where: {
      senderId: input.senderId,
      status: "SUBMITTING",
      providerMessageId: null,
      providerCallAdmittedAt: { not: null },
    },
  });
  if (activeAdmissions > 0) {
    return {
      changed: false as const,
      pausePending: true,
      state: input.current,
    };
  }
  const state = await input.tx.whatsAppSenderSafetyState.update({
    where: { senderId: input.senderId },
    data: {
      pausedAt: input.now,
      pauseRequestedAt: null,
    },
  });
  if (state.pausedByUserId) {
    await input.tx.whatsAppAuditEvent.create({
      data: {
        organizationId: input.organizationId,
        senderId: input.senderId,
        actorUserId: state.pausedByUserId,
        action: "SENDER_PAUSED",
        details: {
          pauseReason: state.pauseReason,
          pauseRevision: state.pauseRevision,
        },
      },
    });
  }
  return { changed: true as const, pausePending: false, state };
}

async function requestPauseWithLockedState(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  senderId: string;
  current: WhatsAppSenderSafetyState;
  reason: WhatsAppSenderPauseReason;
  pausedByUserId: string | null;
  now: Date;
}) {
  if (input.current.pausedAt) {
    return { changed: false as const, pausePending: false, state: input.current };
  }
  let requested = input.current;
  let requestedNow = false;
  if (!input.current.pauseRequestedAt) {
    requested = await input.tx.whatsAppSenderSafetyState.update({
      where: { senderId: input.senderId },
      data: {
        pauseRequestedAt: input.now,
        pauseReason: input.reason,
        pausedByUserId: input.pausedByUserId,
        pauseRevision: { increment: 1 },
      },
    });
    requestedNow = true;
  }
  const finalized = await finalizeRequestedPauseWithLockedState({
    tx: input.tx,
    organizationId: input.organizationId,
    senderId: input.senderId,
    current: requested,
    now: input.now,
  });
  return {
    changed: requestedNow || finalized.changed,
    pausePending: finalized.pausePending,
    state: finalized.state,
  };
}

export type WhatsAppResumeBlocker =
  | "PAUSE_DRAINING"
  | "SENDER_NOT_ACTIVE"
  | "RATE_CARD_NOT_CURRENT"
  | "HEALTH_RECONCILIATION_STALE"
  | "PROVIDER_RESTRICTED"
  | "TEMPLATES_UNHEALTHY"
  | "CRITICAL_INCIDENT_OPEN";

async function templateHealth(
  senderId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  const provisionings = await client.whatsAppManagedTemplateProvisioning.findMany({
    where: {
      senderId,
      catalogVersion: WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
    },
    select: {
      managedKey: true,
      language: true,
      catalogVersion: true,
      status: true,
      binding: {
        select: {
          active: true,
          template: {
            select: { providerStatus: true, category: true, staleAt: true },
          },
        },
      },
    },
  });
  return hasCompleteManagedWhatsAppTemplateCatalog(provisionings)
    && provisionings.every(item =>
    item.status === "READY"
    && item.binding?.active === true
    && item.binding.template.providerStatus === "APPROVED"
    && item.binding.template.category === "UTILITY"
    && item.binding.template.staleAt === null
  );
}

function rateCardView(
  now: Date,
  env: Readonly<Record<string, string | undefined>> | undefined
) {
  try {
    const card = readWhatsAppRateCard(env);
    const status = getWhatsAppRateCardStatus(card, now);
    return {
      state: status === "VALID"
        ? "CURRENT" as const
        : status === "EXPIRING"
          ? "EXPIRING" as const
          : status === "EXPIRED"
            ? "EXPIRED" as const
            : "UNAVAILABLE" as const,
      version: card.version,
      expiresAt: card.expiresAt,
      current: status === "VALID" || status === "EXPIRING",
    };
  } catch {
    return {
      state: "UNAVAILABLE" as const,
      version: null,
      expiresAt: null,
      current: false,
    };
  }
}

export class WhatsAppSenderSafetyService {
  static async recordAmbiguousOutcomeInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    branchId?: string | null;
    senderId: string;
    messageId?: string | null;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const state = await lockSafetyState(input);
    const next = advanceWhatsAppSenderSafetyWindow({
      current: {
        windowStartedAt: state.ambiguousWindowStartedAt,
        count: state.ambiguousOutcomeCount,
      },
      now,
    });
    const updated = await input.tx.whatsAppSenderSafetyState.update({
      where: { senderId: input.senderId },
      data: {
        ambiguousWindowStartedAt: next.windowStartedAt,
        ambiguousOutcomeCount: next.count,
      },
    });
    if (input.messageId) {
      await WhatsAppIncidentService.createOrTouchInTransaction({
        tx: input.tx,
        organizationId: input.organizationId,
        branchId: input.branchId ?? null,
        senderId: input.senderId,
        messageId: input.messageId,
        type: "UNKNOWN_DELIVERY",
        severity: "CRITICAL",
        dedupeKey: `message:${input.messageId}:unknown`,
        safeCode: "PROVIDER_UNKNOWN_OUTCOME",
        now,
      });
    }
    let paused = false;
    if (next.count >= WHATSAPP_AMBIGUOUS_OUTCOME_THRESHOLD) {
      const pause = await applyAutomaticPause({
        tx: input.tx,
        organizationId: input.organizationId,
        senderId: input.senderId,
        reason: "AMBIGUOUS_OUTCOME_BURST",
        now,
      });
      paused = pause.changed;
      await WhatsAppIncidentService.createOrTouchInTransaction({
        tx: input.tx,
        organizationId: input.organizationId,
        senderId: input.senderId,
        type: "CIRCUIT_BREAKER_OPEN",
        severity: "CRITICAL",
        dedupeKey: `sender:${input.senderId}:circuit:ambiguous`,
        safeCode: "AMBIGUOUS_OUTCOME_BURST",
        details: { outcomeCount: next.count, windowMinutes: 10 },
        now,
      });
    }
    return { counted: true as const, count: next.count, paused, state: updated };
  }

  static async recordDefiniteFailureInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    evidence: WhatsAppDefiniteFailureEvidence;
    now?: Date;
  }) {
    if (!isReviewedWhatsAppSenderWideFailure(input.evidence)) {
      return { counted: false as const, count: 0, paused: false };
    }
    const now = input.now ?? new Date();
    const state = await lockSafetyState(input);
    const next = advanceWhatsAppSenderSafetyWindow({
      current: {
        windowStartedAt: state.failureWindowStartedAt,
        count: state.definiteFailureCount,
      },
      now,
    });
    await input.tx.whatsAppSenderSafetyState.update({
      where: { senderId: input.senderId },
      data: {
        failureWindowStartedAt: next.windowStartedAt,
        definiteFailureCount: next.count,
      },
    });
    let paused = false;
    if (next.count >= WHATSAPP_DEFINITE_FAILURE_THRESHOLD) {
      const pause = await applyAutomaticPause({
        tx: input.tx,
        organizationId: input.organizationId,
        senderId: input.senderId,
        reason: "DEFINITE_FAILURE_BURST",
        now,
      });
      paused = pause.changed;
      await WhatsAppIncidentService.createOrTouchInTransaction({
        tx: input.tx,
        organizationId: input.organizationId,
        senderId: input.senderId,
        type: "CIRCUIT_BREAKER_OPEN",
        severity: "CRITICAL",
        dedupeKey: `sender:${input.senderId}:circuit:definite`,
        safeCode: "DEFINITE_FAILURE_BURST",
        details: { failureCount: next.count, windowMinutes: 10 },
        now,
      });
    }
    return { counted: true as const, count: next.count, paused };
  }

  static async pauseForProviderRestrictionInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    await lockSafetyState(input);
    return applyAutomaticPause({
      tx: input.tx,
      organizationId: input.organizationId,
      senderId: input.senderId,
      reason: "PROVIDER_RESTRICTED",
      now,
    });
  }

  static async recordAcceptedInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    at?: Date;
  }) {
    const at = input.at ?? new Date();
    const current = await lockSafetyState(input);
    if (current.lastAcceptedAt && current.lastAcceptedAt.getTime() >= at.getTime()) {
      return current;
    }
    return input.tx.whatsAppSenderSafetyState.update({
      where: { senderId: input.senderId },
      data: { lastAcceptedAt: at },
    });
  }

  static async recordDeliveredInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    at?: Date;
  }) {
    const at = input.at ?? new Date();
    const current = await lockSafetyState(input);
    if (current.lastDeliveredAt && current.lastDeliveredAt.getTime() >= at.getTime()) {
      return current;
    }
    return input.tx.whatsAppSenderSafetyState.update({
      where: { senderId: input.senderId },
      data: { lastDeliveredAt: at },
    });
  }

  static async pauseByOwner(input: {
    actorUserId: string;
    organizationId: string;
    senderId: string;
    confirmation: boolean;
    now?: Date;
  }) {
    if (input.confirmation !== true) throw new WhatsAppValidationError();
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppDeliverySchemaAccessEnabled();
    const now = input.now ?? new Date();
    return prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        input.organizationId,
        tx
      );
      const state = await lockSafetyState({ ...input, tx });
      const result = await requestPauseWithLockedState({
        tx,
        organizationId: input.organizationId,
        senderId: input.senderId,
        current: state,
        reason: "OWNER_PAUSED",
        pausedByUserId: input.actorUserId,
        now,
      });
      return result;
    }, { isolationLevel: "ReadCommitted" });
  }

  static async finalizeRequestedPauseInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    now?: Date;
  }) {
    const current = await lockSafetyState(input);
    return finalizeRequestedPauseWithLockedState({
      ...input,
      current,
      now: input.now ?? new Date(),
    });
  }

  static async getForOwner(input: {
    actorUserId: string;
    organizationId: string;
    senderId: string;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppIntegrationEnabled(input.env);
    assertWhatsAppDeliverySchemaAccessEnabled(input.env);
    await WhatsAppAuthorizationService.assertOwnerEntitled(
      input.actorUserId,
      input.organizationId
    );
    const sender = await prisma.whatsAppSender.findFirst({
      where: { id: input.senderId, organizationId: input.organizationId },
      include: { safetyState: true },
    });
    if (!sender) throw new WhatsAppResourceNotFoundError();
    const now = input.now ?? new Date();
    const [templatesHealthy, unknownOutcomeCount, openCriticalIncidentCount] = await Promise.all([
      templateHealth(sender.id),
      prisma.whatsAppMessage.count({ where: { senderId: sender.id, status: "UNKNOWN" } }),
      prisma.whatsAppOperationalIncident.count({
        where: {
          senderId: sender.id,
          severity: "CRITICAL",
          status: { not: "RESOLVED" },
        },
      }),
    ]);
    const rate = rateCardView(now, input.env);
    const providerRestricted = sender.status === "RESTRICTED"
      || sender.providerRestrictionCode !== null;
    const criticalBlockingCount = await prisma.whatsAppOperationalIncident.count({
      where: {
        senderId: sender.id,
        severity: "CRITICAL",
        status: { not: "RESOLVED" },
        type: {
          notIn: [
            "CIRCUIT_BREAKER_OPEN",
            ...(rate.current ? ["RATE_CARD_EXPIRED" as const] : []),
            ...(!providerRestricted ? ["SENDER_RESTRICTED" as const] : []),
          ],
        },
      },
    });
    const blockers: WhatsAppResumeBlocker[] = [];
    if (sender.safetyState?.pauseRequestedAt) blockers.push("PAUSE_DRAINING");
    if (sender.status !== "ACTIVE") blockers.push("SENDER_NOT_ACTIVE");
    if (!rate.current) blockers.push("RATE_CARD_NOT_CURRENT");
    if (!isWhatsAppSenderHealthFresh({ lastHealthyAt: sender.safetyState?.lastHealthyAt ?? null, now })) {
      blockers.push("HEALTH_RECONCILIATION_STALE");
    }
    if (providerRestricted) blockers.push("PROVIDER_RESTRICTED");
    if (!templatesHealthy) blockers.push("TEMPLATES_UNHEALTHY");
    if (criticalBlockingCount > 0) blockers.push("CRITICAL_INCIDENT_OPEN");
    const state = sender.safetyState;
    const pausePending = Boolean(state?.pauseRequestedAt && !state.pausedAt);
    return {
      senderLabel: sender.verifiedName ?? "WhatsApp sender",
      senderStatus: sender.status === "ACTIVE"
        ? "ACTIVE" as const
        : sender.status === "RESTRICTED"
          ? "RESTRICTED" as const
          : sender.status === "DISCONNECTED"
            ? "INACTIVE" as const
            : "UNKNOWN" as const,
      paused: Boolean(state?.pausedAt || state?.pauseRequestedAt),
      pausePending,
      pauseReason: state?.pauseReason ?? null,
      pausedAt: state?.pausedAt ?? null,
      pauseRequestedAt: state?.pauseRequestedAt ?? null,
      pauseRevision: state?.pauseRevision ?? 0,
      ambiguousOutcomeCount: state?.ambiguousOutcomeCount ?? 0,
      ambiguousWindowStartedAt: state?.ambiguousWindowStartedAt ?? null,
      definiteFailureCount: state?.definiteFailureCount ?? 0,
      failureWindowStartedAt: state?.failureWindowStartedAt ?? null,
      unknownOutcomeCount,
      openCriticalIncidentCount,
      lastAcceptedAt: state?.lastAcceptedAt ?? null,
      lastDeliveredAt: state?.lastDeliveredAt ?? null,
      lastHealthCheckAt: state?.lastHealthCheckAt ?? sender.lastHealthCheckAt,
      lastHealthyAt: state?.lastHealthyAt ?? null,
      providerRestricted,
      templatesHealthy,
      rateCardState: rate.state,
      rateCardVersion: rate.version,
      rateCardExpiresAt: rate.expiresAt,
      resumeEligible: Boolean(state?.pausedAt) && !pausePending && blockers.length === 0,
      resumeBlockers: blockers,
    };
  }

  static async resumeByOwner(input: {
    actorUserId: string;
    organizationId: string;
    senderId: string;
    confirmation: boolean;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    if (input.confirmation !== true) throw new WhatsAppValidationError();
    const readiness = await this.getForOwner(input);
    if (!readiness.paused) return { changed: false as const, readiness };
    if (!readiness.resumeEligible) {
      throw new WhatsAppValidationError("Sender delivery is not ready to resume");
    }
    const now = input.now ?? new Date();
    return prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        input.organizationId,
        tx
      );
      const sender = await tx.whatsAppSender.findFirst({
        where: {
          id: input.senderId,
          organizationId: input.organizationId,
          status: "ACTIVE",
          providerRestrictionCode: null,
        },
        select: { id: true },
      });
      if (!sender) throw new WhatsAppValidationError("Sender delivery is not ready to resume");
      const state = await lockSafetyState({ ...input, tx });
      if (!state.pausedAt) return { changed: false as const, state };
      if (!isWhatsAppSenderHealthFresh({ lastHealthyAt: state.lastHealthyAt, now })) {
        throw new WhatsAppValidationError("Sender delivery is not ready to resume");
      }
      const rate = rateCardView(now, input.env);
      if (!rate.current) throw new WhatsAppValidationError("Sender delivery is not ready to resume");
      const [templatesHealthy, blocking] = await Promise.all([
        templateHealth(input.senderId, tx),
        tx.whatsAppOperationalIncident.count({
          where: {
            senderId: input.senderId,
            severity: "CRITICAL",
            status: { not: "RESOLVED" },
            type: { notIn: ["CIRCUIT_BREAKER_OPEN", "RATE_CARD_EXPIRED", "SENDER_RESTRICTED"] },
          },
        }),
      ]);
      if (!templatesHealthy) {
        throw new WhatsAppValidationError("Sender delivery is not ready to resume");
      }
      if (blocking > 0) throw new WhatsAppValidationError("Sender delivery is not ready to resume");
      const updated = await tx.whatsAppSenderSafetyState.update({
        where: { senderId: input.senderId },
        data: {
          pausedAt: null,
          pauseRequestedAt: null,
          pauseReason: null,
          pausedByUserId: null,
          pauseRevision: { increment: 1 },
          ambiguousWindowStartedAt: null,
          ambiguousOutcomeCount: 0,
          failureWindowStartedAt: null,
          definiteFailureCount: 0,
        },
      });
      for (const dedupeKey of [
        `sender:${input.senderId}:circuit:ambiguous`,
        `sender:${input.senderId}:circuit:definite`,
        `sender:${input.senderId}:rate-card`,
      ]) {
        await WhatsAppIncidentService.resolveInTransaction({
          tx,
          dedupeKey,
          resolutionCode: "OWNER_RESUMED_AFTER_HEALTH",
          now,
        });
      }
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          senderId: input.senderId,
          actorUserId: input.actorUserId,
          action: "SENDER_RESUMED",
          details: { pauseRevision: updated.pauseRevision, unknownRetried: false },
        },
      });
      return { changed: true as const, state: updated };
    }, { isolationLevel: "Serializable" });
  }
}
