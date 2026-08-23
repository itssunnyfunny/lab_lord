import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertIntegrationEnabled: vi.fn(),
  assertOnboardingWritesEnabled: vi.fn(),
  assertOwnerCanWrite: vi.fn(),
  listMessageTemplates: vi.fn(),
  resolveProviderMode: vi.fn(),
  senderFindFirst: vi.fn(),
  transaction: vi.fn(),
  txSenderFindFirst: vi.fn(),
  templateFindMany: vi.fn(),
  templateCreate: vi.fn(),
  templateUpdate: vi.fn(),
  templateUpdateMany: vi.fn(),
  senderUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    whatsAppSender: { findFirst: mocks.senderFindFirst },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/metaWhatsApp", () => ({
  getMetaWhatsAppClient: () => ({
    listMessageTemplates: mocks.listMessageTemplates,
  }),
}));

vi.mock("@/lib/whatsappFeature", () => ({
  assertWhatsAppIntegrationEnabled: mocks.assertIntegrationEnabled,
  assertWhatsAppOnboardingWritesEnabled: mocks.assertOnboardingWritesEnabled,
  resolveWhatsAppProviderMode: mocks.resolveProviderMode,
}));

vi.mock("@/services/whatsappAuthorization.service", () => ({
  WhatsAppAuthorizationService: {
    assertOwnerCanWrite: mocks.assertOwnerCanWrite,
  },
}));

import { WhatsAppProviderOperationError } from "@/lib/whatsappHttp";
import { WhatsAppTemplateService } from "@/services/whatsappTemplate.service";

const INPUT = {
  actorUserId: "user_1",
  organizationId: "org_1",
  senderId: "sender_1",
};

const tx = {
  whatsAppSender: {
    findFirst: mocks.txSenderFindFirst,
    update: mocks.senderUpdate,
  },
  whatsAppTemplate: {
    findMany: mocks.templateFindMany,
    create: mocks.templateCreate,
    update: mocks.templateUpdate,
    updateMany: mocks.templateUpdateMany,
  },
  whatsAppAuditEvent: { create: mocks.auditCreate },
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function componentHash(components: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(components)))
    .digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveProviderMode.mockReturnValue("TEST");
  mocks.senderFindFirst.mockResolvedValue({ id: "sender_1", wabaId: "waba_1" });
  mocks.txSenderFindFirst.mockResolvedValue({ id: "sender_1" });
  mocks.templateFindMany.mockResolvedValue([]);
  mocks.templateCreate.mockResolvedValue({ id: "template_new" });
  mocks.templateUpdate.mockResolvedValue({ id: "template_existing" });
  mocks.templateUpdateMany.mockResolvedValue({ count: 0 });
  mocks.senderUpdate.mockResolvedValue({ id: "sender_1" });
  mocks.auditCreate.mockResolvedValue({ id: "audit_1" });
  mocks.transaction.mockImplementation(async callback => callback(tx));
});

describe("WhatsAppTemplateService.sync", () => {
  it("maps unknown provider category and status values to bounded registry enums", async () => {
    mocks.listMessageTemplates.mockResolvedValue([
      {
        id: "provider_template_1",
        name: "fee_reminder",
        language: "en_US",
        category: "FUTURE_CATEGORY",
        status: "FUTURE_STATUS",
        components: [{ text: "Fee due", type: "BODY" }],
      },
    ]);

    await expect(WhatsAppTemplateService.sync(INPUT)).resolves.toMatchObject({
      fetched: 1,
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(mocks.templateCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        category: "UNKNOWN",
        providerStatus: "UNKNOWN",
      }),
    });
  });

  it("counts a canonically identical template as unchanged without incrementing its version", async () => {
    const components = [{ type: "BODY", text: "Fee due" }];
    mocks.listMessageTemplates.mockResolvedValue([
      {
        id: "provider_template_1",
        name: "fee_reminder",
        language: "en_US",
        category: "utility",
        status: "approved",
        components,
      },
    ]);
    mocks.templateFindMany.mockResolvedValue([
      {
        id: "template_1",
        providerTemplateId: "provider_template_1",
        name: "fee_reminder",
        language: "en_US",
        category: "UTILITY",
        providerStatus: "APPROVED",
        componentHash: componentHash([{ text: "Fee due", type: "BODY" }]),
        version: 7,
      },
    ]);

    await expect(WhatsAppTemplateService.sync(INPUT)).resolves.toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(mocks.templateUpdate).toHaveBeenCalledWith({
      where: { id: "template_1" },
      data: expect.objectContaining({ version: 7, staleAt: null }),
    });
  });

  it("increments the version only when normalized provider content changes", async () => {
    mocks.listMessageTemplates.mockResolvedValue([
      {
        id: "provider_template_1",
        name: "fee_reminder",
        language: "en_US",
        category: "UTILITY",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Fee is now due" }],
      },
    ]);
    mocks.templateFindMany.mockResolvedValue([
      {
        id: "template_1",
        providerTemplateId: "provider_template_1",
        name: "fee_reminder",
        language: "en_US",
        category: "UTILITY",
        providerStatus: "APPROVED",
        componentHash: componentHash([{ type: "BODY", text: "Old copy" }]),
        version: 3,
      },
    ]);

    await expect(WhatsAppTemplateService.sync(INPUT)).resolves.toMatchObject({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    expect(mocks.templateUpdate).toHaveBeenCalledWith({
      where: { id: "template_1" },
      data: expect.objectContaining({ version: { increment: 1 } }),
    });
  });

  it("treats a complete empty provider result as authoritative and stales missing templates", async () => {
    mocks.listMessageTemplates.mockResolvedValue([]);
    mocks.templateUpdateMany.mockResolvedValue({ count: 2 });

    await expect(WhatsAppTemplateService.sync(INPUT)).resolves.toEqual({
      fetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      markedStale: 2,
    });
    expect(mocks.templateUpdateMany).toHaveBeenCalledWith({
      where: {
        senderId: "sender_1",
        providerTemplateId: { notIn: [] },
        staleAt: null,
      },
      data: { staleAt: expect.any(Date) },
    });
  });

  it("does not start a mutation transaction when the provider fetch fails", async () => {
    mocks.listMessageTemplates.mockRejectedValue(new Error("provider unavailable"));

    await expect(WhatsAppTemplateService.sync(INPUT)).rejects.toBeInstanceOf(
      WhatsAppProviderOperationError
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.templateCreate).not.toHaveBeenCalled();
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.templateUpdateMany).not.toHaveBeenCalled();
    expect(mocks.senderUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
