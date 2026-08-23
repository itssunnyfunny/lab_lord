export type WhatsAppDefaultCountry = "IN";

export class WhatsAppPhoneValidationError extends Error {
  readonly code = "INVALID_WHATSAPP_PHONE";

  constructor() {
    super("Phone number must be a valid E.164 number");
    this.name = "WhatsAppPhoneValidationError";
  }
}

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const INDIA_MOBILE_PATTERN = /^[6-9]\d{9}$/;

function fail(): never {
  throw new WhatsAppPhoneValidationError();
}

export function normalizeWhatsAppPhone(
  input: string,
  options: { defaultCountry?: WhatsAppDefaultCountry } = {}
) {
  if (typeof input !== "string") fail();

  const trimmed = input.trim();
  if (!trimmed || /[A-Za-z]/.test(trimmed) || /(?:ext\.?|extension|x)\s*\d/i.test(trimmed)) {
    fail();
  }
  if (/[,;#]/.test(trimmed) || trimmed.startsWith("00")) fail();

  const compact = trimmed.replace(/[\s().-]/g, "");
  if (compact.startsWith("+")) {
    if (!E164_PATTERN.test(compact)) fail();
    if (compact.startsWith("+91") && !INDIA_MOBILE_PATTERN.test(compact.slice(3))) fail();
    return compact;
  }

  if (!/^\d+$/.test(compact)) fail();
  if (options.defaultCountry === "IN" && INDIA_MOBILE_PATTERN.test(compact)) {
    return `+91${compact}`;
  }

  fail();
}

export function isWhatsAppE164(value: string) {
  try {
    return normalizeWhatsAppPhone(value) === value;
  } catch {
    return false;
  }
}
