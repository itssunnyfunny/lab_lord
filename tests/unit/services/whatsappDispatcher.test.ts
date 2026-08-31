import { describe, expect, it, vi } from "vitest";
import {
  calculateWhatsAppRetryAt,
  classifyWhatsAppDispatchError,
  createWhatsAppDispatchOperationClock,
  guardPreparedWhatsAppSubmissionAgainstPauseInTransaction,
  projectAttachedWhatsAppWebhookEvents,
  resolveWhatsAppDispatchOrganizationScope,
  restorePreparedWhatsAppSubmissionAfterAdmissionErrorInTransaction,
  WHATSAPP_DISPATCH_PROVIDER_LEASE_MS,
  WhatsAppDispatcherService,
} from "@/services/whatsappDispatcher.service";
import {
  META_GRAPH_MAX_TIMEOUT_MS,
  MetaWhatsAppAmbiguousMutationError,
  MetaWhatsAppProviderError,
} from "@/lib/metaWhatsApp";
import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";

describe("WhatsApp dispatcher outcome policy", () => {
  it("returns a prepared submission to a held state when pause wins before the provider call", async () => {
    const admittedAt = new Date("2026-08-23T10:00:01.000Z");
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "message_1" }])
        .mockResolvedValueOnce([{ senderId: "sender_1" }]),
      whatsAppSenderSafetyState: {
        findUnique: vi.fn().mockResolvedValue({
          pausedAt: admittedAt,
          pauseRequestedAt: null,
        }),
      },
      whatsAppMessage: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(guardPreparedWhatsAppSubmissionAgainstPauseInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      messageId: "message_1",
      senderId: "sender_1",
      leaseToken: "lease_1",
      admittedAt,
    })).resolves.toBe("HELD");

    expect(tx.whatsAppMessage.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message_1",
        senderId: "sender_1",
        leaseToken: "lease_1",
        status: "SUBMITTING",
        providerMessageId: null,
        providerCallAdmittedAt: null,
      },
      data: {
        status: "SCHEDULED",
        claimedAt: null,
        submissionStartedAt: null,
        providerCallAdmittedAt: null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
  });

  it("fails closed when the prepared submission or safety row is stale", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      whatsAppSenderSafetyState: { findUnique: vi.fn() },
      whatsAppMessage: { updateMany: vi.fn() },
    };

    await expect(guardPreparedWhatsAppSubmissionAgainstPauseInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      messageId: "message_1",
      senderId: "sender_1",
      leaseToken: "lease_1",
      admittedAt: new Date("2026-08-23T10:00:01.000Z"),
    })).resolves.toBe("STALE");
    expect(tx.whatsAppSenderSafetyState.findUnique).not.toHaveBeenCalled();
    expect(tx.whatsAppMessage.updateMany).not.toHaveBeenCalled();
  });

  it("durably admits the provider call without invoking the provider in the transaction", async () => {
    const order: string[] = [];
    const admittedAt = new Date("2026-08-23T10:00:01.000Z");
    const tx = {
      $queryRaw: vi.fn()
        .mockImplementationOnce(async () => {
          order.push("message-locked");
          return [{ id: "message_1" }];
        })
        .mockImplementationOnce(async () => {
          order.push("safety-locked");
          return [{ senderId: "sender_1" }];
        }),
      whatsAppSenderSafetyState: {
        findUnique: vi.fn().mockImplementation(async () => {
          order.push("pause-checked");
          return { pausedAt: null, pauseRequestedAt: null };
        }),
      },
      whatsAppMessage: {
        updateMany: vi.fn().mockImplementation(async () => {
          order.push("admission-recorded");
          return { count: 1 };
        }),
      },
    };

    await expect(guardPreparedWhatsAppSubmissionAgainstPauseInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      messageId: "message_1",
      senderId: "sender_1",
      leaseToken: "lease_1",
      admittedAt,
    })).resolves.toBe("READY");

    expect(order).toEqual([
      "message-locked",
      "safety-locked",
      "pause-checked",
      "admission-recorded",
    ]);
    expect(tx.whatsAppMessage.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message_1",
        senderId: "sender_1",
        leaseToken: "lease_1",
        status: "SUBMITTING",
        providerMessageId: null,
        providerCallAdmittedAt: null,
      },
      data: {
        providerCallAdmittedAt: admittedAt,
        lastAttemptAt: admittedAt,
        attemptCount: { increment: 1 },
      },
    });
  });

  it("blocks admission and drains the pause request when the request wins", async () => {
    const admittedAt = new Date("2026-08-23T10:00:01.000Z");
    const finalize = vi.spyOn(
      WhatsAppSenderSafetyService,
      "finalizeRequestedPauseInTransaction"
    ).mockResolvedValue({ changed: true, pausePending: false, state: {} as never });
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "message_1" }])
        .mockResolvedValueOnce([{ senderId: "sender_1" }]),
      whatsAppSenderSafetyState: {
        findUnique: vi.fn().mockResolvedValue({
          pausedAt: null,
          pauseRequestedAt: admittedAt,
        }),
      },
      whatsAppMessage: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    await expect(guardPreparedWhatsAppSubmissionAgainstPauseInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      messageId: "message_1",
      senderId: "sender_1",
      leaseToken: "lease_1",
      admittedAt,
    })).resolves.toBe("HELD");

    expect(tx.whatsAppMessage.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message_1",
        senderId: "sender_1",
        leaseToken: "lease_1",
        status: "SUBMITTING",
        providerMessageId: null,
        providerCallAdmittedAt: null,
      },
      data: {
        status: "SCHEDULED",
        claimedAt: null,
        submissionStartedAt: null,
        providerCallAdmittedAt: null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(finalize).toHaveBeenCalledWith({
      tx,
      organizationId: "org_1",
      senderId: "sender_1",
      now: admittedAt,
    });
    finalize.mockRestore();
  });

  it("exactly restores committed admission evidence and drains a concurrent pause", async () => {
    const previousLastAttemptAt = new Date("2026-08-23T09:59:00.000Z");
    const admittedAt = new Date("2026-08-23T10:00:01.000Z");
    const recoveredAt = new Date("2026-08-23T10:00:02.000Z");
    const order: string[] = [];
    const finalize = vi.spyOn(
      WhatsAppSenderSafetyService,
      "finalizeRequestedPauseInTransaction"
    ).mockImplementation(async () => {
      order.push("pause-finalized");
      return { changed: true, pausePending: false, state: {} as never };
    });
    const tx = {
      $queryRaw: vi.fn()
        .mockImplementationOnce(async () => {
          order.push("message-locked");
          return [{ id: "message_1", providerCallAdmittedAt: admittedAt }];
        })
        .mockImplementationOnce(async () => {
          order.push("safety-locked");
          return [{ senderId: "sender_1" }];
        }),
      whatsAppMessage: {
        updateMany: vi.fn().mockImplementation(async () => {
          order.push("admission-restored");
          return { count: 1 };
        }),
      },
    };

    await expect(restorePreparedWhatsAppSubmissionAfterAdmissionErrorInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      messageId: "message_1",
      senderId: "sender_1",
      leaseToken: "lease_1",
      admittedAt,
      attemptCount: 3,
      previousAttemptCount: 2,
      previousLastAttemptAt,
      now: recoveredAt,
    })).resolves.toBe("HELD");

    expect(order).toEqual([
      "message-locked",
      "safety-locked",
      "admission-restored",
      "pause-finalized",
    ]);
    expect(tx.whatsAppMessage.updateMany).toHaveBeenCalledWith({
      where: {
        id: "message_1",
        senderId: "sender_1",
        leaseToken: "lease_1",
        status: "SUBMITTING",
        providerMessageId: null,
        providerCallAdmittedAt: admittedAt,
        attemptCount: 3,
        lastAttemptAt: admittedAt,
      },
      data: {
        status: "SCHEDULED",
        claimedAt: null,
        submissionStartedAt: null,
        providerCallAdmittedAt: null,
        attemptCount: 2,
        lastAttemptAt: previousLastAttemptAt,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(finalize).toHaveBeenCalledWith({
      tx,
      organizationId: "org_1",
      senderId: "sender_1",
      now: recoveredAt,
    });
    finalize.mockRestore();
  });

  it("leaves non-exact admission evidence for conservative stale recovery", async () => {
    const finalize = vi.spyOn(
      WhatsAppSenderSafetyService,
      "finalizeRequestedPauseInTransaction"
    ).mockResolvedValue({ changed: true, pausePending: false, state: {} as never });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      whatsAppMessage: { updateMany: vi.fn() },
    };

    await expect(restorePreparedWhatsAppSubmissionAfterAdmissionErrorInTransaction({
      tx: tx as never,
      organizationId: "org_1",
      messageId: "message_1",
      senderId: "sender_1",
      leaseToken: "lease_1",
      admittedAt: new Date("2026-08-23T10:00:01.000Z"),
      attemptCount: 3,
      previousAttemptCount: 2,
      previousLastAttemptAt: null,
      now: new Date("2026-08-23T10:00:02.000Z"),
    })).resolves.toBe("STALE");

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.whatsAppMessage.updateMany).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    finalize.mockRestore();
  });

  it("holds before database or provider work when delivery flags are absent", async () => {
    await expect(WhatsAppDispatcherService.run({
      env: { NODE_ENV: "test" },
    })).resolves.toMatchObject({ held: true, messagesClaimed: 0 });
  });

  it("retries only explicit provider throttling", () => {
    expect(classifyWhatsAppDispatchError(new MetaWhatsAppProviderError("limited", {
      kind: "RATE_LIMIT",
      status: 429,
      retryAfterSeconds: 90,
    }))).toBe("RATE_LIMIT");
    expect(classifyWhatsAppDispatchError(new MetaWhatsAppProviderError("rejected", {
      kind: "REQUEST",
      status: 400,
    }))).toBe("DEFINITE");
  });

  it("treats every possibly accepted outcome as ambiguous", () => {
    expect(classifyWhatsAppDispatchError(new MetaWhatsAppAmbiguousMutationError()))
      .toBe("AMBIGUOUS");
    expect(classifyWhatsAppDispatchError(new Error("connection reset")))
      .toBe("AMBIGUOUS");
  });

  it("bounds retry delay and never schedules an immediate tight loop", () => {
    const now = new Date("2026-08-23T10:00:00Z");
    expect(calculateWhatsAppRetryAt({
      now,
      attemptCount: 1,
      retryAfterSeconds: 90,
    }).toISOString()).toBe("2026-08-23T10:01:30.000Z");
    expect(calculateWhatsAppRetryAt({
      now,
      attemptCount: 3,
      retryAfterSeconds: 99_999,
    }).toISOString()).toBe("2026-08-23T10:15:00.000Z");
  });

  it("takes fresh operation-time readings and fences the provider timeout", () => {
    let current = new Date("2026-08-23T10:00:00.000Z");
    const source = vi.fn(() => current);
    const clock = createWhatsAppDispatchOperationClock({ clock: source });

    const first = clock();
    current = new Date("2026-08-23T10:03:00.000Z");
    const second = clock();

    expect(first.toISOString()).toBe("2026-08-23T10:00:00.000Z");
    expect(second.toISOString()).toBe("2026-08-23T10:03:00.000Z");
    expect(first).not.toBe(source.mock.results[0]!.value);
    expect(source).toHaveBeenCalledTimes(2);
    expect(WHATSAPP_DISPATCH_PROVIDER_LEASE_MS).toBeGreaterThan(
      META_GRAPH_MAX_TIMEOUT_MS
    );
    expect(second.getTime() + WHATSAPP_DISPATCH_PROVIDER_LEASE_MS).toBeGreaterThan(
      second.getTime() + META_GRAPH_MAX_TIMEOUT_MS
    );
  });

  it("preserves a fixed operation clock for deterministic dispatcher tests", () => {
    const now = new Date("2026-08-23T10:00:00.000Z");
    const clock = createWhatsAppDispatchOperationClock({ now });

    expect(clock()).toEqual(now);
    expect(clock()).toEqual(now);
  });

  it("claims only the validated Live delivery canary scope", () => {
    expect(resolveWhatsAppDispatchOrganizationScope({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      META_WHATSAPP_MODE: "LIVE",
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "org_b,org_a",
    })).toEqual(["org_a", "org_b"]);
    expect(resolveWhatsAppDispatchOrganizationScope({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      META_WHATSAPP_MODE: "LIVE",
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "org_a,org_a",
    })).toEqual([]);
    expect(resolveWhatsAppDispatchOrganizationScope({
      NODE_ENV: "test",
      VERCEL_ENV: "preview",
      META_WHATSAPP_MODE: "TEST",
    })).toBeNull();
  });

  it("projects attached orphan lifecycle and authoritative metadata without inventing cost", () => {
    const projection = projectAttachedWhatsAppWebhookEvents([
      {
        id: "event_read",
        status: "READ",
        providerTimestamp: new Date("2026-08-23T10:03:00Z"),
        receivedAt: new Date("2026-08-23T10:03:01Z"),
        providerRecipientWaId: "919876543210",
        providerBillable: true,
        providerPricingCategory: "UTILITY",
        safeErrorCode: null,
      },
      {
        id: "event_sent",
        status: "SENT",
        providerTimestamp: new Date("2026-08-23T10:01:00Z"),
        receivedAt: new Date("2026-08-23T10:01:01Z"),
        providerRecipientWaId: null,
        providerBillable: null,
        providerPricingCategory: null,
        safeErrorCode: null,
      },
      {
        id: "event_delivered",
        status: "DELIVERED",
        providerTimestamp: new Date("2026-08-23T10:02:00Z"),
        receivedAt: new Date("2026-08-23T10:02:01Z"),
        providerRecipientWaId: null,
        providerBillable: null,
        providerPricingCategory: null,
        safeErrorCode: null,
      },
    ]);

    expect(projection).toMatchObject({
      status: "READ",
      sentAt: new Date("2026-08-23T10:01:00Z"),
      deliveredAt: new Date("2026-08-23T10:02:00Z"),
      readAt: new Date("2026-08-23T10:03:00Z"),
      providerRecipientWaId: "919876543210",
      providerBillable: true,
      providerPricingCategory: "UTILITY",
      failureCode: null,
    });
    expect(projection).not.toHaveProperty("actualCostMicros");
  });
});
