import { describe, expect, it } from "vitest";

import {
  estimateWhatsAppUtilityCostMicros,
  getWhatsAppRateCardStatus,
  INR_MICROS_PER_PAISA,
  INR_MICROS_PER_RUPEE,
  paiseToInrMicros,
  readWhatsAppRateCard,
  resolveWhatsAppUtilityRate,
} from "@/lib/whatsappCost";

const validEnvironment = {
  WHATSAPP_UTILITY_RATE_MICROS_INR: "800000",
  WHATSAPP_RATE_CARD_VERSION: "in-utility-2026-08",
  WHATSAPP_RATE_CARD_EFFECTIVE_AT: "2026-08-01T00:00:00Z",
  WHATSAPP_RATE_CARD_EXPIRES_AT: "2026-09-01T00:00:00Z",
};

describe("WhatsApp cost configuration", () => {
  it("uses INR micros and paise without floating-point conversion", () => {
    expect(INR_MICROS_PER_RUPEE).toBe(1_000_000);
    expect(INR_MICROS_PER_PAISA).toBe(10_000);
    expect(paiseToInrMicros(125)).toBe(1_250_000);
    expect(estimateWhatsAppUtilityCostMicros({ messageCount: 3, rateMicros: 800_000 }))
      .toBe(2_400_000);
  });

  it("fails closed for absent, malformed, future, or unsupported rates", () => {
    expect(() => readWhatsAppRateCard({})).toThrow("unavailable");
    expect(() => readWhatsAppRateCard({
      ...validEnvironment,
      WHATSAPP_UTILITY_RATE_MICROS_INR: "0.8",
    })).toThrow("invalid");
    expect(() => resolveWhatsAppUtilityRate({
      recipientPhoneE164: "+14155550100",
      at: new Date("2026-08-23T00:00:00Z"),
      env: validEnvironment,
    })).toThrow("destination");
    expect(() => resolveWhatsAppUtilityRate({
      recipientPhoneE164: "+919876543210",
      at: new Date("2026-07-31T23:59:59Z"),
      env: validEnvironment,
    })).toThrow("not effective");
    expect(() => readWhatsAppRateCard({
      ...validEnvironment,
      WHATSAPP_RATE_CARD_EXPIRES_AT: "2026-08-01T00:00:00Z",
    })).toThrow("expiry date is invalid");
    expect(() => readWhatsAppRateCard({
      ...validEnvironment,
      WHATSAPP_RATE_CARD_EXPIRES_AT: "2026-07-31T23:59:59Z",
    })).toThrow("expiry date is invalid");
    expect(() => resolveWhatsAppUtilityRate({
      recipientPhoneE164: "+919876543210",
      at: new Date("2026-09-01T00:00:00Z"),
      env: validEnvironment,
    })).toThrow("expired");
  });

  it("returns the exact versioned +91 utility rate", () => {
    expect(resolveWhatsAppUtilityRate({
      recipientPhoneE164: "+919876543210",
      at: new Date("2026-08-23T00:00:00Z"),
      env: validEnvironment,
    })).toMatchObject({ currency: "INR", rateMicros: 800_000, version: "in-utility-2026-08" });
    const card = readWhatsAppRateCard(validEnvironment);
    expect(card.expiresAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(getWhatsAppRateCardStatus(card, new Date("2026-08-20T00:00:00Z"))).toBe("VALID");
    expect(getWhatsAppRateCardStatus(card, new Date("2026-08-26T00:00:00Z"))).toBe("EXPIRING");
  });

  it("accepts valid UTC leap days and normalizes omitted milliseconds", () => {
    const card = readWhatsAppRateCard({
      ...validEnvironment,
      WHATSAPP_RATE_CARD_EFFECTIVE_AT: "2024-02-29T23:59:59Z",
      WHATSAPP_RATE_CARD_EXPIRES_AT: "2024-03-01T00:00:00.123Z",
    });

    expect(card.effectiveAt.toISOString()).toBe("2024-02-29T23:59:59.000Z");
    expect(card.expiresAt.toISOString()).toBe("2024-03-01T00:00:00.123Z");
  });

  it.each([
    ["WHATSAPP_RATE_CARD_EFFECTIVE_AT", "2026-02-30T00:00:00Z", "effective"],
    ["WHATSAPP_RATE_CARD_EFFECTIVE_AT", "2025-02-29T00:00:00Z", "effective"],
    ["WHATSAPP_RATE_CARD_EFFECTIVE_AT", "2026-04-31T00:00:00.000Z", "effective"],
    ["WHATSAPP_RATE_CARD_EFFECTIVE_AT", "2026-01-01T24:00:00Z", "effective"],
    ["WHATSAPP_RATE_CARD_EFFECTIVE_AT", "2026-01-01T00:00:00.12Z", "effective"],
    ["WHATSAPP_RATE_CARD_EXPIRES_AT", "2026-09-01T23:60:00Z", "expiry"],
    ["WHATSAPP_RATE_CARD_EXPIRES_AT", "2026-09-01T23:59:60Z", "expiry"],
    ["WHATSAPP_RATE_CARD_EXPIRES_AT", "2026-09-01T23:59:59+00:00", "expiry"],
  ])("rejects non-calendar UTC %s value %s", (name, value, label) => {
    expect(() => readWhatsAppRateCard({
      ...validEnvironment,
      [name]: value,
    })).toThrow(`rate-card ${label} date is invalid`);
  });
});
