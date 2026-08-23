import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isTrustedMetaMessageSource,
  isTrustedMetaOrigin,
  parseMetaEmbeddedSignupEvent,
} from "@/components/whatsapp/MetaEmbeddedSignup";

describe("Meta Embedded Signup browser boundary", () => {
  it("keeps the one-time intent state out of the Facebook login URL options", () => {
    const source = readFileSync(
      new URL("../../../components/whatsapp/MetaEmbeddedSignup.tsx", import.meta.url),
      "utf8"
    );
    const loginStart = source.indexOf("sdk.login(response =>");
    const optionsStart = source.indexOf("      }, {", loginStart);
    const loginEnd = source.indexOf("      });", optionsStart);
    const loginOptions = source.slice(optionsStart, loginEnd);

    expect(loginStart).toBeGreaterThan(-1);
    expect(optionsStart).toBeGreaterThan(loginStart);
    expect(loginEnd).toBeGreaterThan(optionsStart);
    expect(loginOptions).not.toContain("state:");
    expect(loginOptions).not.toContain("rawState");
  });

  it.each([
    "https://facebook.com",
    "https://www.facebook.com",
    "https://business.facebook.com",
  ])("accepts a canonical HTTPS Facebook origin: %s", origin => {
    expect(isTrustedMetaOrigin(origin)).toBe(true);
  });

  it.each([
    "",
    "http://facebook.com",
    "https://evilfacebook.com",
    "https://facebook.com.evil.example",
    "https://facebook.com:444",
    "https://www.facebook.com/path",
  ])("rejects an untrusted or non-origin value: %s", origin => {
    expect(isTrustedMetaOrigin(origin)).toBe(false);
  });

  it("accepts only a non-self window and pins subsequent events to that source", () => {
    const popup = { closed: false, postMessage: () => undefined } as unknown as WindowProxy;
    const otherPopup = { closed: false, postMessage: () => undefined } as unknown as WindowProxy;
    const messagePort = { postMessage: () => undefined } as unknown as MessagePort;

    expect(isTrustedMetaMessageSource(popup, null, null)).toBe(true);
    expect(isTrustedMetaMessageSource(popup, null, popup)).toBe(true);
    expect(isTrustedMetaMessageSource(otherPopup, null, popup)).toBe(false);
    expect(isTrustedMetaMessageSource(messagePort, null, null)).toBe(false);
    expect(isTrustedMetaMessageSource(null, null, null)).toBe(false);
  });

  it("strictly parses the bounded finish payload into normalized browser hints", () => {
    expect(parseMetaEmbeddedSignupEvent(JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: {
        business_id: "123",
        waba_id: "456",
        phone_number_id: "789",
      },
    }))).toEqual({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: {
        businessId: "123",
        wabaId: "456",
        phoneNumberId: "789",
      },
    });
  });

  it("recognizes safe terminal events without carrying provider text forward", () => {
    expect(parseMetaEmbeddedSignupEvent(JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "CANCEL",
      data: { current_step: "phone_number" },
    }))).toEqual({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" });

    expect(parseMetaEmbeddedSignupEvent(JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "ERROR",
      data: { error_message: "provider-private-detail" },
    }))).toEqual({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR" });
  });

  it.each([
    "not-json",
    JSON.stringify({ type: "OTHER", event: "FINISH", data: {} }),
    JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { waba_id: "456", phone_number_id: "789", unexpected: true },
    }),
    JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { waba_id: "not-an-id", phone_number_id: "789" },
    }),
    "x".repeat(16_385),
  ])("ignores malformed, unrelated, or oversized event data", raw => {
    expect(parseMetaEmbeddedSignupEvent(raw)).toBeNull();
  });
});
