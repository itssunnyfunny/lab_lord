import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processWebhookEvents } from "@/services/whatsappWebhook.service";
import { createTestWorld } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("WhatsApp inbound identity across envelopes", () => {
  beforeEach(async () => { await resetDatabase(); vi.stubEnv("WHATSAPP_REPORTS_ENABLED", "true");
    vi.stubEnv("WHATSAPP_INTEGRATION_ENABLED", "true"); });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(disconnectDatabase);
  it("counts one attempt per integration/message across rebatching and rolls back failed processing", async () => {
    const { user, branch } = await createTestWorld();
    const now = new Date();
    const senders = await Promise.all(["one", "two"].map(phoneNumberId => testPrisma.whatsAppSender.create({ data: {
      organizationId: branch.organizationId, provider: "META_CLOUD", providerMode: "TEST",
      wabaId: "test-waba", phoneNumberId, displayPhoneNumber: "+919876543210", status: "ACTIVE",
    } })));
    const subscriptions = await Promise.all(senders.map(sender => testPrisma.whatsAppReportSubscription.create({ data: {
      organizationId: branch.organizationId, branchId: branch.id, senderId: sender.id, userId: user.id,
      scope: "BRANCH", scopeKey: branch.id, phoneE164: "+919876543210", language: "en_IN",
      confirmationCodeHash: sender.id.padEnd(64, "0"), confirmationExpiresAt: new Date(now.getTime() + 60_000),
    } })));
    const event = { kind: "REPORT_CONFIRMATION" as const, providerMessageId: "wamid.same",
      phoneE164: "+919876543210", code: "ABCDEFGHJK" };
    for (const payloadHash of ["envelope-one", "rebatched-envelope"]) {
      await testPrisma.$transaction(tx => processWebhookEvents({ tx, sender: senders[0], events: [event], payloadHash, now }));
    }
    expect(await testPrisma.whatsAppReportSubscription.findUniqueOrThrow({ where: { id: subscriptions[0].id } }))
      .toMatchObject({ confirmationAttemptCount: 1 });
    await expect(testPrisma.$transaction(async tx => {
      await processWebhookEvents({ tx, sender: senders[1], events: [event], payloadHash: "failed", now });
      throw new Error("receipt finalization failed");
    })).rejects.toThrow("finalization");
    await testPrisma.$transaction(tx => processWebhookEvents({ tx, sender: senders[1], events: [event], payloadHash: "retry", now }));
    expect(await testPrisma.whatsAppReportSubscription.findUniqueOrThrow({ where: { id: subscriptions[1].id } }))
      .toMatchObject({ confirmationAttemptCount: 1 });
    expect(await testPrisma.whatsAppInboundMessageReceipt.count()).toBe(2);
  });
});
