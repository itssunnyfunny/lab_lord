import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import {
  WhatsAppConfigurationError,
  WhatsAppFeatureDisabledError,
  WhatsAppOnboardingWritesDisabledError,
  WhatsAppWebhookIngestDisabledError,
} from "@/lib/whatsappFeature";
import {
  BillingReadOnlyError,
  SubscriptionEntitlementError,
} from "@/services/entitlement.service";

export class WhatsAppResourceNotFoundError extends Error {
  readonly code = "WHATSAPP_RESOURCE_NOT_FOUND";

  constructor() {
    super("WhatsApp resource not found");
    this.name = "WhatsAppResourceNotFoundError";
  }
}

export class WhatsAppConflictError extends Error {
  readonly code = "WHATSAPP_CONFLICT";

  constructor(message = "WhatsApp resource is already connected") {
    super(message);
    this.name = "WhatsAppConflictError";
  }
}

export class WhatsAppValidationError extends Error {
  readonly code = "WHATSAPP_INVALID_REQUEST";

  constructor(message = "Invalid WhatsApp request") {
    super(message);
    this.name = "WhatsAppValidationError";
  }
}

export class WhatsAppProviderOperationError extends Error {
  readonly code = "WHATSAPP_PROVIDER_UNAVAILABLE";

  constructor() {
    super("WhatsApp provider verification is temporarily unavailable");
    this.name = "WhatsAppProviderOperationError";
  }
}

type SafeWhatsAppError = {
  status: number;
  code: string;
  message: string;
};

export function safeWhatsAppError(error: unknown): SafeWhatsAppError {
  if (error instanceof WhatsAppResourceNotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }
  if (error instanceof WhatsAppConflictError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof WhatsAppValidationError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof SubscriptionEntitlementError) {
    return {
      status: 403,
      code: "WHATSAPP_UPGRADE_REQUIRED",
      message: "WhatsApp requires the Standard plan",
    };
  }
  if (error instanceof BillingReadOnlyError) {
    return {
      status: 409,
      code: "WHATSAPP_WORKSPACE_READ_ONLY",
      message: "WhatsApp changes are unavailable while this workspace is read-only",
    };
  }
  if (
    error instanceof WhatsAppFeatureDisabledError
    || error instanceof WhatsAppOnboardingWritesDisabledError
    || error instanceof WhatsAppWebhookIngestDisabledError
    || error instanceof WhatsAppConfigurationError
  ) {
    return {
      status: 503,
      code: "WHATSAPP_UNAVAILABLE",
      message: "WhatsApp integration is currently unavailable",
    };
  }
  if (error instanceof WhatsAppProviderOperationError) {
    return { status: 502, code: error.code, message: error.message };
  }

  return {
    status: 500,
    code: "WHATSAPP_INTERNAL_ERROR",
    message: "WhatsApp request could not be completed",
  };
}

export function whatsAppErrorResponse(error: unknown) {
  const safe = safeWhatsAppError(error);
  return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
}

/**
 * Clerk establishes the local actor, but cookie authentication still needs a
 * browser-origin boundary for state-changing WhatsApp routes. `Origin` is the
 * primary signal; Sec-Fetch-Site is accepted only when the browser explicitly
 * identifies the request as same-origin.
 */
export function assertWhatsAppSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (origin) {
    if (origin.length > 2_048 || fetchSite && fetchSite !== "same-origin") {
      throw new WhatsAppValidationError();
    }

    try {
      const parsedOrigin = new URL(origin);
      if (
        origin !== parsedOrigin.origin
        || parsedOrigin.origin !== new URL(request.url).origin
      ) {
        throw new WhatsAppValidationError();
      }
      return;
    } catch (error) {
      if (error instanceof WhatsAppValidationError) throw error;
      throw new WhatsAppValidationError();
    }
  }

  if (fetchSite !== "same-origin") throw new WhatsAppValidationError();
}

export async function parseWhatsAppJson<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = 16 * 1024
) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new WhatsAppValidationError();
  }
  if (!request.body) throw new WhatsAppValidationError();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WhatsAppValidationError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString("utf8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof WhatsAppValidationError) throw error;
    throw new WhatsAppValidationError();
  }
}
