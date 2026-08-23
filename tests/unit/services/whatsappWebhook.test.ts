import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_META_WEBHOOK_BYTES,
  META_WEBHOOK_ACCEPTED_RESPONSE,
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
});
