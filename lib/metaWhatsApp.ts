import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  prepareManagedWhatsAppTemplate,
  resolveExactManagedWhatsAppTemplateDefinition,
  WHATSAPP_MANAGED_STOP_PAYLOAD,
  type WhatsAppManagedTemplateDefinition,
} from "@/lib/whatsappManagedTemplates";
import {
  resolveWhatsAppProviderMode,
  WhatsAppConfigurationError,
  type WhatsAppProviderModeValue,
} from "@/lib/whatsappFeature";
import type {
  MetaAssignedSystemUser,
  MetaApprovedUtilityTemplateSendResult,
  MetaDebugToken,
  MetaManagedUtilityTemplateCreateResult,
  MetaMessageTemplate,
  MetaPhoneNumber,
  MetaSubscribedApp,
  MetaWaba,
} from "@/types/whatsapp";
import {
  META_WHATSAPP_MESSAGE_ID_MAX_LENGTH,
  META_WHATSAPP_MESSAGE_ID_PATTERN,
} from "@/lib/whatsappProviderMessageId";

export type {
  MetaAssignedSystemUser,
  MetaApprovedUtilityTemplateSendResult,
  MetaDebugToken,
  MetaManagedUtilityTemplateCreateResult,
  MetaMessageTemplate,
  MetaPhoneNumber,
  MetaSubscribedApp,
  MetaWaba,
} from "@/types/whatsapp";

export const META_GRAPH_ORIGIN = "https://graph.facebook.com" as const;
export const META_WHATSAPP_GRAPH_API_VERSION = "v25.0" as const;
export const META_GRAPH_DEFAULT_TIMEOUT_MS = 10_000;
export const META_GRAPH_MAX_TIMEOUT_MS = 30_000;
export const META_GRAPH_MAX_RESPONSE_BYTES = 1024 * 1024;
export const META_GRAPH_MAX_PAGES = 20;
export const META_GRAPH_MAX_ITEMS = 2_000;

const META_GRAPH_MAX_READ_ATTEMPTS = 3;
const META_GRAPH_MAX_COMPONENT_BYTES = 64 * 1024;
const META_GRAPH_MAX_PAGE_ITEMS = 500;
const META_GRAPH_MAX_URL_LENGTH = 4_096;
const META_GRAPH_MAX_TOKEN_LENGTH = 8_192;
const META_GRAPH_MAX_ERROR_REQUEST_ID_LENGTH = 256;
const META_GRAPH_MAX_CORRELATION_ID_LENGTH = 512;
const META_GRAPH_VERSION_PATTERN = /^v(?:[1-9]|[1-9][0-9])\.0$/;
const META_PROVIDER_ID_PATTERN = /^[0-9]{1,64}$/;
const META_E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const META_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;

const providerIdSchema = z.string().regex(META_PROVIDER_ID_PATTERN);
const nullableBoundedString = (maximum: number) => z.string().max(maximum).nullable().optional();
const boundedTokenSchema = z.string().min(1).max(META_GRAPH_MAX_TOKEN_LENGTH);
const pagingSchema = z.object({
  cursors: z.object({
    before: z.string().max(2_048).optional(),
    after: z.string().max(2_048).optional(),
  }).optional(),
  next: z.string().min(1).max(META_GRAPH_MAX_URL_LENGTH).optional(),
  previous: z.string().min(1).max(META_GRAPH_MAX_URL_LENGTH).optional(),
}).optional();

const graphErrorSchema = z.object({
  error: z.object({
    code: z.number().int().safe().optional(),
    error_subcode: z.number().int().safe().optional(),
    fbtrace_id: z.string().max(META_GRAPH_MAX_ERROR_REQUEST_ID_LENGTH).optional(),
  }),
});

const accessTokenResponseSchema = z.object({
  access_token: boundedTokenSchema,
  token_type: z.string().max(32).optional(),
  expires_in: z.number().int().nonnegative().max(10 * 365 * 24 * 60 * 60).optional(),
});

const debugTokenResponseSchema = z.object({
  data: z.object({
    app_id: providerIdSchema,
    is_valid: z.boolean(),
    expires_at: z.number().int().nonnegative().max(100_000_000_000).optional(),
    data_access_expires_at: z.number().int().nonnegative().max(100_000_000_000).optional(),
    scopes: z.array(z.string().min(1).max(128)).max(100).optional(),
    granular_scopes: z.array(z.object({
      scope: z.string().min(1).max(128),
      target_ids: z.array(providerIdSchema).max(META_GRAPH_MAX_ITEMS).optional(),
    })).max(100).optional(),
  }),
});

const wabaSchema = z.object({
  id: providerIdSchema,
  name: nullableBoundedString(512),
  currency: nullableBoundedString(16),
  timezone_id: z.union([z.string().max(64), z.number().int().safe()]).nullable().optional(),
  account_mode: nullableBoundedString(64),
});

