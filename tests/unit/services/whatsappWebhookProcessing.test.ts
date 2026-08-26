import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    whatsAppSender: {
      updateMany: vi.fn(),
    },
    whatsAppReportSubscription: {
      updateMany: vi.fn(),
    },
    whatsAppWebhookReceipt: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    whatsAppMessage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    whatsAppMessageEvent: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    whatsAppConsent: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    whatsAppConsentEvent: {
      create: vi.fn(),
    },
    whatsAppAuditEvent: {
      create: vi.fn(),
    },
    whatsAppTemplate: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    whatsAppTemplateBinding: {
      updateMany: vi.fn(),
    },
  };
  return {
    tx,
    senderFindUnique: vi.fn(),
    senderFindMany: vi.fn(),
    receiptFindUnique: vi.fn(),
    receiptCreate: vi.fn(),
    receiptUpdateMany: vi.fn(),
    schemaProbe: vi.fn(),
    transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    disableSenderPhone: vi.fn(),
    recordDelivered: vi.fn(),
    resolveIncident: vi.fn(),
    createOrTouchIncident: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    whatsAppSender: {
      findUnique: mocks.senderFindUnique,
      findMany: mocks.senderFindMany,
    },
    whatsAppWebhookReceipt: {
      findUnique: mocks.receiptFindUnique,
      create: mocks.receiptCreate,
      updateMany: mocks.receiptUpdateMany,
    },
    $transaction: mocks.transaction,
    $queryRaw: mocks.schemaProbe,
  },
}));

vi.mock("@/lib/whatsappSchema", () => ({
  isWhatsAppDeliverySchemaReady: mocks.schemaProbe,
}));

vi.mock("@/services/whatsappRecipient.service", () => ({
  WhatsAppRecipientService: {
    disableSenderPhoneInTransaction: mocks.disableSenderPhone,
  },
}));

vi.mock("@/services/whatsappSenderSafety.service", () => ({
  WhatsAppSenderSafetyService: {
    recordDeliveredInTransaction: mocks.recordDelivered,
  },
}));

vi.mock("@/services/whatsappIncident.service", () => ({
  WhatsAppIncidentService: {
    resolveInTransaction: mocks.resolveIncident,
    createOrTouchInTransaction: mocks.createOrTouchIncident,
  },
}));

import {
  META_WEBHOOK_ACCEPTED_RESPONSE,
  WhatsAppWebhookService,
} from "@/services/whatsappWebhook.service";

const SECRET = "webhook-processing-secret";
const NOW = new Date("2026-08-23T08:00:00.000Z");

function signedRequest(payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", SECRET).update(raw).digest("hex");
  return new Request("https://app.example.test/api/whatsapp/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: raw,
  });
}

function messagesEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba123",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "phone123" },
          ...value,
        },
      }],
    }],
  };
}

