import { describe, expect, it } from "vitest";

import {
  addWhatsAppLocalDays,
  DEFAULT_WHATSAPP_REPORT_SEND_TIME,
  getWhatsAppLocalDateParts,
  getWhatsAppReportCatchUpEndsAt,
  getWhatsAppReportPlanningWindow,
  nextWhatsAppSendAt,
  manualWhatsAppAvailableAt,
  parseWhatsAppSendTime,
  parseWhatsAppReportSendTime,
  scheduleWhatsAppReportForLocalDate,
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

  it("keeps the daily-report window separate with a one-hour Kolkata catch-up", () => {
    expect(parseWhatsAppReportSendTime("18:00").minuteOfDay).toBe(1_080);
    expect(parseWhatsAppReportSendTime("23:30").minuteOfDay).toBe(1_410);
    expect(() => parseWhatsAppReportSendTime("17:59")).toThrow("between 18:00 and 23:30");
    expect(() => parseWhatsAppReportSendTime("23:31")).toThrow("between 18:00 and 23:30");
    const cutoff = scheduleWhatsAppReportForLocalDate({
      localDate: { year: 2026, month: 8, day: 23 },
      sendTimeLocal: DEFAULT_WHATSAPP_REPORT_SEND_TIME,
      timeZone: "Asia/Kolkata",
    });
    expect(cutoff.toISOString()).toBe("2026-08-23T15:30:00.000Z");

    const catchUp = getWhatsAppReportPlanningWindow({
      now: new Date("2026-08-23T15:45:00.000Z"),
      sendTimeLocal: DEFAULT_WHATSAPP_REPORT_SEND_TIME,
      timeZone: "Asia/Kolkata",
    });
    expect(catchUp.localDateKey).toBe("2026-08-23");
    expect(catchUp.eligible).toBe(true);
    expect(catchUp.catchUpEndsAt.toISOString()).toBe("2026-08-23T16:30:00.000Z");
  });

  it("caps a 23:30 report at the next local midnight", () => {
    const beforeMidnight = getWhatsAppReportPlanningWindow({
      now: new Date("2026-08-23T18:29:59.999Z"),
      sendTimeLocal: "23:30",
      timeZone: "Asia/Kolkata",
    });
    expect(beforeMidnight.localDateKey).toBe("2026-08-23");
    expect(beforeMidnight.scheduledCutoffAt.toISOString()).toBe("2026-08-23T18:00:00.000Z");
    expect(beforeMidnight.catchUpEndsAt.toISOString()).toBe("2026-08-23T18:30:00.000Z");
    expect(beforeMidnight.eligible).toBe(true);

    const atMidnight = getWhatsAppReportPlanningWindow({
      now: new Date("2026-08-23T18:30:00.000Z"),
      sendTimeLocal: "23:30",
      timeZone: "Asia/Kolkata",
    });
    expect(atMidnight.localDateKey).toBe("2026-08-23");
    expect(atMidnight.eligible).toBe(false);
    expect(atMidnight.missed).toBe(true);
  });

  it("uses the next IANA local midnight across a daylight-saving transition", () => {
    const cutoff = scheduleWhatsAppReportForLocalDate({
      localDate: { year: 2026, month: 3, day: 8 },
      sendTimeLocal: "23:30",
      timeZone: "America/New_York",
    });
    expect(cutoff.toISOString()).toBe("2026-03-09T03:30:00.000Z");
    expect(getWhatsAppReportCatchUpEndsAt({
      scheduledCutoffAt: cutoff,
      timeZone: "America/New_York",
    }).toISOString()).toBe("2026-03-09T04:00:00.000Z");

    const atMidnight = getWhatsAppReportPlanningWindow({
      now: new Date("2026-03-09T04:00:00.000Z"),
      sendTimeLocal: "23:30",
      timeZone: "America/New_York",
    });
    expect(atMidnight.localDateKey).toBe("2026-03-08");
    expect(atMidnight.eligible).toBe(false);
    expect(atMidnight.missed).toBe(true);
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
