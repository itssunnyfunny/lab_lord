import { createHash } from "node:crypto";

import { z } from "zod";

export const WHATSAPP_REPORT_METRICS_VERSION = 1 as const;

const boundedName = z.string().normalize("NFKC").trim().min(1).max(120);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const count = z.number().int().nonnegative().max(9_999_999);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const aggregateMetrics = {
  localReportDate: localDate,
  asOfLocalTime: localTime,
  paymentsRecordedTodayCount: count,
  paymentsRecordedTodayAmount: amount,
  newStudentsToday: count,
  activeStudents: count,
  usedShiftSlots: count,
  totalShiftCapacity: count,
  openDueCount: count,
  openDueAmount: amount,
  overdueCount: count,
  overdueAmount: amount,
  whatsAppAcceptedToday: count,
  whatsAppDeliveredToday: count,
  whatsAppFailedToday: count,
  whatsAppUnknownToday: count,
} as const;

export const WhatsAppBranchReportMetricsSchema = z.object({
  branchName: boundedName,
  ...aggregateMetrics,
}).strict().superRefine((value, context) => {
  if (value.usedShiftSlots > value.totalShiftCapacity) {
    context.addIssue({
      code: "custom",
      path: ["usedShiftSlots"],
      message: "Used shift slots cannot exceed total shift capacity",
    });
  }
  if (value.overdueCount > value.openDueCount || value.overdueAmount > value.openDueAmount) {
    context.addIssue({
      code: "custom",
      path: ["overdueCount"],
      message: "Overdue totals must be contained in open dues",
    });
  }
});

export const WhatsAppOrganizationReportMetricsSchema = z.object({
  organizationName: boundedName,
  branchCount: count,
  ...aggregateMetrics,
}).strict().superRefine((value, context) => {
  if (value.usedShiftSlots > value.totalShiftCapacity) {
    context.addIssue({
      code: "custom",
      path: ["usedShiftSlots"],
      message: "Used shift slots cannot exceed total shift capacity",
    });
  }
  if (value.overdueCount > value.openDueCount || value.overdueAmount > value.openDueAmount) {
    context.addIssue({
      code: "custom",
      path: ["overdueCount"],
      message: "Overdue totals must be contained in open dues",
    });
  }
});

export type WhatsAppBranchReportMetrics = z.infer<typeof WhatsAppBranchReportMetricsSchema>;
export type WhatsAppOrganizationReportMetrics = z.infer<typeof WhatsAppOrganizationReportMetricsSchema>;
export type WhatsAppReportMetrics =
  | WhatsAppBranchReportMetrics
  | WhatsAppOrganizationReportMetrics;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function parseMetrics(metrics: unknown): WhatsAppReportMetrics {
  const branch = WhatsAppBranchReportMetricsSchema.safeParse(metrics);
  if (branch.success) return branch.data;
  return WhatsAppOrganizationReportMetricsSchema.parse(metrics);
}

export function canonicalizeWhatsAppReportMetrics(metrics: unknown) {
  return canonicalize(parseMetrics(metrics)) as WhatsAppReportMetrics;
}

export function serializeCanonicalWhatsAppReportMetrics(metrics: unknown) {
  return JSON.stringify(canonicalizeWhatsAppReportMetrics(metrics));
}

export function hashWhatsAppReportMetrics(metrics: unknown) {
  return createHash("sha256")
    .update(serializeCanonicalWhatsAppReportMetrics(metrics), "utf8")
    .digest("hex");
}

export function createWhatsAppReportSourceFingerprint(input: {
  scope: "BRANCH" | "ORGANIZATION";
  scopeKey: string;
  localReportDate: string;
  scheduledCutoffAt: Date;
  metricsVersion?: number;
}) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.scopeKey)) {
    throw new Error("Report scope key is invalid");
  }
  localDate.parse(input.localReportDate);
  if (Number.isNaN(input.scheduledCutoffAt.getTime())) {
    throw new Error("Report cutoff is invalid");
  }
  const metricsVersion = input.metricsVersion ?? WHATSAPP_REPORT_METRICS_VERSION;
  if (!Number.isSafeInteger(metricsVersion) || metricsVersion < 1) {
    throw new Error("Report metrics version is invalid");
  }
  return createHash("sha256").update(JSON.stringify({
    kind: "whatsapp-daily-report-source-v1",
    scope: input.scope,
    scopeKey: input.scopeKey,
    localReportDate: input.localReportDate,
    scheduledCutoffAt: input.scheduledCutoffAt.toISOString(),
    metricsVersion,
  }), "utf8").digest("hex");
}
