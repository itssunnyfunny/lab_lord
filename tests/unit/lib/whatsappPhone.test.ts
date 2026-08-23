import { describe, expect, it } from "vitest";
import {
  isWhatsAppE164,
  normalizeWhatsAppPhone,
  WhatsAppPhoneValidationError,
} from "@/lib/whatsappPhone";

describe("WhatsApp phone normalization", () => {
  it("preserves authoritative valid E.164 input", () => {
    expect(normalizeWhatsAppPhone("+14155552671", { defaultCountry: "IN" })).toBe(
      "+14155552671"
    );
  });

  it.each(["9876543210", "81234 56789", "70000-00000"])(
    "normalizes an explicit India-default mobile: %s",
    input => {
      expect(normalizeWhatsAppPhone(input, { defaultCountry: "IN" })).toMatch(/^\+91[6-9]\d{9}$/);
    }
  );

  it("does not infer India without an explicit default", () => {
    expect(() => normalizeWhatsAppPhone("9876543210")).toThrow(
      WhatsAppPhoneValidationError
    );
  });

  it.each([
    "1234567890",
    "+911234567890",
    "+0123456789",
    "+123",
    "+1234567890123456",
    "00919876543210",
    "9876543210 ext 4",
    "9876543210x4",
    "call9876543210",
    "9876543210,4",
    "919876543210",
  ])("rejects invalid or ambiguous input: %s", input => {
    expect(() => normalizeWhatsAppPhone(input, { defaultCountry: "IN" })).toThrow(
      WhatsAppPhoneValidationError
    );
  });

  it("exposes a strict E.164 predicate", () => {
    expect(isWhatsAppE164("+919876543210")).toBe(true);
    expect(isWhatsAppE164("9876543210")).toBe(false);
  });
});
