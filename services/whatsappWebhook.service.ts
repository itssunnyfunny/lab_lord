import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertWhatsAppWebhookIngestEnabled,
  isWhatsAppDeliverySchemaAccessEnabled,
  isWhatsAppReportsEnabled,
  resolveWhatsAppProviderMode,
  WhatsAppConfigurationError,
} from "@/lib/whatsappFeature";
import { WhatsAppValidationError } from "@/lib/whatsappHttp";
import { reduceWhatsAppStatusProjection } from "@/lib/whatsappMessageState";
import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";
import { lockWhatsAppProviderMessage } from "@/lib/whatsappProviderMessageLock";
import {
  META_WHATSAPP_MESSAGE_ID_MAX_LENGTH,
  META_WHATSAPP_MESSAGE_ID_PATTERN,
} from "@/lib/whatsappProviderMessageId";
import { isWhatsAppDeliverySchemaReady } from "@/lib/whatsappSchema";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";
import { WhatsAppReportService } from "@/services/whatsappReport.service";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";
import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";
import { WhatsAppServiceNoticeService } from "@/services/whatsappServiceNotice.service";

export const MAX_META_WEBHOOK_BYTES = 512 * 1024;
export const MAX_META_WEBHOOK_EVENTS = 200;
export const META_WEBHOOK_ACCEPTED_RESPONSE = Object.freeze({ accepted: true as const });

const providerId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const providerMessageId = z.string()
  .max(META_WHATSAPP_MESSAGE_ID_MAX_LENGTH)
  .regex(META_WHATSAPP_MESSAGE_ID_PATTERN);
const providerTimestamp = z.union([
  z.string().min(1).max(16).regex(/^\d+$/),
  z.number().int().nonnegative().safe(),
]);
const safeProviderCode = z.union([
  z.string().min(1).max(64),
  z.number().int().safe(),
]);
const statusSchema = z.object({
  id: providerMessageId,
  status: z.string().min(1).max(32),
  timestamp: providerTimestamp.optional(),
  recipient_id: z.string().min(1).max(32).regex(/^\+?\d+$/).optional(),
  pricing: z.object({
    billable: z.boolean().optional(),
    category: z.string().min(1).max(64).optional(),
  }).optional(),
  errors: z.array(z.object({ code: safeProviderCode })).max(10).optional(),
});
const inboundMessageSchema = z.object({
  id: providerMessageId,
  from: z.string().min(8).max(16).regex(/^\d+$/),
  timestamp: providerTimestamp.optional(),
  type: z.string().min(1).max(32),
  text: z.object({ body: z.string().max(4_096) }).optional(),
  button: z.object({
    payload: z.string().max(256).optional(),
    text: z.string().max(256).optional(),
  }).optional(),
  interactive: z.object({
    type: z.string().min(1).max(32),
    button_reply: z.object({
      id: z.string().max(256),
      title: z.string().max(256).optional(),
    }).optional(),
  }).optional(),
});
const changeValueSchema = z.object({
  metadata: z.object({
    phone_number_id: providerId.optional(),
  }).optional(),
  statuses: z.array(statusSchema).max(100).optional(),
  messages: z.array(inboundMessageSchema).max(100).optional(),
  event: z.string().min(1).max(64).optional(),
  message_template_id: providerId.optional(),
  message_template_name: z.string().min(1).max(512).regex(/^[A-Za-z0-9_]+$/).optional(),
  message_template_language: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).optional(),
  correct_category: z.string().min(1).max(64).optional(),
  new_category: z.string().min(1).max(64).optional(),
  category: z.string().min(1).max(64).optional(),
});
const webhookEnvelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    id: providerId,
    changes: z.array(z.object({
      field: z.string().min(1).max(64),
      value: changeValueSchema,
    })).max(100),
  })).max(100),
}).superRefine((envelope, context) => {
  let eventCount = 0;
  for (const entry of envelope.entry) {
    for (const change of entry.changes) {
      eventCount += 1;
      eventCount += change.value.statuses?.length ?? 0;
      eventCount += change.value.messages?.length ?? 0;
      if (eventCount > MAX_META_WEBHOOK_EVENTS) {
        context.addIssue({
          code: "custom",
          message: "Webhook contains too many events",
        });
        return;
      }
    }
  }
});

type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

type NormalizedStatusEvent = Readonly<{
  kind: "STATUS";
  providerMessageId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  providerTimestamp: Date | null;
  providerRecipientWaId: string | null;
  providerBillable: boolean | null;
  providerPricingCategory: string | null;
  safeErrorCode: string | null;
}>;

type NormalizedStopEvent = Readonly<{
  kind: "STOP";
  phoneE164: string;
}>;

type NormalizedReportStopEvent = Readonly<{
  kind: "STOP_REPORTS";
  providerMessageId: string;
  phoneE164: string;
}>;

type NormalizedReportConfirmationEvent = Readonly<{
  kind: "REPORT_CONFIRMATION";
  providerMessageId: string;
  phoneE164: string;
  code: string;
}>;

type NormalizedTemplateEvent = Readonly<{
  kind: "TEMPLATE";
  providerTemplateId: string | null;
  name: string | null;
  language: string | null;
  providerStatus: "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED" | "UNKNOWN" | null;
  category: "AUTHENTICATION" | "MARKETING" | "UTILITY" | "UNKNOWN" | null;
}>;

type NormalizedWebhookEvent =
  | NormalizedStatusEvent
  | NormalizedStopEvent
  | NormalizedReportStopEvent
  | NormalizedReportConfirmationEvent
  | NormalizedTemplateEvent;

type NormalizedWebhookEventGroup = Readonly<{
  wabaId: string;
  phoneNumberId: string | null;
  events: readonly NormalizedWebhookEvent[];
}>;

