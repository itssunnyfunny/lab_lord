import type { Prisma } from "@/app/generated/prisma/client";
import {
  getManagedWhatsAppTemplate,
} from "@/lib/whatsappManagedTemplates";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  assertOwnerCanWrite: vi.fn(),
  assertIntegrationEnabled: vi.fn(),
  assertDeliverySchemaAccessEnabled: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/whatsappFeature", () => ({
  assertWhatsAppIntegrationEnabled: mocks.assertIntegrationEnabled,
  assertWhatsAppDeliverySchemaAccessEnabled: mocks.assertDeliverySchemaAccessEnabled,
}));

vi.mock("@/services/whatsappAuthorization.service", () => ({
  WhatsAppAuthorizationService: {
    assertOwnerCanWrite: mocks.assertOwnerCanWrite,
  },
}));

import {
  getWhatsAppSenderRequiredTemplateHealth,
  WhatsAppSenderSafetyService,
} from "@/services/whatsappSenderSafety.service";

const requestedAt = new Date("2026-08-24T10:00:00.000Z");
const finalizedAt = new Date("2026-08-24T10:00:08.000Z");

function pendingState() {
  return {
    senderId: "sender_1",
    pausedAt: null,
    pauseRequestedAt: requestedAt,
    pauseReason: "OWNER_PAUSED" as const,
    pausedByUserId: "user_1",
    pauseRevision: 1,
    ambiguousWindowStartedAt: null,
    ambiguousOutcomeCount: 0,
    failureWindowStartedAt: null,
    definiteFailureCount: 0,
    lastAcceptedAt: null,
    lastDeliveredAt: null,
    lastHealthCheckAt: null,
    lastHealthyAt: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
}

function transaction(activeAdmissions: number) {
  const requested = pendingState();
  const paused = { ...requested, pausedAt: finalizedAt, pauseRequestedAt: null };
  return {
    whatsAppSender: {
      findFirst: vi.fn().mockResolvedValue({ id: "sender_1", status: "ACTIVE" }),
    },
    whatsAppSenderSafetyState: {
      upsert: vi.fn().mockResolvedValue(requested),
      findUnique: vi.fn().mockResolvedValue(requested),
      update: vi.fn().mockResolvedValue(paused),
    },
    whatsAppMessage: {
      count: vi.fn().mockResolvedValue(activeAdmissions),
    },
    whatsAppAuditEvent: {
      create: vi.fn().mockResolvedValue({ id: "audit_1" }),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ senderId: "sender_1" }]),
  };
}

function managedBinding(
  managedKey: Parameters<typeof getManagedWhatsAppTemplate>[0],
  language: Parameters<typeof getManagedWhatsAppTemplate>[1] = "en_IN"
) {
  const definition = getManagedWhatsAppTemplate(managedKey, language);
  const suffix = `${managedKey.toLowerCase()}-${language.toLowerCase()}`;
  return {
    id: `binding-${suffix}`,
    senderId: "sender_1",
    templateId: `template-${suffix}`,
    provisioningId: `provisioning-${suffix}`,
    managedKey,
    language,
    catalogVersion: definition.catalogVersion,
    catalogHash: definition.catalogHash,
    active: true,
    template: {
      id: `template-${suffix}`,
      senderId: "sender_1",
      providerTemplateId: `provider-${suffix}`,
      name: definition.providerTemplateName,
      language,
      category: "UTILITY",
      providerStatus: "APPROVED",
      version: 1,
      components: definition.components as unknown as Prisma.JsonValue,
      staleAt: null,
    },
    provisioning: {
      id: `provisioning-${suffix}`,
      senderId: "sender_1",
      managedKey,
      language,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      providerTemplateName: definition.providerTemplateName,
      providerTemplateId: `provider-${suffix}`,
      status: "READY",
    },
  };
}

