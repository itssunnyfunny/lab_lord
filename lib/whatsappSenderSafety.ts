import type { MetaWhatsAppProviderErrorKind } from "@/lib/metaWhatsApp";

export const WHATSAPP_SENDER_SAFETY_WINDOW_MS = 10 * 60 * 1_000;
export const WHATSAPP_AMBIGUOUS_OUTCOME_THRESHOLD = 3;
export const WHATSAPP_DEFINITE_FAILURE_THRESHOLD = 10;
export const WHATSAPP_SENDER_HEALTH_FRESHNESS_MS = 60 * 60 * 1_000;

export type WhatsAppSenderSafetyWindow = Readonly<{
  windowStartedAt: Date | null;
  count: number;
}>;

export type WhatsAppDefiniteFailureEvidence = Readonly<{
  kind: MetaWhatsAppProviderErrorKind;
  providerCode?: number | null;
  providerSubcode?: number | null;
}>;

// These codes represent app/sender/account-wide authorization or restriction
// failures. Recipient/content failures (for example, an unreachable number)
// deliberately do not contribute to a sender-wide circuit breaker.
const SENDER_WIDE_PROVIDER_CODES = new Set([
  10,
  190,
  200,
  131031,
  131042,
  131045,
]);

export function isReviewedWhatsAppSenderWideFailure(
  evidence: WhatsAppDefiniteFailureEvidence
) {
  if (evidence.kind === "AUTHENTICATION") return true;
  return evidence.providerCode !== null
    && evidence.providerCode !== undefined
    && SENDER_WIDE_PROVIDER_CODES.has(evidence.providerCode);
}

export function advanceWhatsAppSenderSafetyWindow(input: {
  current: WhatsAppSenderSafetyWindow;
  now: Date;
  windowMs?: number;
}) {
  const windowMs = input.windowMs ?? WHATSAPP_SENDER_SAFETY_WINDOW_MS;
  if (
    !input.current.windowStartedAt
    || input.current.count < 0
    || !Number.isSafeInteger(input.current.count)
    || input.now.getTime() < input.current.windowStartedAt.getTime()
    || input.now.getTime() - input.current.windowStartedAt.getTime() >= windowMs
  ) {
    return { windowStartedAt: input.now, count: 1 } as const;
  }
  return {
    windowStartedAt: input.current.windowStartedAt,
    count: Math.min(input.current.count + 1, Number.MAX_SAFE_INTEGER),
  } as const;
}

export function isWhatsAppSenderHealthFresh(input: {
  lastHealthyAt: Date | null;
  now: Date;
  freshnessMs?: number;
}) {
  if (!input.lastHealthyAt) return false;
  const age = input.now.getTime() - input.lastHealthyAt.getTime();
  return age >= 0 && age <= (input.freshnessMs ?? WHATSAPP_SENDER_HEALTH_FRESHNESS_MS);
}