const STATUS_MAP = Object.freeze({
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
} as const);
const TEMPLATE_STATUS_MAP = Object.freeze({
  APPROVED: "APPROVED",
  PENDING: "PENDING",
  REJECTED: "REJECTED",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
} as const);
const TEMPLATE_CATEGORY_MAP = Object.freeze({
  AUTHENTICATION: "AUTHENTICATION",
  MARKETING: "MARKETING",
  UTILITY: "UTILITY",
} as const);
const PRICING_CATEGORIES = new Set([
  "AUTHENTICATION",
  "MARKETING",
  "UTILITY",
  "SERVICE",
  "REFERRAL_CONVERSION",
]);
const CONSENT_TYPES = ["OPERATIONAL", "MARKETING", "OWNER_REPORT"] as const;
const RECEIPT_LEASE_MS = 60_000;
const ORPHAN_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_EXPIRED_ORPHAN_EVENTS_PURGED_PER_RECEIPT = 100;

function requiredSecret(name: "META_APP_SECRET" | "META_WHATSAPP_WEBHOOK_VERIFY_TOKEN") {
  const value = process.env[name];
  const maximum = name === "META_APP_SECRET" ? 1_024 : 512;
  if (!value || value.length > maximum) {
    throw new WhatsAppConfigurationError(`${name} is not configured`);
  }
  return value;
}

export function parseMetaWebhookEnvelope(rawBody: Buffer) {
  return webhookEnvelopeSchema.parse(JSON.parse(rawBody.toString("utf8")));
}

function parseProviderTimestamp(value: string | number | undefined) {
  if (value === undefined) return null;
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(seconds)) return null;
  const timestamp = new Date(seconds * 1_000);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function normalizePricingCategory(value: string | undefined) {
  if (!value) return null;
  const normalized = value.toUpperCase();
  return PRICING_CATEGORIES.has(normalized) ? normalized : null;
}

function normalizeSafeErrorCode(value: string | number | undefined) {
  if (value === undefined) return null;
  const normalized = String(value).toUpperCase();
  if (!/^[A-Z0-9_.:-]{1,48}$/.test(normalized)) return "META_FAILED";
  return `META_${normalized}`;
}

function normalizeProviderPhone(value: string) {
  try {
    return normalizeWhatsAppPhone(`+${value}`);
  } catch {
    return null;
  }
}

export function isExactWhatsAppStopCommand(input: {
  type: string;
  text?: string;
  buttonPayload?: string;
  interactiveButtonId?: string;
}) {
  if (input.type === "text") {
    return input.text?.normalize("NFKC").trim().toUpperCase() === "STOP";
  }
  if (input.type === "button") {
    return input.buttonPayload === "LABLORDS_STOP_UPDATES";
  }
  if (input.type === "interactive") {
    return input.interactiveButtonId === "LABLORDS_STOP_UPDATES";
  }
  return false;
}

export function parseExactWhatsAppReportCommand(input: {
  type: string;
  text?: string;
  buttonPayload?: string;
  buttonText?: string;
  interactiveButtonId?: string;
  interactiveButtonTitle?: string;
}): { kind: "STOP_REPORTS" } | { kind: "REPORT_CONFIRMATION"; code: string } | null {
  if (input.type === "text") {
    const normalized = input.text?.normalize("NFKC").trim();
    if (normalized === "STOP REPORTS") return { kind: "STOP_REPORTS" };
    const confirmation = /^START REPORTS ([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10})$/
      .exec(normalized ?? "");
    return confirmation ? { kind: "REPORT_CONFIRMATION", code: confirmation[1]! } : null;
  }
  const replyValues = input.type === "button"
    ? [input.buttonPayload, input.buttonText]
    : input.type === "interactive"
      ? [input.interactiveButtonId, input.interactiveButtonTitle]
      : [];
  return replyValues.some(value =>
    value === "LABLORDS_STOP_REPORTS" || value?.normalize("NFKC").trim() === "Stop reports"
  )
    ? { kind: "STOP_REPORTS" }
    : null;
}

function normalizeTemplateStatus(value: string | undefined) {
  if (!value) return null;
  const normalized = value.toUpperCase();
  return TEMPLATE_STATUS_MAP[normalized as keyof typeof TEMPLATE_STATUS_MAP] ?? "UNKNOWN";
}

function normalizeTemplateCategory(value: string | undefined) {
  if (!value) return null;
  const normalized = value.toUpperCase();
  return TEMPLATE_CATEGORY_MAP[normalized as keyof typeof TEMPLATE_CATEGORY_MAP] ?? "UNKNOWN";
}

