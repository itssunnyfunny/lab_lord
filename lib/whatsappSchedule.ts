const LOCAL_TIME_PATTERN = /^(\d{2}):(\d{2})$/;
export const WHATSAPP_SEND_WINDOW_START_MINUTE = 8 * 60;
export const WHATSAPP_SEND_WINDOW_END_MINUTE = 20 * 60;
export const WHATSAPP_REPORT_SEND_WINDOW_START_MINUTE = 18 * 60;
export const WHATSAPP_REPORT_SEND_WINDOW_END_MINUTE = 23 * 60 + 30;
export const DEFAULT_WHATSAPP_REPORT_SEND_TIME = "21:00" as const;
export const WHATSAPP_REPORT_CATCH_UP_MS = 60 * 60 * 1_000;

export type LocalDateParts = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

export function parseWhatsAppSendTime(value: string) {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) throw new Error("Send time must use HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const minuteOfDay = hour * 60 + minute;
  if (
    hour > 23
    || minute > 59
    || minuteOfDay < WHATSAPP_SEND_WINDOW_START_MINUTE
    || minuteOfDay > WHATSAPP_SEND_WINDOW_END_MINUTE
  ) {
    throw new Error("Send time must be between 08:00 and 20:00 local time");
  }
  return { hour, minute, minuteOfDay } as const;
}

export function parseWhatsAppReportSendTime(value: string) {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) throw new Error("Report time must use HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const minuteOfDay = hour * 60 + minute;
  if (
    hour > 23
    || minute > 59
    || minuteOfDay < WHATSAPP_REPORT_SEND_WINDOW_START_MINUTE
    || minuteOfDay > WHATSAPP_REPORT_SEND_WINDOW_END_MINUTE
  ) {
    throw new Error("Report time must be between 18:00 and 23:30 local time");
  }
  return { hour, minute, minuteOfDay } as const;
}

function formatter(timeZone: string, withTime: boolean) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(withTime
        ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" as const }
        : {}),
    });
  } catch {
    throw new Error("Organization timezone is invalid");
  }
}

