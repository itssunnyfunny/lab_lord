import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMetaWhatsAppClient,
  getMetaWhatsAppClient,
  META_GRAPH_ORIGIN,
  META_WHATSAPP_PROVIDER_METHODS,
  MetaWhatsAppAmbiguousMutationError,
  MetaWhatsAppInputError,
  MetaWhatsAppProviderError,
  readMetaWhatsAppConfiguration,
  setMetaWhatsAppClientForTests,
  type MetaWhatsAppProviderClient,
} from "@/lib/metaWhatsApp";
import { WhatsAppConfigurationError } from "@/lib/whatsappFeature";

function readRuntimeSources(directory: string): string[] {
  const absoluteDirectory = resolve(process.cwd(), directory);
  if (!existsSync(absoluteDirectory)) return [];
  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .flatMap(entry => {
      const relativePath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return readRuntimeSources(relativePath);
      return /\.(?:ts|tsx)$/.test(entry.name)
        ? [readFileSync(resolve(process.cwd(), relativePath), "utf8")]
        : [];
    });
}

const testEnvironment = {
  NODE_ENV: "test",
  VERCEL_ENV: "preview",
  META_WHATSAPP_MODE: "TEST",
  META_GRAPH_API_VERSION: "v26.0",
  META_APP_ID: "10001",
  META_APP_SECRET: "app-secret-value",
  META_EMBEDDED_SIGNUP_CONFIG_ID: "20002",
  META_BUSINESS_ID: "30003",
  META_SYSTEM_USER_ID: "40004",
  META_SYSTEM_USER_ACCESS_TOKEN: "system-user-token",
  META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-token",
} as const;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function clientWithFetch(
  fetchImplementation: ReturnType<typeof vi.fn>,
  options: Partial<Parameters<typeof createMetaWhatsAppClient>[0]> = {}
) {
  return createMetaWhatsAppClient({
    env: testEnvironment,
    fetch: fetchImplementation as typeof fetch,
    sleep: async () => undefined,
    ...options,
  });
}

afterEach(() => {
  setMetaWhatsAppClientForTests(null);
  vi.restoreAllMocks();
});

