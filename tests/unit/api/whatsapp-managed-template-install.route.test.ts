import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  install: vi.fn(),
  getStatus: vi.fn(),
  rateLimitResponse: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/whatsappRoute", () => ({
  whatsAppRateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/services/whatsappTemplateProvisioning.service", () => ({
  WhatsAppTemplateProvisioningService: {
    install: mocks.install,
    getStatus: mocks.getStatus,
  },
}));

const context = {
  params: Promise.resolve({ orgId: "org_1", senderId: "sender_1" }),
};

function request(body: unknown) {
  return new Request(
    "https://app.example.test/api/organizations/org_1/whatsapp/senders/sender_1/managed-templates/install",
    {
      method: "POST",
      headers: {
        origin: "https://app.example.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}

function getRequest() {
  return new Request(
    "https://app.example.test/api/organizations/org_1/whatsapp/senders/sender_1/managed-templates/install"
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: "owner_1" });
  mocks.rateLimitResponse.mockReturnValue(null);
  mocks.install.mockResolvedValue({ catalogVersion: 1, languages: [], templates: [] });
  mocks.getStatus.mockResolvedValue({ catalogVersion: 1, languages: [], templates: [] });
});

describe("managed WhatsApp template installation route", () => {
  it("authenticates the reloadable status read before resolving sender state", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const { GET } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/managed-templates/install/route"
    );

    const response = await GET(getRequest(), context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it("returns only the service-owned catalogue status projection without caching it", async () => {
    mocks.getStatus.mockResolvedValue({
      catalogVersion: 1,
      languages: ["en_IN"],
      templates: [{
        managedKey: "FEE_RENEWAL_POLITE",
        language: "en_IN",
        providerTemplateName: "lablords_fee_renewal_polite_en_in_v1",
        providerTemplateId: "provider_1",
        status: "READY",
        active: true,
        errorCode: null,
        providerCategory: "UTILITY",
        providerStatus: "APPROVED",
        lastSyncedAt: new Date("2026-08-23T10:00:00.000Z"),
      }],
    });
    const { GET } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/managed-templates/install/route"
    );

    const response = await GET(getRequest(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getStatus).toHaveBeenCalledWith({
      actorUserId: "owner_1",
      organizationId: "org_1",
      senderId: "sender_1",
    });
    expect(body.installation.templates[0]).toMatchObject({
      managedKey: "FEE_RENEWAL_POLITE",
      providerCategory: "UTILITY",
      providerStatus: "APPROVED",
      active: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/components|leaseToken|accessToken|systemUser/i);
  });

  it("authenticates before parsing or provisioning", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const { POST } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/managed-templates/install/route"
    );

    const response = await POST(request({ arbitrary: true }), context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("rejects provider names, categories, bodies, components, and duplicate languages", async () => {
    const { POST } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/managed-templates/install/route"
    );
    const unsafe = await POST(request({
      languages: ["en_IN"],
      catalogVersion: 1,
      templateName: "arbitrary",
      category: "MARKETING",
      components: [{ type: "BODY", text: "arbitrary" }],
    }), context);
    const duplicate = await POST(request({
      languages: ["hi", "hi"],
      catalogVersion: 1,
    }), context);

    for (const response of [unsafe, duplicate]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid WhatsApp request",
        code: "WHATSAPP_INVALID_REQUEST",
      });
    }
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("forwards only the authenticated owner scope and server-allowed catalogue selection", async () => {
    const { POST } = await import(
      "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/managed-templates/install/route"
    );

    const response = await POST(request({
      languages: ["en_IN", "hi"],
      catalogVersion: 1,
    }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      installation: { catalogVersion: 1, languages: [], templates: [] },
    });
    expect(mocks.install).toHaveBeenCalledWith({
      actorUserId: "owner_1",
      organizationId: "org_1",
      senderId: "sender_1",
      languages: ["en_IN", "hi"],
      catalogVersion: 1,
    });
  });
});
