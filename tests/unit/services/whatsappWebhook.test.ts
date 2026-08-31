import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_META_WEBHOOK_BYTES,
  MAX_META_WEBHOOK_EVENTS,
  META_WEBHOOK_ACCEPTED_RESPONSE,
  extractMetaWebhookEvents,
  isExactWhatsAppStopCommand,
  parseMetaWebhookEnvelope,
  readBoundedWebhookBody,
  verifyMetaWebhookChallenge,
  verifyMetaWebhookSignature,
} from "@/services/whatsappWebhook.service";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Meta webhook trust boundary", () => {
  it("verifies HMAC over the exact raw bytes with the exact configured secret", () => {
    const secret = "  exact webhook secret  ";
    const raw = Buffer.from('{"object":"whatsapp_business_account","unicode":"नमस्ते"}', "utf8");
    vi.stubEnv("META_APP_SECRET", secret);
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const trimmedSignature = `sha256=${createHmac("sha256", secret.trim()).update(raw).digest("hex")}`;

    expect(verifyMetaWebhookSignature(raw, signature)).toBe(true);
    expect(verifyMetaWebhookSignature(raw, trimmedSignature)).toBe(false);
    expect(verifyMetaWebhookSignature(raw, "sha256=not-hex")).toBe(false);
  });

  it("compares the verification token exactly and fails closed without ingest gates", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("META_WHATSAPP_MODE", "TEST");
    vi.stubEnv("WHATSAPP_INTEGRATION_ENABLED", "true");
    vi.stubEnv("WHATSAPP_WEBHOOK_INGEST_ENABLED", "true");
    vi.stubEnv("META_WHATSAPP_WEBHOOK_VERIFY_TOKEN", " verify token ");

    expect(verifyMetaWebhookChallenge({
      mode: "subscribe",
      token: " verify token ",
      challenge: "bounded-challenge",
    })).toBe("bounded-challenge");
    expect(verifyMetaWebhookChallenge({
      mode: "subscribe",
      token: "verify token",
      challenge: "bounded-challenge",
    })).toBeNull();

    vi.stubEnv("WHATSAPP_WEBHOOK_INGEST_ENABLED", "false");
    expect(() => verifyMetaWebhookChallenge({
      mode: "subscribe",
      token: " verify token ",
      challenge: "bounded-challenge",
    })).toThrow();
  });

  it("accepts only the WhatsApp business object and bounded envelope shape", () => {
    const valid = Buffer.from(JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "123", changes: [{ field: "messages", value: {} }] }],
    }));
    expect(parseMetaWebhookEnvelope(valid)).toMatchObject({
      object: "whatsapp_business_account",
    });
    expect(() => parseMetaWebhookEnvelope(Buffer.from(JSON.stringify({
      object: "page",
      entry: [],
    })))).toThrow();
  });

  it("rejects a declared body above 512 KiB before reading it", async () => {
    const request = new Request("https://app.example.test/api/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Length": String(MAX_META_WEBHOOK_BYTES + 1) },
      body: "x",
    });
    await expect(readBoundedWebhookBody(request)).rejects.toThrow("too large");
  });

  it("defines one generic success projection for known, unknown, and duplicate events", () => {
    expect(META_WEBHOOK_ACCEPTED_RESPONSE).toEqual({ accepted: true });
    expect(Object.keys(META_WEBHOOK_ACCEPTED_RESPONSE)).toEqual(["accepted"]);
  });

  it("normalizes only supported status evidence and retains authoritative pricing fields", () => {
    const parsed = parseMetaWebhookEnvelope(Buffer.from(JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "123",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "456" },
            statuses: [
              {
                id: "wamid.HBgMTA",
                status: "delivered",
                timestamp: "1700000000",
                recipient_id: "919876543210",
                pricing: { billable: true, category: "utility" },
              },
              { id: "wamid.ignored", status: "deleted", timestamp: "1700000001" },
              {
                id: "wamid.failed",
                status: "failed",
                timestamp: "1700000002",
                errors: [{ code: 131026, title: "must not be retained" }],
              },
            ],
          },
        }],
      }],
    })));

    expect(extractMetaWebhookEvents(parsed)).toEqual([
      {
        kind: "STATUS",
        providerMessageId: "wamid.HBgMTA",
        status: "DELIVERED",
        providerTimestamp: new Date("2023-11-14T22:13:20.000Z"),
        providerRecipientWaId: "919876543210",
        providerBillable: true,
        providerPricingCategory: "UTILITY",
        safeErrorCode: null,
      },
      {
        kind: "STATUS",
        providerMessageId: "wamid.failed",
        status: "FAILED",
        providerTimestamp: new Date("2023-11-14T22:13:22.000Z"),
        providerRecipientWaId: null,
        providerBillable: null,
        providerPricingCategory: null,
        safeErrorCode: "META_131026",
      },
    ]);
  });

  it("accepts the same bounded opaque WAMID range as provider-response finalization", () => {
    const providerMessageId = `wamid.${"!".repeat(499)}~`;
    const parsed = parseMetaWebhookEnvelope(Buffer.from(JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "123",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "456" },
            statuses: [{
              id: providerMessageId,
              status: "sent",
              timestamp: "1700000000",
            }],
          },
        }],
      }],
    })));

    expect(extractMetaWebhookEvents(parsed)).toEqual([
      expect.objectContaining({
        kind: "STATUS",
        providerMessageId,
        status: "SENT",
      }),
    ]);
  });

  it("accepts exact normalized STOP commands and the exact managed reply ID only", () => {
    expect(isExactWhatsAppStopCommand({ type: "text", text: " stop " })).toBe(true);
    expect(isExactWhatsAppStopCommand({
      type: "button",
      buttonPayload: "LABLORDS_STOP_UPDATES",
    })).toBe(true);
    expect(isExactWhatsAppStopCommand({
      type: "interactive",
      interactiveButtonId: "LABLORDS_STOP_UPDATES",
    })).toBe(true);

    for (const text of ["stop by tomorrow", "please don't stop", "PAID", "DONE", "START"] ) {
      expect(isExactWhatsAppStopCommand({ type: "text", text })).toBe(false);
    }
    expect(isExactWhatsAppStopCommand({
      type: "button",
      buttonPayload: "STOP",
    })).toBe(false);
    expect(isExactWhatsAppStopCommand({
      type: "button",
      buttonPayload: " LABLORDS_STOP_UPDATES ",
    })).toBe(false);
    expect(isExactWhatsAppStopCommand({
      type: "interactive",
      interactiveButtonId: "lablords_stop_updates",
    })).toBe(false);
  });

  it("deduplicates report commands by inbound provider message identity", () => {
    const parsed = parseMetaWebhookEnvelope(Buffer.from(JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "123",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "456" },
            messages: [
              {
                id: "wamid.expired-confirmation",
                from: "919876543210",
                type: "text",
                text: { body: "START REPORTS ABCDEFGHJK" },
              },
              {
                id: "wamid.valid-confirmation",
                from: "919876543210",
                type: "text",
                text: { body: "START REPORTS KJHGFEDCBA" },
              },
              {
                id: "wamid.valid-confirmation",
                from: "919876543210",
                type: "text",
                text: { body: "START REPORTS KJHGFEDCBA" },
              },
            ],
          },
        }],
      }],
    })));

    expect(extractMetaWebhookEvents(parsed)).toEqual([
      {
        kind: "REPORT_CONFIRMATION",
        providerMessageId: "wamid.expired-confirmation",
        phoneE164: "+919876543210",
        code: "ABCDEFGHJK",
      },
      {
        kind: "REPORT_CONFIRMATION",
        providerMessageId: "wamid.valid-confirmation",
        phoneE164: "+919876543210",
        code: "KJHGFEDCBA",
      },
    ]);
  });

  it("extracts template status and category updates without retaining provider reasons", () => {
    const parsed = parseMetaWebhookEnvelope(Buffer.from(JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "123",
        changes: [
          {
            field: "message_template_status_update",
            value: {
              event: "PAUSED",
              message_template_id: "template123",
              message_template_name: "lablords_fee_v1",
              message_template_language: "en_US",
              reason: "provider text must be discarded",
            },
          },
          {
            field: "template_category_update",
            value: {
              message_template_id: "template123",
              correct_category: "MARKETING",
            },
          },
        ],
      }],
    })));

    expect(extractMetaWebhookEvents(parsed)).toEqual([
      {
        kind: "TEMPLATE",
        providerTemplateId: "template123",
        name: "lablords_fee_v1",
        language: "en_US",
        providerStatus: "PAUSED",
        category: null,
      },
      {
        kind: "TEMPLATE",
        providerTemplateId: "template123",
        name: null,
        language: null,
        providerStatus: null,
        category: "MARKETING",
      },
    ]);
  });

  it("rejects envelopes whose bounded event count is exceeded", () => {
    expect(MAX_META_WEBHOOK_EVENTS).toBe(200);
    expect(() => parseMetaWebhookEnvelope(Buffer.from(JSON.stringify({
      object: "whatsapp_business_account",
      entry: Array.from({ length: 100 }, (_, entryIndex) => ({
        id: String(entryIndex + 1),
        changes: Array.from({ length: 3 }, (_, changeIndex) => ({
          field: `field_${changeIndex}`,
          value: {},
        })),
      })),
    })))).toThrow();
  });
});