function extractMetaWebhookEventGroups(envelope: WebhookEnvelope) {
  const groups = new Map<string, {
    wabaId: string;
    phoneNumberId: string | null;
    events: NormalizedWebhookEvent[];
    inboundKeys: Set<string>;
  }>();

  const groupFor = (wabaId: string, phoneNumberId: string | null) => {
    const key = JSON.stringify([wabaId, phoneNumberId]);
    const existing = groups.get(key);
    if (existing) return existing;
    const group = { wabaId, phoneNumberId, events: [], inboundKeys: new Set<string>() };
    groups.set(key, group);
    return group;
  };

  for (const entry of envelope.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id ?? null;
      if (change.field === "messages") {
        // Preserve known-sender evidence even when every provider value is an
        // unknown future status or unrelated inbound command.
        groupFor(entry.id, phoneNumberId);
        for (const status of change.value.statuses ?? []) {
          const normalizedStatus = STATUS_MAP[status.status.toLowerCase() as keyof typeof STATUS_MAP];
          if (!normalizedStatus) continue;
          groupFor(entry.id, phoneNumberId).events.push({
            kind: "STATUS",
            providerMessageId: status.id,
            status: normalizedStatus,
            providerTimestamp: parseProviderTimestamp(status.timestamp),
            providerRecipientWaId: status.recipient_id ?? null,
            providerBillable: status.pricing?.billable ?? null,
            providerPricingCategory: normalizePricingCategory(status.pricing?.category),
            safeErrorCode: normalizedStatus === "FAILED"
              ? normalizeSafeErrorCode(status.errors?.[0]?.code)
              : null,
          });
        }

        for (const message of change.value.messages ?? []) {
          const phoneE164 = normalizeProviderPhone(message.from);
          if (!phoneE164) continue;
          const group = groupFor(entry.id, phoneNumberId);
          if (isExactWhatsAppStopCommand({
            type: message.type,
            text: message.text?.body,
            buttonPayload: message.button?.payload,
            interactiveButtonId: message.interactive?.type === "button_reply"
              ? message.interactive.button_reply?.id
              : undefined,
          })) {
            const key = `STOP:${phoneE164}`;
            if (!group.inboundKeys.has(key)) {
              group.inboundKeys.add(key);
              group.events.push({ kind: "STOP", phoneE164 });
            }
            continue;
          }
          const reportCommand = parseExactWhatsAppReportCommand({
            type: message.type,
            text: message.text?.body,
            buttonPayload: message.button?.payload,
            buttonText: message.button?.text,
            interactiveButtonId: message.interactive?.type === "button_reply"
              ? message.interactive.button_reply?.id
              : undefined,
            interactiveButtonTitle: message.interactive?.type === "button_reply"
              ? message.interactive.button_reply?.title
              : undefined,
          });
          if (!reportCommand) continue;
          const key = `REPORT_COMMAND:${message.id}`;
          if (group.inboundKeys.has(key)) continue;
          group.inboundKeys.add(key);
          group.events.push(reportCommand.kind === "STOP_REPORTS"
            ? { kind: "STOP_REPORTS", providerMessageId: message.id, phoneE164 }
            : {
                kind: "REPORT_CONFIRMATION",
                providerMessageId: message.id,
                phoneE164,
                code: reportCommand.code,
              });
        }
        continue;
      }

      if (
        change.field === "message_template_status_update"
        || change.field === "template_category_update"
      ) {
        const providerStatus = change.field === "message_template_status_update"
          ? normalizeTemplateStatus(change.value.event)
          : null;
        const category = change.field === "template_category_update"
          ? normalizeTemplateCategory(
              change.value.correct_category
              ?? change.value.new_category
              ?? change.value.category
            )
          : null;
        if (
          !change.value.message_template_id
          && !(change.value.message_template_name && change.value.message_template_language)
        ) {
          continue;
        }
        groupFor(entry.id, phoneNumberId).events.push({
          kind: "TEMPLATE",
          providerTemplateId: change.value.message_template_id ?? null,
          name: change.value.message_template_name ?? null,
          language: change.value.message_template_language ?? null,
          providerStatus,
          category,
        });
      }
    }
  }

  return [...groups.values()].map(group => ({
    wabaId: group.wabaId,
    phoneNumberId: group.phoneNumberId,
    events: group.events,
  })) satisfies NormalizedWebhookEventGroup[];
}

export function extractMetaWebhookEvents(envelope: WebhookEnvelope) {
  return extractMetaWebhookEventGroups(envelope).flatMap(group => group.events);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyMetaWebhookSignature(rawBody: Buffer, signature: string | null) {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const digest = createHmac("sha256", requiredSecret("META_APP_SECRET"))
    .update(rawBody)
    .digest("hex");
  return safeEqual(signature.slice(7).toLowerCase(), digest);
}

export function verifyMetaWebhookChallenge(input: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}) {
  assertWhatsAppWebhookIngestEnabled();
  resolveWhatsAppProviderMode();
  if (
    input.mode !== "subscribe"
    || !input.token
    || input.token.length > 512
    || !input.challenge
    || input.challenge.length > 1_024
  ) {
    return null;
  }
  return safeEqual(input.token, requiredSecret("META_WHATSAPP_WEBHOOK_VERIFY_TOKEN"))
    ? input.challenge
    : null;
}

export async function readBoundedWebhookBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_META_WEBHOOK_BYTES) {
    throw new WhatsAppValidationError("Webhook payload is too large");
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_META_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new WhatsAppValidationError("Webhook payload is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
}

function receiptMetadata(value: WebhookEnvelope) {
  const wabaIds = new Set<string>();
  const phoneNumberIds = new Set<string>();
  const eventTypes = new Set<string>();
  for (const entry of value.entry) {
    wabaIds.add(entry.id);
    for (const change of entry.changes) {
      eventTypes.add(change.field);
      if (change.value.metadata?.phone_number_id) {
        phoneNumberIds.add(change.value.metadata.phone_number_id);
      }
    }
  }
  return {
    wabaId: wabaIds.size === 1 ? [...wabaIds][0] : null,
    phoneNumberId: phoneNumberIds.size === 1 ? [...phoneNumberIds][0] : null,
    eventType: eventTypes.size > 0 ? [...eventTypes].sort().join(",").slice(0, 128) : null,
  };
}

async function existingOrCreateReceipt(input: {
  providerMode: "TEST" | "LIVE";
  dedupeKey: string;
  payloadHash: string;
  organizationId: string | null;
  senderId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  eventType: string | null;
  status?: "RECEIVED" | "FAILED";
  failureCode?: string | null;
}) {
  const existing = await prisma.whatsAppWebhookReceipt.findUnique({
    where: { dedupeKey: input.dedupeKey },
  });
  if (existing) return { receipt: existing, duplicate: true };

  try {
    const receipt = await prisma.whatsAppWebhookReceipt.create({
      data: {
        ...input,
        signatureVersion: "sha256",
        status: input.status ?? "RECEIVED",
      },
    });
    return { receipt, duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.whatsAppWebhookReceipt.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });
      if (raced) return { receipt: raced, duplicate: true };
    }
    throw error;
  }
}

const LEGACY_RECEIPT_SELECT = {
  id: true,
  status: true,
} as const;

/**
 * PR2-only receipt persistence. Every select and mutation is intentionally
 * limited to columns present before the PR3 lease migration.
 */
async function existingOrCreateLegacyReceipt(input: {
  providerMode: "TEST" | "LIVE";
  dedupeKey: string;
  payloadHash: string;
  organizationId: string | null;
  senderId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  eventType: string | null;
  status?: "RECEIVED" | "FAILED";
  failureCode?: string | null;
}) {
  const existing = await prisma.whatsAppWebhookReceipt.findUnique({
    where: { dedupeKey: input.dedupeKey },
    select: LEGACY_RECEIPT_SELECT,
  });
  if (existing) return { receipt: existing, duplicate: true };

  try {
    const receipt = await prisma.whatsAppWebhookReceipt.create({
      data: {
        ...input,
        signatureVersion: "sha256",
        status: input.status ?? "RECEIVED",
      },
      select: LEGACY_RECEIPT_SELECT,
    });
    return { receipt, duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.whatsAppWebhookReceipt.findUnique({
        where: { dedupeKey: input.dedupeKey },
        select: LEGACY_RECEIPT_SELECT,
      });
      if (raced) return { receipt: raced, duplicate: true };
    }
    throw error;
  }
}

