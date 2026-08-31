import { createHash } from "node:crypto";

import type {
  WhatsAppServiceNoticeReason,
  WhatsAppServiceNoticeType,
} from "@/app/generated/prisma/client";
import type {
  WhatsAppManagedTemplateKey,
  WhatsAppManagedTemplateLanguage,
} from "@/lib/whatsappManagedTemplates";
import {
  getWhatsAppLocalDateParts,
  getWhatsAppLocalDateTimeParts,
  manualWhatsAppAvailableAt,
  whatsappLocalDateKey,
  whatsappLocalDatePartsKey,
  whatsappLocalDateTimeToUtc,
  type LocalDateParts,
} from "@/lib/whatsappSchedule";
import { WhatsAppValidationError } from "@/lib/whatsappHttp";

export const WHATSAPP_SERVICE_NOTICE_TYPES = [
  "BRANCH_CLOSED",
  "HOURS_CHANGED",
  "MAINTENANCE_WINDOW",
] as const satisfies readonly WhatsAppServiceNoticeType[];

export const WHATSAPP_SERVICE_NOTICE_REASONS = [
  "PUBLIC_HOLIDAY",
  "LOCAL_HOLIDAY",
  "MAINTENANCE",
  "EMERGENCY",
  "ADMINISTRATIVE",
] as const satisfies readonly WhatsAppServiceNoticeReason[];

export const MAX_WHATSAPP_SERVICE_NOTICE_RECIPIENTS = 500;
export const MAX_WHATSAPP_SERVICE_NOTICE_HORIZON_DAYS = 30;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export type WhatsAppServiceNoticeDraft = Readonly<{
  type: WhatsAppServiceNoticeType;
  reason: WhatsAppServiceNoticeReason;
  localEffectiveDate: string;
  resumeLocalDate: string | null;
  openingTimeLocal: string | null;
  closingTimeLocal: string | null;
  maintenanceStartTimeLocal: string | null;
  maintenanceEndTimeLocal: string | null;
  delivery: "IMMEDIATE" | "SCHEDULED";
  scheduledForLocal: string | null;
}>;

export type ResolvedWhatsAppServiceNotice = Readonly<{
  draft: WhatsAppServiceNoticeDraft;
  managedTemplateKey: WhatsAppManagedTemplateKey;
  localEffectiveDate: string;
  effectiveStartAt: Date;
  effectiveEndAt: Date | null;
  resumeAt: Date | null;
  scheduledFor: Date;
}>;

function invalid(message = "Service notice fields are invalid"): never {
  throw new WhatsAppValidationError(message);
}

function parseLocalDate(value: string): LocalDateParts {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return invalid("Local dates must use YYYY-MM-DD");
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const roundTrip = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
  if (
    roundTrip.getUTCFullYear() !== date.year
    || roundTrip.getUTCMonth() + 1 !== date.month
    || roundTrip.getUTCDate() !== date.day
  ) return invalid("Local date is invalid");
  return date;
}

function parseLocalTime(value: string) {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) return invalid("Local times must use HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return invalid("Local time is invalid");
  return { hour, minute, minuteOfDay: hour * 60 + minute } as const;
}

function parseLocalDateTime(value: string) {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match) return invalid("Scheduled local time must use YYYY-MM-DDTHH:mm");
  const date = parseLocalDate(`${match[1]}-${match[2]}-${match[3]}`);
  const time = parseLocalTime(`${match[4]}:${match[5]}`);
  return { date, ...time } as const;
}

function localDayNumber(value: LocalDateParts) {
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 86_400_000);
}

function localMidnight(value: LocalDateParts, timeZone: string) {
  return whatsappLocalDateTimeToUtc({ date: value, hour: 0, minute: 0, timeZone });
}

