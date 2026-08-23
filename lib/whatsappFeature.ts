export const WHATSAPP_INTEGRATION_FLAG = "WHATSAPP_INTEGRATION_ENABLED" as const;
export const WHATSAPP_META_ONBOARDING_WRITES_FLAG =
  "WHATSAPP_META_ONBOARDING_WRITES_ENABLED" as const;
export const WHATSAPP_WEBHOOK_INGEST_FLAG = "WHATSAPP_WEBHOOK_INGEST_ENABLED" as const;
export const WHATSAPP_LIVE_CANARY_ORG_IDS_ENV = "WHATSAPP_LIVE_CANARY_ORG_IDS" as const;

export type WhatsAppProviderModeValue = "TEST" | "LIVE";

export class WhatsAppFeatureDisabledError extends Error {
  readonly code = "WHATSAPP_FEATURE_DISABLED";

  constructor(message = "WhatsApp integration is not available") {
    super(message);
    this.name = "WhatsAppFeatureDisabledError";
  }
}

export class WhatsAppOnboardingWritesDisabledError extends Error {
  readonly code = "WHATSAPP_ONBOARDING_WRITES_DISABLED";

  constructor() {
    super("WhatsApp connection changes are temporarily unavailable");
    this.name = "WhatsAppOnboardingWritesDisabledError";
  }
}

export class WhatsAppWebhookIngestDisabledError extends Error {
  readonly code = "WHATSAPP_WEBHOOK_INGEST_DISABLED";

  constructor() {
    super("WhatsApp webhook ingestion is disabled");
    this.name = "WhatsAppWebhookIngestDisabledError";
  }
}

export class WhatsAppConfigurationError extends Error {
  readonly code = "WHATSAPP_CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "WhatsAppConfigurationError";
  }
}

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

export function isWhatsAppIntegrationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return enabled(env[WHATSAPP_INTEGRATION_FLAG]);
}

export function isWhatsAppWebhookIngestEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return isWhatsAppIntegrationEnabled(env) && enabled(env[WHATSAPP_WEBHOOK_INGEST_FLAG]);
}

export function resolveWhatsAppProviderMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): WhatsAppProviderModeValue {
  const configured = env.META_WHATSAPP_MODE?.trim().toUpperCase();
  if (configured !== "TEST" && configured !== "LIVE") {
    throw new WhatsAppConfigurationError(
      "META_WHATSAPP_MODE must be explicitly set to TEST or LIVE"
    );
  }

  const vercelEnvironment = env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnvironment === "production" && configured !== "LIVE") {
    throw new WhatsAppConfigurationError("Vercel Production requires META_WHATSAPP_MODE=LIVE");
  }
  if (vercelEnvironment === "preview" && configured !== "TEST") {
    throw new WhatsAppConfigurationError("Vercel Preview requires META_WHATSAPP_MODE=TEST");
  }
  if (
    (vercelEnvironment === "development" || !vercelEnvironment)
    && env.NODE_ENV !== "test"
    && configured !== "TEST"
  ) {
    throw new WhatsAppConfigurationError("Local development requires META_WHATSAPP_MODE=TEST");
  }

  return configured;
}

function configuredLiveCanaryOrganizations(
  env: Readonly<Record<string, string | undefined>>
) {
  const values = env[WHATSAPP_LIVE_CANARY_ORG_IDS_ENV]?.split(",") ?? [];
  return new Set(
    values
      .map(value => value.trim())
      .filter(value => /^[A-Za-z0-9_-]{1,128}$/.test(value))
  );
}

export function areWhatsAppOnboardingWritesEnabled(
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!isWhatsAppIntegrationEnabled(env)) return false;
  if (!enabled(env[WHATSAPP_META_ONBOARDING_WRITES_FLAG])) return false;

  const mode = resolveWhatsAppProviderMode(env);
  if (mode === "TEST") return true;

  return env.VERCEL_ENV?.trim().toLowerCase() === "production"
    && configuredLiveCanaryOrganizations(env).has(organizationId);
}

export function assertWhatsAppIntegrationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!isWhatsAppIntegrationEnabled(env)) throw new WhatsAppFeatureDisabledError();
}

export function assertWhatsAppOnboardingWritesEnabled(
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!areWhatsAppOnboardingWritesEnabled(organizationId, env)) {
    throw new WhatsAppOnboardingWritesDisabledError();
  }
}

export function assertWhatsAppWebhookIngestEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!isWhatsAppWebhookIngestEnabled(env)) throw new WhatsAppWebhookIngestDisabledError();
}