const phoneNumberSchema = z.object({
  id: providerIdSchema,
  display_phone_number: z.string().min(1).max(64),
  verified_name: nullableBoundedString(512),
  quality_rating: nullableBoundedString(64),
  code_verification_status: nullableBoundedString(64),
  platform_type: nullableBoundedString(64),
  status: nullableBoundedString(64),
});

const assignedSystemUserSchema = z.object({
  id: providerIdSchema,
  name: nullableBoundedString(512),
  tasks: z.array(z.string().min(1).max(64)).max(20).optional(),
});

const subscribedAppSchema = z.object({
  id: providerIdSchema.optional(),
  name: nullableBoundedString(512),
  whatsapp_business_api_data: z.object({
    id: providerIdSchema,
    name: nullableBoundedString(512),
  }).optional(),
}).refine(value => value.id !== undefined || value.whatsapp_business_api_data !== undefined);

const templateSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1).max(512),
  language: z.string().min(1).max(64),
  category: z.string().min(1).max(64),
  status: z.string().min(1).max(64),
  components: z.array(z.unknown()).max(100).optional(),
});

const managedTemplateCreateResponseSchema = z.object({
  id: providerIdSchema,
  status: z.string().min(1).max(64),
  category: z.string().min(1).max(64),
});

const messageSubmissionStatusSchema = z.enum([
  "accepted",
  "held_for_quality_assessment",
  "paused",
]);
const sendTemplateResponseSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  contacts: z.array(z.object({
    input: z.string().min(1).max(32),
    wa_id: z.string().regex(/^[0-9]{8,32}$/),
  })).max(1).optional(),
  messages: z.array(z.object({
    id: z.string()
      .max(META_WHATSAPP_MESSAGE_ID_MAX_LENGTH)
      .regex(META_WHATSAPP_MESSAGE_ID_PATTERN),
    message_status: messageSubmissionStatusSchema.optional(),
  })).length(1),
});

const successResponseSchema = z.object({
  success: z.union([z.boolean(), z.literal("true")]).transform(value => value === true || value === "true"),
});

const wabaPageSchema = z.object({
  data: z.array(wabaSchema).max(META_GRAPH_MAX_PAGE_ITEMS),
  paging: pagingSchema,
});
const phoneNumberPageSchema = z.object({
  data: z.array(phoneNumberSchema).max(META_GRAPH_MAX_PAGE_ITEMS),
  paging: pagingSchema,
});
const assignedSystemUserPageSchema = z.object({
  data: z.array(assignedSystemUserSchema).max(META_GRAPH_MAX_PAGE_ITEMS),
  paging: pagingSchema,
});
const subscribedAppPageSchema = z.object({
  data: z.array(subscribedAppSchema).max(META_GRAPH_MAX_PAGE_ITEMS),
  paging: pagingSchema,
});
const templatePageSchema = z.object({
  data: z.array(templateSchema).max(META_GRAPH_MAX_PAGE_ITEMS),
  paging: pagingSchema,
});

export type MetaWhatsAppConfiguration = {
  providerMode: WhatsAppProviderModeValue;
  graphApiVersion: string;
  appId: string;
  appSecret: string;
  embeddedSignupConfigId: string;
  businessId: string;
  systemUserId: string;
  systemUserAccessToken: string;
  webhookVerifyToken: string;
};

export type MetaWhatsAppProviderErrorKind =
  | "AUTHENTICATION"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "NETWORK"
  | "TIMEOUT"
  | "REQUEST"
  | "PROVIDER"
  | "INVALID_RESPONSE"
  | "BOUNDS";

export class MetaWhatsAppProviderError extends Error {
  readonly code: string = "META_PROVIDER_ERROR";
  readonly kind: MetaWhatsAppProviderErrorKind;
  readonly status: number | null;
  readonly providerCode: number | null;
  readonly providerSubcode: number | null;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    input: {
      kind: MetaWhatsAppProviderErrorKind;
      status?: number | null;
      providerCode?: number | null;
      providerSubcode?: number | null;
      requestId?: string | null;
      retryAfterSeconds?: number | null;
    }
  ) {
    super(message);
    this.name = "MetaWhatsAppProviderError";
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.providerCode = input.providerCode ?? null;
    this.providerSubcode = input.providerSubcode ?? null;
    this.requestId = input.requestId ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

export class MetaWhatsAppAmbiguousMutationError extends MetaWhatsAppProviderError {
  readonly code = "META_PROVIDER_MUTATION_AMBIGUOUS";

  constructor(input: { requestId?: string | null; status?: number | null } = {}) {
    super("Meta could not confirm whether the requested mutation completed", {
      kind: "PROVIDER",
      status: input.status,
      requestId: input.requestId,
    });
    this.name = "MetaWhatsAppAmbiguousMutationError";
  }
}

export class MetaWhatsAppInputError extends Error {
  readonly code = "META_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MetaWhatsAppInputError";
  }
}

export type MetaAccessTokenExchange = {
  accessToken: string;
  tokenType: string | null;
  expiresInSeconds: number | null;
};

