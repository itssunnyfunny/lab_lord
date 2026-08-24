import { describe, expect, it, vi } from "vitest";
import {
  calculateWhatsAppRetryAt,
  classifyWhatsAppDispatchError,
  createWhatsAppDispatchOperationClock,
  projectAttachedWhatsAppWebhookEvents,
  resolveWhatsAppDispatchOrganizationScope,
  WHATSAPP_DISPATCH_PROVIDER_LEASE_MS,
  WhatsAppDispatcherService,
} from "@/services/whatsappDispatcher.service";
import {
  META_GRAPH_MAX_TIMEOUT_MS,
  MetaWhatsAppAmbiguousMutationError,
  MetaWhatsAppProviderError,
} from "@/lib/metaWhatsApp";

describe("WhatsApp dispatcher outcome policy", () => {
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