type ResolvedSender = {
  id: string;
  organizationId: string;
  wabaId: string;
};

type WebhookSenderMetadata = Readonly<{
  wabaId: string | null;
  phoneNumberId: string | null;
}>;

async function resolveWebhookSender(
  providerMode: "TEST" | "LIVE",
  metadata: WebhookSenderMetadata
): Promise<ResolvedSender | null> {
  if (metadata.phoneNumberId) {
    const sender = await prisma.whatsAppSender.findUnique({
      where: {
        provider_providerMode_phoneNumberId: {
          provider: "META_CLOUD",
          providerMode,
          phoneNumberId: metadata.phoneNumberId,
        },
      },
      select: { id: true, organizationId: true, wabaId: true },
    });
    return sender && (!metadata.wabaId || sender.wabaId === metadata.wabaId)
      ? sender
      : null;
  }
  if (!metadata.wabaId) return null;

  const candidates = await prisma.whatsAppSender.findMany({
    where: {
      provider: "META_CLOUD",
      providerMode,
      wabaId: metadata.wabaId,
    },
    select: { id: true, organizationId: true, wabaId: true },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0] : null;
}

async function resolveWebhookEventGroupSenders(
  providerMode: "TEST" | "LIVE",
  group: NormalizedWebhookEventGroup
) {
  if (
    group.phoneNumberId
    || group.events.some(event => event.kind !== "TEMPLATE")
  ) {
    const sender = await resolveWebhookSender(providerMode, {
      wabaId: group.wabaId,
      phoneNumberId: group.phoneNumberId,
    });
    return sender ? [sender] : [];
  }

  // Template lifecycle notifications are WABA-scoped and commonly omit phone
  // metadata. Every connected number under that exact mode/WABA owns a local
  // synchronized registry that must be invalidated together. Bound the fanout
  // and fail retryably instead of silently leaving an unexamined sender active.
  const senders = await prisma.whatsAppSender.findMany({
    where: {
      provider: "META_CLOUD",
      providerMode,
      wabaId: group.wabaId,
    },
    select: { id: true, organizationId: true, wabaId: true },
    orderBy: { id: "asc" },
    take: MAX_META_WEBHOOK_EVENTS + 1,
  });
  if (senders.length > MAX_META_WEBHOOK_EVENTS) {
    throw new Error("WhatsApp template webhook sender fanout exceeds the safe bound");
  }
  return senders;
}

async function claimReceipt(input: {
  receiptId: string;
  sender: ResolvedSender | null;
  now: Date;
}) {
  const leaseToken = randomUUID();
  const leaseUntil = new Date(input.now.getTime() + RECEIPT_LEASE_MS);
  const claimed = await prisma.whatsAppWebhookReceipt.updateMany({
    where: {
      id: input.receiptId,
      OR: [
        { status: { in: ["RECEIVED", "FAILED"] } },
        {
          status: "PROCESSING",
          OR: [
            { leaseUntil: null },
            { leaseUntil: { lt: input.now } },
          ],
        },
      ],
    },
    data: {
      status: "PROCESSING",
      leaseToken,
      leaseUntil,
      lastAttemptAt: input.now,
      attemptCount: { increment: 1 },
      processedAt: null,
      failureCode: null,
      ...(input.sender
        ? {
            organizationId: input.sender.organizationId,
            senderId: input.sender.id,
          }
        : {}),
    },
  });
  return claimed.count === 1 ? { leaseToken } : null;
}

function statusEventKey(senderId: string, event: NormalizedStatusEvent) {
  return createHash("sha256")
    .update(JSON.stringify({
      source: "META_CLOUD",
      senderId,
      providerMessageId: event.providerMessageId,
      status: event.status,
      providerTimestamp: event.providerTimestamp?.toISOString() ?? null,
      providerRecipientWaId: event.providerRecipientWaId,
      providerBillable: event.providerBillable,
      providerPricingCategory: event.providerPricingCategory,
      safeErrorCode: event.safeErrorCode,
    }))
    .digest("hex");
}

function sameTimestamp(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

async function projectStatusEvent(
  tx: Prisma.TransactionClient,
  messageId: string,
  event: NormalizedStatusEvent,
  now: Date
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const message = await tx.whatsAppMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        providerStatusTimestamp: true,
        providerRecipientWaId: true,
        providerBillable: true,
        providerPricingCategory: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        failedAt: true,
      },
    });
    if (!message) return;

    const projection = reduceWhatsAppStatusProjection(
      {
        status: message.status,
        providerStatusTimestamp: message.providerStatusTimestamp,
      },
      {
        status: event.status,
        providerTimestamp: event.providerTimestamp,
      }
    );
    const data: Prisma.WhatsAppMessageUpdateManyMutationInput = {};
    if (
      projection.status !== message.status
      || !sameTimestamp(
        projection.providerStatusTimestamp,
        message.providerStatusTimestamp
      )
    ) {
      data.status = projection.status;
      data.providerStatusTimestamp = projection.providerStatusTimestamp;
    }
    if (
      event.providerRecipientWaId !== null
      && event.providerRecipientWaId !== message.providerRecipientWaId
    ) {
      data.providerRecipientWaId = event.providerRecipientWaId;
    }
    if (
      event.providerBillable !== null
      && event.providerBillable !== message.providerBillable
    ) {
      data.providerBillable = event.providerBillable;
    }
    if (
      event.providerPricingCategory !== null
      && event.providerPricingCategory !== message.providerPricingCategory
    ) {
      data.providerPricingCategory = event.providerPricingCategory;
    }

    const occurredAt = event.providerTimestamp ?? now;
    if (event.status === "SENT" && !message.sentAt) data.sentAt = occurredAt;
    if (event.status === "DELIVERED" && !message.deliveredAt) {
      data.deliveredAt = occurredAt;
    }
    if (event.status === "READ" && !message.readAt) data.readAt = occurredAt;
    if (projection.status === event.status) {
      if (event.status === "FAILED" && !message.failedAt) data.failedAt = occurredAt;
      if (event.status === "FAILED") {
        data.failureCode = event.safeErrorCode ?? "META_FAILED";
        data.safeFailureMessage = null;
      } else if (message.status === "FAILED" || message.status === "UNKNOWN") {
        data.failureCode = null;
        data.safeFailureMessage = null;
        data.failedAt = null;
      }
    }

    if (Object.keys(data).length === 0) return;
    const updated = await tx.whatsAppMessage.updateMany({
      where: { id: message.id, updatedAt: message.updatedAt },
      data,
    });
    if (updated.count === 1) return;
  }

  // The event row and receipt finalization share this transaction. Exhausting
  // the bounded optimistic-CAS retries must abort that transaction so Meta can
  // retry the receipt; otherwise the event could be recorded while its message
  // projection is silently lost.
  throw new Error("WhatsApp status projection conflicted repeatedly");
}