export interface MetaWhatsAppProviderClient {
  exchangeEmbeddedSignupCode(input: { code: string }): Promise<MetaAccessTokenExchange>;
  debugAccessToken(input: { accessToken: string }): Promise<MetaDebugToken>;
  listOrResolveSharedWabas(input: { businessId: string; accessToken: string }): Promise<MetaWaba[]>;
  fetchWaba(input: { wabaId: string; accessToken: string }): Promise<MetaWaba>;
  listPhoneNumbers(input: { wabaId: string; accessToken: string }): Promise<MetaPhoneNumber[]>;
  fetchPhoneNumber(input: {
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
  }): Promise<MetaPhoneNumber>;
  listAssignedSystemUsers(input: { wabaId: string }): Promise<MetaAssignedSystemUser[]>;
  assignSystemUserToWaba(input: { wabaId: string }): Promise<{ success: boolean }>;
  listSubscribedApps(input: { wabaId: string }): Promise<MetaSubscribedApp[]>;
  subscribeAppToWaba(input: { wabaId: string }): Promise<{ success: boolean }>;
  registerPhoneNumber(input: { phoneNumberId: string; pin: string }): Promise<{ success: boolean }>;
  listMessageTemplates(input: { wabaId: string }): Promise<MetaMessageTemplate[]>;
  createManagedUtilityTemplate(input: {
    wabaId: string;
    definition: WhatsAppManagedTemplateDefinition;
  }): Promise<MetaManagedUtilityTemplateCreateResult>;
  sendApprovedUtilityTemplate(input: {
    phoneNumberId: string;
    recipientPhoneE164: string;
    definition: WhatsAppManagedTemplateDefinition;
    values: Readonly<Record<string, unknown>>;
    correlationId: string;
  }): Promise<MetaApprovedUtilityTemplateSendResult>;
}

export const META_WHATSAPP_PROVIDER_METHODS = [
  "exchangeEmbeddedSignupCode",
  "debugAccessToken",
  "listOrResolveSharedWabas",
  "fetchWaba",
  "listPhoneNumbers",
  "fetchPhoneNumber",
  "listAssignedSystemUsers",
  "assignSystemUserToWaba",
  "listSubscribedApps",
  "subscribeAppToWaba",
  "registerPhoneNumber",
  "listMessageTemplates",
  "createManagedUtilityTemplate",
  "sendApprovedUtilityTemplate",
] as const satisfies readonly (keyof MetaWhatsAppProviderClient)[];

type MetaWhatsAppClientOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxReadAttempts?: number;
  maxPages?: number;
  maxItems?: number;
  maxTemplateComponentBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type GraphRequest = {
  url: URL;
  method: "GET" | "POST";
  accessToken?: string;
  body?: BodyInit;
  contentType?: string;
  mutation?: boolean;
};

type PageWithPaging = {
  data: unknown[];
  paging?: { next?: string };
};

function requiredEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum: number
) {
  const value = env[name]?.trim();
  if (!value) throw new WhatsAppConfigurationError(`${name} must be configured`);
  if (value.length > maximum) throw new WhatsAppConfigurationError(`${name} is invalid`);
  return value;
}

function requiredSecretEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum: number
) {
  const value = env[name];
  if (!value || !value.trim()) {
    throw new WhatsAppConfigurationError(`${name} must be configured`);
  }
  if (value.length > maximum || /[\r\n]/.test(value)) {
    throw new WhatsAppConfigurationError(`${name} is invalid`);
  }
  return value;
}

function configuredProviderId(
  env: Readonly<Record<string, string | undefined>>,
  name: string
) {
  const value = requiredEnvironmentValue(env, name, 64);
  if (!META_PROVIDER_ID_PATTERN.test(value)) {
    throw new WhatsAppConfigurationError(`${name} must be a valid Meta provider ID`);
  }
  return value;
}

export function readMetaWhatsAppConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env
): MetaWhatsAppConfiguration {
  const providerMode = resolveWhatsAppProviderMode(env);
  const graphApiVersion = requiredEnvironmentValue(env, "META_GRAPH_API_VERSION", 6);
  if (
    !META_GRAPH_VERSION_PATTERN.test(graphApiVersion)
    || graphApiVersion !== META_WHATSAPP_GRAPH_API_VERSION
  ) {
    throw new WhatsAppConfigurationError(
      `META_GRAPH_API_VERSION must be pinned to ${META_WHATSAPP_GRAPH_API_VERSION}`
    );
  }

  return {
    providerMode,
    graphApiVersion,
    appId: configuredProviderId(env, "META_APP_ID"),
    appSecret: requiredSecretEnvironmentValue(env, "META_APP_SECRET", 1_024),
    embeddedSignupConfigId: configuredProviderId(env, "META_EMBEDDED_SIGNUP_CONFIG_ID"),
    businessId: configuredProviderId(env, "META_BUSINESS_ID"),
    systemUserId: configuredProviderId(env, "META_SYSTEM_USER_ID"),
    systemUserAccessToken: requiredSecretEnvironmentValue(
      env,
      "META_SYSTEM_USER_ACCESS_TOKEN",
      META_GRAPH_MAX_TOKEN_LENGTH
    ),
    webhookVerifyToken: requiredSecretEnvironmentValue(
      env,
      "META_WHATSAPP_WEBHOOK_VERIFY_TOKEN",
      512
    ),
  };
}

