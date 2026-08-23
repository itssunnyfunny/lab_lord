import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertIntegrationEnabled: vi.fn(),
  assertOnboardingWritesEnabled: vi.fn(),
  assertTemplateWritesEnabled: vi.fn(),
  assertOwnerCanWrite: vi.fn(),
  assertOwnerEntitled: vi.fn(),
  resolveProviderMode: vi.fn(),
  deliverySchemaAccessEnabled: vi.fn(),
  deliverySchemaReady: vi.fn(),
  listMessageTemplates: vi.fn(),
  createManagedUtilityTemplate: vi.fn(),
  transaction: vi.fn(),
  senderFindFirst: vi.fn(),
  provisioningUpsert: vi.fn(),
  provisioningUpdateMany: vi.fn(),
  provisioningFindFirst: vi.fn(),
  provisioningFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  templateCreate: vi.fn(),
  templateUpdate: vi.fn(),
  templateUpdateMany: vi.fn(),
  bindingUpsert: vi.fn(),
  bindingUpdateMany: vi.fn(),
  senderUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/metaWhatsApp", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/metaWhatsApp")>()),
  getMetaWhatsAppClient: () => ({
    listMessageTemplates: mocks.listMessageTemplates,
    createManagedUtilityTemplate: mocks.createManagedUtilityTemplate,
  }),
}));

vi.mock("@/lib/whatsappFeature", () => ({
  assertWhatsAppIntegrationEnabled: mocks.assertIntegrationEnabled,
  assertWhatsAppOnboardingWritesEnabled: mocks.assertOnboardingWritesEnabled,
  assertWhatsAppTemplateWritesEnabled: mocks.assertTemplateWritesEnabled,
  isWhatsAppDeliverySchemaAccessEnabled: mocks.deliverySchemaAccessEnabled,
  resolveWhatsAppProviderMode: mocks.resolveProviderMode,
}));

vi.mock("@/lib/whatsappSchema", () => ({
  isWhatsAppDeliverySchemaReady: mocks.deliverySchemaReady,
}));

vi.mock("@/services/whatsappAuthorization.service", () => ({
  WhatsAppAuthorizationService: {
    assertOwnerCanWrite: mocks.assertOwnerCanWrite,
    assertOwnerEntitled: mocks.assertOwnerEntitled,
  },
}));

