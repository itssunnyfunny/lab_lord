import { describe, expect, it } from "vitest";

import {
  generateWhatsAppReportConfirmationCode,
  hashWhatsAppReportConfirmationCode,
  matchesWhatsAppReportConfirmationHash,
  normalizeWhatsAppReportConfirmationCode,
  WHATSAPP_REPORT_CONFIRMATION_CODE_LENGTH,
} from "@/lib/whatsappReportConfirmation";

describe("WhatsApp report confirmation challenges", () => {
  it("creates a ten-character ambiguity-free challenge", () => {
    const code = generateWhatsAppReportConfirmationCode(size =>
      Buffer.from(Array.from({ length: size }, (_, index) => index))
    );
    expect(code).toHaveLength(WHATSAPP_REPORT_CONFIRMATION_CODE_LENGTH);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    expect(normalizeWhatsAppReportConfirmationCode(`  ${code.toLowerCase()}  `)).toBe(code);
  });

  it("rejects ambiguous or partial codes", () => {
    expect(() => normalizeWhatsAppReportConfirmationCode("START REPORTS ABCD234XYZ"))
      .toThrow("invalid");
    expect(() => normalizeWhatsAppReportConfirmationCode("ABCDO34IYZ"))
      .toThrow("invalid");
  });

  it("binds the stored hash to sender, subscription, and normalized phone", () => {
    const base = {
      senderId: "sender_1",
      subscriptionId: "subscription_1",
      phoneE164: "+919876543210",
      code: "ABCDEFGHJK",
    };
    const hash = hashWhatsAppReportConfirmationCode(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(matchesWhatsAppReportConfirmationHash(hash, hash)).toBe(true);
    expect(hashWhatsAppReportConfirmationCode({ ...base, senderId: "sender_2" }))
      .not.toBe(hash);
    expect(matchesWhatsAppReportConfirmationHash(hash, "not-a-hash")).toBe(false);
  });
});