export function parseMetaProviderId(value: string, label = "Meta provider ID") {
  const normalized = value.trim();
  if (!META_PROVIDER_ID_PATTERN.test(normalized)) {
    throw new MetaWhatsAppInputError(`${label} is invalid`);
  }
  return normalized;
}

function boundedSecret(value: string, label: string) {
  if (!value || value.length > META_GRAPH_MAX_TOKEN_LENGTH) {
    throw new MetaWhatsAppInputError(`${label} is invalid`);
  }
  return value;
}

function normalizedMessageRecipient(value: string) {
  const normalized = value.trim();
  if (!META_E164_PATTERN.test(normalized)) {
    throw new MetaWhatsAppInputError("WhatsApp recipient must be a valid E.164 number");
  }
  return normalized.slice(1);
}

function normalizedCorrelationId(value: string) {
  const normalized = value.trim();
  if (
    normalized.length > META_GRAPH_MAX_CORRELATION_ID_LENGTH
    || !META_CORRELATION_ID_PATTERN.test(normalized)
  ) {
    throw new MetaWhatsAppInputError("WhatsApp message correlation ID is invalid");
  }
  return normalized;
}

function normalizedCode(value: string) {
  const code = value.trim();
  if (!code || code.length > 4_096 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new MetaWhatsAppInputError("Embedded Signup authorization code is invalid");
  }
  return code;
}

function normalizeWaba(input: z.infer<typeof wabaSchema>): MetaWaba {
  return {
    id: input.id,
    name: input.name ?? null,
    currency: input.currency ?? null,
    timezoneId: input.timezone_id == null ? null : String(input.timezone_id),
    accountMode: input.account_mode ?? null,
  };
}

function normalizePhoneNumber(
  input: z.infer<typeof phoneNumberSchema>,
  wabaId: string
): MetaPhoneNumber {
  return {
    id: input.id,
    wabaId,
    displayPhoneNumber: input.display_phone_number,
    verifiedName: input.verified_name ?? null,
    qualityRating: input.quality_rating ?? null,
    codeVerificationStatus: input.code_verification_status ?? null,
    platformType: input.platform_type ?? null,
    status: input.status ?? null,
    registrationStatus: input.status ?? input.code_verification_status ?? null,
  };
}

function epochSecondsToDate(value: number | undefined) {
  if (value === undefined) return null;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeRequestId(response: Response, traceId?: string) {
  const header = response.headers.get("x-fb-request-id")?.trim();
  const candidate = header || traceId?.trim();
  return candidate
    && candidate.length <= META_GRAPH_MAX_ERROR_REQUEST_ID_LENGTH
    && /^[A-Za-z0-9._:-]+$/.test(candidate)
    ? candidate
    : null;
}

const META_RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);

function providerErrorKind(
  status: number,
  providerCode: number | null
): MetaWhatsAppProviderErrorKind {
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 404) return "NOT_FOUND";
  if (status === 429 || providerCode !== null && META_RATE_LIMIT_CODES.has(providerCode)) {
    return "RATE_LIMIT";
  }
  if (status >= 500) return "PROVIDER";
  return "REQUEST";
}

function safeRetryAfterSeconds(response: Response) {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw || !/^[0-9]{1,6}$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400
    ? seconds
    : null;
}

function providerErrorMessage(kind: MetaWhatsAppProviderErrorKind) {
  if (kind === "AUTHENTICATION") return "Meta authorization failed";
  if (kind === "NOT_FOUND") return "Meta resource was not found";
  if (kind === "RATE_LIMIT") return "Meta request rate limit was reached";
  if (kind === "NETWORK") return "Meta could not be reached";
  if (kind === "TIMEOUT") return "Meta did not respond in time";
  if (kind === "INVALID_RESPONSE") return "Meta returned an invalid response";
  if (kind === "BOUNDS") return "Meta response exceeded a safety limit";
  if (kind === "PROVIDER") return "Meta is temporarily unavailable";
  return "Meta rejected the request";
}

function isRetryableReadError(error: unknown) {
  return error instanceof MetaWhatsAppProviderError
    && ["NETWORK", "TIMEOUT", "RATE_LIMIT", "PROVIDER"].includes(error.kind);
}

function couldMutationHaveCommitted(error: unknown) {
  return error instanceof MetaWhatsAppProviderError
    && ["NETWORK", "TIMEOUT", "PROVIDER", "INVALID_RESPONSE", "BOUNDS"].includes(error.kind);
}

