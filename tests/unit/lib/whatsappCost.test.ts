import { describe, expect, it } from "vitest";

import {
  estimateWhatsAppUtilityCostMicros,
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
  });

  it("returns the exact versioned +91 utility rate", () => {
    expect(resolveWhatsAppUtilityRate({
      recipientPhoneE164: "+919876543210",
      at: new Date("2026-08-23T00:00:00Z"),
      env: validEnvironment,
    })).toMatchObject({ currency: "INR", rateMicros: 800_000, version: "in-utility-2026-08" });
  });
});
