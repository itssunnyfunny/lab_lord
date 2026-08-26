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

import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";

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
