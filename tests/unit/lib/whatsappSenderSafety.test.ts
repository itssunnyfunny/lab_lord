import { describe, expect, it } from "vitest";

import {
  advanceWhatsAppSenderSafetyWindow,
  isReviewedWhatsAppSenderWideFailure,
  isWhatsAppSenderHealthFresh,
  WHATSAPP_SENDER_SAFETY_WINDOW_MS,
} from "@/lib/whatsappSenderSafety";

describe("WhatsApp sender safety rules", () => {
  it("increments within the fixed ten-minute window and resets at its boundary", () => {
    const started = new Date("2026-08-24T10:00:00.000Z");
    const second = advanceWhatsAppSenderSafetyWindow({
      current: { windowStartedAt: started, count: 1 },
      now: new Date(started.getTime() + WHATSAPP_SENDER_SAFETY_WINDOW_MS - 1),
    });
    expect(second).toEqual({ windowStartedAt: started, count: 2 });

    const resetAtBoundary = advanceWhatsAppSenderSafetyWindow({
      current: second,
      now: new Date(started.getTime() + WHATSAPP_SENDER_SAFETY_WINDOW_MS),
    });
    expect(resetAtBoundary).toEqual({
      windowStartedAt: new Date("2026-08-24T10:10:00.000Z"),
      count: 1,
    });
  });

  it("fails closed on corrupt or reversed window state", () => {
    const now = new Date("2026-08-24T10:00:00.000Z");
    expect(advanceWhatsAppSenderSafetyWindow({
      current: { windowStartedAt: new Date("2026-08-24T10:01:00.000Z"), count: 9 },
      now,
    })).toEqual({ windowStartedAt: now, count: 1 });
    expect(advanceWhatsAppSenderSafetyWindow({
      current: { windowStartedAt: now, count: -1 },
      now,
    })).toEqual({ windowStartedAt: now, count: 1 });
  });

  it("counts only reviewed sender-wide failures, not recipient or transient failures", () => {
    expect(isReviewedWhatsAppSenderWideFailure({ kind: "AUTHENTICATION" })).toBe(true);
    expect(isReviewedWhatsAppSenderWideFailure({
      kind: "PROVIDER",
      providerCode: 131042,
    })).toBe(true);
    expect(isReviewedWhatsAppSenderWideFailure({
      kind: "PROVIDER",
      providerCode: 131026,
    })).toBe(false);
    expect(isReviewedWhatsAppSenderWideFailure({ kind: "RATE_LIMIT" })).toBe(false);
    expect(isReviewedWhatsAppSenderWideFailure({ kind: "NETWORK" })).toBe(false);
  });

  it("requires nonfuture health evidence no older than the fixed freshness window", () => {
    const now = new Date("2026-08-24T11:00:00.000Z");
    expect(isWhatsAppSenderHealthFresh({
      lastHealthyAt: new Date("2026-08-24T10:00:00.000Z"),
      now,
    })).toBe(true);
    expect(isWhatsAppSenderHealthFresh({
      lastHealthyAt: new Date("2026-08-24T09:59:59.999Z"),
      now,
    })).toBe(false);
    expect(isWhatsAppSenderHealthFresh({
      lastHealthyAt: new Date("2026-08-24T11:00:00.001Z"),
      now,
    })).toBe(false);
  });
});