async function processStatusEvent(input: {
  tx: Prisma.TransactionClient;
  sender: ResolvedSender;
  event: NormalizedStatusEvent;
  payloadHash: string;
  now: Date;
}) {
  await lockWhatsAppProviderMessage(input.tx, {
    senderId: input.sender.id,
    providerMessageId: input.event.providerMessageId,
  });
  const message = await input.tx.whatsAppMessage.findFirst({
    where: {
      senderId: input.sender.id,
      providerMessageId: input.event.providerMessageId,
    },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      senderId: true,
      serviceNoticeId: true,
      status: true,
    },
  });
  const eventKey = statusEventKey(input.sender.id, input.event);
  await input.tx.whatsAppMessageEvent.createMany({
    data: [{
      messageId: message?.id ?? null,
      senderId: input.sender.id,
      providerMessageId: input.event.providerMessageId,
      eventKey,
      source: "PROVIDER_WEBHOOK",
      status: input.event.status,
      providerTimestamp: input.event.providerTimestamp,
      receivedAt: input.now,
      payloadHash: input.payloadHash,
      providerRecipientWaId: input.event.providerRecipientWaId,
      providerBillable: input.event.providerBillable,
      providerPricingCategory: input.event.providerPricingCategory,
      safeErrorCode: input.event.safeErrorCode,
      expiresAt: message
        ? null
        : new Date(input.now.getTime() + ORPHAN_EVENT_TTL_MS),
    }],
    skipDuplicates: true,
  });

  if (!message) return;
  const persistedEvent = await input.tx.whatsAppMessageEvent.findUnique({
    where: { eventKey },
    select: { id: true, messageId: true, senderId: true, providerMessageId: true },
  });
  if (
    persistedEvent
    && persistedEvent.messageId === null
    && persistedEvent.senderId === input.sender.id
    && persistedEvent.providerMessageId === input.event.providerMessageId
  ) {
    await input.tx.whatsAppMessageEvent.updateMany({
      where: { id: persistedEvent.id, messageId: null },
      data: { messageId: message.id, expiresAt: null },
    });
  }
  await projectStatusEvent(input.tx, message.id, input.event, input.now);
  if (input.event.status === "DELIVERED" || input.event.status === "READ") {
    await WhatsAppSenderSafetyService.recordDeliveredInTransaction({
      tx: input.tx,
      organizationId: message.organizationId,
      senderId: message.senderId,
      at: input.event.providerTimestamp ?? input.now,
    });
  }
  if (message.status === "UNKNOWN") {
    await WhatsAppIncidentService.resolveInTransaction({
      tx: input.tx,
      dedupeKey: `message:${message.id}:unknown`,
      resolutionCode: input.event.status === "FAILED"
        ? "PROVIDER_FAILURE_CONFIRMED"
        : "PROVIDER_DELIVERY_CONFIRMED",
      now: input.now,
    });
  }
  if (message.serviceNoticeId) {
    await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
      tx: input.tx,
      noticeId: message.serviceNoticeId,
      now: input.now,
    });
  }
}

