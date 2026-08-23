export const WHATSAPP_INTEGRATION_FLAG = "WHATSAPP_INTEGRATION_ENABLED" as const;
export const WHATSAPP_META_ONBOARDING_WRITES_FLAG =
  "WHATSAPP_META_ONBOARDING_WRITES_ENABLED" as const;
export const WHATSAPP_WEBHOOK_INGEST_FLAG = "WHATSAPP_WEBHOOK_INGEST_ENABLED" as const;
export const WHATSAPP_LIVE_CANARY_ORG_IDS_ENV = "WHATSAPP_LIVE_CANARY_ORG_IDS" as const;
export const WHATSAPP_META_TEMPLATE_WRITES_FLAG =
  "WHATSAPP_META_TEMPLATE_WRITES_ENABLED" as const;
export const WHATSAPP_META_MESSAGE_WRITES_FLAG =
  "WHATSAPP_META_MESSAGE_WRITES_ENABLED" as const;
export const WHATSAPP_AUTOMATION_PLANNER_FLAG =
  "WHATSAPP_AUTOMATION_PLANNER_ENABLED" as const;
export const WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS_ENV =
  "WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS" as const;

export type WhatsAppProviderModeValue = "TEST" | "LIVE";

export class WhatsAppFeatureDisabledError extends Error {
  readonly code: string = "WHATSAPP_FEATURE_DISABLED";

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

export class WhatsAppTemplateWritesDisabledError extends WhatsAppFeatureDisabledError {
  readonly code = "WHATSAPP_TEMPLATE_WRITES_DISABLED";

  constructor() {
    super("WhatsApp managed-template installation is unavailable");
    this.name = "WhatsAppTemplateWritesDisabledError";
  }
}

export class WhatsAppMessageWritesDisabledError extends WhatsAppFeatureDisabledError {
  readonly code = "WHATSAPP_MESSAGE_WRITES_DISABLED";

  constructor() {
    super("WhatsApp message delivery is unavailable");
    this.name = "WhatsAppMessageWritesDisabledError";
  }
}

export class WhatsAppAutomationPlannerDisabledError extends WhatsAppFeatureDisabledError {
  readonly code = "WHATSAPP_AUTOMATION_PLANNER_DISABLED";

  constructor() {
    super("WhatsApp automation planning is unavailable");
    this.name = "WhatsAppAutomationPlannerDisabledError";
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

export function configuredWhatsAppLiveDeliveryCanaryOrganizationIds(
  env: Readonly<Record<string, string | undefined>>
): ReadonlySet<string> {
  const raw = env[WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS_ENV];
  if (!raw?.trim()) return new Set<string>();
  const values = raw.split(",").map(value => value.trim());
  if (
    values.some(value => !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    || new Set(values).size !== values.length
  ) {
    return new Set<string>();
  }
  return new Set(values);
}

function areWhatsAppProviderWritesEnabled(
  flag: typeof WHATSAPP_META_TEMPLATE_WRITES_FLAG | typeof WHATSAPP_META_MESSAGE_WRITES_FLAG,
  organizationId: string,
  env: Readonly<Record<string, string | undefined>>
) {
  if (!isWhatsAppIntegrationEnabled(env) || !enabled(env[flag])) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) return false;

  const mode = resolveWhatsAppProviderMode(env);
  if (mode === "TEST") return true;
  return env.VERCEL_ENV?.trim().toLowerCase() === "production"
    && configuredWhatsAppLiveDeliveryCanaryOrganizationIds(env).has(organizationId);
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

export function areWhatsAppTemplateWritesEnabled(
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return areWhatsAppProviderWritesEnabled(
    WHATSAPP_META_TEMPLATE_WRITES_FLAG,
    organizationId,
    env
  );
}

export function areWhatsAppMessageWritesEnabled(
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return areWhatsAppProviderWritesEnabled(
    WHATSAPP_META_MESSAGE_WRITES_FLAG,
    organizationId,
    env
  );
}

export function isWhatsAppAutomationPlannerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!isWhatsAppIntegrationEnabled(env) || !enabled(env[WHATSAPP_AUTOMATION_PLANNER_FLAG])) {
    return false;
  }
  const mode = resolveWhatsAppProviderMode(env);
  return mode === "TEST" || env.VERCEL_ENV?.trim().toLowerCase() === "production";
}

/**
 * Indicates that the PR3 delivery schema may be accessed by this application
 * release. This is deliberately separate from the per-operation provider-write
 * gates: it is a feature-surface fence, not authorization to call Meta and not
 * proof that the migration has been applied.
 *
 * PR3 is deployed database-first because ordinary Student reads and writes use
 * the new enrollmentSource column. Keeping every PR3 flag false after that
 * migration holds the new delivery surfaces during application rollout.
 */
export function isWhatsAppDeliverySchemaAccessEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return isWhatsAppIntegrationEnabled(env) && (
    enabled(env[WHATSAPP_META_TEMPLATE_WRITES_FLAG])
    || enabled(env[WHATSAPP_META_MESSAGE_WRITES_FLAG])
    || enabled(env[WHATSAPP_AUTOMATION_PLANNER_FLAG])
  );
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

export function assertWhatsAppTemplateWritesEnabled(
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!areWhatsAppTemplateWritesEnabled(organizationId, env)) {
    throw new WhatsAppTemplateWritesDisabledError();
  }
}

export function assertWhatsAppMessageWritesEnabled(
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!areWhatsAppMessageWritesEnabled(organizationId, env)) {
    throw new WhatsAppMessageWritesDisabledError();
  }
}

export function assertWhatsAppAutomationPlannerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!isWhatsAppAutomationPlannerEnabled(env)) {
    throw new WhatsAppAutomationPlannerDisabledError();
  }
}

export function assertWhatsAppDeliverySchemaAccessEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!isWhatsAppDeliverySchemaAccessEnabled(env)) {
    throw new WhatsAppFeatureDisabledError("WhatsApp delivery features are unavailable");
  }
}

export function assertWhatsAppWebhookIngestEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!isWhatsAppWebhookIngestEnabled(env)) throw new WhatsAppWebhookIngestDisabledError();
}
