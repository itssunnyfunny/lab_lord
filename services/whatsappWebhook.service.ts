import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertWhatsAppWebhookIngestEnabled,
  resolveWhatsAppProviderMode,
  WhatsAppConfigurationError,
} from "@/lib/whatsappFeature";
import { WhatsAppValidationError } from "@/lib/whatsappHttp";

export const MAX_META_WEBHOOK_BYTES = 512 * 1024;
export const META_WEBHOOK_ACCEPTED_RESPONSE = Object.freeze({ accepted: true as const });

const providerId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const webhookEnvelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    id: providerId,
    changes: z.array(z.object({
      field: z.string().min(1).max(64),
      value: z.object({
        metadata: z.object({
          phone_number_id: providerId.optional(),
        }).optional(),
      }),
    })).max(100),
  })).max(100),
});

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

function receiptMetadata(value: z.infer<typeof webhookEnvelopeSchema>) {
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

export class WhatsAppWebhookService {
  static async handle(request: Request) {
    assertWhatsAppWebhookIngestEnabled();
    const providerMode = resolveWhatsAppProviderMode();
    const rawBody = await readBoundedWebhookBody(request);
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyMetaWebhookSignature(rawBody, signature)) {
      throw new WhatsAppValidationError("Invalid webhook signature");
    }

    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const dedupeKey = `META_CLOUD:${providerMode}:${payloadHash}`;
    let parsed: z.infer<typeof webhookEnvelopeSchema>;
    try {
      parsed = parseMetaWebhookEnvelope(rawBody);
    } catch {
      await existingOrCreateReceipt({
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
    let sender = null;
    if (metadata.phoneNumberId) {
      sender = await prisma.whatsAppSender.findUnique({
        where: {
          provider_providerMode_phoneNumberId: {
            provider: "META_CLOUD",
            providerMode,
            phoneNumberId: metadata.phoneNumberId,
          },
        },
        select: { id: true, organizationId: true, wabaId: true },
      });
      if (sender && metadata.wabaId && sender.wabaId !== metadata.wabaId) sender = null;
    } else if (metadata.wabaId) {
      const candidates = await prisma.whatsAppSender.findMany({
        where: { provider: "META_CLOUD", providerMode, wabaId: metadata.wabaId },
        select: { id: true, organizationId: true, wabaId: true },
        take: 2,
      });
      if (candidates.length === 1) sender = candidates[0];
    }

    const { receipt, duplicate } = await existingOrCreateReceipt({
      providerMode,
      dedupeKey,
      payloadHash,
      organizationId: sender?.organizationId ?? null,
      senderId: sender?.id ?? null,
      wabaId: metadata.wabaId,
      phoneNumberId: metadata.phoneNumberId,
      eventType: metadata.eventType,
    });
    if (duplicate && (receipt.status === "PROCESSED" || receipt.status === "IGNORED")) {
      return META_WEBHOOK_ACCEPTED_RESPONSE;
    }

    await prisma.whatsAppWebhookReceipt.update({
      where: { id: receipt.id },
      data: { status: "IGNORED", processedAt: new Date(), failureCode: null },
    });
    return META_WEBHOOK_ACCEPTED_RESPONSE;
  }
}