async function optOutConsentTypes(input: {
  tx: Prisma.TransactionClient;
  sender: ResolvedSender;
  phoneE164: string;
  now: Date;
  consentTypes?: readonly (typeof CONSENT_TYPES)[number][];
  reason?: "INBOUND_STOP" | "INBOUND_STOP_REPORTS";
}) {
  // Dashboard consent mutations lock the same sender row. Taking that lock
  // here serializes distinct signed STOP receipts (including missing consent
  // rows) so only the transaction that changes truth appends transition events.
  const lockedSender = await input.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "WhatsAppSender"
    WHERE "id" = ${input.sender.id}
    FOR UPDATE
  `);
  if (lockedSender.length !== 1) return 0;

  let changedCount = 0;
  for (const consentType of input.consentTypes ?? CONSENT_TYPES) {
    const existing = await input.tx.whatsAppConsent.findUnique({
      where: {
        senderId_phoneE164_consentType: {
          senderId: input.sender.id,
          phoneE164: input.phoneE164,
          consentType,
        },
      },
    });
    if (existing?.status === "OPTED_OUT") continue;

    const previousStatus = existing?.status ?? "UNKNOWN";
    const consent = existing
      ? await input.tx.whatsAppConsent.update({
          where: { id: existing.id },
          data: {
            status: "OPTED_OUT",
            source: "WHATSAPP_REPLY",
            recordedByUserId: null,
            revokedAt: input.now,
          },
        })
      : await input.tx.whatsAppConsent.create({
          data: {
            senderId: input.sender.id,
            phoneE164: input.phoneE164,
            consentType,
            status: "OPTED_OUT",
            source: "WHATSAPP_REPLY",
            revokedAt: input.now,
          },
        });
    await input.tx.whatsAppConsentEvent.create({
      data: {
        consentId: consent.id,
        senderId: input.sender.id,
        phoneE164: input.phoneE164,
        consentType,
        actorUserId: null,
        previousStatus,
        nextStatus: "OPTED_OUT",
        source: "WHATSAPP_REPLY",
        policyVersion: consent.policyVersion,
        details: { reason: input.reason ?? "INBOUND_STOP" },
        occurredAt: input.now,
      },
    });
    changedCount += 1;
  }
  return changedCount;
}

async function processStopEvent(input: {
  tx: Prisma.TransactionClient;
  sender: ResolvedSender;
  event: NormalizedStopEvent;
  now: Date;
}) {
  const affectedNoticeRows = await input.tx.whatsAppMessage.findMany({
    where: {
      organizationId: input.sender.organizationId,
      senderId: input.sender.id,
      recipientPhoneE164: input.event.phoneE164,
      serviceNoticeId: { not: null },
      OR: [
        { status: "SCHEDULED" },
        { status: "CLAIMED", submissionStartedAt: null },
      ],
    },
    select: { serviceNoticeId: true },
    distinct: ["serviceNoticeId"],
  });
  const consentChangedCount = await optOutConsentTypes({
    tx: input.tx,
    sender: input.sender,
    phoneE164: input.event.phoneE164,
    now: input.now,
  });
  const disabled = await WhatsAppRecipientService.disableSenderPhoneInTransaction({
    tx: input.tx,
    organizationId: input.sender.organizationId,
    senderId: input.sender.id,
    phoneE164: input.event.phoneE164,
    now: input.now,
  });
  const pausedSubscriptions = await input.tx.whatsAppReportSubscription.updateMany({
    where: {
      organizationId: input.sender.organizationId,
      senderId: input.sender.id,
      phoneE164: input.event.phoneE164,
      status: { in: ["PENDING_CONFIRMATION", "ACTIVE"] },
    },
    data: {
      status: "PAUSED",
      pausedAt: input.now,
      confirmationCodeHash: null,
      confirmationExpiresAt: null,
      plannerLeaseToken: null,
      plannerLeaseUntil: null,
    },
  });
  for (const row of affectedNoticeRows) {
    if (!row.serviceNoticeId) continue;
    await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
      tx: input.tx,
      noticeId: row.serviceNoticeId,
      now: input.now,
    });
  }
  if (
    consentChangedCount > 0
    || disabled.disabledCount > 0
    || disabled.cancelledCount > 0
    || pausedSubscriptions.count > 0
  ) {
    await input.tx.whatsAppAuditEvent.create({
      data: {
        organizationId: input.sender.organizationId,
        branchId: null,
        senderId: input.sender.id,
        actorUserId: null,
        action: "RECIPIENT_DISABLED",
        details: {
          reason: "INBOUND_STOP",
          consentChangedCount,
          disabledRecipientCount: disabled.disabledCount,
          cancelledMessageCount: disabled.cancelledCount,
          releasedReservationCount: disabled.releasedReservationCount,
          pausedReportSubscriptionCount: pausedSubscriptions.count,
        },
      },
    });
  }
}

async function processReportStopEvent(input: {
  tx: Prisma.TransactionClient;
  sender: ResolvedSender;
  event: NormalizedReportStopEvent;
  now: Date;
}) {
  const consentChangedCount = await optOutConsentTypes({
    tx: input.tx,
    sender: input.sender,
    phoneE164: input.event.phoneE164,
    now: input.now,
    consentTypes: ["OWNER_REPORT"],
    reason: "INBOUND_STOP_REPORTS",
  });
  const paused = await input.tx.whatsAppReportSubscription.updateMany({
    where: {
      organizationId: input.sender.organizationId,
      senderId: input.sender.id,
      phoneE164: input.event.phoneE164,
      status: { in: ["PENDING_CONFIRMATION", "ACTIVE"] },
    },
    data: {
      status: "PAUSED",
      pausedAt: input.now,
      confirmationCodeHash: null,
      confirmationExpiresAt: null,
      plannerLeaseToken: null,
      plannerLeaseUntil: null,
    },
  });
  const branchReports = await WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
    tx: input.tx,
    scope: {
      organizationId: input.sender.organizationId,
      senderId: input.sender.id,
      recipientPhoneE164: input.event.phoneE164,
      purpose: "DAILY_BRANCH_REPORT",
    },
    reason: "OWNER_REPORT_CONSENT_OPTED_OUT",
    now: input.now,
  });
  const organizationReports = await WhatsAppRecipientService
    .cancelUnsubmittedMessagesInTransaction({
      tx: input.tx,
      scope: {
        organizationId: input.sender.organizationId,
        senderId: input.sender.id,
        recipientPhoneE164: input.event.phoneE164,
        purpose: "DAILY_ORGANIZATION_REPORT",
      },
      reason: "OWNER_REPORT_CONSENT_OPTED_OUT",
      now: input.now,
    });
  const cancelledMessageCount = branchReports.cancelledCount
    + organizationReports.cancelledCount;
  const releasedReservationCount = branchReports.releasedReservationCount
    + organizationReports.releasedReservationCount;
  if (consentChangedCount > 0 || paused.count > 0 || cancelledMessageCount > 0) {
    await input.tx.whatsAppAuditEvent.create({
      data: {
        organizationId: input.sender.organizationId,
        branchId: null,
        senderId: input.sender.id,
        actorUserId: null,
        action: "REPORT_SUBSCRIPTION_PAUSED",
        details: {
          reason: "INBOUND_STOP_REPORTS",
          consentChangedCount,
          pausedSubscriptionCount: paused.count,
          cancelledMessageCount,
          releasedReservationCount,
        },
      },
    });
  }
}

async function processTemplateEvent(input: {
  tx: Prisma.TransactionClient;
  sender: ResolvedSender;
  event: NormalizedTemplateEvent;
  now: Date;
}) {
  const template = await input.tx.whatsAppTemplate.findFirst({
    where: {
      senderId: input.sender.id,
      ...(input.event.providerTemplateId
        ? { providerTemplateId: input.event.providerTemplateId }
        : {
            name: input.event.name!,
            language: input.event.language!,
          }),
    },
    select: {
      id: true,
      providerStatus: true,
      category: true,
      binding: { select: { id: true } },
    },
  });
  if (!template) return;

  const providerStatus = input.event.providerStatus ?? template.providerStatus;
  const category = input.event.category ?? template.category;
  await input.tx.whatsAppTemplate.update({
    where: { id: template.id },
    data: {
      ...(input.event.providerStatus
        ? { providerStatus: input.event.providerStatus }
        : {}),
      ...(input.event.category ? { category: input.event.category } : {}),
      lastSyncedAt: input.now,
    },
  });

  const incidentDedupeKey = `template-unavailable:${input.sender.id}:${template.id}`;
  if (providerStatus === "APPROVED" && category === "UTILITY") {
    await WhatsAppIncidentService.resolveInTransaction({
      tx: input.tx,
      dedupeKey: incidentDedupeKey,
      resolutionCode: "PROVIDER_TEMPLATE_READY",
      now: input.now,
    });
    return;
  }
  await WhatsAppIncidentService.createOrTouchInTransaction({
    tx: input.tx,
    organizationId: input.sender.organizationId,
    senderId: input.sender.id,
    type: "TEMPLATE_UNAVAILABLE",
    severity: "WARNING",
    dedupeKey: incidentDedupeKey,
    safeCode: category !== "UTILITY" ? "TEMPLATE_NOT_UTILITY" : "TEMPLATE_NOT_APPROVED",
    details: {
      providerStatus,
      providerCategory: category,
    },
    now: input.now,
  });
  if (template.binding) {
    await input.tx.whatsAppTemplateBinding.updateMany({
      where: { id: template.binding.id, active: true },
      data: { active: false },
    });
  }

  const unsubmitted = {
    OR: [
      { status: "SCHEDULED" as const },
      { status: "CLAIMED" as const, submissionStartedAt: null },
    ],
    AND: [{
      OR: [
        { templateId: template.id },
        ...(template.binding ? [{ templateBindingId: template.binding.id }] : []),
      ],
    }],
  } satisfies Prisma.WhatsAppMessageWhereInput;
  await input.tx.whatsAppMessage.updateMany({
    where: { ...unsubmitted, budgetState: "RESERVED" },
    data: {
      status: "SUPPRESSED",
      suppressedAt: input.now,
      failureCode: "TEMPLATE_UNAVAILABLE",
      budgetState: "RELEASED",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  await input.tx.whatsAppMessage.updateMany({
    where: { ...unsubmitted, budgetState: { not: "RESERVED" } },
    data: {
      status: "SUPPRESSED",
      suppressedAt: input.now,
      failureCode: "TEMPLATE_UNAVAILABLE",
      leaseToken: null,
      leaseUntil: null,
    },
  });
}

export async function processWebhookEvents(input: {
  tx: Prisma.TransactionClient;
  sender: ResolvedSender;
  events: NormalizedWebhookEvent[];
  payloadHash: string;
  now: Date;
}) {
  for (const event of input.events) {
    if (event.kind === "STOP_REPORTS" || event.kind === "REPORT_CONFIRMATION") {
      const receipt = await input.tx.whatsAppInboundMessageReceipt.createMany({ data: [{
        senderId: input.sender.id, providerMessageId: event.providerMessageId,
      }], skipDuplicates: true });
      if (receipt.count === 0) continue;
    }
    if (event.kind === "STATUS") {
      await processStatusEvent({ ...input, event });
    } else if (event.kind === "STOP") {
      await processStopEvent({
        tx: input.tx,
        sender: input.sender,
        event,
        now: input.now,
      });
    } else if (event.kind === "STOP_REPORTS") {
      await processReportStopEvent({
        tx: input.tx,
        sender: input.sender,
        event,
        now: input.now,
      });
    } else if (event.kind === "REPORT_CONFIRMATION") {
      if (isWhatsAppReportsEnabled()) {
        await WhatsAppReportService.confirmSubscriptionInTransaction({
          tx: input.tx,
          senderId: input.sender.id,
          phoneE164: event.phoneE164,
          code: event.code,
          now: input.now,
        });
      }
    } else {
      await processTemplateEvent({
        tx: input.tx,
        sender: input.sender,
        event,
        now: input.now,
      });
    }
  }
}

async function purgeExpiredOrphanEvents(input: {
  tx: Prisma.TransactionClient;
  senderIds: string[];
  now: Date;
}) {
  const senderIds = [...new Set(input.senderIds)];
  if (senderIds.length === 0) return 0;

  const expiredRows = await input.tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "WhatsAppMessageEvent"
    WHERE "messageId" IS NULL
      AND "expiresAt" <= ${input.now}
      AND "senderId" IN (${Prisma.join(senderIds)})
    ORDER BY "expiresAt" ASC, "id" ASC
    FOR UPDATE SKIP LOCKED
    LIMIT ${MAX_EXPIRED_ORPHAN_EVENTS_PURGED_PER_RECEIPT}
  `);
  if (expiredRows.length === 0) return 0;

  const deleted = await input.tx.whatsAppMessageEvent.deleteMany({
    where: {
      id: { in: expiredRows.map(row => row.id) },
      messageId: null,
      expiresAt: { lte: input.now },
      senderId: { in: senderIds },
    },
  });
  return deleted.count;
}

