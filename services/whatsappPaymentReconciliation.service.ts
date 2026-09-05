import { Prisma } from "@/app/generated/prisma/client";
import {
  deriveWhatsAppManualCollectionMessageRefresh,
  type WhatsAppCollectionMessageRefresh,
} from "@/services/whatsappMessage.service";
import {
  deriveWhatsAppAutomaticCollectionMessageRefresh,
  type WhatsAppAutomaticCollectionMessageRefresh,
} from "@/services/whatsappPlanner.service";

const AUTOMATIC_COLLECTION_STAGES = [
  "FEE_DUE_MINUS_7",
  "FEE_DUE_MINUS_3",
  "FEE_DUE_MINUS_1",
  "FEE_DUE_TODAY",
  "PAST_DUE_PLUS_1",
  "PAST_DUE_PLUS_3",
  "PAST_DUE_PLUS_7",
] as const;

type CollectionRefresh = WhatsAppCollectionMessageRefresh & Partial<Pick<
  WhatsAppAutomaticCollectionMessageRefresh,
  "automationStage" | "purpose"
>>;

function isSafelyUnsubmitted(message: {
  status: string;
  submissionStartedAt: Date | null;
}) {
  return message.status === "SCHEDULED"
    || (message.status === "CLAIMED" && message.submissionStartedAt === null);
}

async function cancelLockedMessage(input: {
  tx: Prisma.TransactionClient;
  messageId: string;
  budgetState: string;
  reason: string;
  now: Date;
}) {
  await input.tx.whatsAppMessage.update({
    where: { id: input.messageId },
    data: {
      status: "CANCELLED",
      cancelledAt: input.now,
      failureCode: input.reason,
      ...(input.budgetState === "RESERVED" ? { budgetState: "RELEASED" } : {}),
      leaseToken: null,
      leaseUntil: null,
    },
  });
  return input.budgetState === "RESERVED" ? 1 : 0;
}

async function refreshLockedCollectionMessage(input: {
  tx: Prisma.TransactionClient;
  messageId: string;
  branchId: string;
  trigger: "MANUAL" | "AUTOMATION";
  refresh: CollectionRefresh;
}) {
  await input.tx.whatsAppMessagePayment.deleteMany({
    where: { messageId: input.messageId },
  });
  await input.tx.whatsAppMessagePayment.createMany({
    data: input.refresh.paymentIds.map(paymentId => ({
      messageId: input.messageId,
      branchId: input.branchId,
      paymentId,
    })),
  });
  await input.tx.whatsAppMessage.update({
    where: { id: input.messageId },
    data: {
      studentId: input.refresh.studentIds.length === 1
        ? input.refresh.studentIds[0]
        : null,
      paymentId: input.refresh.paymentIds.length === 1
        ? input.refresh.paymentIds[0]
        : null,
      templateId: input.refresh.templateId,
      templateBindingId: input.refresh.templateBindingId,
      purpose: input.trigger === "AUTOMATION"
        ? input.refresh.purpose!
        : "MANUAL_REMINDER",
      automationStage: input.trigger === "AUTOMATION"
        ? input.refresh.automationStage!
        : null,
      managedTemplateKey: input.refresh.managedTemplateKey,
      catalogVersion: input.refresh.catalogVersion,
      catalogHash: input.refresh.catalogHash,
      templateVersion: input.refresh.templateVersion,
      templateVariables: input.refresh.templateVariables,
      renderedPreview: input.refresh.renderedPreview,
      settingsRevision: input.refresh.settingsRevision,
      sourceFingerprint: input.refresh.sourceFingerprint,
      status: "SCHEDULED",
      leaseToken: null,
      leaseUntil: null,
      failureCode: null,
      safeFailureMessage: null,
      cancelledAt: null,
      suppressedAt: null,
    },
  });
}

