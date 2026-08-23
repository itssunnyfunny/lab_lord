import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaDebugToken, MetaPhoneNumber, MetaWaba } from "@/types";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  activeLeaseFindFirst: vi.fn(),
  intentFindFirst: vi.fn(),
  intentUpdateMany: vi.fn(),
  intentCreate: vi.fn(),
  intentUpdate: vi.fn(),
  senderFindFirst: vi.fn(),
  senderFindUnique: vi.fn(),
  senderCreate: vi.fn(),
  senderUpdate: vi.fn(),
  auditCreate: vi.fn(),
  messageCreate: vi.fn(),
  assertOwner: vi.fn(),
  assertOwnerCanWrite: vi.fn(),
  getOrganizationProfile: vi.fn(),
  assertIntegrationEnabled: vi.fn(),
  assertOnboardingWritesEnabled: vi.fn(),
  assertWebhookIngestEnabled: vi.fn(),
  isWebhookIngestEnabled: vi.fn(),
  resolveProviderMode: vi.fn(),
  readMetaConfiguration: vi.fn(),
  getMetaClient: vi.fn(),
  exchangeEmbeddedSignupCode: vi.fn(),
  debugAccessToken: vi.fn(),
  listOrResolveSharedWabas: vi.fn(),
  fetchWaba: vi.fn(),
  listPhoneNumbers: vi.fn(),
  fetchPhoneNumber: vi.fn(),
  listAssignedSystemUsers: vi.fn(),
  assignSystemUserToWaba: vi.fn(),
  listSubscribedApps: vi.fn(),
  subscribeAppToWaba: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    whatsAppConnectionIntent: { findFirst: mocks.activeLeaseFindFirst },
    whatsAppMessage: { create: mocks.messageCreate },
  },
}));

vi.mock("@/services/whatsappAuthorization.service", () => ({
  WhatsAppAuthorizationService: {
    assertOwner: mocks.assertOwner,
    assertOwnerCanWrite: mocks.assertOwnerCanWrite,
  },
}));

vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    getOrganizationProfile: mocks.getOrganizationProfile,
  },
}));

vi.mock("@/lib/whatsappFeature", () => ({
  assertWhatsAppIntegrationEnabled: mocks.assertIntegrationEnabled,
  assertWhatsAppOnboardingWritesEnabled: mocks.assertOnboardingWritesEnabled,
  assertWhatsAppWebhookIngestEnabled: mocks.assertWebhookIngestEnabled,
  isWhatsAppWebhookIngestEnabled: mocks.isWebhookIngestEnabled,
  resolveWhatsAppProviderMode: mocks.resolveProviderMode,
}));

vi.mock("@/lib/metaWhatsApp", () => ({
  getMetaWhatsAppClient: mocks.getMetaClient,
  readMetaWhatsAppConfiguration: mocks.readMetaConfiguration,
}));

import {
  assertWhatsAppProviderModeMatches,
  assertWhatsAppTokenAuthorization,
  WhatsAppConnectionService,
} from "@/services/whatsappConnection.service";
import {
  WhatsAppConflictError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";

const ACTOR_ID = "user_1";
const ORGANIZATION_ID = "org_1";
const INTENT_ID = "intent_1";
const VALID_STATE = Buffer.alloc(32, 7).toString("base64url");
const AUTHORIZATION_CODE = "temporary-embedded-signup-code";
const TEMPORARY_ACCESS_TOKEN = "temporary-provider-access-token";
const RAW_BROWSER_SESSION = "raw-browser-session-secret";

const WABA: MetaWaba = {
  id: "50005",
  name: "Customer WABA",
  currency: "INR",
  timezoneId: "Asia/Kolkata",
  accountMode: "SANDBOX",
};

const PHONE: MetaPhoneNumber = {
  id: "60006",
  wabaId: WABA.id,
  displayPhoneNumber: "+91 98765 43210",
  verifiedName: "Customer Study Hall",
  qualityRating: "GREEN",
  codeVerificationStatus: "VERIFIED",
  platformType: "CLOUD_API",
  status: "CONNECTED",
  registrationStatus: "REGISTERED",
};

const COMPLETE_INPUT = {
  actorUserId: ACTOR_ID,
  organizationId: ORGANIZATION_ID,
  intentId: INTENT_ID,
  state: VALID_STATE,
  code: AUTHORIZATION_CODE,
  businessId: "30003",
  wabaId: WABA.id,
  phoneNumberId: PHONE.id,
};

const provider = {
  exchangeEmbeddedSignupCode: mocks.exchangeEmbeddedSignupCode,
  debugAccessToken: mocks.debugAccessToken,
  listOrResolveSharedWabas: mocks.listOrResolveSharedWabas,
  fetchWaba: mocks.fetchWaba,
  listPhoneNumbers: mocks.listPhoneNumbers,
  fetchPhoneNumber: mocks.fetchPhoneNumber,
  listAssignedSystemUsers: mocks.listAssignedSystemUsers,
  assignSystemUserToWaba: mocks.assignSystemUserToWaba,
  listSubscribedApps: mocks.listSubscribedApps,
  subscribeAppToWaba: mocks.subscribeAppToWaba,
};

const tx = {
  whatsAppConnectionIntent: {
    findFirst: mocks.intentFindFirst,
    updateMany: mocks.intentUpdateMany,
    create: mocks.intentCreate,
    update: mocks.intentUpdate,
  },
  whatsAppSender: {
    findFirst: mocks.senderFindFirst,
    findUnique: mocks.senderFindUnique,
    create: mocks.senderCreate,
    update: mocks.senderUpdate,
  },
  whatsAppAuditEvent: { create: mocks.auditCreate },
  whatsAppMessage: { create: mocks.messageCreate },
};

function stateHash(state = VALID_STATE) {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function connectionIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    providerMode: "TEST",
    stateHash: stateHash(),
    status: "CREATED",
    leaseToken: null,
    leaseUntil: null,
    attemptCount: 0,
    phoneNumberId: null,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    ...overrides,
  };
}