function assertTypeSpecificShape(draft: WhatsAppServiceNoticeDraft) {
  if (!WHATSAPP_SERVICE_NOTICE_TYPES.includes(draft.type)) invalid();
  if (!WHATSAPP_SERVICE_NOTICE_REASONS.includes(draft.reason)) invalid();
  if (draft.delivery !== "IMMEDIATE" && draft.delivery !== "SCHEDULED") invalid();

  if (draft.type === "BRANCH_CLOSED") {
    if (
      !draft.resumeLocalDate
      || draft.openingTimeLocal !== null
      || draft.closingTimeLocal !== null
      || draft.maintenanceStartTimeLocal !== null
      || draft.maintenanceEndTimeLocal !== null
    ) invalid();
    return;
  }
  if (draft.type === "HOURS_CHANGED") {
    if (
      draft.resumeLocalDate !== null
      || !draft.openingTimeLocal
      || !draft.closingTimeLocal
      || draft.maintenanceStartTimeLocal !== null
      || draft.maintenanceEndTimeLocal !== null
    ) invalid();
    return;
  }
  if (
    draft.reason !== "MAINTENANCE"
    || draft.resumeLocalDate !== null
    || draft.openingTimeLocal !== null
    || draft.closingTimeLocal !== null
    || !draft.maintenanceStartTimeLocal
    || !draft.maintenanceEndTimeLocal
  ) invalid();
}

export function managedTemplateKeyForServiceNotice(
  type: WhatsAppServiceNoticeType
): WhatsAppManagedTemplateKey {
  if (type === "BRANCH_CLOSED") return "BRANCH_CLOSED_NOTICE";
  if (type === "HOURS_CHANGED") return "BRANCH_HOURS_CHANGED_NOTICE";
  if (type === "MAINTENANCE_WINDOW") return "BRANCH_MAINTENANCE_NOTICE";
  return invalid();
}

export function resolveWhatsAppServiceNoticeDraft(input: {
  draft: WhatsAppServiceNoticeDraft;
  now: Date;
  timeZone: string;
  branchSendTimeLocal: string;
}): ResolvedWhatsAppServiceNotice {
  assertTypeSpecificShape(input.draft);
  if (Number.isNaN(input.now.getTime())) invalid();
  const localEffective = parseLocalDate(input.draft.localEffectiveDate);
  const today = getWhatsAppLocalDateParts(input.now, input.timeZone);
  const horizon = localDayNumber(localEffective) - localDayNumber(today);
  if (horizon < 0) invalid("The effective date cannot be in the past");
  if (horizon > MAX_WHATSAPP_SERVICE_NOTICE_HORIZON_DAYS) {
    invalid("Service notices may be scheduled at most 30 days ahead");
  }

  let effectiveStartAt = localMidnight(localEffective, input.timeZone);
  let effectiveEndAt: Date | null = null;
  let resumeAt: Date | null = null;

  if (input.draft.type === "BRANCH_CLOSED") {
    const resumeDate = parseLocalDate(input.draft.resumeLocalDate!);
    if (localDayNumber(resumeDate) <= localDayNumber(localEffective)) {
      invalid("Resume date must follow the closure date");
    }
    resumeAt = localMidnight(resumeDate, input.timeZone);
  } else {
    const start = parseLocalTime(
      input.draft.type === "HOURS_CHANGED"
        ? input.draft.openingTimeLocal!
        : input.draft.maintenanceStartTimeLocal!
    );
    const end = parseLocalTime(
      input.draft.type === "HOURS_CHANGED"
        ? input.draft.closingTimeLocal!
        : input.draft.maintenanceEndTimeLocal!
    );
    if (end.minuteOfDay <= start.minuteOfDay) {
      invalid("The end time must follow the start time");
    }
    effectiveStartAt = whatsappLocalDateTimeToUtc({
      date: localEffective,
      hour: start.hour,
      minute: start.minute,
      timeZone: input.timeZone,
    });
    effectiveEndAt = whatsappLocalDateTimeToUtc({
      date: localEffective,
      hour: end.hour,
      minute: end.minute,
      timeZone: input.timeZone,
    });
  }

  let scheduledFor: Date;
  if (input.draft.delivery === "IMMEDIATE") {
    if (input.draft.scheduledForLocal !== null) invalid();
    scheduledFor = manualWhatsAppAvailableAt({
      now: input.now,
      sendTimeLocal: input.branchSendTimeLocal,
      timeZone: input.timeZone,
    });
  } else {
    if (!input.draft.scheduledForLocal) invalid();
    const scheduled = parseLocalDateTime(input.draft.scheduledForLocal);
    if (scheduled.minuteOfDay < 8 * 60 || scheduled.minuteOfDay > 20 * 60) {
      invalid("Scheduled delivery must be between 08:00 and 20:00 local time");
    }
    scheduledFor = whatsappLocalDateTimeToUtc({
      date: scheduled.date,
      hour: scheduled.hour,
      minute: scheduled.minute,
      timeZone: input.timeZone,
    });
  }

  if (scheduledFor.getTime() < input.now.getTime()) {
    invalid("Scheduled delivery cannot be in the past");
  }
  if (scheduledFor.getTime() > input.now.getTime() + MAX_WHATSAPP_SERVICE_NOTICE_HORIZON_DAYS * 86_400_000) {
    invalid("Service notices may be scheduled at most 30 days ahead");
  }
  if (input.draft.delivery === "SCHEDULED" && scheduledFor.getTime() >= effectiveStartAt.getTime()) {
    invalid("Scheduled delivery must precede the effective event");
  }
  if (input.draft.delivery === "IMMEDIATE") {
    if (
      input.draft.type !== "BRANCH_CLOSED"
      && scheduledFor.getTime() >= effectiveStartAt.getTime()
    ) invalid("The notice can no longer be delivered before the effective event");
    if (
      input.draft.type === "BRANCH_CLOSED"
      && whatsappLocalDateKey(scheduledFor, input.timeZone) > input.draft.localEffectiveDate
    ) invalid("The notice can no longer be delivered on or before the closure date");
  }

  return Object.freeze({
    draft: Object.freeze({ ...input.draft }),
    managedTemplateKey: managedTemplateKeyForServiceNotice(input.draft.type),
    localEffectiveDate: whatsappLocalDatePartsKey(localEffective),
    effectiveStartAt,
    effectiveEndAt,
    resumeAt,
    scheduledFor,
  });
}