function templateEnvelope(field: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba123", changes: [{ field, value }] }],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("META_WHATSAPP_MODE", "TEST");
  vi.stubEnv("WHATSAPP_INTEGRATION_ENABLED", "true");
  vi.stubEnv("WHATSAPP_WEBHOOK_INGEST_ENABLED", "true");
  vi.stubEnv("WHATSAPP_META_MESSAGE_WRITES_ENABLED", "true");
  vi.stubEnv("META_APP_SECRET", SECRET);

  mocks.senderFindUnique.mockResolvedValue({
    id: "sender_1",
    organizationId: "org_1",
    wabaId: "waba123",
  });
  mocks.senderFindMany.mockResolvedValue([]);
  mocks.receiptFindUnique.mockResolvedValue(null);
  mocks.receiptCreate.mockResolvedValue({ id: "receipt_1", status: "RECEIVED" });
  mocks.receiptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.schemaProbe.mockResolvedValue(false);
  mocks.tx.whatsAppWebhookReceipt.findFirst.mockResolvedValue({ id: "receipt_1" });
  mocks.tx.$queryRaw.mockResolvedValue([{ id: "sender_1" }]);
  mocks.tx.whatsAppSender.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.whatsAppReportSubscription.updateMany.mockResolvedValue({ count: 0 });
  mocks.tx.whatsAppWebhookReceipt.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.whatsAppMessageEvent.createMany.mockResolvedValue({ count: 1 });
  mocks.tx.whatsAppMessageEvent.deleteMany.mockResolvedValue({ count: 0 });
  mocks.tx.whatsAppMessageEvent.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.whatsAppMessage.findMany.mockResolvedValue([]);
  mocks.tx.whatsAppMessage.updateMany.mockResolvedValue({ count: 1 });
  mocks.recordDelivered.mockResolvedValue(undefined);
  mocks.resolveIncident.mockResolvedValue({ count: 0 });
  mocks.createOrTouchIncident.mockResolvedValue({ id: "incident_1" });
  mocks.disableSenderPhone.mockResolvedValue({
    disabledCount: 0,
    cancelledCount: 0,
    releasedReservationCount: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("WhatsApp webhook durable processing", () => {
  it("rejects an invalid signature before probing migration metadata or any tenant row", async () => {
    const request = new Request("https://app.example.test/api/whatsapp/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body: JSON.stringify(messagesEnvelope({})),
    });

    await expect(WhatsAppWebhookService.handle(request)).rejects.toThrow("Invalid webhook signature");
    expect(mocks.schemaProbe).not.toHaveBeenCalled();
    expect(mocks.senderFindUnique).not.toHaveBeenCalled();
    expect(mocks.receiptCreate).not.toHaveBeenCalled();
  });

  it("leases a receipt, appends a deduped event, and projects authoritative status metadata", async () => {
    mocks.tx.whatsAppMessage.findFirst.mockResolvedValue({ id: "message_1" });
    mocks.tx.whatsAppMessageEvent.findUnique.mockResolvedValue({
      id: "event_1",
      messageId: "message_1",
      senderId: "sender_1",
      providerMessageId: "wamid.status1",
    });
    mocks.tx.whatsAppMessage.findUnique.mockResolvedValue({
      id: "message_1",
      status: "ACCEPTED",
      updatedAt: new Date("2026-08-23T07:59:00.000Z"),
      providerStatusTimestamp: null,
      providerRecipientWaId: null,
      providerBillable: null,
      providerPricingCategory: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
    });

    const result = await WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      statuses: [{
        id: "wamid.status1",
        status: "delivered",
        timestamp: "1787471940",
        recipient_id: "919876543210",
        pricing: { billable: true, category: "utility" },
      }],
    })));

    expect(result).toEqual(META_WEBHOOK_ACCEPTED_RESPONSE);
    expect(mocks.receiptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { status: { in: ["RECEIVED", "FAILED"] } },
        ]),
      }),
      data: expect.objectContaining({
        status: "PROCESSING",
        attemptCount: { increment: 1 },
      }),
    }));
    expect(mocks.tx.whatsAppMessageEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        messageId: "message_1",
        senderId: "sender_1",
        providerMessageId: "wamid.status1",
        source: "PROVIDER_WEBHOOK",
        status: "DELIVERED",
        providerRecipientWaId: "919876543210",
        providerBillable: true,
        providerPricingCategory: "UTILITY",
        safeErrorCode: null,
      })],
      skipDuplicates: true,
    });
    const projection = mocks.tx.whatsAppMessage.updateMany.mock.calls[0]?.[0];
    expect(projection.data).toMatchObject({
      status: "DELIVERED",
      providerRecipientWaId: "919876543210",
      providerBillable: true,
      providerPricingCategory: "UTILITY",
    });
    expect(projection.data).not.toHaveProperty("actualCostMicros");
    expect(mocks.tx.whatsAppWebhookReceipt.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PROCESSED", leaseToken: null }),
      })
    );
  });

  it("resolves UNKNOWN when later signed provider delivery evidence arrives", async () => {
    mocks.tx.whatsAppMessage.findFirst.mockResolvedValue({ id: "message_unknown" });
    mocks.tx.whatsAppMessageEvent.findUnique.mockResolvedValue({
      id: "event_unknown",
      messageId: "message_unknown",
      senderId: "sender_1",
      providerMessageId: "wamid.unknown1",
    });
    mocks.tx.whatsAppMessage.findUnique.mockResolvedValue({
      id: "message_unknown",
      status: "UNKNOWN",
      updatedAt: new Date("2026-08-23T07:59:00.000Z"),
      providerStatusTimestamp: null,
      providerRecipientWaId: null,
      providerBillable: null,
      providerPricingCategory: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
    });

    await WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      statuses: [{
        id: "wamid.unknown1",
        status: "sent",
        timestamp: "1787471940",
      }],
    })));

    expect(mocks.tx.whatsAppMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SENT",
        failureCode: null,
        safeFailureMessage: null,
      }),
    }));
  });

  it("retains a bounded orphan event when provider finalization has not linked a message", async () => {
    mocks.tx.whatsAppMessage.findFirst.mockResolvedValue(null);

    await WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      statuses: [{
        id: "wamid.orphan1",
        status: "sent",
        timestamp: "1787471940",
      }],
    })));

    expect(mocks.tx.whatsAppMessageEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        messageId: null,
        providerMessageId: "wamid.orphan1",
        expiresAt: new Date("2026-08-30T08:00:00.000Z"),
      })],
      skipDuplicates: true,
    });
    expect(mocks.tx.whatsAppMessage.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.whatsAppMessage.updateMany).not.toHaveBeenCalled();
  });

  it("routes each signed entry/change to its own sender and scopes STOP dedupe by sender", async () => {
    mocks.senderFindUnique.mockImplementation(async (input: {
      where: { provider_providerMode_phoneNumberId: { phoneNumberId: string } };
    }) => {
      const phoneNumberId = input.where.provider_providerMode_phoneNumberId.phoneNumberId;
      if (phoneNumberId === "phone123") {
        return { id: "sender_1", organizationId: "org_1", wabaId: "waba123" };
      }
      if (phoneNumberId === "phone456") {
        return { id: "sender_2", organizationId: "org_2", wabaId: "waba456" };
      }
      return null;
    });
    mocks.tx.whatsAppConsent.findUnique.mockResolvedValue({ status: "OPTED_OUT" });

    await WhatsAppWebhookService.handle(signedRequest({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba123",
          changes: [{
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone123" },
              messages: [{
                id: "wamid.stop1",
                from: "919876543210",
                type: "text",
                text: { body: "STOP" },
              }],
            },
          }],
        },
        {
          id: "waba456",
          changes: [{
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone456" },
              messages: [{
                id: "wamid.stop2",
                from: "919876543210",
                type: "text",
                text: { body: "STOP" },
              }],
            },
          }],
        },
      ],
    }));

    expect(mocks.disableSenderPhone).toHaveBeenCalledTimes(2);
    expect(mocks.disableSenderPhone).toHaveBeenNthCalledWith(1, expect.objectContaining({
      organizationId: "org_1",
      senderId: "sender_1",
      phoneE164: "+919876543210",
    }));
    expect(mocks.disableSenderPhone).toHaveBeenNthCalledWith(2, expect.objectContaining({
      organizationId: "org_2",
      senderId: "sender_2",
      phoneE164: "+919876543210",
    }));
    expect(mocks.receiptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: null, senderId: null }),
    }));
  });

  it("returns success for a fully processed duplicate without claiming it again", async () => {
    mocks.receiptFindUnique.mockResolvedValue({
      id: "receipt_1",
      status: "PROCESSED",
    });

    await expect(WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({})))).resolves
      .toEqual(META_WEBHOOK_ACCEPTED_RESPONSE);
    expect(mocks.receiptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("uses only the PR2 receipt projection and ignores delivery events while every PR3 flag is off", async () => {
    vi.stubEnv("WHATSAPP_META_MESSAGE_WRITES_ENABLED", "false");

    await expect(WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      statuses: [{ id: "wamid.held1", status: "sent", timestamp: "1787471940" }],
    })))).resolves.toEqual(META_WEBHOOK_ACCEPTED_RESPONSE);

    expect(mocks.receiptFindUnique).toHaveBeenCalledWith({
      where: { dedupeKey: expect.any(String) },
      select: { id: true, status: true },
    });
    expect(mocks.receiptCreate).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, status: true },
    }));
    expect(mocks.receiptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "IGNORED" }),
    }));
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.tx.whatsAppMessageEvent.createMany).not.toHaveBeenCalled();
  });

  it("continues signed status projection after migration when every write kill switch is off", async () => {
    vi.stubEnv("WHATSAPP_META_MESSAGE_WRITES_ENABLED", "false");
    mocks.schemaProbe.mockResolvedValue(true);
    mocks.tx.whatsAppMessage.findFirst.mockResolvedValue({ id: "message_kill_switch" });
    mocks.tx.whatsAppMessageEvent.findUnique.mockResolvedValue({
      id: "event_kill_switch",
      messageId: "message_kill_switch",
      senderId: "sender_1",
      providerMessageId: "wamid.kill1",
    });
    mocks.tx.whatsAppMessage.findUnique.mockResolvedValue({
      id: "message_kill_switch",
      status: "ACCEPTED",
      updatedAt: new Date("2026-08-23T07:59:00.000Z"),
      providerStatusTimestamp: null,
      providerRecipientWaId: null,
      providerBillable: null,
      providerPricingCategory: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
    });

    await WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      statuses: [{ id: "wamid.kill1", status: "sent", timestamp: "1787471940" }],
    })));

    expect(mocks.tx.whatsAppMessageEvent.createMany).toHaveBeenCalled();
    expect(mocks.tx.whatsAppMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SENT" }),
    }));
  });

  it("does not acknowledge an active processing duplicate before side effects commit", async () => {
    mocks.receiptFindUnique.mockResolvedValue({
      id: "receipt_1",
      status: "PROCESSING",
    });
    mocks.receiptUpdateMany.mockResolvedValue({ count: 0 });

    await expect(WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({}))))
      .rejects.toThrow("already processing");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("allows failed and stale processing receipts to be reclaimed by compare-and-set", async () => {
    mocks.receiptFindUnique.mockResolvedValue({ id: "receipt_1", status: "FAILED" });

    await WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({})));
    expect(mocks.receiptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: "PROCESSING",
            OR: expect.arrayContaining([{ leaseUntil: { lt: NOW } }]),
          }),
        ]),
      }),
    }));
  });

  it("marks a claimed receipt failed and throws when durable processing fails", async () => {
    mocks.tx.whatsAppMessage.findFirst.mockResolvedValue({ id: "message_1" });
    mocks.tx.whatsAppMessageEvent.createMany.mockRejectedValue(new Error("database unavailable"));

    await expect(WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      statuses: [{ id: "wamid.failure1", status: "sent", timestamp: "1787471940" }],
    })))).rejects.toThrow("database unavailable");
    expect(mocks.receiptUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: {
        status: "FAILED",
        failureCode: "PROCESSING_FAILED",
        processedAt: null,
        leaseToken: null,
        leaseUntil: null,
      },
    }));
  });

  it("fails the receipt when status projection exhausts optimistic retries", async () => {
    mocks.tx.whatsAppMessage.findFirst.mockResolvedValue({ id: "message_conflict" });
    mocks.tx.whatsAppMessageEvent.findUnique.mockResolvedValue({
      id: "event_conflict",
      messageId: "message_conflict",
      senderId: "sender_1",
      providerMessageId: "wamid.conflict1",
    });
    mocks.tx.whatsAppMessage.findUnique.mockResolvedValue({
      id: "message_conflict",
      status: "ACCEPTED",
      updatedAt: new Date("2026-08-23T07:59:00.000Z"),
      providerStatusTimestamp: null,
      providerRecipientWaId: null,
      providerBillable: null,
      providerPricingCategory: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
    });
    mocks.tx.whatsAppMessage.updateMany.mockResolvedValue({ count: 0 });

    await expect(WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      statuses: [{ id: "wamid.conflict1", status: "sent", timestamp: "1787471940" }],
    })))).rejects.toThrow("status projection conflicted repeatedly");

    expect(mocks.tx.whatsAppMessage.findUnique).toHaveBeenCalledTimes(3);
    expect(mocks.tx.whatsAppMessage.updateMany).toHaveBeenCalledTimes(3);
    expect(mocks.receiptUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "receipt_1",
        status: "PROCESSING",
      }),
      data: expect.objectContaining({
        status: "FAILED",
        failureCode: "PROCESSING_FAILED",
      }),
    }));
  });

  it("opts out all sender-scoped consent types and disables mappings for exact STOP", async () => {
    mocks.tx.whatsAppConsent.findUnique.mockResolvedValue(null);
    mocks.tx.whatsAppConsent.create
      .mockResolvedValueOnce({ id: "consent_operational", policyVersion: null })
      .mockResolvedValueOnce({ id: "consent_marketing", policyVersion: null })
      .mockResolvedValueOnce({ id: "consent_owner", policyVersion: null });
    mocks.disableSenderPhone.mockResolvedValue({
      disabledCount: 2,
      cancelledCount: 3,
      releasedReservationCount: 3,
    });

    await WhatsAppWebhookService.handle(signedRequest(messagesEnvelope({
      messages: [{
        id: "wamid.inbound1",
        from: "919876543210",
        timestamp: "1787471940",
        type: "text",
        text: { body: " STOP " },
      }],
    })));

    expect(mocks.tx.whatsAppConsent.create).toHaveBeenCalledTimes(3);
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.tx.whatsAppConsent.create.mock.calls.map(call => call[0].data.consentType))
      .toEqual(["OPERATIONAL", "MARKETING", "OWNER_REPORT"]);
    expect(mocks.tx.whatsAppConsentEvent.create).toHaveBeenCalledTimes(3);
    expect(mocks.disableSenderPhone).toHaveBeenCalledWith({
      tx: mocks.tx,
      organizationId: "org_1",
      senderId: "sender_1",
      phoneE164: "+919876543210",
      now: NOW,
    });
    expect(mocks.tx.whatsAppAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        details: {
          reason: "INBOUND_STOP",
          consentChangedCount: 3,
          disabledRecipientCount: 2,
          cancelledMessageCount: 3,
          releasedReservationCount: 3,
          pausedReportSubscriptionCount: 0,
        },
      }),
    });
    expect(JSON.stringify(mocks.tx.whatsAppAuditEvent.create.mock.calls))
      .not.toContain("+919876543210");
  });

  it("deactivates an unsafe template binding and suppresses only unsubmitted messages", async () => {
    mocks.senderFindUnique.mockResolvedValue(null);
    mocks.senderFindMany.mockResolvedValue([{
      id: "sender_1",
      organizationId: "org_1",
      wabaId: "waba123",
    }]);
    mocks.tx.whatsAppTemplate.findFirst.mockResolvedValue({
      id: "template_1",
      providerStatus: "APPROVED",
      category: "UTILITY",
      binding: { id: "binding_1" },
    });
    mocks.tx.whatsAppTemplate.update.mockResolvedValue({ id: "template_1" });

    await WhatsAppWebhookService.handle(signedRequest(templateEnvelope(
      "message_template_status_update",
      {
        event: "PAUSED",
        message_template_id: "template123",
        message_template_name: "lablords_fee_v1",
        message_template_language: "en_US",
      }
    )));

    expect(mocks.tx.whatsAppTemplate.update).toHaveBeenCalledWith({
      where: { id: "template_1" },
      data: { providerStatus: "PAUSED", lastSyncedAt: NOW },
    });
    expect(mocks.tx.whatsAppTemplateBinding.updateMany).toHaveBeenCalledWith({
      where: { id: "binding_1", active: true },
      data: { active: false },
    });
    expect(mocks.tx.whatsAppMessage.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.tx.whatsAppMessage.updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { status: "SCHEDULED" },
            { status: "CLAIMED", submissionStartedAt: null },
          ],
          budgetState: "RESERVED",
        }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          failureCode: "TEMPLATE_UNAVAILABLE",
          budgetState: "RELEASED",
        }),
      })
    );
  });

  it("fans a phone-less WABA template reclassification out to every connected sender", async () => {
    mocks.senderFindUnique.mockResolvedValue(null);
    mocks.senderFindMany.mockResolvedValue([
      { id: "sender_1", organizationId: "org_1", wabaId: "waba123" },
      { id: "sender_2", organizationId: "org_1", wabaId: "waba123" },
    ]);
    mocks.tx.whatsAppTemplate.findFirst
      .mockResolvedValueOnce({
        id: "template_1",
        providerStatus: "APPROVED",
        category: "UTILITY",
        binding: { id: "binding_1" },
      })
      .mockResolvedValueOnce({
        id: "template_2",
        providerStatus: "APPROVED",
        category: "UTILITY",
        binding: { id: "binding_2" },
      });
    mocks.tx.whatsAppTemplate.update.mockResolvedValue({});

    await WhatsAppWebhookService.handle(signedRequest(templateEnvelope(
      "template_category_update",
      {
        message_template_id: "template123",
        correct_category: "MARKETING",
      }
    )));

    expect(mocks.tx.whatsAppTemplate.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ senderId: "sender_1" }),
    }));
    expect(mocks.tx.whatsAppTemplate.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ senderId: "sender_2" }),
    }));
    expect(mocks.tx.whatsAppTemplateBinding.updateMany).toHaveBeenCalledTimes(2);
  });
});
