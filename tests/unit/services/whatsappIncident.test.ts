import { describe, expect, it } from "vitest";

import { sanitizeWhatsAppIncidentDetails } from "@/services/whatsappIncident.service";

describe("WhatsApp operational incident evidence", () => {
  it("accepts bounded operational evidence including configured rate-card versions", () => {
    expect(sanitizeWhatsAppIncidentDetails({
      rateCardVersion: "in-utility-2026-08",
      messagesSuppressed: 2,
      expectedRecentActivity: true,
    })).toEqual({
      rateCardVersion: "in-utility-2026-08",
      messagesSuppressed: 2,
      expectedRecentActivity: true,
    });
  });

  it("rejects PII-shaped or unbounded detail values", () => {
    for (const details of [
      { recipientPhone: "+919876543210" },
      { renderedMessage: "A complete provider message" },
      { rateCardVersion: "bad version with spaces" },
      { count: -1 },
    ]) {
      expect(() => sanitizeWhatsAppIncidentDetails(details)).toThrow();
    }
  });
});