describe("Meta WhatsApp provider configuration", () => {
  it("requires explicit mode, all server credentials, and a bounded pinned version", () => {
    expect(readMetaWhatsAppConfiguration(testEnvironment)).toEqual({
      providerMode: "TEST",
      graphApiVersion: "v26.0",
      appId: "10001",
      appSecret: "app-secret-value",
      embeddedSignupConfigId: "20002",
      businessId: "30003",
      systemUserId: "40004",
      systemUserAccessToken: "system-user-token",
      webhookVerifyToken: "verify-token",
    });

    expect(() => readMetaWhatsAppConfiguration({
      ...testEnvironment,
      META_GRAPH_API_VERSION: "latest",
    })).toThrow(WhatsAppConfigurationError);
    expect(() => readMetaWhatsAppConfiguration({
      ...testEnvironment,
      META_APP_SECRET: "",
    })).toThrow("META_APP_SECRET must be configured");
    expect(() => readMetaWhatsAppConfiguration({
      ...testEnvironment,
      VERCEL_ENV: "production",
    })).toThrow("Vercel Production requires META_WHATSAPP_MODE=LIVE");
  });

  it("exposes only the narrow onboarding and synchronization facade", () => {
    const client = clientWithFetch(vi.fn());

    expect(Object.keys(client).sort()).toEqual([...META_WHATSAPP_PROVIDER_METHODS].sort());
  });

  it("contains no hidden message-delivery or credit-sharing capability", () => {
    const source = readFileSync(resolve(process.cwd(), "lib/metaWhatsApp.ts"), "utf8");
    const runtimeSource = [
      source,
      ...readRuntimeSources("services").filter(item => /WhatsApp/i.test(item)),
      ...readRuntimeSources("app/api/organizations/[orgId]/whatsapp"),
      ...readRuntimeSources("app/api/whatsapp"),
      ...readRuntimeSources("components/whatsapp"),
    ].join("\n");
    const methods = META_WHATSAPP_PROVIDER_METHODS.join(" ");

    expect(methods).not.toMatch(
      /sendMessage|sendTemplate|sendWhatsApp|sendText|sendMedia|markMessageRead/i
    );
    expect(runtimeSource).not.toMatch(
      /sendMessage|sendTemplate|sendWhatsApp|sendText|sendMedia|markMessageRead|test[- ]send/i
    );
    expect(runtimeSource).not.toMatch(/["'`]\/messages(?:[?"'`/]|$)/);
    expect(runtimeSource).not.toMatch(
      /credit_line|extendedcredit|extended_credit|credit sharing|shareCredit/i
    );
    expect(runtimeSource).not.toMatch(
      /whatsAppMessage(?:Event)?\.(?:create|createMany|upsert|update|updateMany)\s*\(/i
    );
  });

  it("fails closed in tests when no fake provider was injected", () => {
    setMetaWhatsAppClientForTests(null);
    expect(() => getMetaWhatsAppClient()).toThrow(
      "A fake Meta WhatsApp provider client must be injected during tests"
    );
  });

  it("uses an injected fake through the test client setter", async () => {
    const fake = {
      exchangeEmbeddedSignupCode: vi.fn(async () => ({
        accessToken: "temporary",
        tokenType: null,
        expiresInSeconds: null,
      })),
    } as unknown as MetaWhatsAppProviderClient;
    setMetaWhatsAppClientForTests(fake);

    await expect(getMetaWhatsAppClient().exchangeEmbeddedSignupCode({ code: "one-time" }))
      .resolves.toMatchObject({ accessToken: "temporary" });
  });
});

describe("Meta WhatsApp HTTP safeguards", () => {
  it("posts the signup code and app secret in the body to the fixed versioned origin", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      access_token: "temporary-customer-token",
      token_type: "bearer",
      expires_in: 3_600,
      ignored: "provider fields are stripped",
    }));
    const client = clientWithFetch(fetchMock);

    await expect(client.exchangeEmbeddedSignupCode({ code: "one-time-code" })).resolves.toEqual({
      accessToken: "temporary-customer-token",
      tokenType: "bearer",
      expiresInSeconds: 3_600,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe(META_GRAPH_ORIGIN);
    expect(url.pathname).toBe("/v26.0/oauth/access_token");
    expect(url.search).toBe("");
    expect(String(init.body)).toContain("code=one-time-code");
    expect(String(init.body)).toContain("client_secret=app-secret-value");
    expect(init.redirect).toBe("error");
  });

  it("schema-validates successful responses and never exposes a raw provider error", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: {
        message: "raw-private-provider-message",
        code: 190,
        error_subcode: 463,
        fbtrace_id: "trace-safe",
      },
    }, { status: 401 }));
    const client = clientWithFetch(fetchMock, { maxReadAttempts: 1 });

    const error = await client.fetchWaba({
      wabaId: "50005",
      accessToken: "temporary-customer-token",
    }).catch(value => value);

    expect(error).toBeInstanceOf(MetaWhatsAppProviderError);
    expect(error).toMatchObject({
      kind: "AUTHENTICATION",
      status: 401,
      providerCode: 190,
      providerSubcode: 463,
      requestId: "trace-safe",
    });
    expect(error.message).toBe("Meta authorization failed");
    expect(JSON.stringify(error)).not.toContain("raw-private-provider-message");
  });

  it("rejects oversized response bytes before parsing", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(101), {
      status: 200,
      headers: { "Content-Length": "101" },
    }));
    const client = clientWithFetch(fetchMock, {
      maxReadAttempts: 1,
      maxResponseBytes: 100,
    });

    await expect(client.fetchWaba({ wabaId: "50005", accessToken: "temporary" }))
      .rejects.toMatchObject({ kind: "BOUNDS" });
  });

  it("rejects a successful response that does not match its operation schema", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: "not-a-provider-id",
      name: "Untrusted",
    }));
    const client = clientWithFetch(fetchMock, { maxReadAttempts: 1 });

    await expect(client.fetchWaba({ wabaId: "50005", accessToken: "temporary" }))
      .rejects.toMatchObject({ kind: "INVALID_RESPONSE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces the request timeout", async () => {
    const fetchMock = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const client = clientWithFetch(fetchMock, { timeoutMs: 1, maxReadAttempts: 1 });

    await expect(client.fetchWaba({ wabaId: "50005", accessToken: "temporary" }))
      .rejects.toMatchObject({ kind: "TIMEOUT" });
  });

  it("retries only bounded idempotent reads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 2 } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({
        id: "50005",
        name: "Customer WABA",
        currency: "INR",
        timezone_id: "Asia/Kolkata",
        account_mode: "LIVE",
      }));
    const client = clientWithFetch(fetchMock);

    await expect(client.fetchWaba({ wabaId: "50005", accessToken: "temporary" }))
      .resolves.toMatchObject({ id: "50005", name: "Customer WABA" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a provider mutation with an ambiguous outcome", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: 2 } }, { status: 503 }));
    const client = clientWithFetch(fetchMock);

    const error = await client.registerPhoneNumber({
      phoneNumberId: "60006",
      pin: "123456",
    }).catch(value => value);

    expect(error).toBeInstanceOf(MetaWhatsAppAmbiguousMutationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain("123456");
  });
});