async function readBoundedResponse(response: Response, maximumBytes: number) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new MetaWhatsAppProviderError(providerErrorMessage("BOUNDS"), {
      kind: "BOUNDS",
      status: response.status,
      requestId: safeRequestId(response),
    });
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MetaWhatsAppProviderError(providerErrorMessage("BOUNDS"), {
          kind: "BOUNDS",
          status: response.status,
          requestId: safeRequestId(response),
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function normalizePaginationUrl(raw: string, expectedPath: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
      kind: "INVALID_RESPONSE",
    });
  }

  if (
    raw.length > META_GRAPH_MAX_URL_LENGTH
    || parsed.origin !== META_GRAPH_ORIGIN
    || parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.pathname !== expectedPath
  ) {
    throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
      kind: "INVALID_RESPONSE",
    });
  }

  if ([...parsed.searchParams].length > 20) {
    throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
      kind: "INVALID_RESPONSE",
    });
  }
  for (const [key, value] of parsed.searchParams) {
    if (key.length > 128 || value.length > 2_048) {
      throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
        kind: "INVALID_RESPONSE",
      });
    }
  }

  // Meta pagination links can echo a token. Authentication stays in the
  // Authorization header, so discard any credential-like query parameter.
  parsed.searchParams.delete("access_token");
  parsed.searchParams.delete("appsecret_proof");
  return parsed;
}