class WhatsAppWebhookLeaseLostError extends Error {}

export class WhatsAppWebhookService {
  static async handle(request: Request) {
    assertWhatsAppWebhookIngestEnabled();
    const providerMode = resolveWhatsAppProviderMode();
    const rawBody = await readBoundedWebhookBody(request);
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyMetaWebhookSignature(rawBody, signature)) {
      throw new WhatsAppValidationError("Invalid webhook signature");
    }
    // Never let an unauthenticated public request reach database metadata.
    const deliverySchemaAccessEnabled = isWhatsAppDeliverySchemaAccessEnabled()
      || await isWhatsAppDeliverySchemaReady();

    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const dedupeKey = `META_CLOUD:${providerMode}:${payloadHash}`;
    let parsed: WebhookEnvelope;
    try {
      parsed = parseMetaWebhookEnvelope(rawBody);
    } catch {
      const persistReceipt = deliverySchemaAccessEnabled
        ? existingOrCreateReceipt
        : existingOrCreateLegacyReceipt;
      await persistReceipt({
        providerMode,
        dedupeKey,
        payloadHash,
        organizationId: null,
        senderId: null,
        wabaId: null,
        phoneNumberId: null,
        eventType: null,
        status: "FAILED",
        failureCode: "INVALID_PAYLOAD",
      });
      throw new WhatsAppValidationError("Invalid webhook payload");
    }