function templateHealthClient(input: {
  queuedMessages?: unknown[];
  branchSettings?: unknown[];
  enabledRules?: unknown[];
  reportSubscriptions?: unknown[];
  organizationReportSettings?: unknown;
  bindings?: unknown[];
}) {
  const queries = {
    queuedMessages: vi.fn().mockResolvedValue(input.queuedMessages ?? []),
    branchSettings: vi.fn().mockResolvedValue(input.branchSettings ?? []),
    enabledRules: vi.fn().mockResolvedValue(input.enabledRules ?? []),
    reportSubscriptions: vi.fn().mockResolvedValue(input.reportSubscriptions ?? []),
    organizationReportSettings: vi.fn().mockResolvedValue(
      input.organizationReportSettings ?? null
    ),
    bindings: vi.fn().mockResolvedValue(input.bindings ?? []),
  };
  return {
    client: {
      whatsAppMessage: { groupBy: queries.queuedMessages },
      branchWhatsAppSettings: { findMany: queries.branchSettings },
      whatsAppAutomationRule: { findMany: queries.enabledRules },
      whatsAppReportSubscription: { findMany: queries.reportSubscriptions },
      organizationWhatsAppReportSettings: { findFirst: queries.organizationReportSettings },
      whatsAppTemplateBinding: { findMany: queries.bindings },
    } as never,
    queries,
  };
}

function queuedMessageFor(binding: ReturnType<typeof managedBinding>) {
  return {
    managedTemplateKey: binding.managedKey,
    catalogVersion: binding.catalogVersion,
    catalogHash: binding.catalogHash,
    templateId: binding.templateId,
    templateBindingId: binding.id,
    templateVersion: binding.template.version,
    templateBinding: binding,
  };
}

describe("WhatsApp sender pause drain", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses a fresh read-committed snapshot after the safety fence is locked", async () => {
    const initial = {
      ...pendingState(),
      pauseRequestedAt: null,
      pauseReason: null,
      pausedByUserId: null,
      pauseRevision: 0,
    };
    const requested = pendingState();
    const paused = { ...requested, pausedAt: finalizedAt, pauseRequestedAt: null };
    const tx = {
      whatsAppSender: {
        findFirst: vi.fn().mockResolvedValue({ id: "sender_1", status: "ACTIVE" }),
      },
      whatsAppSenderSafetyState: {
        upsert: vi.fn().mockResolvedValue(initial),
        findUnique: vi.fn().mockResolvedValue(initial),
        update: vi.fn()
          .mockResolvedValueOnce(requested)
          .mockResolvedValueOnce(paused),
      },
      whatsAppMessage: { count: vi.fn().mockResolvedValue(0) },
      whatsAppAuditEvent: { create: vi.fn().mockResolvedValue({ id: "audit_1" }) },
      $queryRaw: vi.fn().mockResolvedValue([{ senderId: "sender_1" }]),
    };
    mocks.transaction.mockImplementation(async callback => callback(tx));

    await expect(WhatsAppSenderSafetyService.pauseByOwner({
      actorUserId: "user_1",
      organizationId: "org_1",
      senderId: "sender_1",
      confirmation: true,
      now: finalizedAt,
    })).resolves.toMatchObject({ changed: true, pausePending: false });

    expect(mocks.assertOwnerCanWrite).toHaveBeenCalledWith(
      "user_1",
      "org_1",
      tx
    );
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "ReadCommitted" }
    );
    expect(tx.whatsAppMessage.count).toHaveBeenCalledAfter(
      tx.$queryRaw
    );
  });

  it("keeps the pause pending while an admitted provider call is active", async () => {
    const tx = transaction(1);

    await expect(WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      senderId: "sender_1",
      now: finalizedAt,
    })).resolves.toMatchObject({ changed: false, pausePending: true });

    expect(tx.whatsAppMessage.count).toHaveBeenCalledWith({
      where: {
        senderId: "sender_1",
        status: "SUBMITTING",
        providerMessageId: null,
        providerCallAdmittedAt: { not: null },
      },
    });
    expect(tx.whatsAppSenderSafetyState.update).not.toHaveBeenCalled();
    expect(tx.whatsAppAuditEvent.create).not.toHaveBeenCalled();
  });

  it("records the full pause only after every admitted call has drained", async () => {
    const tx = transaction(0);

    await expect(WhatsAppSenderSafetyService.finalizeRequestedPauseInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      senderId: "sender_1",
      now: finalizedAt,
    })).resolves.toMatchObject({ changed: true, pausePending: false });

    expect(tx.whatsAppSenderSafetyState.update).toHaveBeenCalledWith({
      where: { senderId: "sender_1" },
      data: { pausedAt: finalizedAt, pauseRequestedAt: null },
    });
    expect(tx.whatsAppAuditEvent.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org_1",
        senderId: "sender_1",
        actorUserId: "user_1",
        action: "SENDER_PAUSED",
        details: { pauseReason: "OWNER_PAUSED", pauseRevision: 1 },
      },
    });
  });
});