/**
 * Atomically reconciles locally queued WhatsApp rows after one Payment changes
 * out of DUE. No provider client is reachable from this service.
 *
 * Collection rows retain their durable identity and one budget reservation
 * only when the remaining current DUE facts re-derive a valid managed message.
 * All other safely unsubmitted payment-linked rows are cancelled in place.
 * Rows at or beyond provider submission remain immutable history.
 */
export class WhatsAppPaymentReconciliationService {
  static async reconcileResolutionInTransaction(input: {
    tx: Prisma.TransactionClient;
    branchId: string;
    paymentId: string;
    reason: "PAYMENT_RESOLVED" | "PAYMENT_CONFIRMATION_CORRECTED";
    now: Date;
  }) {
    const candidates = await input.tx.whatsAppMessage.findMany({
      where: {
        branchId: input.branchId,
        AND: [
          {
            OR: [
              { paymentId: input.paymentId },
              { paymentSources: { some: { paymentId: input.paymentId } } },
            ],
          },
          {
            OR: [
              { status: "SCHEDULED" },
              { status: "CLAIMED", submissionStartedAt: null },
            ],
          },
        ],
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });

    let refreshedCount = 0;
    let cancelledCount = 0;
    let releasedReservationCount = 0;
    for (const candidate of candidates) {
      const locked = await input.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "WhatsAppMessage"
        WHERE "id" = ${candidate.id}
        FOR UPDATE
      `);
      if (locked.length !== 1) continue;
      const message = await input.tx.whatsAppMessage.findFirst({
        where: {
          id: candidate.id,
          OR: [
            { paymentId: input.paymentId },
            { paymentSources: { some: { paymentId: input.paymentId } } },
          ],
        },
        select: {
          id: true,
          branchId: true,
          trigger: true,
          purpose: true,
          automationStage: true,
          status: true,
          submissionStartedAt: true,
          budgetState: true,
        },
      });
      if (
        !message
        || message.branchId !== input.branchId
        || !isSafelyUnsubmitted(message)
      ) continue;

      const isManualCollection = message.trigger === "MANUAL"
        && message.purpose === "MANUAL_REMINDER";
      const isAutomaticCollection = message.trigger === "AUTOMATION"
        && message.automationStage !== null
        && (AUTOMATIC_COLLECTION_STAGES as readonly string[]).includes(
          message.automationStage
        );
      let refreshResult:
        | Awaited<ReturnType<typeof deriveWhatsAppManualCollectionMessageRefresh>>
        | Awaited<ReturnType<typeof deriveWhatsAppAutomaticCollectionMessageRefresh>>
        | null = null;
      if (message.budgetState === "RESERVED" && isManualCollection) {
        refreshResult = await deriveWhatsAppManualCollectionMessageRefresh({
          tx: input.tx,
          messageId: message.id,
          now: input.now,
        });
      } else if (message.budgetState === "RESERVED" && isAutomaticCollection) {
        refreshResult = await deriveWhatsAppAutomaticCollectionMessageRefresh({
          tx: input.tx,
          messageId: message.id,
          now: input.now,
        });
      }

      if (
        refreshResult?.valid
        && refreshResult.refresh.paymentIds.length > 0
        && !refreshResult.refresh.paymentIds.includes(input.paymentId)
      ) {
        await refreshLockedCollectionMessage({
          tx: input.tx,
          messageId: message.id,
          branchId: input.branchId,
          trigger: message.trigger,
          refresh: refreshResult.refresh,
        });
        refreshedCount += 1;
        continue;
      }

      releasedReservationCount += await cancelLockedMessage({
        tx: input.tx,
        messageId: message.id,
        budgetState: message.budgetState,
        reason: refreshResult && !refreshResult.valid
          ? refreshResult.code
          : input.reason,
        now: input.now,
      });
      cancelledCount += 1;
    }

    return {
      affectedCount: refreshedCount + cancelledCount,
      refreshedCount,
      cancelledCount,
      releasedReservationCount,
    };
  }
}
