import { describe, expect, it } from "vitest";
import {
  assertWhatsAppSameOriginRequest,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";

function request(headers: HeadersInit = {}) {
  return new Request("https://app.example.test/api/organizations/org_1/whatsapp/action", {
    method: "POST",
    headers,
  });
}

const REJECTED_HEADERS: HeadersInit[] = [
  { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  { Origin: "https://app.example.test.evil.example" },
  { Origin: "https://app.example.test/path" },
  { Origin: "http://app.example.test" },
  { "Sec-Fetch-Site": "same-site" },
  {},
];

describe("WhatsApp authenticated mutation origin boundary", () => {
  it("accepts an exact Origin and same-origin fetch metadata", () => {
    expect(() => assertWhatsAppSameOriginRequest(request({
      Origin: "https://app.example.test",
      "Sec-Fetch-Site": "same-origin",
    }))).not.toThrow();
  });

  it("accepts browser same-origin metadata when Origin is omitted", () => {
    expect(() => assertWhatsAppSameOriginRequest(request({
      "Sec-Fetch-Site": "same-origin",
    }))).not.toThrow();
  });

  it.each(REJECTED_HEADERS)("rejects missing, cross-site, or lookalike origins: %j", headers => {
    expect(() => assertWhatsAppSameOriginRequest(request(headers))).toThrow(
      WhatsAppValidationError
    );
  });
});