describe("Meta WhatsApp normalized onboarding operations", () => {
  it("normalizes token debug scopes and expiry", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: {
        app_id: "10001",
        is_valid: true,
        expires_at: 1_800_000_000,
        scopes: ["business_management", "whatsapp_business_management"],
        granular_scopes: [{
          scope: "whatsapp_business_management",
          target_ids: ["50005"],
        }],
        ignored: "untrusted",
      },
    }));
    const client = clientWithFetch(fetchMock);

    await expect(client.debugAccessToken({ accessToken: "temporary-customer-token" }))
      .resolves.toEqual({
        appId: "10001",
        isValid: true,
        expiresAt: new Date(1_800_000_000 * 1_000),
        scopes: ["business_management", "whatsapp_business_management"],
        granularScopes: [{
          scope: "whatsapp_business_management",
          targetIds: ["50005"],
        }],
      });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v26.0/debug_token");
    expect(init.headers).toMatchObject({ Authorization: "Bearer 10001|app-secret-value" });
  });

  it("preserves an explicit zero token expiry as expired provider truth", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: { app_id: "10001", is_valid: true, expires_at: 0 },
    }));
    const client = clientWithFetch(fetchMock);

    await expect(client.debugAccessToken({ accessToken: "temporary-customer-token" }))
      .resolves.toMatchObject({ expiresAt: new Date(0) });
  });

  it("follows only same-origin, same-version, same-path pagination and strips echoed tokens", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: "70007",
          name: "approved_template",
          language: "en_US",
          category: "UTILITY",
          status: "APPROVED",
          components: [],
        }],
        paging: {
          next: "https://graph.facebook.com/v26.0/50005/message_templates?after=cursor-1&access_token=must-not-be-followed",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: "70008",
          name: "future_template",
          language: "hi",
          category: "FUTURE_CATEGORY",
          status: "FUTURE_STATUS",
          components: [{ type: "BODY", text: "Hello" }],
        }],
      }));
    const client = clientWithFetch(fetchMock);

    await expect(client.listMessageTemplates({ wabaId: "50005" })).resolves.toEqual([
      expect.objectContaining({ id: "70007", category: "UTILITY", status: "APPROVED" }),
      expect.objectContaining({ id: "70008", category: "UNKNOWN", status: "UNKNOWN" }),
    ]);
    const [secondUrl, secondInit] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(secondUrl.toString()).toBe(
      "https://graph.facebook.com/v26.0/50005/message_templates?after=cursor-1"
    );
    expect(secondInit.headers).toMatchObject({ Authorization: "Bearer system-user-token" });
  });

  it("rejects pagination that escapes the fixed Graph boundary", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [],
      paging: { next: "https://graph.facebook.com.evil.example/v26.0/50005/message_templates?after=x" },
    }));
    const client = clientWithFetch(fetchMock);

    await expect(client.listMessageTemplates({ wabaId: "50005" }))
      .rejects.toMatchObject({ kind: "INVALID_RESPONSE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails a pagination sequence that exceeds the explicit page bound", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: [],
      paging: { next: "https://graph.facebook.com/v26.0/50005/message_templates?after=x" },
    }));
    const client = clientWithFetch(fetchMock, { maxPages: 1 });

    await expect(client.listMessageTemplates({ wabaId: "50005" }))
      .rejects.toMatchObject({ kind: "BOUNDS" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces total-item and per-template component bounds", async () => {
    const twoTemplates = ["70007", "70008"].map(id => ({
      id,
      name: `template_${id}`,
      language: "en_US",
      category: "UTILITY",
      status: "APPROVED",
      components: [{ type: "BODY", text: "bounded text" }],
    }));
    const fetchMock = vi.fn(async () => jsonResponse({ data: twoTemplates }));

    await expect(clientWithFetch(fetchMock, { maxItems: 1 })
      .listMessageTemplates({ wabaId: "50005" }))
      .rejects.toMatchObject({ kind: "BOUNDS" });
    await expect(clientWithFetch(fetchMock, { maxTemplateComponentBytes: 4 })
      .listMessageTemplates({ wabaId: "50005" }))
      .rejects.toMatchObject({ kind: "BOUNDS" });
  });

  it("normalizes provider-authoritative phone registration readiness", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: "60006",
      display_phone_number: "+919876543210",
      verified_name: "Lab One",
      quality_rating: "GREEN",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      status: "CONNECTED",
    }));
    const client = clientWithFetch(fetchMock);

    await expect(client.fetchPhoneNumber({
      wabaId: "50005",
      phoneNumberId: "60006",
      accessToken: "temporary",
    })).resolves.toEqual({
      id: "60006",
      wabaId: "50005",
      displayPhoneNumber: "+919876543210",
      verifiedName: "Lab One",
      qualityRating: "GREEN",
      codeVerificationStatus: "VERIFIED",
      platformType: "CLOUD_API",
      status: "CONNECTED",
      registrationStatus: "CONNECTED",
    });
  });

  it("requires six ASCII digits and assigns only the minimum MANAGE task", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
    const client = clientWithFetch(fetchMock);

    await expect(client.registerPhoneNumber({ phoneNumberId: "60006", pin: "１２３４５６" }))
      .rejects.toBeInstanceOf(MetaWhatsAppInputError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.assignSystemUserToWaba({ wabaId: "50005" }))
      .resolves.toEqual({ success: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(init.body)).toContain("user=40004");
    expect(decodeURIComponent(String(init.body))).toContain('tasks=["MANAGE"]');
  });
});