const tx = {
  whatsAppSender: { findFirst: mocks.senderFindFirst, update: mocks.senderUpdate },
  whatsAppManagedTemplateProvisioning: {
    upsert: mocks.provisioningUpsert,
    updateMany: mocks.provisioningUpdateMany,
    findFirst: mocks.provisioningFindFirst,
    findMany: mocks.provisioningFindMany,
  },
  whatsAppTemplate: {
    findMany: mocks.templateFindMany,
    create: mocks.templateCreate,
    update: mocks.templateUpdate,
    updateMany: mocks.templateUpdateMany,
  },
  whatsAppTemplateBinding: {
    upsert: mocks.bindingUpsert,
    updateMany: mocks.bindingUpdateMany,
  },
  whatsAppAuditEvent: { create: mocks.auditCreate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    whatsAppSender: { findFirst: mocks.senderFindFirst, update: mocks.senderUpdate },
    whatsAppManagedTemplateProvisioning: {
      upsert: mocks.provisioningUpsert,
      updateMany: mocks.provisioningUpdateMany,
      findFirst: mocks.provisioningFindFirst,
      findMany: mocks.provisioningFindMany,
    },
    whatsAppTemplate: {
      findMany: mocks.templateFindMany,
      create: mocks.templateCreate,
      update: mocks.templateUpdate,
      updateMany: mocks.templateUpdateMany,
    },
    whatsAppTemplateBinding: {
      upsert: mocks.bindingUpsert,
      updateMany: mocks.bindingUpdateMany,
    },
    whatsAppAuditEvent: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import {
  META_GRAPH_MAX_TIMEOUT_MS,
  MetaWhatsAppAmbiguousMutationError,
} from "@/lib/metaWhatsApp";
import {
  WhatsAppConflictError,
  WhatsAppResourceNotFoundError,
} from "@/lib/whatsappHttp";
import {
  listManagedWhatsAppTemplates,
  type WhatsAppManagedTemplateDefinition,
} from "@/lib/whatsappManagedTemplates";
import { WhatsAppTemplateProvisioningService } from
  "@/services/whatsappTemplateProvisioning.service";
import { WhatsAppTemplateService } from "@/services/whatsappTemplate.service";

const INPUT = {
  actorUserId: "owner_1",
  organizationId: "org_1",
  senderId: "sender_1",
  languages: ["en_IN"] as const,
  catalogVersion: 1,
};

type ProvisioningRow = {
  id: string;
  senderId: string;
  managedKey: string;
  language: string;
  catalogVersion: number;
  catalogHash: string;
  providerTemplateName: string;
  providerTemplateId: string | null;
  status: string;
  attemptCount: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
};

const provisioningRows = new Map<string, ProvisioningRow>();
const templateRows = new Map<string, Record<string, unknown>>();
const bindings = new Map<string, Record<string, unknown>>();
let inTransaction = false;

function providerTemplate(
  definition: WhatsAppManagedTemplateDefinition,
  index: number,
  overrides: Partial<{
    id: string;
    category: string;
    status: string;
    components: unknown[];
  }> = {}
) {
  return {
    id: overrides.id ?? String(70_000 + index),
    name: definition.providerTemplateName,
    language: definition.language,
    category: overrides.category ?? "UTILITY",
    status: overrides.status ?? "APPROVED",
    components: overrides.components ?? [...definition.components],
  };
}

function definitions() {
  return listManagedWhatsAppTemplates({ languages: ["en_IN"], catalogVersion: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  provisioningRows.clear();
  templateRows.clear();
  bindings.clear();
  inTransaction = false;

  mocks.resolveProviderMode.mockReturnValue("TEST");
  mocks.deliverySchemaAccessEnabled.mockReturnValue(true);
  mocks.deliverySchemaReady.mockResolvedValue(true);
  mocks.assertOwnerCanWrite.mockResolvedValue({ id: "org_1" });
  mocks.assertOwnerEntitled.mockResolvedValue({ id: "org_1" });
  mocks.senderFindFirst.mockResolvedValue({
    id: "sender_1",
    wabaId: "50005",
    providerMode: "TEST",
  });
  mocks.auditCreate.mockResolvedValue({ id: "audit_1" });
  mocks.senderUpdate.mockResolvedValue({ id: "sender_1" });
  mocks.templateUpdateMany.mockResolvedValue({ count: 0 });
  mocks.transaction.mockImplementation(async callback => {
    inTransaction = true;
    try {
      return await callback(tx);
    } finally {
      inTransaction = false;
    }
  });

  mocks.provisioningUpsert.mockImplementation(async input => {
    const name = input.create.providerTemplateName as string;
    const existing = provisioningRows.get(name);
    if (existing) return { ...existing };
    const row: ProvisioningRow = {
      id: `provisioning_${provisioningRows.size + 1}`,
      ...input.create,
      providerTemplateId: null,
      status: "PENDING",
      attemptCount: 0,
      leaseToken: null,
      leaseUntil: null,
      lastAttemptAt: null,
      lastErrorCode: null,
    };
    provisioningRows.set(name, row);
    return { ...row };
  });
  mocks.provisioningUpdateMany.mockImplementation(async input => {
    const row = [...provisioningRows.values()].find(item => item.id === input.where.id);
    if (!row) return { count: 0 };
    if (typeof input.where.status === "string" && row.status !== input.where.status) {
      return { count: 0 };
    }
    if (
      input.where.status
      && typeof input.where.status === "object"
      && input.where.status.not === row.status
    ) {
      return { count: 0 };
    }
    if (input.where.leaseToken && row.leaseToken !== input.where.leaseToken) return { count: 0 };
    Object.assign(row, input.data, {
      attemptCount: typeof input.data.attemptCount === "object"
        ? row.attemptCount + 1
        : input.data.attemptCount ?? row.attemptCount,
    });
    return { count: 1 };
  });
  mocks.provisioningFindFirst.mockImplementation(async input => {
    const row = [...provisioningRows.values()].find(item => item.id === input.where.id);
    return row && row.status === input.where.status && row.leaseToken === input.where.leaseToken
      ? { id: row.id }
      : null;
  });
  mocks.provisioningFindMany.mockImplementation(async () =>
    [...provisioningRows.values()].map(row => {
      const binding = bindings.get(`${row.managedKey}:${row.language}`);
      const template = binding?.templateId
        ? templateRows.get(String(binding.templateId))
        : null;
      return {
        ...row,
        binding: binding ? { ...binding, template } : null,
      };
    })
  );

  mocks.templateFindMany.mockImplementation(async input => {
    const candidates = [...templateRows.values()].filter(row => row.senderId === input.where.senderId);
    if (!input.where.OR) return candidates;
    return candidates.filter(row => input.where.OR.some((condition: Record<string, unknown>) =>
      condition.providerTemplateId === row.providerTemplateId
      || condition.name === row.name && condition.language === row.language
    ));
  });
  mocks.templateCreate.mockImplementation(async input => {
    const row = {
      id: `template_${templateRows.size + 1}`,
      version: 1,
      staleAt: null,
      ...input.data,
    };
    templateRows.set(String(row.id), row);
    return row;
  });
  mocks.templateUpdate.mockImplementation(async input => {
    const row = templateRows.get(input.where.id);
    if (!row) throw new Error("missing template");
    const next = { ...row, ...input.data };
    templateRows.set(input.where.id, next);
    return next;
  });
  mocks.bindingUpsert.mockImplementation(async input => {
    const key = `${input.create.managedKey}:${input.create.language}`;
    const row = { ...(bindings.get(key) ?? {}), ...input.create, ...input.update };
    bindings.set(key, row);
    return row;
  });
  mocks.bindingUpdateMany.mockImplementation(async input => {
    const key = `${input.where.managedKey}:${input.where.language}`;
    const existing = bindings.get(key);
    if (existing) bindings.set(key, { ...existing, ...input.data });
    return { count: existing ? 1 : 0 };
  });
});

describe("WhatsAppTemplateProvisioningService.install", () => {
  it("reloads provider-authoritative catalogue state without calling Meta", async () => {
    mocks.listMessageTemplates.mockResolvedValue(
      definitions().map((definition, index) => providerTemplate(definition, index))
    );
    await WhatsAppTemplateProvisioningService.install(INPUT);
    mocks.listMessageTemplates.mockClear();
    mocks.createManagedUtilityTemplate.mockClear();

    const result = await WhatsAppTemplateProvisioningService.getStatus({
      actorUserId: "owner_1",
      organizationId: "org_1",
      senderId: "sender_1",
    });

    expect(mocks.assertOwnerEntitled).toHaveBeenCalledWith("owner_1", "org_1");
    expect(mocks.listMessageTemplates).not.toHaveBeenCalled();
    expect(mocks.createManagedUtilityTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      catalogVersion: 1,
      languages: ["en_IN"],
    });
    expect(result.templates).toHaveLength(9);
    expect(result.templates[0]).toMatchObject({
      providerCategory: "UTILITY",
      providerStatus: "APPROVED",
      status: "READY",
      active: true,
      lastSyncedAt: expect.any(Date),
    });
  });

  it("rejects a non-owner status read before resolving the sender or catalogue", async () => {
    mocks.assertOwnerEntitled.mockRejectedValue(new WhatsAppResourceNotFoundError());

    await expect(WhatsAppTemplateProvisioningService.getStatus({
      actorUserId: "foreign_user",
      organizationId: "org_1",
      senderId: "sender_1",
    })).rejects.toBeInstanceOf(WhatsAppResourceNotFoundError);

    expect(mocks.senderFindFirst).not.toHaveBeenCalled();
    expect(mocks.provisioningFindMany).not.toHaveBeenCalled();
    expect(mocks.listMessageTemplates).not.toHaveBeenCalled();
  });

  it("returns an empty legacy-safe projection before the delivery migration is ready", async () => {
    mocks.deliverySchemaAccessEnabled.mockReturnValue(false);
    mocks.deliverySchemaReady.mockResolvedValue(false);

    const result = await WhatsAppTemplateProvisioningService.getStatus({
      actorUserId: "owner_1",
      organizationId: "org_1",
      senderId: "sender_1",
    });

    expect(result).toEqual({ catalogVersion: 1, languages: [], templates: [] });
    expect(mocks.deliverySchemaReady).toHaveBeenCalledTimes(1);
    expect(mocks.provisioningFindMany).not.toHaveBeenCalled();
  });

  it("fails closed to the code-defined identity when durable catalogue state is corrupted", async () => {
    mocks.listMessageTemplates.mockResolvedValue(
      definitions().map((definition, index) => providerTemplate(definition, index))
    );
    await WhatsAppTemplateProvisioningService.install(INPUT);
    const row = provisioningRows.values().next().value as ProvisioningRow;
    row.providerTemplateName = "arbitrary_customer_template";

    const result = await WhatsAppTemplateProvisioningService.getStatus({
      actorUserId: "owner_1",
      organizationId: "org_1",
      senderId: "sender_1",
    });
    const projection = result.templates.find(item => item.managedKey === row.managedKey)!;

    expect(projection).toMatchObject({
      providerTemplateName: expect.stringMatching(/^lablords_/),
      providerTemplateId: null,
      providerCategory: null,
      providerStatus: null,
      status: "FAILED",
      active: false,
      errorCode: "MANAGED_CATALOGUE_IDENTITY_MISMATCH",
    });
    expect(JSON.stringify(projection)).not.toContain("arbitrary_customer_template");
  });

  it("reuses exact provider templates and activates only approved Utility bindings", async () => {
    mocks.listMessageTemplates.mockResolvedValue(
      definitions().map((definition, index) => providerTemplate(definition, index))
    );

    const result = await WhatsAppTemplateProvisioningService.install(INPUT);

    expect(result.templates).toHaveLength(9);
    expect(result.templates.every(item => item.status === "READY" && item.active)).toBe(true);
    expect(mocks.createManagedUtilityTemplate).not.toHaveBeenCalled();
    expect(mocks.bindingUpsert).toHaveBeenCalledTimes(9);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MANAGED_TEMPLATE_INSTALL_COMPLETED",
        details: expect.not.objectContaining({ components: expect.anything() }),
      }),
    });
  });

  it("creates only the missing deterministic template after the claim transaction commits", async () => {
    const catalogue = definitions();
    const missing = catalogue.at(-1)!;
    mocks.listMessageTemplates.mockResolvedValue(
      catalogue.slice(0, -1).map((definition, index) => providerTemplate(definition, index))
    );
    mocks.createManagedUtilityTemplate.mockImplementation(async input => {
      expect(inTransaction).toBe(false);
      return {
        providerTemplateId: "79999",
        providerStatus: "PENDING",
        category: "UTILITY",
        definition: input.definition,
      };
    });

    const result = await WhatsAppTemplateProvisioningService.install(INPUT);

    expect(mocks.createManagedUtilityTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.createManagedUtilityTemplate).toHaveBeenCalledWith({
      wabaId: "50005",
      definition: missing,
    });
    expect(result.templates.find(item => item.managedKey === missing.managedKey)).toMatchObject({
      providerTemplateName: missing.providerTemplateName,
      providerTemplateId: "79999",
      status: "WAITING_APPROVAL",
      active: false,
    });
  });

  it("atomically renews the exact lease beyond the provider timeout before creating", async () => {
    const catalogue = definitions();
    mocks.listMessageTemplates.mockResolvedValue(
      catalogue.slice(0, -1).map((definition, index) => providerTemplate(definition, index))
    );
    mocks.createManagedUtilityTemplate.mockResolvedValue({
      providerTemplateId: "79999",
      providerStatus: "PENDING",
      category: "UTILITY",
    });

    await WhatsAppTemplateProvisioningService.install(INPUT);

    const renewal = mocks.provisioningUpdateMany.mock.calls
      .map(([call]) => call)
      .find(call =>
        call.where.leaseUntil?.gt instanceof Date
        && typeof call.where.leaseToken === "string"
        && call.data.leaseUntil instanceof Date
        && call.data.status === undefined
      );
    expect(renewal).toBeDefined();
    expect(renewal.where).toMatchObject({
      senderId: "sender_1",
      status: "CREATING",
      leaseToken: expect.any(String),
    });
    expect(
      renewal.data.leaseUntil.getTime() - renewal.where.leaseUntil.gt.getTime()
    ).toBeGreaterThan(META_GRAPH_MAX_TIMEOUT_MS);
    expect(mocks.createManagedUtilityTemplate).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider when a newer worker owns the provisioning lease", async () => {
    const catalogue = definitions();
    mocks.listMessageTemplates.mockResolvedValue(
      catalogue.slice(1).map((definition, index) => providerTemplate(definition, index))
    );
    const applyUpdate = mocks.provisioningUpdateMany.getMockImplementation()!;
    mocks.provisioningUpdateMany.mockImplementation(async (call: {
      where: {
        id?: unknown;
        leaseUntil?: { gt?: unknown };
        leaseToken?: unknown;
      };
      data: {
        leaseUntil?: unknown;
        status?: unknown;
      };
    }) => {
      const providerFence = call.where.leaseUntil?.gt instanceof Date
        && typeof call.where.leaseToken === "string"
        && call.data.leaseUntil instanceof Date
        && call.data.status === undefined;
      if (!providerFence) return applyUpdate(call);

      const row = [...provisioningRows.values()].find(item => item.id === call.where.id)!;
      const renewedUntil = call.data.leaseUntil;
      if (!(renewedUntil instanceof Date)) throw new Error("expected lease renewal");
      row.leaseToken = "newer-worker-token";
      row.leaseUntil = new Date(renewedUntil.getTime());
      return { count: 0 };
    });

    await expect(WhatsAppTemplateProvisioningService.install(INPUT))
      .rejects.toBeInstanceOf(WhatsAppConflictError);

    expect(mocks.createManagedUtilityTemplate).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous create by deterministic name without a blind retry", async () => {
    const catalogue = definitions();
    const missing = catalogue.at(-1)!;
    const existing = catalogue.slice(0, -1)
      .map((definition, index) => providerTemplate(definition, index));
    mocks.listMessageTemplates
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce([...existing, providerTemplate(missing, 99)]);
    mocks.createManagedUtilityTemplate.mockRejectedValue(
      new MetaWhatsAppAmbiguousMutationError({ requestId: "safe-request" })
    );

    const result = await WhatsAppTemplateProvisioningService.install(INPUT);

    expect(mocks.createManagedUtilityTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.listMessageTemplates).toHaveBeenCalledTimes(2);
    expect(result.templates.find(item => item.managedKey === missing.managedKey)).toMatchObject({
      status: "READY",
      active: true,
    });
  });

  it("keeps an unproven ambiguous creation UNKNOWN through sync and never creates it again", async () => {
    const catalogue = definitions();
    const missing = catalogue.at(-1)!;
    const existing = catalogue.slice(0, -1)
      .map((definition, index) => providerTemplate(definition, index));
    mocks.listMessageTemplates.mockResolvedValue(existing);
    mocks.createManagedUtilityTemplate.mockRejectedValue(
      new MetaWhatsAppAmbiguousMutationError()
    );

    const result = await WhatsAppTemplateProvisioningService.install(INPUT);
    await WhatsAppTemplateService.sync(INPUT);
    const replay = await WhatsAppTemplateProvisioningService.install(INPUT);

    expect(mocks.createManagedUtilityTemplate).toHaveBeenCalledTimes(1);
    expect(result.templates.find(item => item.managedKey === missing.managedKey)).toMatchObject({
      status: "UNKNOWN",
      active: false,
      errorCode: "PROVIDER_RESULT_AMBIGUOUS",
    });
    expect([...provisioningRows.values()].find(row => row.managedKey === missing.managedKey))
      .toMatchObject({
        status: "UNKNOWN",
        lastErrorCode: "PROVIDER_RESULT_AMBIGUOUS",
      });
    expect(replay.templates.find(item => item.managedKey === missing.managedKey)).toMatchObject({
      status: "UNKNOWN",
      active: false,
    });
    expect(
      replay.templates
        .filter(item => item.managedKey !== missing.managedKey)
        .every(item => item.status === "READY" && item.active)
    ).toBe(true);
  });

  it("blocks a same-name component or category mismatch without overwriting or recreating it", async () => {
    const catalogue = definitions();
    const mismatched = catalogue[0];
    mocks.listMessageTemplates.mockResolvedValue(catalogue.map((definition, index) =>
      definition === mismatched
        ? providerTemplate(definition, index, { components: [{ type: "BODY", text: "Other" }] })
        : providerTemplate(definition, index)
    ));

    const result = await WhatsAppTemplateProvisioningService.install(INPUT);

    expect(mocks.createManagedUtilityTemplate).not.toHaveBeenCalled();
    expect(result.templates.find(item => item.managedKey === mismatched.managedKey)).toMatchObject({
      status: "FAILED",
      active: false,
      errorCode: "PROVIDER_TEMPLATE_MISMATCH",
    });
  });

  it("fails before provider or provisioning work when owner authorization changes", async () => {
    mocks.assertOwnerCanWrite.mockRejectedValue(new WhatsAppResourceNotFoundError());

    await expect(WhatsAppTemplateProvisioningService.install(INPUT))
      .rejects.toBeInstanceOf(WhatsAppResourceNotFoundError);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.provisioningUpsert).not.toHaveBeenCalled();
    expect(mocks.listMessageTemplates).not.toHaveBeenCalled();
    expect(mocks.createManagedUtilityTemplate).not.toHaveBeenCalled();
  });
});
