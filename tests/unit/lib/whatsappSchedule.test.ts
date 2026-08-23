import { describe, expect, it } from "vitest";

import {
  addWhatsAppLocalDays,
  getWhatsAppLocalDateParts,
  nextWhatsAppSendAt,
  manualWhatsAppAvailableAt,
  parseWhatsAppSendTime,
  scheduleWhatsAppForLocalDate,
  whatsappBudgetMonth,
  whatsappLocalDateTimeToUtc,
  whatsappLocalDateKey,
} from "@/lib/whatsappSchedule";

describe("WhatsApp scheduling", () => {
  it("validates the fixed local send window", () => {
    expect(parseWhatsAppSendTime("08:00").minuteOfDay).toBe(480);
    expect(parseWhatsAppSendTime("20:00").minuteOfDay).toBe(1_200);
    expect(() => parseWhatsAppSendTime("07:59")).toThrow("between 08:00 and 20:00");
    expect(() => parseWhatsAppSendTime("20:01")).toThrow("between 08:00 and 20:00");
  });

  it("converts an IANA-zoned India slot without fixed-offset arithmetic", () => {
    const scheduled = scheduleWhatsAppForLocalDate({
      localDate: { year: 2026, month: 8, day: 23 },
      sendTimeLocal: "10:00",
      timeZone: "Asia/Kolkata",
    });
    expect(scheduled.toISOString()).toBe("2026-08-23T04:30:00.000Z");
    expect(whatsappLocalDateKey(scheduled, "Asia/Kolkata")).toBe("2026-08-23");
  });

  it("schedules the next valid local slot and crosses month boundaries", () => {
    const next = nextWhatsAppSendAt({
      now: new Date("2026-08-31T06:00:00.000Z"),
      sendTimeLocal: "10:00",
      timeZone: "Asia/Kolkata",
    });
    expect(next.toISOString()).toBe("2026-09-01T04:30:00.000Z");
    expect(addWhatsAppLocalDays({ year: 2024, month: 2, day: 28 }, 1))
      .toEqual({ year: 2024, month: 2, day: 29 });
    expect(getWhatsAppLocalDateParts(next, "Asia/Kolkata"))
      .toEqual({ year: 2026, month: 9, day: 1 });
    expect(whatsappBudgetMonth(new Date("2026-08-31T20:00:00Z"), "Asia/Kolkata"))
      .toBe("2026-09");
  });

  it("uses IANA daylight-saving offsets and rejects skipped local instants", () => {
    expect(scheduleWhatsAppForLocalDate({
      localDate: { year: 2026, month: 7, day: 15 },
      sendTimeLocal: "10:00",
      timeZone: "America/New_York",
    }).toISOString()).toBe("2026-07-15T14:00:00.000Z");
    expect(() => whatsappLocalDateTimeToUtc({
      date: { year: 2026, month: 3, day: 8 },
      hour: 2,
      minute: 30,
      timeZone: "America/New_York",
    })).toThrow("does not exist");
  });

  it("queues manual work now inside the window and at the next configured slot outside it", () => {
    const inside = new Date("2026-08-23T06:30:00Z");
    expect(manualWhatsAppAvailableAt({
      now: inside,
      sendTimeLocal: "10:00",
      timeZone: "Asia/Kolkata",
    })).toBe(inside);
    expect(manualWhatsAppAvailableAt({
      now: new Date("2026-08-23T17:00:00Z"),
      sendTimeLocal: "10:00",
      timeZone: "Asia/Kolkata",
    }).toISOString()).toBe("2026-08-24T04:30:00.000Z");

    const nextMonth = manualWhatsAppAvailableAt({
      now: new Date("2026-08-31T17:00:00Z"),
      sendTimeLocal: "10:00",
      timeZone: "Asia/Kolkata",
    });
    expect(nextMonth.toISOString()).toBe("2026-09-01T04:30:00.000Z");
    expect(whatsappBudgetMonth(nextMonth, "Asia/Kolkata")).toBe("2026-09");
  });
});