function debugToken(overrides: Partial<MetaDebugToken> = {}): MetaDebugToken {
  return {
    appId: "10001",
    isValid: true,
    expiresAt: new Date(Date.now() + 60_000),
    scopes: [],
    granularScopes: [
      { scope: "whatsapp_business_management", targetIds: [WABA.id] },
      { scope: "whatsapp_business_messaging", targetIds: [WABA.id] },
    ],
    ...overrides,
  };
}

function persistedCalls() {
  return JSON.stringify([
    ...mocks.intentUpdateMany.mock.calls,
    ...mocks.intentCreate.mock.calls,
    ...mocks.intentUpdate.mock.calls,
    ...mocks.senderCreate.mock.calls,
    ...mocks.senderUpdate.mock.calls,
    ...mocks.auditCreate.mock.calls,
    ...mocks.messageCreate.mock.calls,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.resolveProviderMode.mockReturnValue("TEST");
  mocks.isWebhookIngestEnabled.mockReturnValue(false);
  mocks.assertOwner.mockResolvedValue({ id: ORGANIZATION_ID });
  mocks.assertOwnerCanWrite.mockResolvedValue({ id: ORGANIZATION_ID });
  mocks.getOrganizationProfile.mockResolvedValue({
    entitlements: ["WHATSAPP_AUTOMATION"],
  });
  mocks.readMetaConfiguration.mockReturnValue({
    providerMode: "TEST",
    graphApiVersion: "v23.0",
    appId: "10001",
    embeddedSignupConfigId: "20002",
    businessId: "30003",
    systemUserId: "40004",
  });
  mocks.getMetaClient.mockReturnValue(provider);

  mocks.exchangeEmbeddedSignupCode.mockResolvedValue({
    accessToken: TEMPORARY_ACCESS_TOKEN,
  });
  mocks.debugAccessToken.mockResolvedValue(debugToken());
  mocks.listOrResolveSharedWabas.mockResolvedValue([WABA]);
  mocks.fetchWaba.mockResolvedValue(WABA);
  mocks.listPhoneNumbers.mockResolvedValue([PHONE]);
  mocks.fetchPhoneNumber.mockResolvedValue(PHONE);
  mocks.listAssignedSystemUsers.mockResolvedValue([
    { id: "40004", name: "Lab Lords", tasks: ["MANAGE"] },
  ]);
  mocks.listSubscribedApps.mockResolvedValue([
    { id: "10001", name: "Lab Lords" },
  ]);

  mocks.transaction.mockImplementation(async callback => callback(tx));
  mocks.intentFindFirst.mockImplementation(async input => (
    input.where?.status === "PROCESSING"
      ? { id: INTENT_ID }
      : connectionIntent()
  ));
  mocks.intentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.intentCreate.mockImplementation(async input => ({
    id: INTENT_ID,
    expiresAt: input.data.expiresAt,
  }));
  mocks.intentUpdate.mockResolvedValue({ id: INTENT_ID });
  mocks.senderFindFirst.mockResolvedValue(null);
  mocks.senderFindUnique.mockResolvedValue(null);
  mocks.senderCreate.mockResolvedValue({ id: "sender_new", status: "PENDING" });
  mocks.senderUpdate.mockResolvedValue({ id: "sender_existing", status: "PENDING" });
  mocks.auditCreate.mockResolvedValue({ id: "audit_1" });
  mocks.messageCreate.mockResolvedValue({ id: "message_1" });
});

describe("WhatsAppConnectionService intent acceptance", () => {
  it("returns 256-bit state, persists only its SHA-256 hash, and supersedes older intents", async () => {
    const result = await WhatsAppConnectionService.createIntent(
      ACTOR_ID,
      ORGANIZATION_ID
    );

    expect(Buffer.from(result.state, "base64url")).toHaveLength(32);
    const createData = mocks.intentCreate.mock.calls[0][0].data;
    expect(createData.stateHash).toBe(stateHash(result.state));
    expect(createData).not.toHaveProperty("state");
    expect(persistedCalls()).not.toContain(result.state);

    expect(mocks.intentUpdateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        status: { in: ["CREATED", "PROCESSING", "FAILED"] },
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: "SUPERSEDED",
      }),
    });
    expect(mocks.assertOwnerCanWrite).toHaveBeenCalledTimes(2);
    expect(mocks.assertOwnerCanWrite).toHaveBeenNthCalledWith(
      2,
      ACTOR_ID,
      ORGANIZATION_ID,
      tx
    );
    expect(mocks.assertOnboardingWritesEnabled).toHaveBeenCalledTimes(2);
    expect(mocks.resolveProviderMode).toHaveBeenCalledTimes(2);
  });

  it("rejects a wrong actor or state with the same safe not-found error before provider work", async () => {
    mocks.assertOwnerCanWrite.mockImplementation(async actorUserId => {
      if (actorUserId !== ACTOR_ID) throw new WhatsAppResourceNotFoundError();
      return { id: ORGANIZATION_ID };
    });

    await expect(WhatsAppConnectionService.complete({
      ...COMPLETE_INPUT,
      actorUserId: "user_2",
    })).rejects.toBeInstanceOf(WhatsAppResourceNotFoundError);

    mocks.assertOwnerCanWrite.mockResolvedValue({ id: ORGANIZATION_ID });
    mocks.intentFindFirst.mockResolvedValueOnce(null);
    await expect(WhatsAppConnectionService.complete({
      ...COMPLETE_INPUT,
      state: "wrong-state",
    })).rejects.toBeInstanceOf(WhatsAppResourceNotFoundError);

    expect(mocks.intentFindFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        actorUserId: ACTOR_ID,
        stateHash: stateHash("wrong-state"),
      }),
    });
    expect(mocks.exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
    expect(mocks.senderCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("expires a stale intent without making a provider call", async () => {
    mocks.intentFindFirst.mockResolvedValueOnce(connectionIntent({
      expiresAt: new Date(Date.now() - 1_000),
    }));

    await expect(WhatsAppConnectionService.complete(COMPLETE_INPUT)).rejects.toBeInstanceOf(
      WhatsAppValidationError
    );

    expect(mocks.intentUpdate).toHaveBeenCalledWith({
      where: { id: INTENT_ID },
      data: { status: "EXPIRED", leaseToken: null, leaseUntil: null },
    });
    expect(mocks.exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("rejects an actively leased intent without making a provider call", async () => {
    mocks.intentFindFirst.mockResolvedValueOnce(connectionIntent({
      status: "PROCESSING",
      leaseToken: "another-worker",
      leaseUntil: new Date(Date.now() + 60_000),
    }));

    await expect(WhatsAppConnectionService.complete(COMPLETE_INPUT)).rejects.toBeInstanceOf(
      WhatsAppConflictError
    );

    expect(mocks.intentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("returns a completed replay without repeating provider or persistence work", async () => {
    mocks.intentFindFirst.mockResolvedValueOnce(connectionIntent({
      status: "COMPLETED",
      phoneNumberId: PHONE.id,
    }));
    mocks.senderFindFirst.mockResolvedValueOnce({
      id: "sender_existing",
      status: "ACTIVE",
    });

    await expect(WhatsAppConnectionService.complete(COMPLETE_INPUT)).resolves.toEqual({
      senderId: "sender_existing",
      status: "ACTIVE",
      replay: true,
    });

    expect(mocks.getMetaClient).not.toHaveBeenCalled();
    expect(mocks.exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
    expect(mocks.intentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.intentUpdate).not.toHaveBeenCalled();
    expect(mocks.senderCreate).not.toHaveBeenCalled();
    expect(mocks.senderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });
});

describe("WhatsAppConnectionService provider acceptance", () => {
  it.each([
    ["a WABA absent from the provider-authorized set", () => {
      mocks.listOrResolveSharedWabas.mockResolvedValueOnce([
        { ...WABA, id: "99991" },
      ]);
    }],
    ["a phone whose authoritative WABA differs", () => {
      mocks.fetchPhoneNumber.mockResolvedValueOnce({
        ...PHONE,
        wabaId: "99992",
      });
    }],
  ])("rejects %s without persisting a sender", async (_label, arrange) => {
    arrange();

    await expect(WhatsAppConnectionService.complete(COMPLETE_INPUT)).rejects.toBeInstanceOf(
      WhatsAppValidationError
    );

    expect(mocks.senderCreate).not.toHaveBeenCalled();
    expect(mocks.senderUpdate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("reconciles a provider-verified phone into its existing same-organization sender", async () => {
    const connectedAt = new Date("2026-08-01T00:00:00.000Z");
    mocks.senderFindUnique.mockResolvedValueOnce({
      id: "sender_existing",
      organizationId: ORGANIZATION_ID,
      connectedAt,
      phoneRegisteredAt: connectedAt,
      webhookSubscribedAt: null,
    });

    const runtimeInput = {
      ...COMPLETE_INPUT,
      session: RAW_BROWSER_SESSION,
    };
    await expect(WhatsAppConnectionService.complete(runtimeInput)).resolves.toMatchObject({
      senderId: "sender_existing",
      replay: false,
    });

    expect(mocks.fetchWaba).toHaveBeenCalledWith({
      wabaId: WABA.id,
      accessToken: TEMPORARY_ACCESS_TOKEN,
    });
    expect(mocks.fetchPhoneNumber).toHaveBeenCalledWith({
      wabaId: WABA.id,
      phoneNumberId: PHONE.id,
      accessToken: TEMPORARY_ACCESS_TOKEN,
    });
    expect(mocks.senderUpdate).toHaveBeenCalledWith({
      where: { id: "sender_existing" },
      data: expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        wabaId: WABA.id,
        phoneNumberId: PHONE.id,
        connectedAt,
      }),
    });
    expect(mocks.senderCreate).not.toHaveBeenCalled();

    const transcript = persistedCalls();
    expect(transcript).not.toContain(VALID_STATE);
    expect(transcript).not.toContain(AUTHORIZATION_CODE);
    expect(transcript).not.toContain(TEMPORARY_ACCESS_TOKEN);
    expect(transcript).not.toContain(RAW_BROWSER_SESSION);
    expect(transcript).not.toMatch(/"(?:code|accessToken|session)":/);
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(mocks.assertOwnerCanWrite).toHaveBeenCalledTimes(3);
    expect(mocks.assertOwnerCanWrite).toHaveBeenLastCalledWith(
      ACTOR_ID,
      ORGANIZATION_ID,
      tx
    );
  });

  it("rejects a phone identity already owned by another organization", async () => {
    mocks.senderFindUnique.mockResolvedValueOnce({
      id: "sender_foreign",
      organizationId: "org_2",
      connectedAt: new Date("2026-08-01T00:00:00.000Z"),
      phoneRegisteredAt: null,
      webhookSubscribedAt: null,
    });

    await expect(WhatsAppConnectionService.complete(COMPLETE_INPUT)).rejects.toBeInstanceOf(
      WhatsAppConflictError
    );

    expect(mocks.senderCreate).not.toHaveBeenCalled();
    expect(mocks.senderUpdate).not.toHaveBeenCalled();
    expect(mocks.intentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "FAILED",
        lastErrorCode: "PROVIDER_IDENTITY_CONFLICT",
      }),
    }));
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });
});

describe("provider-authoritative WhatsApp connection checks", () => {
  it("requires nonempty granular targets to prove selected WABA access", () => {
    expect(() => assertWhatsAppTokenAuthorization(
      debugToken({
        granularScopes: [
          { scope: "whatsapp_business_management", targetIds: [] },
          { scope: "whatsapp_business_messaging", targetIds: [WABA.id] },
        ],
      }),
      "10001",
      WABA.id
    )).toThrow(WhatsAppValidationError);
  });

  it("accepts a genuinely top-level required scope without granular targets", () => {
    expect(() => assertWhatsAppTokenAuthorization(
      debugToken({
        scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
        granularScopes: [],
      }),
      "10001",
      WABA.id
    )).not.toThrow();
  });

  it("requires a valid future expiry from the expected app", () => {
    expect(() => assertWhatsAppTokenAuthorization(
      debugToken({ expiresAt: null }),
      "10001",
      WABA.id
    )).toThrow(WhatsAppValidationError);
    expect(() => assertWhatsAppTokenAuthorization(
      debugToken({ appId: "99999" }),
      "10001",
      WABA.id
    )).toThrow(WhatsAppValidationError);
  });

  it("maps SANDBOX to Test and rejects Live or unknown modes", () => {
    expect(() => assertWhatsAppProviderModeMatches(WABA, "TEST")).not.toThrow();
    expect(() => assertWhatsAppProviderModeMatches(WABA, "LIVE")).toThrow(
      WhatsAppValidationError
    );
    expect(() => assertWhatsAppProviderModeMatches(
      { ...WABA, accountMode: "FUTURE_MODE" },
      "TEST"
    )).toThrow(WhatsAppValidationError);
  });
});