class DefaultMetaWhatsAppClient implements MetaWhatsAppProviderClient {
  private readonly configuration: MetaWhatsAppConfiguration;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxReadAttempts: number;
  private readonly maxPages: number;
  private readonly maxItems: number;
  private readonly maxTemplateComponentBytes: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: MetaWhatsAppClientOptions) {
    this.configuration = readMetaWhatsAppConfiguration(options.env ?? process.env);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? META_GRAPH_DEFAULT_TIMEOUT_MS,
      1,
      META_GRAPH_MAX_TIMEOUT_MS,
      "Meta request timeout"
    );
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? META_GRAPH_MAX_RESPONSE_BYTES,
      1,
      4 * 1024 * 1024,
      "Meta response size"
    );
    this.maxReadAttempts = boundedInteger(
      options.maxReadAttempts ?? META_GRAPH_MAX_READ_ATTEMPTS,
      1,
      META_GRAPH_MAX_READ_ATTEMPTS,
      "Meta read attempts"
    );
    this.maxPages = boundedInteger(
      options.maxPages ?? META_GRAPH_MAX_PAGES,
      1,
      META_GRAPH_MAX_PAGES,
      "Meta page limit"
    );
    this.maxItems = boundedInteger(
      options.maxItems ?? META_GRAPH_MAX_ITEMS,
      1,
      META_GRAPH_MAX_ITEMS,
      "Meta item limit"
    );
    this.maxTemplateComponentBytes = boundedInteger(
      options.maxTemplateComponentBytes ?? META_GRAPH_MAX_COMPONENT_BYTES,
      1,
      META_GRAPH_MAX_COMPONENT_BYTES,
      "Meta template component size"
    );
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));

    if (typeof this.fetchImplementation !== "function") {
      throw new WhatsAppConfigurationError("A server-side fetch implementation is required for Meta");
    }
  }

  async exchangeEmbeddedSignupCode(input: { code: string }): Promise<MetaAccessTokenExchange> {
    const response = await this.request({
      url: this.graphUrl("oauth", "access_token"),
      method: "POST",
      body: new URLSearchParams({
        client_id: this.configuration.appId,
        client_secret: this.configuration.appSecret,
        code: normalizedCode(input.code),
      }),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      mutation: true,
    }, accessTokenResponseSchema);
    return {
      accessToken: response.access_token,
      tokenType: response.token_type ?? null,
      expiresInSeconds: response.expires_in ?? null,
    };
  }

  async debugAccessToken(input: { accessToken: string }): Promise<MetaDebugToken> {
    const accessToken = boundedSecret(input.accessToken, "Meta access token");
    const url = this.graphUrl("debug_token");
    url.searchParams.set("input_token", accessToken);
    const response = await this.request({
      url,
      method: "GET",
      accessToken: `${this.configuration.appId}|${this.configuration.appSecret}`,
    }, debugTokenResponseSchema);
    return {
      appId: response.data.app_id,
      isValid: response.data.is_valid,
      expiresAt: epochSecondsToDate(response.data.expires_at),
      scopes: [...(response.data.scopes ?? [])],
      granularScopes: (response.data.granular_scopes ?? []).map(scope => ({
        scope: scope.scope,
        targetIds: [...(scope.target_ids ?? [])],
      })),
    };
  }

  listOrResolveSharedWabas(input: { businessId: string; accessToken: string }) {
    const businessId = parseMetaProviderId(input.businessId, "Meta business ID");
    return this.collectPages({
      initialUrl: this.graphUrl(businessId, "client_whatsapp_business_accounts", {
        fields: "id,name,currency,timezone_id,account_mode",
        limit: String(META_GRAPH_MAX_PAGE_ITEMS),
      }),
      accessToken: boundedSecret(input.accessToken, "Meta access token"),
      schema: wabaPageSchema,
      normalize: normalizeWaba,
    });
  }

  async fetchWaba(input: { wabaId: string; accessToken: string }): Promise<MetaWaba> {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    const response = await this.request({
      url: this.graphUrl(wabaId, undefined, {
        fields: "id,name,currency,timezone_id,account_mode",
      }),
      method: "GET",
      accessToken: boundedSecret(input.accessToken, "Meta access token"),
    }, wabaSchema);
    return normalizeWaba(response);
  }

  listPhoneNumbers(input: { wabaId: string; accessToken: string }) {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    return this.collectPages({
      initialUrl: this.graphUrl(wabaId, "phone_numbers", {
        fields: "id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status",
        limit: String(META_GRAPH_MAX_PAGE_ITEMS),
      }),
      accessToken: boundedSecret(input.accessToken, "Meta access token"),
      schema: phoneNumberPageSchema,
      normalize: phone => normalizePhoneNumber(phone, wabaId),
    });
  }

  async fetchPhoneNumber(input: {
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
  }): Promise<MetaPhoneNumber> {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    const phoneNumberId = parseMetaProviderId(input.phoneNumberId, "Meta phone-number ID");
    const response = await this.request({
      url: this.graphUrl(phoneNumberId, undefined, {
        fields: "id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status",
      }),
      method: "GET",
      accessToken: boundedSecret(input.accessToken, "Meta access token"),
    }, phoneNumberSchema);
    return normalizePhoneNumber(response, wabaId);
  }

  listAssignedSystemUsers(input: { wabaId: string }) {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    return this.collectPages({
      initialUrl: this.graphUrl(wabaId, "assigned_users", {
        business: this.configuration.businessId,
        fields: "id,name,tasks",
        limit: String(META_GRAPH_MAX_PAGE_ITEMS),
      }),
      accessToken: this.configuration.systemUserAccessToken,
      schema: assignedSystemUserPageSchema,
      normalize: user => ({
        id: user.id,
        name: user.name ?? null,
        tasks: [...(user.tasks ?? [])],
      }),
    });
  }

  async assignSystemUserToWaba(input: { wabaId: string }) {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    const response = await this.request({
      url: this.graphUrl(wabaId, "assigned_users"),
      method: "POST",
      accessToken: this.configuration.systemUserAccessToken,
      body: new URLSearchParams({
        user: this.configuration.systemUserId,
        tasks: JSON.stringify(["MANAGE"]),
      }),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      mutation: true,
    }, successResponseSchema);
    return { success: response.success };
  }

  listSubscribedApps(input: { wabaId: string }) {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    return this.collectPages({
      initialUrl: this.graphUrl(wabaId, "subscribed_apps", {
        limit: String(META_GRAPH_MAX_PAGE_ITEMS),
      }),
      accessToken: this.configuration.systemUserAccessToken,
      schema: subscribedAppPageSchema,
      normalize: app => ({
        id: app.id ?? app.whatsapp_business_api_data!.id,
        name: app.name ?? app.whatsapp_business_api_data?.name ?? null,
      }),
    });
  }

  async subscribeAppToWaba(input: { wabaId: string }) {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    const response = await this.request({
      url: this.graphUrl(wabaId, "subscribed_apps"),
      method: "POST",
      accessToken: this.configuration.systemUserAccessToken,
      mutation: true,
    }, successResponseSchema);
    return { success: response.success };
  }

  async registerPhoneNumber(input: { phoneNumberId: string; pin: string }) {
    const phoneNumberId = parseMetaProviderId(input.phoneNumberId, "Meta phone-number ID");
    if (!/^[0-9]{6}$/.test(input.pin)) {
      throw new MetaWhatsAppInputError("Meta registration PIN must contain exactly six ASCII digits");
    }
    const response = await this.request({
      url: this.graphUrl(phoneNumberId, "register"),
      method: "POST",
      accessToken: this.configuration.systemUserAccessToken,
      body: JSON.stringify({ messaging_product: "whatsapp", pin: input.pin }),
      contentType: "application/json",
      mutation: true,
    }, successResponseSchema);
    return { success: response.success };
  }

  listMessageTemplates(input: { wabaId: string }) {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    return this.collectPages({
      initialUrl: this.graphUrl(wabaId, "message_templates", {
        fields: "id,name,language,category,status,components",
        limit: String(META_GRAPH_MAX_PAGE_ITEMS),
      }),
      accessToken: this.configuration.systemUserAccessToken,
      schema: templatePageSchema,
      normalize: template => {
        const components = template.components ?? [];
        const componentBytes = Buffer.byteLength(JSON.stringify(components), "utf8");
        if (componentBytes > this.maxTemplateComponentBytes) {
          throw new MetaWhatsAppProviderError(providerErrorMessage("BOUNDS"), { kind: "BOUNDS" });
        }
        return {
          id: template.id,
          name: template.name,
          language: template.language,
          category: normalizeTemplateCategory(template.category),
          status: normalizeTemplateStatus(template.status),
          components,
        };
      },
    });
  }

  async createManagedUtilityTemplate(input: {
    wabaId: string;
    definition: WhatsAppManagedTemplateDefinition;
  }): Promise<MetaManagedUtilityTemplateCreateResult> {
    const wabaId = parseMetaProviderId(input.wabaId, "Meta WABA ID");
    const definition = resolveExactManagedWhatsAppTemplateDefinition(input.definition);
    const response = await this.request({
      url: this.graphUrl(wabaId, "message_templates"),
      method: "POST",
      accessToken: this.configuration.systemUserAccessToken,
      body: JSON.stringify({
        name: definition.providerTemplateName,
        language: definition.language,
        category: "UTILITY",
        parameter_format: "POSITIONAL",
        components: definition.components,
      }),
      contentType: "application/json",
      mutation: true,
    }, managedTemplateCreateResponseSchema);
    return {
      providerTemplateId: response.id,
      providerStatus: normalizeTemplateStatus(response.status),
      category: normalizeTemplateCategory(response.category),
    };
  }

  async sendApprovedUtilityTemplate(input: {
    phoneNumberId: string;
    recipientPhoneE164: string;
    definition: WhatsAppManagedTemplateDefinition;
    values: Readonly<Record<string, unknown>>;
    correlationId: string;
  }): Promise<MetaApprovedUtilityTemplateSendResult> {
    const phoneNumberId = parseMetaProviderId(
      input.phoneNumberId,
      "Meta phone-number ID"
    );
    const prepared = prepareManagedWhatsAppTemplate(input.definition, input.values);
    const recipient = normalizedMessageRecipient(input.recipientPhoneE164);
    const correlationId = normalizedCorrelationId(input.correlationId);
    const response = await this.request({
      url: this.graphUrl(phoneNumberId, "messages"),
      method: "POST",
      accessToken: this.configuration.systemUserAccessToken,
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: {
          name: prepared.definition.providerTemplateName,
          language: { code: prepared.definition.language },
          components: [
            {
              type: "body",
              parameters: prepared.orderedValues.map(value => ({ type: "text", text: value })),
            },
            {
              type: "button",
              sub_type: "quick_reply",
              index: "0",
              parameters: [{ type: "payload", payload: WHATSAPP_MANAGED_STOP_PAYLOAD }],
            },
          ],
        },
        biz_opaque_callback_data: correlationId,
      }),
      contentType: "application/json",
      mutation: true,
    }, sendTemplateResponseSchema);
    const submissionStatus = response.messages[0].message_status;
    return {
      providerMessageId: response.messages[0].id,
      providerRecipientWaId: response.contacts?.[0]?.wa_id ?? null,
      submissionStatus: submissionStatus === "accepted"
        ? "ACCEPTED"
        : submissionStatus === "held_for_quality_assessment"
          ? "HELD_FOR_QUALITY_ASSESSMENT"
          : submissionStatus === "paused"
            ? "PAUSED"
            : null,
    };
  }

  private graphUrl(
    firstPathSegment: string,
    secondPathSegment?: string,
    query?: Readonly<Record<string, string>>
  ) {
    const segments = [this.configuration.graphApiVersion, firstPathSegment, secondPathSegment]
      .filter((segment): segment is string => Boolean(segment))
      .map(segment => encodeURIComponent(segment));
    const url = new URL(`/${segments.join("/")}`, META_GRAPH_ORIGIN);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url;
  }

  private async collectPages<TRaw, TOutput>(input: {
    initialUrl: URL;
    accessToken: string;
    schema: z.ZodType<{ data: TRaw[]; paging?: { next?: string } }>;
    normalize: (item: TRaw) => TOutput;
  }) {
    const expectedPath = input.initialUrl.pathname;
    const seenUrls = new Set<string>();
    const collected: TOutput[] = [];
    let nextUrl: URL | null = input.initialUrl;

    for (let page = 0; page < this.maxPages && nextUrl; page += 1) {
      const serializedUrl = nextUrl.toString();
      if (seenUrls.has(serializedUrl)) {
        throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
          kind: "INVALID_RESPONSE",
        });
      }
      seenUrls.add(serializedUrl);

      const response: PageWithPaging = await this.request({
        url: nextUrl,
        method: "GET",
        accessToken: input.accessToken,
      }, input.schema);
      for (const raw of response.data as TRaw[]) {
        collected.push(input.normalize(raw));
        if (collected.length > this.maxItems) {
          throw new MetaWhatsAppProviderError(providerErrorMessage("BOUNDS"), { kind: "BOUNDS" });
        }
      }

      const rawNext = response.paging?.next;
      if (!rawNext) return collected;
      if (page + 1 >= this.maxPages) {
        throw new MetaWhatsAppProviderError(providerErrorMessage("BOUNDS"), { kind: "BOUNDS" });
      }
      nextUrl = normalizePaginationUrl(rawNext, expectedPath);
    }

    return collected;
  }

  private async request<T>(request: GraphRequest, schema: z.ZodType<T>): Promise<T> {
    const attempts = request.mutation ? 1 : this.maxReadAttempts;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.requestOnce(request, schema);
      } catch (error) {
        if (request.mutation && couldMutationHaveCommitted(error)) {
          const providerError = error as MetaWhatsAppProviderError;
          throw new MetaWhatsAppAmbiguousMutationError({
            requestId: providerError.requestId,
            status: providerError.status,
          });
        }
        lastError = error;
        if (attempt >= attempts || !isRetryableReadError(error)) throw error;
        await this.sleep(Math.min(500, 100 * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  private async requestOnce<T>(request: GraphRequest, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(request.url, {
        method: request.method,
        headers: {
          Accept: "application/json",
          ...(request.accessToken ? { Authorization: `Bearer ${request.accessToken}` } : {}),
          ...(request.contentType ? { "Content-Type": request.contentType } : {}),
        },
        body: request.body,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted;
      clearTimeout(timeout);
      throw new MetaWhatsAppProviderError(
        providerErrorMessage(timedOut ? "TIMEOUT" : "NETWORK"),
        { kind: timedOut ? "TIMEOUT" : "NETWORK" }
      );
    }

    let raw: Buffer;
    try {
      raw = await readBoundedResponse(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof MetaWhatsAppProviderError) throw error;
      if (controller.signal.aborted) {
        throw new MetaWhatsAppProviderError(providerErrorMessage("TIMEOUT"), {
          kind: "TIMEOUT",
          status: response.status,
          requestId: safeRequestId(response),
        });
      }
      throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
        kind: "INVALID_RESPONSE",
        status: response.status,
        requestId: safeRequestId(response),
      });
    } finally {
      clearTimeout(timeout);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
        kind: "INVALID_RESPONSE",
        status: response.status,
        requestId: safeRequestId(response),
      });
    }

    if (!response.ok) {
      const parsedError = graphErrorSchema.safeParse(payload);
      const providerCode = parsedError.success ? parsedError.data.error.code ?? null : null;
      const kind = providerErrorKind(response.status, providerCode);
      throw new MetaWhatsAppProviderError(providerErrorMessage(kind), {
        kind,
        status: response.status,
        providerCode,
        providerSubcode: parsedError.success ? parsedError.data.error.error_subcode : null,
        requestId: safeRequestId(
          response,
          parsedError.success ? parsedError.data.error.fbtrace_id : undefined
        ),
        retryAfterSeconds: kind === "RATE_LIMIT" ? safeRetryAfterSeconds(response) : null,
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new MetaWhatsAppProviderError(providerErrorMessage("INVALID_RESPONSE"), {
        kind: "INVALID_RESPONSE",
        status: response.status,
        requestId: safeRequestId(response),
      });
    }
    return parsed.data;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WhatsAppConfigurationError(`${label} is invalid`);
  }
  return value;
}

function normalizeTemplateCategory(
  value: string
): MetaManagedUtilityTemplateCreateResult["category"] {
  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case "AUTHENTICATION":
    case "MARKETING":
    case "UTILITY":
      return normalized;
    default:
      return "UNKNOWN";
  }
}

