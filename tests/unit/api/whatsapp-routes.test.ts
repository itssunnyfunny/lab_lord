import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  assertOwner: vi.fn(),
  browserConfig: vi.fn(),
  createIntent: vi.fn(),
  complete: vi.fn(),
  rateLimitResponse: vi.fn(),
  verifyChallenge: vi.fn(),
  handleWebhook: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/whatsappAuthorization.service", () => ({
  WhatsAppAuthorizationService: {
    assertOwner: mocks.assertOwner,
  },
}));

vi.mock("@/services/whatsappConnection.service", () => ({
  WhatsAppConnectionService: {
    browserConfig: mocks.browserConfig,
    createIntent: mocks.createIntent,
    complete: mocks.complete,
  },
}));

vi.mock("@/lib/whatsappRoute", () => ({
  whatsAppRateLimitResponse: mocks.rateLimitResponse,
}));

vi.mock("@/services/whatsappWebhook.service", () => ({
  verifyMetaWebhookChallenge: mocks.verifyChallenge,
  WhatsAppWebhookService: {
    handle: mocks.handleWebhook,
  },
}));

const orgContext = { params: Promise.resolve({ orgId: "org_1" }) };
const completeContext = {
  params: Promise.resolve({ orgId: "org_1", intentId: "intent_1" }),
};

function sameOriginRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
      ...init.headers,
    },
  });
}

describe("WhatsApp organization route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WHATSAPP_INTEGRATION_ENABLED", "false");
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1" });
    mocks.assertOwner.mockResolvedValue({ id: "org_1" });
    mocks.rateLimitResponse.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the owner-scoped, secret-free disabled configuration without reading provider config", async () => {
    vi.stubEnv("META_APP_SECRET", "must-not-leak-app-secret");
    vi.stubEnv("META_SYSTEM_USER_ACCESS_TOKEN", "must-not-leak-system-token");
    vi.stubEnv("META_WHATSAPP_WEBHOOK_VERIFY_TOKEN", "must-not-leak-verify-token");
    const { GET } = await import("@/app/api/organizations/[orgId]/whatsapp/config/route");

    const response = await GET(
      new Request("https://app.example.test/api/organizations/org_1/whatsapp/config"),
      orgContext
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      enabled: false,
      providerMode: null,
      appId: null,
      embeddedSignupConfigId: null,
      graphApiVersion: null,
      connectionAvailability: "DISABLED",
      safeReason: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/must-not-leak|secret|accessToken|verifyToken/i);
    expect(mocks.assertOwner).toHaveBeenCalledWith("owner_1", "org_1");
    expect(mocks.browserConfig).not.toHaveBeenCalled();
  });

  it("authenticates both connection mutation handlers before origin or payload processing", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const [{ POST: createIntent }, { POST: completeIntent }] = await Promise.all([
      import("@/app/api/organizations/[orgId]/whatsapp/connection-intents/route"),
      import(
        "@/app/api/organizations/[orgId]/whatsapp/connection-intents/[intentId]/complete/route"
      ),
    ]);

    const createResponse = await createIntent(
      new Request("https://app.example.test/api/organizations/org_1/whatsapp/connection-intents", {
        method: "POST",
      }),
      orgContext
    );
    const completeResponse = await completeIntent(
      new Request(
        "https://app.example.test/api/organizations/org_1/whatsapp/connection-intents/intent_1/complete",
        { method: "POST" }
      ),
      completeContext
    );

    expect(createResponse.status).toBe(401);
    expect(completeResponse.status).toBe(401);
    expect(await createResponse.json()).toEqual({ error: "Unauthorized" });
    expect(await completeResponse.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("rejects cross-origin create and complete requests before calling the service", async () => {
    const [{ POST: createIntent }, { POST: completeIntent }] = await Promise.all([
      import("@/app/api/organizations/[orgId]/whatsapp/connection-intents/route"),
      import(
        "@/app/api/organizations/[orgId]/whatsapp/connection-intents/[intentId]/complete/route"
      ),
    ]);
    const headers = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };

    const createResponse = await createIntent(
      new Request("https://app.example.test/api/organizations/org_1/whatsapp/connection-intents", {
        method: "POST",
        headers,
      }),
      orgContext
    );
    const completeResponse = await completeIntent(
      new Request(
        "https://app.example.test/api/organizations/org_1/whatsapp/connection-intents/intent_1/complete",
        { method: "POST", headers, body: "{}" }
      ),
      completeContext
    );

    for (const response of [createResponse, completeResponse]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid WhatsApp request",
        code: "WHATSAPP_INVALID_REQUEST",
      });
    }
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("accepts an exact same-origin create request and forwards only the authenticated tenant", async () => {
    mocks.createIntent.mockResolvedValue({ intentId: "intent_1", state: "opaque-state" });
    const { POST } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/connection-intents/route"
    );

    const response = await POST(
      sameOriginRequest(
        "https://app.example.test/api/organizations/org_1/whatsapp/connection-intents",
        { method: "POST" }
      ),
      orgContext
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ intentId: "intent_1", state: "opaque-state" });
    expect(mocks.createIntent).toHaveBeenCalledWith("owner_1", "org_1");
  });

  it("rejects an over-limit completion body before parsing or provider work", async () => {
    const { POST } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/connection-intents/[intentId]/complete/route"
    );
    const response = await POST(
      sameOriginRequest(
        "https://app.example.test/api/organizations/org_1/whatsapp/connection-intents/intent_1/complete",
        {
          method: "POST",
          headers: { "content-length": String(16 * 1024 + 1) },
          body: "{}",
        }
      ),
      completeContext
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid WhatsApp request",
      code: "WHATSAPP_INVALID_REQUEST",
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("validates and forwards a bounded same-origin completion payload", async () => {
    mocks.complete.mockResolvedValue({ senderId: "sender_1", status: "READY_TO_REGISTER" });
    const { POST } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/connection-intents/[intentId]/complete/route"
    );
    const payload = {
      state: "opaque-state",
      code: "one-time-code",
      businessId: "10001",
      wabaId: "20002",
      phoneNumberId: "30003",
    };

    const response = await POST(
      sameOriginRequest(
        "https://app.example.test/api/organizations/org_1/whatsapp/connection-intents/intent_1/complete",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }
      ),
      completeContext
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true });
    expect(mocks.complete).toHaveBeenCalledWith({
      actorUserId: "owner_1",
      organizationId: "org_1",
      intentId: "intent_1",
      ...payload,
    });
  });
});

describe("public WhatsApp webhook route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the exact plain-text Meta challenge without invoking Clerk auth", async () => {
    mocks.verifyChallenge.mockReturnValue("challenge-123");
    const { GET } = await import("@/app/api/whatsapp/webhook/route");

    const response = await GET(new Request(
      "https://app.example.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=token&hub.challenge=challenge-123"
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("challenge-123");
    expect(mocks.verifyChallenge).toHaveBeenCalledWith({
      mode: "subscribe",
      token: "token",
      challenge: "challenge-123",
    });
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("returns only the generic accepted response for a webhook POST without Clerk auth", async () => {
    mocks.handleWebhook.mockResolvedValue({ accepted: true });
    const { POST } = await import("@/app/api/whatsapp/webhook/route");
    const request = new Request("https://app.example.test/api/whatsapp/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${"a".repeat(64)}` },
      body: '{"object":"whatsapp_business_account","entry":[]}',
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(mocks.handleWebhook).toHaveBeenCalledWith(request);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });
});