function numericParts(date: Date, timeZone: string, withTime: boolean) {
  const values = Object.fromEntries(
    formatter(timeZone, withTime)
      .formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

export function isValidWhatsAppTimeZone(timeZone: string) {
  try {
    formatter(timeZone, false).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function getWhatsAppLocalDateParts(date: Date, timeZone: string): LocalDateParts {
  const value = numericParts(date, timeZone, false);
  return { year: value.year, month: value.month, day: value.day };
}

export function getWhatsAppLocalDateTimeParts(date: Date, timeZone: string) {
  return numericParts(date, timeZone, true);
}

export function isWithinWhatsAppSendWindow(date: Date, timeZone: string) {
  const local = getWhatsAppLocalDateTimeParts(date, timeZone);
  const minuteOfDay = local.hour * 60 + local.minute;
  return minuteOfDay >= WHATSAPP_SEND_WINDOW_START_MINUTE
    && minuteOfDay <= WHATSAPP_SEND_WINDOW_END_MINUTE;
}

export function whatsappLocalDateKey(date: Date, timeZone: string) {
  return whatsappLocalDatePartsKey(getWhatsAppLocalDateParts(date, timeZone));
}

export function whatsappLocalDatePartsKey({ year, month, day }: LocalDateParts) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function whatsappBudgetMonth(date: Date, timeZone: string) {
  const { year, month } = getWhatsAppLocalDateParts(date, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function addWhatsAppLocalDays(value: LocalDateParts, days: number): LocalDateParts {
  if (!Number.isSafeInteger(days)) throw new Error("Local day offset is invalid");
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + days, 12));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function whatsappLocalDateTimeToUtc(input: {
  date: LocalDateParts;
  hour: number;
  minute: number;
  timeZone: string;
}) {
  if (!isValidWhatsAppTimeZone(input.timeZone)) throw new Error("Organization timezone is invalid");
  const desired = Date.UTC(
    input.date.year,
    input.date.month - 1,
    input.date.day,
    input.hour,
    input.minute,
    0
  );
  let candidate = desired;

  // IANA offsets may change around DST. Re-evaluating converges for valid local instants.
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = numericParts(new Date(candidate), input.timeZone, true);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );
    const correction = desired - observedAsUtc;
    if (correction === 0) break;
    candidate += correction;
  }

  const result = new Date(candidate);
  const roundTrip = numericParts(result, input.timeZone, true);
  if (
    roundTrip.year !== input.date.year
    || roundTrip.month !== input.date.month
    || roundTrip.day !== input.date.day
    || roundTrip.hour !== input.hour
    || roundTrip.minute !== input.minute
  ) {
    throw new Error("Local send time does not exist in the organization timezone");
  }
  return result;
}

export function scheduleWhatsAppForLocalDate(input: {
  localDate: LocalDateParts;
  sendTimeLocal: string;
  timeZone: string;
}) {
  const sendTime = parseWhatsAppSendTime(input.sendTimeLocal);
  return whatsappLocalDateTimeToUtc({
    date: input.localDate,
    hour: sendTime.hour,
    minute: sendTime.minute,
    timeZone: input.timeZone,
  });
}

export function scheduleWhatsAppReportForLocalDate(input: {
  localDate: LocalDateParts;
  sendTimeLocal: string;
  timeZone: string;
}) {
  const sendTime = parseWhatsAppReportSendTime(input.sendTimeLocal);
  return whatsappLocalDateTimeToUtc({
    date: input.localDate,
    hour: sendTime.hour,
    minute: sendTime.minute,
    timeZone: input.timeZone,
  });
}

/**
 * Returns the exclusive end of the report catch-up window. Catch-up is bounded
 * to one hour and can never continue into the next local report day.
 */
export function getWhatsAppReportCatchUpEndsAt(input: {
  scheduledCutoffAt: Date;
  timeZone: string;
}) {
  if (Number.isNaN(input.scheduledCutoffAt.getTime())) {
    throw new Error("Report cutoff is invalid");
  }
  const localDate = getWhatsAppLocalDateParts(input.scheduledCutoffAt, input.timeZone);
  const nextLocalMidnight = whatsappLocalDateTimeToUtc({
    date: addWhatsAppLocalDays(localDate, 1),
    hour: 0,
    minute: 0,
    timeZone: input.timeZone,
  });
  return new Date(Math.min(
    input.scheduledCutoffAt.getTime() + WHATSAPP_REPORT_CATCH_UP_MS,
    nextLocalMidnight.getTime()
  ));
}

export function getWhatsAppReportPlanningWindow(input: {
  now: Date;
  sendTimeLocal: string;
  timeZone: string;
}) {
  const today = getWhatsAppLocalDateParts(input.now, input.timeZone);
  const todayCutoff = scheduleWhatsAppReportForLocalDate({
    localDate: today,
    sendTimeLocal: input.sendTimeLocal,
    timeZone: input.timeZone,
  });
  const localDate = input.now.getTime() >= todayCutoff.getTime()
    ? today
    : addWhatsAppLocalDays(today, -1);
  const scheduledCutoffAt = localDate === today
    ? todayCutoff
    : scheduleWhatsAppReportForLocalDate({
        localDate,
        sendTimeLocal: input.sendTimeLocal,
        timeZone: input.timeZone,
      });
  const catchUpEndsAt = getWhatsAppReportCatchUpEndsAt({
    scheduledCutoffAt,
    timeZone: input.timeZone,
  });
  return {
    localDate,
    localDateKey: whatsappLocalDatePartsKey(localDate),
    scheduledCutoffAt,
    catchUpEndsAt,
    eligible: input.now.getTime() >= scheduledCutoffAt.getTime()
      && input.now.getTime() < catchUpEndsAt.getTime(),
    missed: input.now.getTime() >= catchUpEndsAt.getTime(),
  } as const;
}

export function nextWhatsAppSendAt(input: {
  now: Date;
  sendTimeLocal: string;
  timeZone: string;
}) {
  const today = getWhatsAppLocalDateParts(input.now, input.timeZone);
  const todaySlot = scheduleWhatsAppForLocalDate({
    localDate: today,
    sendTimeLocal: input.sendTimeLocal,
    timeZone: input.timeZone,
  });
  if (todaySlot.getTime() >= input.now.getTime()) return todaySlot;
  return scheduleWhatsAppForLocalDate({
    localDate: addWhatsAppLocalDays(today, 1),
    sendTimeLocal: input.sendTimeLocal,
    timeZone: input.timeZone,
  });
}

export function manualWhatsAppAvailableAt(input: {
  now: Date;
  sendTimeLocal: string;
  timeZone: string;
}) {
  parseWhatsAppSendTime(input.sendTimeLocal);
  if (isWithinWhatsAppSendWindow(input.now, input.timeZone)) return input.now;
  return nextWhatsAppSendAt(input);
}