const REASON_LABELS: Readonly<Record<
  WhatsAppManagedTemplateLanguage,
  Readonly<Record<WhatsAppServiceNoticeReason, string>>
>> = {
  en_IN: {
    PUBLIC_HOLIDAY: "a public holiday",
    LOCAL_HOLIDAY: "a local holiday",
    MAINTENANCE: "maintenance",
    EMERGENCY: "an emergency",
    ADMINISTRATIVE: "administrative requirements",
  },
  hi: {
    PUBLIC_HOLIDAY: "सार्वजनिक अवकाश",
    LOCAL_HOLIDAY: "स्थानीय अवकाश",
    MAINTENANCE: "रखरखाव",
    EMERGENCY: "आपात स्थिति",
    ADMINISTRATIVE: "प्रशासनिक कारणों",
  },
};

function formatLocalDate(value: string, language: WhatsAppManagedTemplateLanguage) {
  const date = parseLocalDate(value);
  return new Intl.DateTimeFormat(language === "hi" ? "hi-IN" : "en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day, 12)));
}

function formatLocalTime(value: string, language: WhatsAppManagedTemplateLanguage) {
  const time = parseLocalTime(value);
  return new Intl.DateTimeFormat(language === "hi" ? "hi-IN" : "en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, time.hour, time.minute)));
}

export function serviceNoticeTemplateValues(input: {
  draft: WhatsAppServiceNoticeDraft;
  branchName: string;
  language: WhatsAppManagedTemplateLanguage;
}) {
  if (input.draft.type === "BRANCH_CLOSED") {
    return {
      branchName: input.branchName,
      closureDate: formatLocalDate(input.draft.localEffectiveDate, input.language),
      reason: REASON_LABELS[input.language][input.draft.reason],
      resumeDate: formatLocalDate(input.draft.resumeLocalDate!, input.language),
    } as const;
  }
  if (input.draft.type === "HOURS_CHANGED") {
    return {
      branchName: input.branchName,
      effectiveDate: formatLocalDate(input.draft.localEffectiveDate, input.language),
      openingTime: formatLocalTime(input.draft.openingTimeLocal!, input.language),
      closingTime: formatLocalTime(input.draft.closingTimeLocal!, input.language),
      reason: REASON_LABELS[input.language][input.draft.reason],
    } as const;
  }
  return {
    branchName: input.branchName,
    effectiveDate: formatLocalDate(input.draft.localEffectiveDate, input.language),
    startTime: formatLocalTime(input.draft.maintenanceStartTimeLocal!, input.language),
    endTime: formatLocalTime(input.draft.maintenanceEndTimeLocal!, input.language),
  } as const;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createWhatsAppServiceNoticeRequestHash(input: {
  branchId: string;
  draft: WhatsAppServiceNoticeDraft;
}) {
  return sha256(JSON.stringify({
    kind: "whatsapp-service-notice-request-v1",
    branchId: input.branchId,
    draft: {
      type: input.draft.type,
      reason: input.draft.reason,
      localEffectiveDate: input.draft.localEffectiveDate,
      resumeLocalDate: input.draft.resumeLocalDate,
      openingTimeLocal: input.draft.openingTimeLocal,
      closingTimeLocal: input.draft.closingTimeLocal,
      maintenanceStartTimeLocal: input.draft.maintenanceStartTimeLocal,
      maintenanceEndTimeLocal: input.draft.maintenanceEndTimeLocal,
      delivery: input.draft.delivery,
      scheduledForLocal: input.draft.scheduledForLocal,
    },
  }));
}

export function createWhatsAppServiceNoticeSourceFingerprint(input: {
  noticeId: string;
  organizationId: string;
  branchId: string;
  branchName: string;
  senderId: string;
  recipientPhoneE164: string;
  type: WhatsAppServiceNoticeType;
  reason: WhatsAppServiceNoticeReason;
  localEffectiveDate: string;
  effectiveStartAt: Date | null;
  effectiveEndAt: Date | null;
  resumeAt: Date | null;
  scheduledFor: Date;
  templateBindingId: string;
  managedTemplateKey: WhatsAppManagedTemplateKey;
  catalogHash: string;
  settingsRevision: number;
  templateVariables: Readonly<Record<string, unknown>>;
}) {
  return sha256(JSON.stringify({
    kind: "whatsapp-service-notice-source-v1",
    noticeId: input.noticeId,
    organizationId: input.organizationId,
    branchId: input.branchId,
    branchName: input.branchName,
    senderId: input.senderId,
    recipientHash: sha256(input.recipientPhoneE164),
    type: input.type,
    reason: input.reason,
    localEffectiveDate: input.localEffectiveDate,
    effectiveStartAt: input.effectiveStartAt?.toISOString() ?? null,
    effectiveEndAt: input.effectiveEndAt?.toISOString() ?? null,
    resumeAt: input.resumeAt?.toISOString() ?? null,
    scheduledFor: input.scheduledFor.toISOString(),
    templateBindingId: input.templateBindingId,
    managedTemplateKey: input.managedTemplateKey,
    catalogHash: input.catalogHash,
    settingsRevision: input.settingsRevision,
    templateVariables: input.templateVariables,
  }));
}

export function createWhatsAppServiceNoticeMessageKey(input: {
  kind: "dedupe" | "frequency";
  noticeId: string;
  senderId: string;
  recipientPhoneE164: string;
}) {
  return sha256(JSON.stringify({
    kind: `whatsapp-service-notice-${input.kind}-v1`,
    noticeId: input.noticeId,
    senderId: input.senderId,
    recipientHash: sha256(input.recipientPhoneE164),
  }));
}

export function serviceNoticeHasExpired(input: {
  type: WhatsAppServiceNoticeType;
  localEffectiveDate: string;
  effectiveEndAt: Date | null;
  resumeAt: Date | null;
  now: Date;
  timeZone: string;
}) {
  if (input.type === "BRANCH_CLOSED") {
    if (input.resumeAt) return input.now.getTime() >= input.resumeAt.getTime();
    return whatsappLocalDateKey(input.now, input.timeZone) > input.localEffectiveDate;
  }
  return !input.effectiveEndAt || input.now.getTime() >= input.effectiveEndAt.getTime();
}

export function serviceNoticeLocalScheduleDate(date: Date, timeZone: string) {
  const local = getWhatsAppLocalDateTimeParts(date, timeZone);
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}
