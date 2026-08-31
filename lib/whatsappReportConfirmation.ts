import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";

export const WHATSAPP_REPORT_CONFIRMATION_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" as const;
export const WHATSAPP_REPORT_CONFIRMATION_CODE_LENGTH = 10;
export const WHATSAPP_REPORT_CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
export const WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS = 5;
export const WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION = "owner-report-v1" as const;

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertId(value: string) {
  if (!ID_PATTERN.test(value)) throw new Error("Report confirmation binding is invalid");
  return value;
}

export function normalizeWhatsAppReportConfirmationCode(value: string) {
  if (typeof value !== "string") throw new Error("Report confirmation code is invalid");
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) throw new Error("Report confirmation code is invalid");
  return normalized;
}

export function generateWhatsAppReportConfirmationCode(
  bytes: (size: number) => Buffer = randomBytes
) {
  const entropy = bytes(WHATSAPP_REPORT_CONFIRMATION_CODE_LENGTH);
  if (entropy.length !== WHATSAPP_REPORT_CONFIRMATION_CODE_LENGTH) {
    throw new Error("Report confirmation entropy is unavailable");
  }
  let code = "";
  for (const value of entropy) {
    code += WHATSAPP_REPORT_CONFIRMATION_ALPHABET[value & 31];
  }
  return code;
}

export function hashWhatsAppReportConfirmationCode(input: {
  senderId: string;
  subscriptionId: string;
  phoneE164: string;
  code: string;
}) {
  const phoneE164 = normalizeWhatsAppPhone(input.phoneE164);
  const code = normalizeWhatsAppReportConfirmationCode(input.code);
  return createHash("sha256").update(JSON.stringify([
    "whatsapp-report-confirmation-v1",
    assertId(input.senderId),
    assertId(input.subscriptionId),
    phoneE164,
    code,
  ]), "utf8").digest("hex");
}

export function matchesWhatsAppReportConfirmationHash(expected: string, actual: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