describe("WhatsApp sender resume template requirements", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts an English-only configured sender and ignores a rejected unused template", async () => {
    const renewal = managedBinding("FEE_RENEWAL_POLITE");
    const summary = managedBinding("MULTI_STUDENT_COLLECTION_SUMMARY");
    const rejectedOptional = managedBinding("BRANCH_MAINTENANCE_NOTICE");
    rejectedOptional.active = false;
    rejectedOptional.provisioning.status = "REJECTED";
    rejectedOptional.template.providerStatus = "REJECTED";
    const { client, queries } = templateHealthClient({
      branchSettings: [{
        branchId: "branch_1",
        defaultLanguage: "en",
        defaultTone: "polite",
        automationEnabledAt: null,
      }],
      bindings: [renewal, summary, rejectedOptional],
    });

    await expect(getWhatsAppSenderRequiredTemplateHealth({
      organizationId: "org_1",
      senderId: "sender_1",
      client,
    })).resolves.toBe(true);

    expect(queries.bindings).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        senderId: "sender_1",
        sender: { organizationId: "org_1" },
      },
    }));
    expect(queries.branchSettings).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationId: "org_1",
        senderId: "sender_1",
        enabled: true,
      },
    }));
  });

  it("rejects a queued message whose exact optional binding is unavailable", async () => {
    const renewal = managedBinding("FEE_RENEWAL_POLITE");
    const summary = managedBinding("MULTI_STUDENT_COLLECTION_SUMMARY");
    const rejected = managedBinding("BRANCH_MAINTENANCE_NOTICE");
    rejected.active = false;
    rejected.provisioning.status = "REJECTED";
    rejected.template.providerStatus = "REJECTED";
    const { client } = templateHealthClient({
      queuedMessages: [queuedMessageFor(rejected)],
      branchSettings: [{
        branchId: "branch_1",
        defaultLanguage: "en_IN",
        defaultTone: "polite",
        automationEnabledAt: null,
      }],
      bindings: [renewal, summary, rejected],
    });

    await expect(getWhatsAppSenderRequiredTemplateHealth({
      organizationId: "org_1",
      senderId: "sender_1",
      client,
    })).resolves.toBe(false);
  });

  it("requires only configured automation stages and active report languages", async () => {
    const bindings = [
      managedBinding("FEE_RENEWAL_POLITE"),
      managedBinding("MULTI_STUDENT_COLLECTION_SUMMARY"),
      managedBinding("WELCOME_GENERAL"),
      managedBinding("WELCOME_ALLOCATED"),
    ];
    const configured = {
      branchSettings: [{
        branchId: "branch_1",
        defaultLanguage: "en_IN",
        defaultTone: "polite",
        automationEnabledAt: finalizedAt,
      }],
      enabledRules: [{ branchId: "branch_1", stage: "WELCOME" }],
      reportSubscriptions: [{ branchId: "branch_1", scope: "BRANCH", language: "hi" }],
    };
    const missingReport = templateHealthClient({ ...configured, bindings });

    await expect(getWhatsAppSenderRequiredTemplateHealth({
      organizationId: "org_1",
      senderId: "sender_1",
      client: missingReport.client,
    })).resolves.toBe(false);

    const complete = templateHealthClient({
      ...configured,
      bindings: [...bindings, managedBinding("DAILY_BRANCH_REPORT", "hi")],
    });
    await expect(getWhatsAppSenderRequiredTemplateHealth({
      organizationId: "org_1",
      senderId: "sender_1",
      client: complete.client,
    })).resolves.toBe(true);
  });
});