function normalizeTemplateStatus(value: string) {
  const normalized = value.trim().toUpperCase();
  return ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"].includes(normalized)
    ? normalized
    : "UNKNOWN";
}

export function createMetaWhatsAppClient(
  options: MetaWhatsAppClientOptions = {}
): MetaWhatsAppProviderClient {
  const implementation = new DefaultMetaWhatsAppClient(options);
  return {
    exchangeEmbeddedSignupCode: input => implementation.exchangeEmbeddedSignupCode(input),
    debugAccessToken: input => implementation.debugAccessToken(input),
    listOrResolveSharedWabas: input => implementation.listOrResolveSharedWabas(input),
    fetchWaba: input => implementation.fetchWaba(input),
    listPhoneNumbers: input => implementation.listPhoneNumbers(input),
    fetchPhoneNumber: input => implementation.fetchPhoneNumber(input),
    listAssignedSystemUsers: input => implementation.listAssignedSystemUsers(input),
    assignSystemUserToWaba: input => implementation.assignSystemUserToWaba(input),
    listSubscribedApps: input => implementation.listSubscribedApps(input),
    subscribeAppToWaba: input => implementation.subscribeAppToWaba(input),
    registerPhoneNumber: input => implementation.registerPhoneNumber(input),
    listMessageTemplates: input => implementation.listMessageTemplates(input),
    createManagedUtilityTemplate: input => implementation.createManagedUtilityTemplate(input),
    sendApprovedUtilityTemplate: input => implementation.sendApprovedUtilityTemplate(input),
  };
}

let testClient: MetaWhatsAppProviderClient | null = null;

export function setMetaWhatsAppClientForTests(client: MetaWhatsAppProviderClient | null) {
  if (process.env.NODE_ENV !== "test" && client !== null) {
    throw new WhatsAppConfigurationError("Meta provider injection is available only in tests");
  }
  testClient = client;
}

export function getMetaWhatsAppClient(): MetaWhatsAppProviderClient {
  if (testClient) return testClient;
  if (process.env.NODE_ENV === "test") {
    throw new WhatsAppConfigurationError(
      "A fake Meta WhatsApp provider client must be injected during tests"
    );
  }
  return createMetaWhatsAppClient();
}