    const metadata = receiptMetadata(parsed);

    if (!deliverySchemaAccessEnabled) {
      const metadataSender = await resolveWebhookSender(providerMode, metadata);
      const { receipt, duplicate } = await existingOrCreateLegacyReceipt({
        providerMode,
        dedupeKey,
        payloadHash,
        organizationId: metadataSender?.organizationId ?? null,
        senderId: metadataSender?.id ?? null,
        wabaId: metadata.wabaId,
        phoneNumberId: metadata.phoneNumberId,
        eventType: metadata.eventType,
      });
      if (duplicate && (receipt.status === "PROCESSED" || receipt.status === "IGNORED")) {
        return META_WEBHOOK_ACCEPTED_RESPONSE;
      }
      await prisma.whatsAppWebhookReceipt.updateMany({
        where: { id: receipt.id },
        data: { status: "IGNORED", processedAt: new Date(), failureCode: null },
      });
      return META_WEBHOOK_ACCEPTED_RESPONSE;
    }

    const eventGroups = extractMetaWebhookEventGroups(parsed);
    const resolvedEventGroups: Array<{
      sender: ResolvedSender;
      events: readonly NormalizedWebhookEvent[];
    }> = [];
    for (const group of eventGroups) {
      const groupSenders = await resolveWebhookEventGroupSenders(providerMode, group);
      for (const groupSender of groupSenders) {
        resolvedEventGroups.push({ sender: groupSender, events: group.events });
      }
    }

    // A receipt may span senders. Associate it only when every normalized
    // event group resolves to the same tenant-scoped sender; individual events
    // remain routed by their own entry/change metadata below.
    const resolvedSenderIds = new Set(resolvedEventGroups.map(group => group.sender.id));
    const receiptSender = resolvedEventGroups.length === eventGroups.length
      && resolvedSenderIds.size === 1
      ? resolvedEventGroups[0]!.sender
      : null;

    const inboundKeys = new Set<string>();
    const processableEventGroups = resolvedEventGroups.map(group => ({
      sender: group.sender,
      events: group.events.filter(event => {
        if (event.kind === "STATUS" || event.kind === "TEMPLATE") return true;
        const key = event.kind === "STOP"
          ? `STOP:${group.sender.id}:${event.phoneE164}`
          : `REPORT_COMMAND:${group.sender.id}:${event.providerMessageId}`;
        if (inboundKeys.has(key)) return false;
        inboundKeys.add(key);
        return true;
      }),
    })).filter(group => group.events.length > 0)
      .sort((left, right) => left.sender.id.localeCompare(right.sender.id));
    const processableEventCount = processableEventGroups.reduce(
      (count, group) => count + group.events.length,
      0
    );

    const { receipt, duplicate } = await existingOrCreateReceipt({
      providerMode,
      dedupeKey,
      payloadHash,
      organizationId: receiptSender?.organizationId ?? null,
      senderId: receiptSender?.id ?? null,
      wabaId: metadata.wabaId,
      phoneNumberId: metadata.phoneNumberId,
      eventType: metadata.eventType,
    });
    if (duplicate && (receipt.status === "PROCESSED" || receipt.status === "IGNORED")) {
      return META_WEBHOOK_ACCEPTED_RESPONSE;
    }

    const now = new Date();
    const claim = await claimReceipt({ receiptId: receipt.id, sender: receiptSender, now });
    // Do not acknowledge an in-flight duplicate before the lease owner has
    // durably committed its side effects. If that owner later fails, a 2xx
    // here could cause Meta to stop retrying the only durable FAILED receipt.
    if (!claim) throw new Error("WhatsApp webhook receipt is already processing");

    try {
      await prisma.$transaction(async tx => {
        const ownedReceipt = await tx.whatsAppWebhookReceipt.findFirst({
          where: {
            id: receipt.id,
            status: "PROCESSING",
            leaseToken: claim.leaseToken,
          },
          select: { id: true },
        });
        if (!ownedReceipt) throw new WhatsAppWebhookLeaseLostError();

        const knownSenderIds = [...new Set(
          resolvedEventGroups.map(group => group.sender.id)
        )];
        if (knownSenderIds.length > 0) {
          await tx.whatsAppSender.updateMany({
            where: { id: { in: knownSenderIds }, providerMode },
            data: { lastWebhookReceivedAt: now },
          });
        }

        await purgeExpiredOrphanEvents({
          tx,
          senderIds: processableEventGroups.map(group => group.sender.id),
          now,
        });

        for (const group of processableEventGroups) {
          await processWebhookEvents({
            tx,
            sender: group.sender,
            events: [...group.events],
            payloadHash,
            now,
          });
        }

        const finalized = await tx.whatsAppWebhookReceipt.updateMany({
          where: {
            id: receipt.id,
            status: "PROCESSING",
            leaseToken: claim.leaseToken,
          },
          data: {
            status: processableEventCount > 0 ? "PROCESSED" : "IGNORED",
            processedAt: now,
            failureCode: null,
            leaseToken: null,
            leaseUntil: null,
          },
        });
        if (finalized.count !== 1) throw new WhatsAppWebhookLeaseLostError();
      });
    } catch (error) {
      await prisma.whatsAppWebhookReceipt.updateMany({
        where: {
          id: receipt.id,
          status: "PROCESSING",
          leaseToken: claim.leaseToken,
        },
        data: {
          status: "FAILED",
          failureCode: "PROCESSING_FAILED",
          processedAt: null,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      throw error;
    }

    return META_WEBHOOK_ACCEPTED_RESPONSE;
  }
}
