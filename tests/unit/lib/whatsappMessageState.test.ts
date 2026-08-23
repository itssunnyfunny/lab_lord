import { describe, expect, it } from "vitest";

import { projectWhatsAppStatus, reduceWhatsAppStatusProjection } from "@/lib/whatsappMessageState";

describe("WhatsApp provider status projection", () => {
  it("does not regress when provider events arrive out of order", () => {
    const projected = projectWhatsAppStatus(
      { status: "ACCEPTED", providerStatusTimestamp: null },
      [
        { status: "READ", providerTimestamp: new Date("2026-08-23T10:03:00Z") },
        { status: "SENT", providerTimestamp: new Date("2026-08-23T10:01:00Z") },
        { status: "DELIVERED", providerTimestamp: new Date("2026-08-23T10:02:00Z") },
      ]
    );
    expect(projected).toEqual({
      status: "READ",
      providerStatusTimestamp: new Date("2026-08-23T10:03:00Z"),
    });
  });

  it("does not replace successful delivery with a later failure", () => {
    expect(reduceWhatsAppStatusProjection(
      { status: "DELIVERED", providerStatusTimestamp: new Date("2026-08-23T10:02:00Z") },
      { status: "FAILED", providerTimestamp: new Date("2026-08-23T10:03:00Z") }
    ).status).toBe("DELIVERED");
  });

  it("does not regress READ when a lower success status carries a later timestamp", () => {
    expect(reduceWhatsAppStatusProjection(
      { status: "READ", providerStatusTimestamp: new Date("2026-08-23T10:03:00Z") },
      { status: "SENT", providerTimestamp: new Date("2026-08-23T10:04:00Z") }
    )).toEqual({
      status: "READ",
      providerStatusTimestamp: new Date("2026-08-23T10:03:00Z"),
    });
  });

  it("allows signed provider evidence to resolve a conservative unknown outcome", () => {
    expect(reduceWhatsAppStatusProjection(
      { status: "UNKNOWN", providerStatusTimestamp: null },
      { status: "SENT", providerTimestamp: new Date("2026-08-23T10:01:00Z") }
    ).status).toBe("SENT");
  });

  it("allows a later provider failure after sent but preserves local cancellation", () => {
    expect(reduceWhatsAppStatusProjection(
      { status: "SENT", providerStatusTimestamp: new Date("2026-08-23T10:01:00Z") },
      { status: "FAILED", providerTimestamp: new Date("2026-08-23T10:02:00Z") }
    ).status).toBe("FAILED");
    expect(reduceWhatsAppStatusProjection(
      { status: "CANCELLED", providerStatusTimestamp: null },
      { status: "SENT", providerTimestamp: new Date("2026-08-23T10:01:00Z") }
    ).status).toBe("CANCELLED");
  });
});
