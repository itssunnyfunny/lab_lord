export const WHATSAPP_UTILITY_RATE_MICROS_INR_ENV =
  "WHATSAPP_UTILITY_RATE_MICROS_INR" as const;
export const WHATSAPP_RATE_CARD_VERSION_ENV = "WHATSAPP_RATE_CARD_VERSION" as const;
export const WHATSAPP_RATE_CARD_EFFECTIVE_AT_ENV =
  "WHATSAPP_RATE_CARD_EFFECTIVE_AT" as const;

export const INR_MICROS_PER_RUPEE = 1_000_000;
export const INR_MICROS_PER_PAISA = 10_000;

// INR 100,000. This is a product safety ceiling, not a provider price.
export const MAX_WHATSAPP_MONTHLY_BUDGET_MINOR = 10_000_000;
export const MAX_WHATSAPP_UTILITY_RATE_MICROS_INR = 10 * INR_MICROS_PER_RUPEE;

export type WhatsAppRateCard = Readonly<{
  currency: "INR";
  effectiveAt: Date;
  rateMicros: number;
  version: string;
}>;

export type WhatsAppCostErrorCode =
  | "RATE_UNAVAILABLE"
  | "DESTINATION_UNSUPPORTED"
  | "BUDGET_INVALID";

export class WhatsAppCostConfigurationError extends Error {
  constructor(
    readonly code: WhatsAppCostErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WhatsAppCostConfigurationError";
  }
}
function requiredEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string
) {
  const value = env[name]?.trim();
  if (!value) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp utility rate configuration is unavailable"
    );
  }
  return value;
}

export function readWhatsAppRateCard(
  env: Readonly<Record<string, string | undefined>> = process.env
): WhatsAppRateCard {
  const rawRate = requiredEnvironmentValue(env, WHATSAPP_UTILITY_RATE_MICROS_INR_ENV);
  const version = requiredEnvironmentValue(env, WHATSAPP_RATE_CARD_VERSION_ENV);
  const rawEffectiveAt = requiredEnvironmentValue(env, WHATSAPP_RATE_CARD_EFFECTIVE_AT_ENV);

  if (!/^[1-9]\d{0,9}$/.test(rawRate)) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp utility rate configuration is invalid"
    );
  }
  const rateMicros = Number(rawRate);
  if (!Number.isSafeInteger(rateMicros) || rateMicros > MAX_WHATSAPP_UTILITY_RATE_MICROS_INR) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp utility rate configuration is invalid"
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp rate-card version is invalid"
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(rawEffectiveAt)) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp rate-card effective date is invalid"
    );
  }
  const effectiveAt = new Date(rawEffectiveAt);
  if (Number.isNaN(effectiveAt.getTime())) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp rate-card effective date is invalid"
    );
  }

  return Object.freeze({ currency: "INR", effectiveAt, rateMicros, version });
}

export function resolveWhatsAppUtilityRate(input: {
  recipientPhoneE164: string;
  at?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  if (!/^\+91[6-9]\d{9}$/.test(input.recipientPhoneE164)) {
    throw new WhatsAppCostConfigurationError(
      "DESTINATION_UNSUPPORTED",
      "WhatsApp delivery is not available for this destination"
    );
  }
  const card = readWhatsAppRateCard(input.env);
  const at = input.at ?? new Date();
  if (card.effectiveAt.getTime() > at.getTime()) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp utility rate configuration is not effective yet"
    );
  }
  return card;
}

export function paiseToInrMicros(paise: number) {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new WhatsAppCostConfigurationError("BUDGET_INVALID", "WhatsApp budget is invalid");
  }
  const micros = paise * INR_MICROS_PER_PAISA;
  if (!Number.isSafeInteger(micros)) {
    throw new WhatsAppCostConfigurationError("BUDGET_INVALID", "WhatsApp budget is invalid");
  }
  return micros;
}

export function validateWhatsAppMonthlyBudgetMinor(value: number | null | undefined) {
  if (
    value === null
    || value === undefined
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_WHATSAPP_MONTHLY_BUDGET_MINOR
  ) {
    throw new WhatsAppCostConfigurationError("BUDGET_INVALID", "WhatsApp budget is invalid");
  }
  return value;
}

export function estimateWhatsAppUtilityCostMicros(input: {
  messageCount: number;
  rateMicros: number;
}) {
  if (
    !Number.isSafeInteger(input.messageCount)
    || input.messageCount < 0
    || !Number.isSafeInteger(input.rateMicros)
    || input.rateMicros <= 0
  ) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp cost estimate is invalid"
    );
  }
  const estimate = input.messageCount * input.rateMicros;
  if (!Number.isSafeInteger(estimate)) {
    throw new WhatsAppCostConfigurationError(
      "RATE_UNAVAILABLE",
      "WhatsApp cost estimate is invalid"
    );
  }
  return estimate;
}
