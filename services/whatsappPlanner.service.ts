import { createHash, randomUUID } from "node:crypto";

import {
  Prisma,
  type WhatsAppAutomationStage,
  type WhatsAppManagedTemplateKey,
  type WhatsAppMessagePurpose,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  isWhatsAppAutomationPlannerEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  paiseToInrMicros,
  readWhatsAppRateCard,
  resolveWhatsAppUtilityRate,
  validateWhatsAppMonthlyBudgetMinor,
  type WhatsAppRateCard,
} from "@/lib/whatsappCost";
import {
  getManagedWhatsAppTemplate,
  managedProviderTemplateMatches,
  prepareManagedWhatsAppTemplate,
  type WhatsAppManagedTemplateLanguage,
} from "@/lib/whatsappManagedTemplates";
import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";
import {
  addWhatsAppLocalDays,
  getWhatsAppLocalDateParts,
  nextWhatsAppSendAt,
  scheduleWhatsAppForLocalDate,
  whatsappBudgetMonth,
  whatsappLocalDateKey,
  type LocalDateParts,
} from "@/lib/whatsappSchedule";
import { EntitlementService } from "@/services/entitlement.service";
import type { WhatsAppCollectionMessageRefresh } from "@/services/whatsappMessage.service";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";
import { upcomingCyclesBetween } from "@/utils/studentBillingCycles";

export const WHATSAPP_PLANNER_MAX_BRANCHES = 25;
export const WHATSAPP_PLANNER_HORIZON_HOURS = 36;
export const WHATSAPP_PLANNER_LEASE_MINUTES = 10;
export const WHATSAPP_PLANNER_BRANCH_INTERVAL_MINUTES = 10;
export const WHATSAPP_PLANNER_MAX_RECIPIENTS_SCANNED = 2_000;
export const WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED = 5_000;
export const WHATSAPP_PLANNER_MAX_EVENTS_SCANNED = 1_000;
export const WHATSAPP_PLANNER_MAX_MESSAGES_PER_BRANCH = 200;
export const WHATSAPP_WELCOME_GRACE_MINUTES = 10;
export const WHATSAPP_WELCOME_WINDOW_HOURS = 48;

type PlannerClient = Prisma.TransactionClient;

type PlannerClaim = Readonly<{
  branchId: string;
  leaseToken: string;
}>;

type PlannerBinding = Awaited<ReturnType<typeof loadValidBindings>> extends Map<string, infer T>
  ? T
  : never;

type PlannerCandidate = {
  kind: "WELCOME" | "COLLECTION" | "PAYMENT_CONFIRMATION" | "PAYMENT_CORRECTION";
  stage: WhatsAppAutomationStage;
  purpose: WhatsAppMessagePurpose;
  priority: number;
  recipientPhoneE164: string;
  recipientIds: string[];
  studentIds: string[];
  paymentIds: string[];
  paymentResolutionEventId: string | null;
  managedTemplateKey: WhatsAppManagedTemplateKey;
  values: Record<string, string>;
  scheduledFor: Date;
  localDate: LocalDateParts;
  cycleDueDate: Date | null;
  identity: unknown;
  fingerprintFacts: unknown;
};

export type WhatsAppPlannerEventCursor = Readonly<{
  occurredAt: Date;
  id: string;
}>;

type PlannerCollectionSourcePage = Readonly<{
  recipients: Awaited<ReturnType<typeof queryRecipients>>;
  payments: Array<{
    id: string;
    studentId: string;
    amount: number;
    dueDate: Date;
    periodStart: Date;
  }>;
  nextRecipientCursorPhoneE164: string | null;
  skippedSourceGroups: number;
}>;

type CollectionChoice<T> = Readonly<{
  priority: number;
  stableId: string;
  value: T;
}>;

type BranchPlanResult = Readonly<{
  plannedMessages: number;
  skippedCandidates: number;
  cancelledMessages: number;
  errorCode: string | null;
}>;

type PlannerRunResult = Readonly<{
  held: boolean;
  claimedBranches: number;
  completedBranches: number;
  failedBranches: number;
  plannedMessages: number;
  skippedCandidates: number;
  cancelledMessages: number;
  limitReached: boolean;
}>;

const COLLECTION_STAGES = [
  "FEE_DUE_MINUS_7",
  "FEE_DUE_MINUS_3",
  "FEE_DUE_MINUS_1",
  "FEE_DUE_TODAY",
  "PAST_DUE_PLUS_1",
  "PAST_DUE_PLUS_3",
  "PAST_DUE_PLUS_7",
] as const satisfies readonly WhatsAppAutomationStage[];

const PRE_DUE_STAGES = [
  ["FEE_DUE_MINUS_7", 7, 101],
  ["FEE_DUE_MINUS_3", 3, 103],
  ["FEE_DUE_MINUS_1", 1, 107],
] as const satisfies ReadonlyArray<readonly [WhatsAppAutomationStage, number, number]>;

const PAST_DUE_STAGES = [
  ["PAST_DUE_PLUS_1", 1, 301],
  ["PAST_DUE_PLUS_3", 3, 303],
  ["PAST_DUE_PLUS_7", 7, 307],
] as const satisfies ReadonlyArray<readonly [WhatsAppAutomationStage, number, number]>;

const POSSIBLY_ACCEPTED_STATUSES = new Set([
  "SUBMITTING",
  "ACCEPTED",
  "SENT",
  "DELIVERED",
  "READ",
  "UNKNOWN",
]);

export function paymentCorrectionAction(input: {
  status: string;
  submissionStartedAt: Date | null;
}) {
  if (
    input.status === "SCHEDULED"
    || (input.status === "CLAIMED" && input.submissionStartedAt === null)
  ) return "CANCEL" as const;
  if (POSSIBLY_ACCEPTED_STATUSES.has(input.status)) return "CORRECT" as const;
  return "NONE" as const;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function hashWhatsAppPlannerValue(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export function createAutomaticMessageSourceFingerprint(input: {
  organizationId: string;
  branchId: string;
  senderId: string;
  recipientPhoneE164: string;
  recipientIds: readonly string[];
  settingsRevision: number;
  templateBindingId: string;
  templateId: string;
  templateVersion: number;
  catalogVersion: number;
  catalogHash: string;
  stage: WhatsAppAutomationStage;
  templateVariables: Readonly<Record<string, string>>;
  facts: unknown;
}) {
  return hashWhatsAppPlannerValue({
    version: 1,
    organizationId: input.organizationId,
    branchId: input.branchId,
    senderId: input.senderId,
    recipientHash: hashWhatsAppPlannerValue(input.recipientPhoneE164),
    recipientIds: [...input.recipientIds].sort(),
    settingsRevision: input.settingsRevision,
    templateBindingId: input.templateBindingId,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    catalogVersion: input.catalogVersion,
    catalogHash: input.catalogHash,
    stage: input.stage,
    templateVariables: input.templateVariables,
    facts: input.facts,
  });
}

export function chooseHighestPriorityCollection<T>(
  choices: readonly CollectionChoice<T>[]
): T | null {
  return [...choices]
    .sort((left, right) => right.priority - left.priority
      || left.stableId.localeCompare(right.stableId))[0]?.value ?? null;
}

function localDatePartsKey(value: LocalDateParts) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function utcLocalDate(value: LocalDateParts) {
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}

function addHours(value: Date, hours: number) {
  return new Date(value.getTime() + hours * 60 * 60 * 1_000);
}

function addMinutes(value: Date, minutes: number) {
  return new Date(value.getTime() + minutes * 60 * 1_000);
}

function normalizeLanguage(value: string): WhatsAppManagedTemplateLanguage | null {
  if (value === "en" || value === "en_IN") return "en_IN";
  if (value === "hi") return "hi";
  return null;
}

function formatAmount(value: number, language: WhatsAppManagedTemplateLanguage) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("PLANNER_AMOUNT_INVALID");
  return new Intl.NumberFormat(language === "hi" ? "hi-IN" : "en-IN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: Date, language: WhatsAppManagedTemplateLanguage, timeZone: string) {
  return new Intl.DateTimeFormat(language === "hi" ? "hi-IN" : "en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(value).replace(/\s+/g, " ").trim();
}

function formatPaymentMethod(value: string | null) {
  if (!value) return "Not specified";
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function collectionTemplateKey(input: {
  studentCount: number;
  pastDue: boolean;
  tone: string;
}): WhatsAppManagedTemplateKey {
  if (input.studentCount > 1) return "MULTI_STUDENT_COLLECTION_SUMMARY";
  if (input.pastDue) return input.tone === "firm" ? "PAST_DUE_FIRM" : "PAST_DUE_POLITE";
  return input.tone === "friendly" ? "FEE_RENEWAL_FRIENDLY" : "FEE_RENEWAL_POLITE";
}

function safePlannerErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)) {
    return error.message;
  }
  return "BRANCH_PLANNING_FAILED";
}

function plannerSlots(input: {
  now: Date;
  horizonEnd: Date;
  timeZone: string;
  sendTimeLocal: string;
}) {
  const today = getWhatsAppLocalDateParts(input.now, input.timeZone);
  const slots: Array<{ localDate: LocalDateParts; scheduledFor: Date }> = [];
  for (let offset = 0; offset <= 2; offset += 1) {
    const localDate = addWhatsAppLocalDays(today, offset);
    const scheduledFor = scheduleWhatsAppForLocalDate({
      localDate,
      sendTimeLocal: input.sendTimeLocal,
      timeZone: input.timeZone,
    });
    if (scheduledFor >= input.now && scheduledFor <= input.horizonEnd) {
      slots.push({ localDate, scheduledFor });
    }
  }
  return slots;
}

function frequencyKey(input: {
  senderId: string;
  branchId: string;
  phoneE164: string;
  localDate: LocalDateParts;
}) {
  return hashWhatsAppPlannerValue({
    kind: "automatic-collection-frequency-v1",
    senderId: input.senderId,
    branchId: input.branchId,
    recipientHash: hashWhatsAppPlannerValue(input.phoneE164),
    localDate: localDatePartsKey(input.localDate),
  });
}

function dedupeKey(input: {
  senderId: string;
  branchId: string;
  candidate: PlannerCandidate;
}) {
  return hashWhatsAppPlannerValue({
    kind: "automatic-message-business-event-v1",
    senderId: input.senderId,
    branchId: input.branchId,
    event: input.candidate.identity,
  });
}

function validCurrentPhone(studentPhone: string | null, recipientPhoneE164: string) {
  if (!studentPhone) return false;
  try {
    return normalizeWhatsAppPhone(studentPhone, { defaultCountry: "IN" }) === recipientPhoneE164;
  } catch {
    return false;
  }
}

function isValidBinding(
  binding: Awaited<ReturnType<typeof queryBindings>>[number],
  managedKey: WhatsAppManagedTemplateKey,
  language: WhatsAppManagedTemplateLanguage
) {
  const definition = getManagedWhatsAppTemplate(managedKey, language);
  return binding.managedKey === managedKey
    && binding.language === language
    && binding.catalogVersion === definition.catalogVersion
    && binding.catalogHash === definition.catalogHash
    && binding.provisioning.status === "READY"
    && binding.template.providerStatus === "APPROVED"
    && binding.template.category === "UTILITY"
    && binding.template.staleAt === null
    && Array.isArray(binding.template.components)
    && managedProviderTemplateMatches({
      name: binding.template.name,
      language: binding.template.language,
      category: binding.template.category,
      components: binding.template.components,
    }, definition);
}

function queryBindings(
  tx: PlannerClient,
  senderId: string,
  language: WhatsAppManagedTemplateLanguage
) {
  return tx.whatsAppTemplateBinding.findMany({
    where: { senderId, language, active: true },
    include: { template: true, provisioning: true },
  });
}

async function loadValidBindings(
  tx: PlannerClient,
  senderId: string,
  language: WhatsAppManagedTemplateLanguage
) {
  const rows = await queryBindings(tx, senderId, language);
  const bindings = new Map<WhatsAppManagedTemplateKey, (typeof rows)[number]>();
  for (const row of rows) {
    if (isValidBinding(row, row.managedKey, language)) bindings.set(row.managedKey, row);
  }
  return bindings;
}

async function reconcileConfigurationRevision(input: {
  tx: PlannerClient;
  branchId: string;
  settingsRevision: number;
  now: Date;
}) {
  const baseWhere: Prisma.WhatsAppMessageWhereInput = {
    branchId: input.branchId,
    trigger: "AUTOMATION",
    OR: [
      { settingsRevision: null },
      { settingsRevision: { not: input.settingsRevision } },
    ],
    AND: [{
      OR: [
        { status: "SCHEDULED" },
        { status: "CLAIMED", submissionStartedAt: null },
      ],
    }],
  };
  const reserved = await input.tx.whatsAppMessage.updateMany({
    where: { ...baseWhere, budgetState: "RESERVED" },
    data: {
      status: "SUPPRESSED",
      suppressedAt: input.now,
      failureCode: "CONFIGURATION_CHANGED",
      budgetState: "RELEASED",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  const unreserved = await input.tx.whatsAppMessage.updateMany({
    where: { ...baseWhere, budgetState: { not: "RESERVED" } },
    data: {
      status: "SUPPRESSED",
      suppressedAt: input.now,
      failureCode: "CONFIGURATION_CHANGED",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  return reserved.count + unreserved.count;
}

async function cancelConfirmationMessage(input: {
  tx: PlannerClient;
  messageId: string;
  now: Date;
}) {
  const eligible = {
    id: input.messageId,
    OR: [
      { status: "SCHEDULED" as const },
      { status: "CLAIMED" as const, submissionStartedAt: null },
    ],
  };
  const reserved = await input.tx.whatsAppMessage.updateMany({
    where: { ...eligible, budgetState: "RESERVED" },
    data: {
      status: "CANCELLED",
      cancelledAt: input.now,
      failureCode: "PAYMENT_WAIVED",
      budgetState: "RELEASED",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  const unreserved = await input.tx.whatsAppMessage.updateMany({
    where: { ...eligible, budgetState: { not: "RESERVED" } },
    data: {
      status: "CANCELLED",
      cancelledAt: input.now,
      failureCode: "PAYMENT_WAIVED",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  return reserved.count + unreserved.count;
}

async function disqualifyBranch(input: {
  tx: PlannerClient;
  claim: PlannerClaim;
  now: Date;
  code: string;
  cancelPending: boolean;
}) {
  let cancelledMessages = 0;
  if (input.cancelPending) {
    const cancellation = await WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
      tx: input.tx,
      scope: { branchId: input.claim.branchId, trigger: "AUTOMATION" },
      reason: input.code,
      disposition: "SUPPRESSED",
      now: input.now,
    });
    cancelledMessages = cancellation.affectedCount;
  }
  await input.tx.branchWhatsAppSettings.updateMany({
    where: { branchId: input.claim.branchId, plannerLeaseToken: input.claim.leaseToken },
    data: {
      plannerLeaseToken: null,
      plannerLeaseUntil: null,
      lastPlannedAt: input.now,
      lastPlannerErrorCode: input.code,
    },
  });
  return {
    plannedMessages: 0,
    skippedCandidates: 0,
    cancelledMessages,
    errorCode: input.code,
  } satisfies BranchPlanResult;
}

function candidateRecipientGroups<
  T extends { id: string; phoneE164: string; student: { id: string } }
>(recipients: readonly T[]) {
  const byPhone = new Map<string, T[]>();
  const byStudent = new Map<string, T>();
  for (const recipient of recipients) {
    const group = byPhone.get(recipient.phoneE164) ?? [];
    group.push(recipient);
    byPhone.set(recipient.phoneE164, group);
    byStudent.set(recipient.student.id, recipient);
  }
  return { byPhone, byStudent };
}

export function buildWelcomeCandidates(input: {
  recipients: Awaited<ReturnType<typeof queryRecipients>>;
  enabledStages: ReadonlySet<WhatsAppAutomationStage>;
  existingStudentIds: ReadonlySet<string>;
  activationAt: Date;
  now: Date;
  horizonEnd: Date;
  sendTimeLocal: string;
  timeZone: string;
  language: WhatsAppManagedTemplateLanguage;
  branchName: string;
}) {
  if (!input.enabledStages.has("WELCOME")) return [];
  const candidates: PlannerCandidate[] = [];
  const earliestCreatedAt = addHours(input.now, -WHATSAPP_WELCOME_WINDOW_HOURS);
  for (const recipient of input.recipients) {
    const student = recipient.student;
    if (
      student.enrollmentSource !== "MANUAL"
      || student.createdAt < input.activationAt
      || student.createdAt < earliestCreatedAt
      || student.createdAt > addMinutes(input.now, -WHATSAPP_WELCOME_GRACE_MINUTES)
      || input.existingStudentIds.has(student.id)
    ) continue;

    const graceAt = addMinutes(student.createdAt, WHATSAPP_WELCOME_GRACE_MINUTES);
    const scheduledFor = nextWhatsAppSendAt({
      now: graceAt > input.now ? graceAt : input.now,
      sendTimeLocal: input.sendTimeLocal,
      timeZone: input.timeZone,
    });
    if (
      scheduledFor > input.horizonEnd
      || scheduledFor > addHours(student.createdAt, WHATSAPP_WELCOME_WINDOW_HOURS)
    ) continue;

    const allocation = student.seatAllocations[0] ?? null;
    const managedTemplateKey = allocation ? "WELCOME_ALLOCATED" : "WELCOME_GENERAL";
    const startDate = allocation?.startDate ?? student.joinedAt;
    const values: Record<string, string> = allocation
      ? {
          studentName: student.name,
          branchName: input.branchName,
          seatLabel: allocation.seat.label,
          shiftName: allocation.multiShift?.name ?? allocation.shift.name,
          startDate: formatDate(startDate, input.language, input.timeZone),
        }
      : {
          studentName: student.name,
          branchName: input.branchName,
          startDate: formatDate(startDate, input.language, input.timeZone),
        };
    candidates.push({
      kind: "WELCOME",
      stage: "WELCOME",
      purpose: "WELCOME",
      priority: 25,
      recipientPhoneE164: recipient.phoneE164,
      recipientIds: [recipient.id],
      studentIds: [student.id],
      paymentIds: [],
      paymentResolutionEventId: null,
      managedTemplateKey,
      values,
      scheduledFor,
      localDate: getWhatsAppLocalDateParts(scheduledFor, input.timeZone),
      cycleDueDate: null,
      identity: { kind: "welcome-v1", studentId: student.id },
      fingerprintFacts: {
        studentId: student.id,
        enrollmentSource: student.enrollmentSource,
        status: student.status,
        joinedAt: student.joinedAt,
        allocation: allocation ? {
          id: allocation.id,
          seatId: allocation.seatId,
          shiftId: allocation.shiftId,
          multiShiftId: allocation.multiShiftId,
          startDate: allocation.startDate,
          endDate: allocation.endDate,
        } : null,
      },
    });
  }
  return candidates;
}

function recipientQueryWhere(input: {
  branchId: string;
  senderId: string;
  phoneE164?: string;
  afterPhoneE164?: string | null;
  studentIds?: readonly string[];
}): Prisma.WhatsAppStudentRecipientWhereInput {
  return {
    branchId: input.branchId,
    senderId: input.senderId,
    ...(input.phoneE164
      ? { phoneE164: input.phoneE164 }
      : input.afterPhoneE164
        ? { phoneE164: { gt: input.afterPhoneE164 } }
        : {}),
    ...(input.studentIds ? { studentId: { in: [...input.studentIds] } } : {}),
    status: "ACTIVE",
    consent: {
      senderId: input.senderId,
      consentType: "OPERATIONAL",
      status: "OPTED_IN",
    },
    student: { status: "ACTIVE" },
  };
}

function queryRecipients(input: {
  tx: PlannerClient;
  branchId: string;
  senderId: string;
  now: Date;
  phoneE164?: string;
  afterPhoneE164?: string | null;
  studentIds?: readonly string[];
  limit?: number;
}) {
  return input.tx.whatsAppStudentRecipient.findMany({
    where: recipientQueryWhere(input),
    orderBy: [{ phoneE164: "asc" }, { id: "asc" }],
    take: input.limit ?? WHATSAPP_PLANNER_MAX_RECIPIENTS_SCANNED,
    include: {
      consent: { select: { id: true, senderId: true, phoneE164: true, status: true } },
      student: {
        select: {
          id: true,
          name: true,
          phone: true,
          status: true,
          enrollmentSource: true,
          joinedAt: true,
          billingStartAt: true,
          monthlyFee: true,
          createdAt: true,
          seatAllocations: {
            where: {
              startDate: { lte: input.now },
              OR: [{ endDate: null }, { endDate: { gte: input.now } }],
            },
            orderBy: [{ startDate: "desc" }, { id: "desc" }],
            take: 1,
            include: {
              seat: { select: { label: true } },
              shift: { select: { name: true } },
              multiShift: { select: { name: true } },
            },
          },
        },
      },
    },
  });
}

/**
 * Loads only whole recipient-phone groups whose complete DUE source set fits
 * inside the per-run payment bound. The persisted phone cursor is always moved
 * at a group boundary, so a page cut can defer a group but can never fabricate
 * a partial amount, partial fingerprint, or false pre-due candidate.
 */
export async function loadPlannerCollectionSourcePage(input: {
  tx: PlannerClient;
  branchId: string;
  senderId: string;
  now: Date;
  horizonEnd: Date;
  recipientCursorPhoneE164: string | null;
}): Promise<PlannerCollectionSourcePage> {
  const queryWindow = (afterPhoneE164: string | null) => queryRecipients({
    tx: input.tx,
    branchId: input.branchId,
    senderId: input.senderId,
    now: input.now,
    afterPhoneE164,
  });
  let rawRecipients = await queryWindow(input.recipientCursorPhoneE164);
  let wrapped = false;
  if (rawRecipients.length === 0 && input.recipientCursorPhoneE164) {
    wrapped = true;
    rawRecipients = await queryWindow(null);
  }
  if (rawRecipients.length === 0) {
    return {
      recipients: [],
      payments: [],
      nextRecipientCursorPhoneE164: null,
      skippedSourceGroups: 0,
    };
  }

  let completeRecipients = rawRecipients;
  const lastPhoneE164 = rawRecipients.at(-1)!.phoneE164;
  let oversizedTrailingPhone = false;
  if (rawRecipients.length === WHATSAPP_PLANNER_MAX_RECIPIENTS_SCANNED) {
    const loadedForLastPhone = rawRecipients.filter(
      recipient => recipient.phoneE164 === lastPhoneE164
    ).length;
    const totalForLastPhone = await input.tx.whatsAppStudentRecipient.count({
      where: recipientQueryWhere({
        branchId: input.branchId,
        senderId: input.senderId,
        phoneE164: lastPhoneE164,
      }),
    });
    if (totalForLastPhone > loadedForLastPhone) {
      completeRecipients = rawRecipients.filter(
        recipient => recipient.phoneE164 !== lastPhoneE164
      );
      oversizedTrailingPhone = totalForLastPhone > WHATSAPP_PLANNER_MAX_RECIPIENTS_SCANNED;
    }
  }

  const groups = new Map<string, typeof completeRecipients>();
  for (const recipient of completeRecipients) {
    const group = groups.get(recipient.phoneE164) ?? [];
    group.push(recipient);
    groups.set(recipient.phoneE164, group);
  }
  const completeStudentIds = completeRecipients.map(recipient => recipient.student.id);
  const dueCounts = completeStudentIds.length === 0
    ? []
    : await input.tx.payment.groupBy({
        by: ["studentId"],
        where: {
          branchId: input.branchId,
          studentId: { in: completeStudentIds },
          status: "DUE",
          amount: { gt: 0 },
          dueDate: { lte: input.horizonEnd },
        },
        _count: { id: true },
        orderBy: { studentId: "asc" },
      });
  const dueCountByStudent = new Map(dueCounts.map(row => [row.studentId, row._count.id]));
  const selectedRecipients: typeof completeRecipients = [];
  const selectedStudentIds: string[] = [];
  let expectedPaymentCount = 0;
  let skippedSourceGroups = 0;
  let nextRecipientCursorPhoneE164 = wrapped ? null : input.recipientCursorPhoneE164;

  for (const [phoneE164, group] of groups) {
    const groupDueCount = group.reduce(
      (count, recipient) => count + (dueCountByStudent.get(recipient.student.id) ?? 0),
      0
    );
    if (groupDueCount > WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED) {
      // One guardian group cannot be represented truthfully inside the hard
      // source-row ceiling. Rotate past it so it cannot starve later groups.
      skippedSourceGroups += 1;
      nextRecipientCursorPhoneE164 = phoneE164;
      continue;
    }
    if (expectedPaymentCount + groupDueCount > WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED) {
      break;
    }
    selectedRecipients.push(...group);
    selectedStudentIds.push(...group.map(recipient => recipient.student.id));
    expectedPaymentCount += groupDueCount;
    nextRecipientCursorPhoneE164 = phoneE164;
  }

  if (groups.size === 0 && oversizedTrailingPhone) {
    // The phone itself exceeds the recipient ceiling. It is intentionally
    // skipped for this cycle, but the circular cursor will revisit it later.
    skippedSourceGroups += 1;
    nextRecipientCursorPhoneE164 = lastPhoneE164;
  }

  const payments = selectedStudentIds.length === 0
    ? []
    : await input.tx.payment.findMany({
        where: {
          branchId: input.branchId,
          studentId: { in: selectedStudentIds },
          status: "DUE",
          amount: { gt: 0 },
          dueDate: { lte: input.horizonEnd },
        },
        orderBy: [{ studentId: "asc" }, { dueDate: "asc" }, { id: "asc" }],
        take: WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED,
        select: {
          id: true,
          studentId: true,
          amount: true,
          dueDate: true,
          periodStart: true,
        },
      });
  if (payments.length !== expectedPaymentCount) {
    // Serializable planning will retry a concurrent source change. Failing
    // closed is safer than interpreting a changed/truncated set as complete.
    throw new Error("PLANNER_DUE_SCAN_CHANGED");
  }

  return {
    recipients: selectedRecipients,
    payments,
    nextRecipientCursorPhoneE164,
    skippedSourceGroups,
  };
}

export function buildCollectionCandidates(input: {
  recipients: Awaited<ReturnType<typeof queryRecipients>>;
  payments: Array<{
    id: string;
    studentId: string;
    amount: number;
    dueDate: Date;
    periodStart: Date;
  }>;
  enabledStages: ReadonlySet<WhatsAppAutomationStage>;
  slots: Array<{ localDate: LocalDateParts; scheduledFor: Date }>;
  now: Date;
  horizonEnd: Date;
  timeZone: string;
  language: WhatsAppManagedTemplateLanguage;
  branchName: string;
  tone: string;
}) {
  const { byPhone } = candidateRecipientGroups(input.recipients);
  const paymentsByStudent = new Map<string, typeof input.payments>();
  for (const payment of input.payments) {
    const rows = paymentsByStudent.get(payment.studentId) ?? [];
    rows.push(payment);
    paymentsByStudent.set(payment.studentId, rows);
  }
  const candidates: PlannerCandidate[] = [];

  for (const slot of input.slots) {
    const slotKey = localDatePartsKey(slot.localDate);
    for (const [phoneE164, recipients] of byPhone) {
      const choices: Array<CollectionChoice<PlannerCandidate>> = [];
      const recipientStudentIds = new Set(recipients.map(row => row.student.id));
      const phonePayments = input.payments.filter(payment => recipientStudentIds.has(payment.studentId));

      for (const [stage, offset, priority] of PAST_DUE_STAGES) {
        if (!input.enabledStages.has(stage)) continue;
        const triggerKey = localDatePartsKey(addWhatsAppLocalDays(slot.localDate, -offset));
        const triggers = phonePayments.filter(payment =>
          whatsappLocalDateKey(payment.dueDate, input.timeZone) === triggerKey
        );
        if (triggers.length === 0) continue;
        const unresolved = phonePayments.filter(payment =>
          whatsappLocalDateKey(payment.dueDate, input.timeZone) <= slotKey
        );
        if (unresolved.length === 0) continue;
        const studentIds = [...new Set(unresolved.map(row => row.studentId))].sort();
        const totalAmount = unresolved.reduce((sum, row) => sum + row.amount, 0);
        const oldestDueDate = [...unresolved]
          .sort((left, right) => left.dueDate.getTime() - right.dueDate.getTime())[0]!.dueDate;
        const managedTemplateKey = collectionTemplateKey({
          studentCount: studentIds.length,
          pastDue: true,
          tone: input.tone,
        });
        const values: Record<string, string> = studentIds.length > 1
          ? {
              studentCount: String(studentIds.length),
              amount: formatAmount(totalAmount, input.language),
              branchName: input.branchName,
              earliestDueDate: formatDate(oldestDueDate, input.language, input.timeZone),
            }
          : {
              studentName: recipients.find(row => row.student.id === studentIds[0])!.student.name,
              amount: formatAmount(totalAmount, input.language),
              branchName: input.branchName,
              oldestDueDate: formatDate(oldestDueDate, input.language, input.timeZone),
            };
        choices.push({
          priority,
          stableId: stage,
          value: {
            kind: "COLLECTION",
            stage,
            purpose: "PAST_DUE",
            priority,
            recipientPhoneE164: phoneE164,
            recipientIds: recipients
              .filter(row => studentIds.includes(row.student.id)).map(row => row.id).sort(),
            studentIds,
            paymentIds: unresolved.map(row => row.id).sort(),
            paymentResolutionEventId: null,
            managedTemplateKey,
            values,
            scheduledFor: slot.scheduledFor,
            localDate: slot.localDate,
            cycleDueDate: triggers[0]!.dueDate,
            identity: {
              kind: "past-due-v1",
              localDate: slotKey,
              stage,
              triggerPaymentIds: triggers.map(row => row.id).sort(),
            },
            fingerprintFacts: {
              unresolved: unresolved.map(row => ({
                id: row.id,
                studentId: row.studentId,
                status: "DUE",
                amount: row.amount,
                dueDate: row.dueDate,
              })).sort((left, right) => left.id.localeCompare(right.id)),
            },
          },
        });
      }

      if (input.enabledStages.has("FEE_DUE_TODAY")) {
        const dueToday = phonePayments.filter(payment =>
          whatsappLocalDateKey(payment.dueDate, input.timeZone) === slotKey
        );
        if (dueToday.length > 0) {
          const studentIds = [...new Set(dueToday.map(row => row.studentId))].sort();
          const totalAmount = dueToday.reduce((sum, row) => sum + row.amount, 0);
          const dueDate = dueToday[0]!.dueDate;
          const managedTemplateKey = collectionTemplateKey({
            studentCount: studentIds.length,
            pastDue: false,
            tone: input.tone,
          });
          const values: Record<string, string> = studentIds.length > 1
            ? {
                studentCount: String(studentIds.length),
                amount: formatAmount(totalAmount, input.language),
                branchName: input.branchName,
                earliestDueDate: formatDate(dueDate, input.language, input.timeZone),
              }
            : {
                studentName: recipients.find(row => row.student.id === studentIds[0])!.student.name,
                amount: formatAmount(totalAmount, input.language),
                branchName: input.branchName,
                dueDate: formatDate(dueDate, input.language, input.timeZone),
              };
          choices.push({
            priority: 200,
            stableId: "FEE_DUE_TODAY",
            value: {
              kind: "COLLECTION",
              stage: "FEE_DUE_TODAY",
              purpose: "FEE_RENEWAL",
              priority: 200,
              recipientPhoneE164: phoneE164,
              recipientIds: recipients
                .filter(row => studentIds.includes(row.student.id)).map(row => row.id).sort(),
              studentIds,
              paymentIds: dueToday.map(row => row.id).sort(),
              paymentResolutionEventId: null,
              managedTemplateKey,
              values,
              scheduledFor: slot.scheduledFor,
              localDate: slot.localDate,
              cycleDueDate: dueDate,
              identity: {
                kind: "due-today-v1",
                localDate: slotKey,
                paymentIds: dueToday.map(row => row.id).sort(),
              },
              fingerprintFacts: dueToday.map(row => ({
                id: row.id,
                studentId: row.studentId,
                status: "DUE",
                amount: row.amount,
                dueDate: row.dueDate,
              })).sort((left, right) => left.id.localeCompare(right.id)),
            },
          });
        }
      }

      const phoneHasUnresolved = phonePayments.some(payment =>
        whatsappLocalDateKey(payment.dueDate, input.timeZone) <= slotKey
      );
      if (!phoneHasUnresolved) {
        for (const [stage, offset, priority] of PRE_DUE_STAGES) {
          if (!input.enabledStages.has(stage)) continue;
          const targetDueKey = localDatePartsKey(addWhatsAppLocalDays(slot.localDate, offset));
          const cycles = recipients.flatMap(recipient => {
            const student = recipient.student;
            if (student.monthlyFee <= 0) return [];
            if ((paymentsByStudent.get(student.id) ?? []).some(payment =>
              whatsappLocalDateKey(payment.dueDate, input.timeZone) <= slotKey
            )) return [];
            return upcomingCyclesBetween(
              student.joinedAt,
              addHours(input.now, -24),
              addHours(input.horizonEnd, 7 * 24),
              student.billingStartAt
            ).filter(cycle => whatsappLocalDateKey(cycle.dueDate, input.timeZone) === targetDueKey)
              .map(cycle => ({ recipient, student, cycle }));
          });
          if (cycles.length === 0) continue;
          const studentIds = [...new Set(cycles.map(row => row.student.id))].sort();
          const totalAmount = cycles.reduce((sum, row) => sum + row.student.monthlyFee, 0);
          const earliestDueDate = [...cycles]
            .sort((left, right) => left.cycle.dueDate.getTime() - right.cycle.dueDate.getTime())[0]!
            .cycle.dueDate;
          const managedTemplateKey = collectionTemplateKey({
            studentCount: studentIds.length,
            pastDue: false,
            tone: input.tone,
          });
          const values: Record<string, string> = studentIds.length > 1
            ? {
                studentCount: String(studentIds.length),
                amount: formatAmount(totalAmount, input.language),
                branchName: input.branchName,
                earliestDueDate: formatDate(earliestDueDate, input.language, input.timeZone),
              }
            : {
                studentName: cycles[0]!.student.name,
                amount: formatAmount(totalAmount, input.language),
                branchName: input.branchName,
                dueDate: formatDate(earliestDueDate, input.language, input.timeZone),
              };
          const cycleFacts = cycles.map(row => ({
            studentId: row.student.id,
            status: row.student.status,
            joinedAt: row.student.joinedAt,
            billingStartAt: row.student.billingStartAt,
            periodStart: row.cycle.periodStart,
            periodEnd: row.cycle.periodEnd,
            dueDate: row.cycle.dueDate,
            amount: row.student.monthlyFee,
          })).sort((left, right) => left.studentId.localeCompare(right.studentId));
          choices.push({
            priority,
            stableId: stage,
            value: {
              kind: "COLLECTION",
              stage,
              purpose: "FEE_RENEWAL",
              priority,
              recipientPhoneE164: phoneE164,
              recipientIds: cycles.map(row => row.recipient.id).sort(),
              studentIds,
              paymentIds: [],
              paymentResolutionEventId: null,
              managedTemplateKey,
              values,
              scheduledFor: slot.scheduledFor,
              localDate: slot.localDate,
              cycleDueDate: earliestDueDate,
              identity: { kind: "pre-due-v1", localDate: slotKey, stage, cycles: cycleFacts },
              fingerprintFacts: cycleFacts,
            },
          });
        }
      }

      const selected = chooseHighestPriorityCollection(choices);
      if (selected) candidates.push(selected);
    }
  }
  return candidates;
}

function plannerEventCursorWhere(
  cursor: WhatsAppPlannerEventCursor | null
): Prisma.PaymentResolutionEventWhereInput | null {
  if (!cursor) return null;
  return {
    OR: [
      { occurredAt: { gt: cursor.occurredAt } },
      { occurredAt: cursor.occurredAt, id: { gt: cursor.id } },
    ],
  };
}

export function earlierPaymentActionPaidEventWhere(
  event: WhatsAppPlannerEventCursor & Readonly<{ paymentId: string }>
): Prisma.PaymentResolutionEventWhereInput {
  return {
    paymentId: event.paymentId,
    source: "PAYMENT_ACTION",
    toStatus: "PAID",
    OR: [
      { occurredAt: { lt: event.occurredAt } },
      { occurredAt: event.occurredAt, id: { lt: event.id } },
    ],
  };
}

/**
 * Reads one bounded compound-key page and wraps after the tail. Successful
 * outbox dedupe makes revisits harmless, while circular scanning ensures an
 * ineligible or temporarily unplannable head page cannot starve later events.
 */
export async function loadPlannerPaymentEventPage(input: {
  tx: PlannerClient;
  where: Prisma.PaymentResolutionEventWhereInput;
  cursor: WhatsAppPlannerEventCursor | null;
}) {
  const queryPage = (cursor: WhatsAppPlannerEventCursor | null) => {
    const cursorWhere = plannerEventCursorWhere(cursor);
    return input.tx.paymentResolutionEvent.findMany({
      where: {
        AND: [input.where, ...(cursorWhere ? [cursorWhere] : [])],
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: WHATSAPP_PLANNER_MAX_EVENTS_SCANNED,
      include: { payment: { include: { student: true } } },
    });
  };
  let events = await queryPage(input.cursor);
  if (events.length === 0 && input.cursor) events = await queryPage(null);
  const last = events.at(-1);
  return {
    events,
    nextCursor: last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}

function readPlannerEventCursor(
  occurredAt: Date | null,
  id: string | null
): WhatsAppPlannerEventCursor | null {
  return occurredAt && id ? { occurredAt, id } : null;
}

async function paymentEventCandidates(input: {
  tx: PlannerClient;
  enabledStages: ReadonlySet<WhatsAppAutomationStage>;
  organizationId: string;
  branchId: string;
  senderId: string;
  activationAt: Date;
  now: Date;
  horizonEnd: Date;
  sendTimeLocal: string;
  timeZone: string;
  language: WhatsAppManagedTemplateLanguage;
  branchName: string;
  correctionCursor: WhatsAppPlannerEventCursor | null;
  paidCursor: WhatsAppPlannerEventCursor | null;
}) {
  const candidates: PlannerCandidate[] = [];
  let cancelledMessages = 0;
  const correctionPage = await loadPlannerPaymentEventPage({
    tx: input.tx,
    where: {
      branchId: input.branchId,
      source: "PAYMENT_ACTION",
      fromStatus: "PAID",
      toStatus: "WAIVED",
      occurredAt: { gte: input.activationAt, lte: input.now },
    },
    cursor: input.correctionCursor,
  });
  const paidPage = input.enabledStages.has("PAYMENT_CONFIRMATION")
    ? await loadPlannerPaymentEventPage({
        tx: input.tx,
        where: {
          branchId: input.branchId,
          source: "PAYMENT_ACTION",
          toStatus: "PAID",
          occurredAt: { gte: input.activationAt, lte: input.now },
          payment: { status: "PAID" },
          whatsAppMessages: {
            none: { senderId: input.senderId, automationStage: "PAYMENT_CONFIRMATION" },
          },
        },
        cursor: input.paidCursor,
      })
    : { events: [], nextCursor: input.paidCursor };
  const eventStudentIds = [...new Set([
    ...correctionPage.events.map(event => event.payment.studentId),
    ...paidPage.events.map(event => event.payment.studentId),
  ])];
  const rawEventRecipients = eventStudentIds.length === 0
    ? []
    : await queryRecipients({
        tx: input.tx,
        branchId: input.branchId,
        senderId: input.senderId,
        now: input.now,
        studentIds: eventStudentIds,
        limit: Math.min(eventStudentIds.length, WHATSAPP_PLANNER_MAX_RECIPIENTS_SCANNED),
      });
  const eventRecipients = rawEventRecipients.filter(recipient =>
    recipient.organizationId === input.organizationId
    && recipient.consent.senderId === input.senderId
    && recipient.consent.phoneE164 === recipient.phoneE164
    && validCurrentPhone(recipient.student.phone, recipient.phoneE164)
  );
  const { byStudent: recipientsByStudent } = candidateRecipientGroups(eventRecipients);

  for (const event of correctionPage.events) {
    const earlierPaid = await input.tx.paymentResolutionEvent.findFirst({
      where: earlierPaymentActionPaidEventWhere(event),
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (!earlierPaid) continue;
    const confirmation = await input.tx.whatsAppMessage.findFirst({
      where: {
        senderId: input.senderId,
        paymentResolutionEventId: earlierPaid.id,
        automationStage: "PAYMENT_CONFIRMATION",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true, submissionStartedAt: true },
    });
    if (!confirmation) continue;
    const correctionAction = paymentCorrectionAction(confirmation);
    if (correctionAction === "CANCEL") {
      cancelledMessages += await cancelConfirmationMessage({
        tx: input.tx,
        messageId: confirmation.id,
        now: input.now,
      });
      continue;
    }
    if (
      !input.enabledStages.has("PAYMENT_CORRECTION")
      || correctionAction !== "CORRECT"
    ) continue;
    const recipient = recipientsByStudent.get(event.payment.studentId);
    if (!recipient) continue;
    const scheduledFor = nextWhatsAppSendAt({
      now: input.now,
      sendTimeLocal: input.sendTimeLocal,
      timeZone: input.timeZone,
    });
    if (scheduledFor > input.horizonEnd) continue;
    candidates.push({
      kind: "PAYMENT_CORRECTION",
      stage: "PAYMENT_CORRECTION",
      purpose: "PAYMENT_CORRECTION",
      priority: 500,
      recipientPhoneE164: recipient.phoneE164,
      recipientIds: [recipient.id],
      studentIds: [event.payment.studentId],
      paymentIds: [event.paymentId],
      paymentResolutionEventId: event.id,
      managedTemplateKey: "PAYMENT_CORRECTION",
      values: {
        amount: formatAmount(event.amount, input.language),
        studentName: event.payment.student.name,
        branchName: input.branchName,
        paymentDate: formatDate(event.paidAt ?? event.occurredAt, input.language, input.timeZone),
        newStatus: "waived",
      },
      scheduledFor,
      localDate: getWhatsAppLocalDateParts(scheduledFor, input.timeZone),
      cycleDueDate: null,
      identity: { kind: "payment-correction-v1", paymentResolutionEventId: event.id },
      fingerprintFacts: {
        eventId: event.id,
        paymentId: event.paymentId,
        source: event.source,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        amount: event.amount,
        paidAt: event.paidAt,
        occurredAt: event.occurredAt,
        confirmationMessageId: confirmation.id,
      },
    });
  }

  if (input.enabledStages.has("PAYMENT_CONFIRMATION")) {
    for (const event of paidPage.events) {
      const recipient = recipientsByStudent.get(event.payment.studentId);
      if (!recipient) continue;
      const scheduledFor = nextWhatsAppSendAt({
        now: input.now,
        sendTimeLocal: input.sendTimeLocal,
        timeZone: input.timeZone,
      });
      if (scheduledFor > input.horizonEnd) continue;
      candidates.push({
        kind: "PAYMENT_CONFIRMATION",
        stage: "PAYMENT_CONFIRMATION",
        purpose: "PAYMENT_CONFIRMATION",
        priority: 450,
        recipientPhoneE164: recipient.phoneE164,
        recipientIds: [recipient.id],
        studentIds: [event.payment.studentId],
        paymentIds: [event.paymentId],
        paymentResolutionEventId: event.id,
        managedTemplateKey: "PAYMENT_CONFIRMATION",
        values: {
          studentName: event.payment.student.name,
          amount: formatAmount(event.amount, input.language),
          branchName: input.branchName,
          paymentDate: formatDate(event.paidAt ?? event.occurredAt, input.language, input.timeZone),
          paymentMethod: formatPaymentMethod(event.paymentMethod),
        },
        scheduledFor,
        localDate: getWhatsAppLocalDateParts(scheduledFor, input.timeZone),
        cycleDueDate: null,
        identity: { kind: "payment-confirmation-v1", paymentResolutionEventId: event.id },
        fingerprintFacts: {
          eventId: event.id,
          paymentId: event.paymentId,
          source: event.source,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          amount: event.amount,
          paidAt: event.paidAt,
          paymentMethod: event.paymentMethod,
          occurredAt: event.occurredAt,
        },
      });
    }
  }
  return {
    candidates,
    cancelledMessages,
    nextCorrectionCursor: correctionPage.nextCursor,
    nextPaidCursor: paidPage.nextCursor,
  };
}

async function createCandidateMessage(input: {
  tx: PlannerClient;
  organizationId: string;
  branchId: string;
  senderId: string;
  settingsRevision: number;
  timeZone: string;
  language: WhatsAppManagedTemplateLanguage;
  binding: PlannerBinding;
  candidate: PlannerCandidate;
  rateCard: WhatsAppRateCard;
}) {
  const definition = getManagedWhatsAppTemplate(
    input.candidate.managedTemplateKey,
    input.language
  );
  const prepared = prepareManagedWhatsAppTemplate(definition, input.candidate.values);
  const candidateDedupeKey = dedupeKey({
    senderId: input.senderId,
    branchId: input.branchId,
    candidate: input.candidate,
  });
  const candidateFrequencyKey = input.candidate.kind === "COLLECTION"
    ? frequencyKey({
        senderId: input.senderId,
        branchId: input.branchId,
        phoneE164: input.candidate.recipientPhoneE164,
        localDate: input.candidate.localDate,
      })
    : null;
  const existing = await input.tx.whatsAppMessage.findFirst({
    where: {
      OR: [
        { dedupeKey: candidateDedupeKey },
        ...(candidateFrequencyKey ? [{ frequencyKey: candidateFrequencyKey }] : []),
      ],
    },
    select: { id: true },
  });
  if (existing) return false;

  const sourceFingerprint = createAutomaticMessageSourceFingerprint({
    organizationId: input.organizationId,
    branchId: input.branchId,
    senderId: input.senderId,
    recipientPhoneE164: input.candidate.recipientPhoneE164,
    recipientIds: input.candidate.recipientIds,
    settingsRevision: input.settingsRevision,
    templateBindingId: input.binding.id,
    templateId: input.binding.templateId,
    templateVersion: input.binding.template.version,
    catalogVersion: definition.catalogVersion,
    catalogHash: definition.catalogHash,
    stage: input.candidate.stage,
    templateVariables: input.candidate.values,
    facts: input.candidate.fingerprintFacts,
  });
  await input.tx.whatsAppMessage.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      senderId: input.senderId,
      studentId: input.candidate.studentIds.length === 1 ? input.candidate.studentIds[0] : null,
      paymentId: input.candidate.paymentIds.length === 1 ? input.candidate.paymentIds[0] : null,
      paymentResolutionEventId: input.candidate.paymentResolutionEventId,
      templateId: input.binding.templateId,
      templateBindingId: input.binding.id,
      recipientPhoneE164: input.candidate.recipientPhoneE164,
      purpose: input.candidate.purpose,
      trigger: "AUTOMATION",
      automationStage: input.candidate.stage,
      managedTemplateKey: input.candidate.managedTemplateKey,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      templateVersion: input.binding.template.version,
      templateVariables: input.candidate.values,
      renderedPreview: prepared.renderedPreview,
      scheduledFor: input.candidate.scheduledFor,
      availableAt: input.candidate.scheduledFor,
      localScheduleDate: utcLocalDate(input.candidate.localDate),
      status: "SCHEDULED",
      dedupeKey: candidateDedupeKey,
      frequencyKey: candidateFrequencyKey,
      settingsRevision: input.settingsRevision,
      sourceFingerprint,
      budgetMonth: whatsappBudgetMonth(input.candidate.scheduledFor, input.timeZone),
      budgetState: "RESERVED",
      rateCardVersion: input.rateCard.version,
      estimatedCostMicros: BigInt(input.rateCard.rateMicros),
      currency: "INR",
      ...(input.candidate.paymentIds.length > 0
        ? {
            paymentSources: {
              create: input.candidate.paymentIds.map(paymentId => ({ paymentId })),
            },
          }
        : {}),
    },
  });
  return true;
}

async function collectionCycleCount(input: {
  tx: PlannerClient;
  branchId: string;
  senderId: string;
  phoneE164: string;
  cycleDueDate: Date;
}) {
  return input.tx.whatsAppMessage.count({
    where: {
      branchId: input.branchId,
      senderId: input.senderId,
      recipientPhoneE164: input.phoneE164,
      trigger: "AUTOMATION",
      automationStage: { in: [...COLLECTION_STAGES] },
      status: { notIn: ["CANCELLED", "SUPPRESSED"] },
      scheduledFor: {
        gte: addHours(input.cycleDueDate, -7 * 24),
        lte: addHours(input.cycleDueDate, 8 * 24),
      },
    },
  });
}

async function planCandidates(input: {
  tx: PlannerClient;
  organizationId: string;
  branchId: string;
  senderId: string;
  settingsRevision: number;
  timeZone: string;
  language: WhatsAppManagedTemplateLanguage;
  bindings: Map<WhatsAppManagedTemplateKey, PlannerBinding>;
  rateCard: WhatsAppRateCard;
  budgetMicros: bigint;
  dailyLimit: number;
  cycleLimit: number;
  candidates: PlannerCandidate[];
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const budgetByMonth = new Map<string, bigint>();
  const dailyCount = new Map<string, number>();
  let plannedMessages = 0;
  let skippedCandidates = 0;
  const ordered = [...input.candidates].sort((left, right) =>
    left.scheduledFor.getTime() - right.scheduledFor.getTime()
    || right.priority - left.priority
    || hashWhatsAppPlannerValue(left.identity).localeCompare(hashWhatsAppPlannerValue(right.identity))
  );
  for (const candidate of ordered) {
    if (plannedMessages >= WHATSAPP_PLANNER_MAX_MESSAGES_PER_BRANCH) {
      skippedCandidates += 1;
      continue;
    }
    const binding = input.bindings.get(candidate.managedTemplateKey);
    if (!binding) {
      skippedCandidates += 1;
      continue;
    }
    try {
      resolveWhatsAppUtilityRate({
        recipientPhoneE164: candidate.recipientPhoneE164,
        at: candidate.scheduledFor,
        env: input.env,
      });
    } catch {
      skippedCandidates += 1;
      continue;
    }
    const localDate = localDatePartsKey(candidate.localDate);
    let usedToday = dailyCount.get(localDate);
    if (usedToday === undefined) {
      usedToday = await input.tx.whatsAppMessage.count({
        where: {
          branchId: input.branchId,
          trigger: "AUTOMATION",
          localScheduleDate: utcLocalDate(candidate.localDate),
          status: { notIn: ["CANCELLED", "SUPPRESSED"] },
        },
      });
    }
    if (usedToday >= input.dailyLimit) {
      dailyCount.set(localDate, usedToday);
      skippedCandidates += 1;
      continue;
    }
    if (candidate.kind === "COLLECTION" && candidate.cycleDueDate) {
      const cycleCount = await collectionCycleCount({
        tx: input.tx,
        branchId: input.branchId,
        senderId: input.senderId,
        phoneE164: candidate.recipientPhoneE164,
        cycleDueDate: candidate.cycleDueDate,
      });
      if (cycleCount >= input.cycleLimit) {
        skippedCandidates += 1;
        continue;
      }
    }
    const month = whatsappBudgetMonth(candidate.scheduledFor, input.timeZone);
    let budgetUsed = budgetByMonth.get(month);
    if (budgetUsed === undefined) {
      const aggregate = await input.tx.whatsAppMessage.aggregate({
        where: {
          branchId: input.branchId,
          budgetMonth: month,
          budgetState: { in: ["RESERVED", "COMMITTED"] },
        },
        _sum: { estimatedCostMicros: true },
      });
      budgetUsed = aggregate._sum.estimatedCostMicros ?? 0n;
    }
    if (budgetUsed + BigInt(input.rateCard.rateMicros) > input.budgetMicros) {
      budgetByMonth.set(month, budgetUsed);
      skippedCandidates += 1;
      continue;
    }
    try {
      const created = await createCandidateMessage({
        tx: input.tx,
        organizationId: input.organizationId,
        branchId: input.branchId,
        senderId: input.senderId,
        settingsRevision: input.settingsRevision,
        timeZone: input.timeZone,
        language: input.language,
        binding,
        candidate,
        rateCard: input.rateCard,
      });
      if (!created) {
        skippedCandidates += 1;
        continue;
      }
      plannedMessages += 1;
      dailyCount.set(localDate, usedToday + 1);
      budgetByMonth.set(month, budgetUsed + BigInt(input.rateCard.rateMicros));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        skippedCandidates += 1;
        continue;
      }
      throw error;
    }
  }
  return { plannedMessages, skippedCandidates };
}

function invalidAutomaticSource(code = "SOURCE_CHANGED") {
  return { valid: false as const, code };
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function sameCanonicalValue(left: unknown, right: unknown) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export type WhatsAppAutomaticCollectionMessageRefresh = WhatsAppCollectionMessageRefresh & Readonly<{
  automationStage: WhatsAppAutomationStage;
  purpose: WhatsAppMessagePurpose;
}>;

export type WhatsAppAutomaticCollectionMessageRefreshResult =
  | Readonly<{ valid: true; refresh: WhatsAppAutomaticCollectionMessageRefresh }>
  | Readonly<{ valid: false; code: string }>;

/**
 * Re-derives one safely unsubmitted automatic collection row at its original
 * schedule slot. Payment transitions use this under the message lock so a
 * shared-phone reminder can retain one truthful row/reservation when another
 * DUE source still independently justifies delivery.
 */
export async function deriveWhatsAppAutomaticCollectionMessageRefresh(input: {
  tx: PlannerClient;
  messageId: string;
  now: Date;
}): Promise<WhatsAppAutomaticCollectionMessageRefreshResult> {
  const invalid = (code = "SOURCE_CHANGED") => ({ valid: false as const, code });
  const message = await input.tx.whatsAppMessage.findUnique({
    where: { id: input.messageId },
    include: {
      branch: { include: { organization: { select: { id: true, timezone: true } } } },
      sender: true,
    },
  });
  if (
    !message
    || message.trigger !== "AUTOMATION"
    || !message.automationStage
    || !(COLLECTION_STAGES as readonly WhatsAppAutomationStage[]).includes(message.automationStage)
    || !message.branch
    || !message.branchId
    || message.branch.organizationId !== message.organizationId
    || message.branch.organization.id !== message.organizationId
    || message.sender.organizationId !== message.organizationId
    || message.sender.status !== "ACTIVE"
    || message.settingsRevision === null
    || !message.localScheduleDate
  ) return invalid();

  const timeZone = message.branch.organization.timezone;
  const scheduledLocalKey = whatsappLocalDateKey(message.scheduledFor, timeZone);
  if (
    whatsappLocalDateKey(input.now, timeZone) > scheduledLocalKey
    || message.scheduledFor > addHours(input.now, WHATSAPP_PLANNER_HORIZON_HOURS)
  ) return invalid("SOURCE_WINDOW_EXPIRED");

  const settings = await input.tx.branchWhatsAppSettings.findFirst({
    where: {
      branchId: message.branchId,
      organizationId: message.organizationId,
      senderId: message.senderId,
    },
  });
  if (
    !settings?.enabled
    || !settings.automationEnabledAt
    || settings.automationEnabledAt > input.now
    || settings.configurationRevision !== message.settingsRevision
    || !Number.isSafeInteger(settings.dailyAutomaticMessageLimit)
    || settings.dailyAutomaticMessageLimit < 1
    || settings.dailyAutomaticMessageLimit > 200
    || !Number.isSafeInteger(settings.maxAutomaticCollectionMessagesPerCycle)
    || settings.maxAutomaticCollectionMessagesPerCycle < 1
    || settings.maxAutomaticCollectionMessagesPerCycle > 4
    || !["polite", "friendly", "firm"].includes(settings.defaultTone)
  ) return invalid("SETTINGS_REVISION_CHANGED");
  const language = normalizeLanguage(settings.defaultLanguage);
  if (!language) return invalid();

  const ruleRows = await input.tx.whatsAppAutomationRule.findMany({
    where: {
      branchId: message.branchId,
      organizationId: message.organizationId,
      enabled: true,
      stage: { in: [...COLLECTION_STAGES] },
    },
    select: { stage: true },
  });
  const enabledStages = new Set(ruleRows.map(row => row.stage));
  if (enabledStages.size === 0) return invalid("AUTOMATION_DISABLED");

  const rawRecipients = await queryRecipients({
    tx: input.tx,
    branchId: message.branchId,
    senderId: message.senderId,
    phoneE164: message.recipientPhoneE164,
    now: input.now,
  });
  if (rawRecipients.length === WHATSAPP_PLANNER_MAX_RECIPIENTS_SCANNED) {
    const recipientCount = await input.tx.whatsAppStudentRecipient.count({
      where: recipientQueryWhere({
        branchId: message.branchId,
        senderId: message.senderId,
        phoneE164: message.recipientPhoneE164,
      }),
    });
    if (recipientCount !== rawRecipients.length) {
      return invalid("SOURCE_RECIPIENT_LIMIT_EXCEEDED");
    }
  }
  const recipients = rawRecipients.filter(recipient =>
    recipient.organizationId === message.organizationId
    && recipient.consent.senderId === message.senderId
    && recipient.consent.phoneE164 === message.recipientPhoneE164
    && validCurrentPhone(recipient.student.phone, recipient.phoneE164)
  );
  const studentIds = [...new Set(recipients.map(recipient => recipient.student.id))];
  if (studentIds.length === 0) return invalid("RECIPIENT_ASSOCIATION_STALE");

  const horizonEnd = addHours(input.now, WHATSAPP_PLANNER_HORIZON_HOURS);
  const dueWhere: Prisma.PaymentWhereInput = {
    branchId: message.branchId,
    studentId: { in: studentIds },
    status: "DUE",
    amount: { gt: 0 },
    dueDate: { lte: horizonEnd },
  };
  const payments = await input.tx.payment.findMany({
    where: dueWhere,
    orderBy: [{ studentId: "asc" }, { dueDate: "asc" }, { id: "asc" }],
    take: WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED,
    select: {
      id: true,
      studentId: true,
      amount: true,
      dueDate: true,
      periodStart: true,
    },
  });
  if (payments.length === WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED) {
    const paymentCount = await input.tx.payment.count({ where: dueWhere });
    if (paymentCount !== payments.length) {
      return invalid("SOURCE_PAYMENT_LIMIT_EXCEEDED");
    }
  }

  const candidate = buildCollectionCandidates({
    recipients,
    payments,
    enabledStages,
    slots: [{
      localDate: getWhatsAppLocalDateParts(message.scheduledFor, timeZone),
      scheduledFor: message.scheduledFor,
    }],
    now: input.now,
    horizonEnd,
    timeZone,
    language,
    branchName: message.branch.name,
    tone: settings.defaultTone,
  }).find(row => row.recipientPhoneE164 === message.recipientPhoneE164) ?? null;
  if (!candidate || candidate.kind !== "COLLECTION" || candidate.paymentIds.length === 0) {
    return invalid("PAYMENT_RESOLVED");
  }
  if (
    message.localScheduleDate.getTime() !== utcLocalDate(candidate.localDate).getTime()
  ) return invalid();

  const dailyCount = await input.tx.whatsAppMessage.count({
    where: {
      branchId: message.branchId,
      trigger: "AUTOMATION",
      localScheduleDate: message.localScheduleDate,
      status: { notIn: ["CANCELLED", "SUPPRESSED"] },
    },
  });
  if (dailyCount > settings.dailyAutomaticMessageLimit) {
    return invalid("DAILY_LIMIT_EXCEEDED");
  }
  if (candidate.cycleDueDate) {
    const cycleCount = await collectionCycleCount({
      tx: input.tx,
      branchId: message.branchId,
      senderId: message.senderId,
      phoneE164: message.recipientPhoneE164,
      cycleDueDate: candidate.cycleDueDate,
    });
    if (cycleCount > settings.maxAutomaticCollectionMessagesPerCycle) {
      return invalid("CYCLE_LIMIT_EXCEEDED");
    }
  }

  const bindings = await loadValidBindings(input.tx, message.senderId, language);
  const binding = bindings.get(candidate.managedTemplateKey);
  if (!binding) return invalid("TEMPLATE_NOT_APPROVED");
  const definition = getManagedWhatsAppTemplate(candidate.managedTemplateKey, language);
  let prepared: ReturnType<typeof prepareManagedWhatsAppTemplate>;
  try {
    prepared = prepareManagedWhatsAppTemplate(definition, candidate.values);
  } catch {
    return invalid();
  }
  return {
    valid: true,
    refresh: {
      paymentIds: candidate.paymentIds,
      studentIds: candidate.studentIds,
      automationStage: candidate.stage,
      purpose: candidate.purpose,
      managedTemplateKey: candidate.managedTemplateKey,
      templateId: binding.templateId,
      templateBindingId: binding.id,
      templateVersion: binding.template.version,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      templateVariables: candidate.values,
      renderedPreview: prepared.renderedPreview,
      sourceFingerprint: createAutomaticMessageSourceFingerprint({
        organizationId: message.organizationId,
        branchId: message.branchId,
        senderId: message.senderId,
        recipientPhoneE164: message.recipientPhoneE164,
        recipientIds: candidate.recipientIds,
        settingsRevision: settings.configurationRevision,
        templateBindingId: binding.id,
        templateId: binding.templateId,
        templateVersion: binding.template.version,
        catalogVersion: definition.catalogVersion,
        catalogHash: definition.catalogHash,
        stage: candidate.stage,
        templateVariables: candidate.values,
        facts: candidate.fingerprintFacts,
      }),
      settingsRevision: settings.configurationRevision,
    },
  };
}

/**
 * Read-only, transaction-aware send-time verification for planner-created rows.
 * The dispatcher calls this after locking the message and before starting any
 * provider submission. It intentionally performs no provider or domain write.
 */
export async function verifyAutomaticMessageSource(input: {
  tx: PlannerClient;
  messageId: string;
  now: Date;
}) {
  const message = await input.tx.whatsAppMessage.findUnique({
    where: { id: input.messageId },
    include: {
      branch: { include: { organization: { select: { id: true, timezone: true } } } },
      templateBinding: { include: { template: true } },
      paymentResolutionEvent: { include: { payment: { include: { student: true } } } },
      paymentSources: { include: { payment: true } },
    },
  });
  if (!message || message.trigger !== "AUTOMATION") return invalidAutomaticSource();
  if (
    !message.branch
    || !message.branchId
    || message.branch.organizationId !== message.organizationId
    || message.branch.organization.id !== message.organizationId
    || !message.automationStage
    || message.settingsRevision === null
    || !message.managedTemplateKey
    || message.catalogVersion === null
    || !message.catalogHash
    || message.templateVersion === null
    || !message.templateBinding
    || !message.templateBindingId
    || !message.templateId
    || !message.localScheduleDate
  ) return invalidAutomaticSource();

  const settings = await input.tx.branchWhatsAppSettings.findFirst({
    where: {
      branchId: message.branchId,
      organizationId: message.organizationId,
      senderId: message.senderId,
    },
  });
  if (
    !settings?.enabled
    || !settings.automationEnabledAt
    || settings.automationEnabledAt > input.now
    || settings.configurationRevision !== message.settingsRevision
    || !Number.isSafeInteger(settings.dailyAutomaticMessageLimit)
    || settings.dailyAutomaticMessageLimit < 1
    || settings.dailyAutomaticMessageLimit > 200
    || !Number.isSafeInteger(settings.maxAutomaticCollectionMessagesPerCycle)
    || settings.maxAutomaticCollectionMessagesPerCycle < 1
    || settings.maxAutomaticCollectionMessagesPerCycle > 4
    || settings.configurationRevision < 1
    || !["polite", "friendly", "firm"].includes(settings.defaultTone)
  ) return invalidAutomaticSource("SETTINGS_REVISION_CHANGED");
  const language = normalizeLanguage(settings.defaultLanguage);
  if (!language) return invalidAutomaticSource();
  if (
    message.templateBinding.senderId !== message.senderId
    || message.templateBinding.templateId !== message.templateId
    || message.templateBinding.managedKey !== message.managedTemplateKey
    || message.templateBinding.catalogVersion !== message.catalogVersion
    || message.templateBinding.catalogHash !== message.catalogHash
    || message.templateBinding.template.version !== message.templateVersion
  ) return invalidAutomaticSource("TEMPLATE_COMPONENT_MISMATCH");

  const ruleRows = await input.tx.whatsAppAutomationRule.findMany({
    where: {
      branchId: message.branchId,
      organizationId: message.organizationId,
      enabled: true,
    },
    select: { stage: true },
  });
  const enabledStages = new Set(ruleRows.map(row => row.stage));
  if (!enabledStages.has(message.automationStage)) {
    return invalidAutomaticSource("AUTOMATION_DISABLED");
  }

  const rawRecipients = await queryRecipients({
    tx: input.tx,
    branchId: message.branchId,
    senderId: message.senderId,
    phoneE164: message.recipientPhoneE164,
    now: input.now,
  });
  if (rawRecipients.length === WHATSAPP_PLANNER_MAX_RECIPIENTS_SCANNED) {
    const recipientCount = await input.tx.whatsAppStudentRecipient.count({
      where: recipientQueryWhere({
        branchId: message.branchId,
        senderId: message.senderId,
        phoneE164: message.recipientPhoneE164,
      }),
    });
    if (recipientCount !== rawRecipients.length) {
      return invalidAutomaticSource("SOURCE_RECIPIENT_LIMIT_EXCEEDED");
    }
  }
  const recipients = rawRecipients.filter(recipient =>
    recipient.organizationId === message.organizationId
    && recipient.consent.senderId === message.senderId
    && recipient.consent.phoneE164 === message.recipientPhoneE164
    && validCurrentPhone(recipient.student.phone, recipient.phoneE164)
  );
  const { byStudent } = candidateRecipientGroups(recipients);
  let candidate: PlannerCandidate | null = null;

  if ((COLLECTION_STAGES as readonly WhatsAppAutomationStage[]).includes(message.automationStage)) {
    if (
      whatsappLocalDateKey(input.now, message.branch.organization.timezone)
      !== whatsappLocalDateKey(message.scheduledFor, message.branch.organization.timezone)
    ) return invalidAutomaticSource("SOURCE_WINDOW_EXPIRED");
    const studentIds = [...byStudent.keys()];
    const dueWhere: Prisma.PaymentWhereInput = {
      branchId: message.branchId,
      studentId: { in: studentIds },
      status: "DUE",
      amount: { gt: 0 },
      dueDate: { lte: addHours(input.now, WHATSAPP_PLANNER_HORIZON_HOURS) },
    };
    const payments = studentIds.length === 0
      ? []
      : await input.tx.payment.findMany({
          where: dueWhere,
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          take: WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED,
          select: {
            id: true,
            studentId: true,
            amount: true,
            dueDate: true,
            periodStart: true,
          },
        });
    if (payments.length === WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED) {
      const paymentCount = await input.tx.payment.count({ where: dueWhere });
      if (paymentCount !== payments.length) {
        return invalidAutomaticSource("SOURCE_PAYMENT_LIMIT_EXCEEDED");
      }
    }
    candidate = buildCollectionCandidates({
      recipients,
      payments,
      enabledStages,
      slots: [{
        localDate: getWhatsAppLocalDateParts(
          message.scheduledFor,
          message.branch.organization.timezone
        ),
        scheduledFor: message.scheduledFor,
      }],
      now: input.now,
      horizonEnd: addHours(input.now, WHATSAPP_PLANNER_HORIZON_HOURS),
      timeZone: message.branch.organization.timezone,
      language,
      branchName: message.branch.name,
      tone: settings.defaultTone,
    }).find(row => row.recipientPhoneE164 === message.recipientPhoneE164) ?? null;
  } else if (message.automationStage === "WELCOME") {
    if (!message.studentId) return invalidAutomaticSource();
    const recipient = byStudent.get(message.studentId);
    if (!recipient) return invalidAutomaticSource("RECIPIENT_ASSOCIATION_STALE");
    const student = recipient.student;
    if (
      student.enrollmentSource !== "MANUAL"
      || student.createdAt < settings.automationEnabledAt
      || student.createdAt > addMinutes(input.now, -WHATSAPP_WELCOME_GRACE_MINUTES)
      || student.createdAt < addHours(input.now, -WHATSAPP_WELCOME_WINDOW_HOURS)
    ) return invalidAutomaticSource();
    const allocation = student.seatAllocations[0] ?? null;
    const managedTemplateKey = allocation ? "WELCOME_ALLOCATED" : "WELCOME_GENERAL";
    const startDate = allocation?.startDate ?? student.joinedAt;
    const values: Record<string, string> = allocation
      ? {
          studentName: student.name,
          branchName: message.branch.name,
          seatLabel: allocation.seat.label,
          shiftName: allocation.multiShift?.name ?? allocation.shift.name,
          startDate: formatDate(startDate, language, message.branch.organization.timezone),
        }
      : {
          studentName: student.name,
          branchName: message.branch.name,
          startDate: formatDate(startDate, language, message.branch.organization.timezone),
        };
    candidate = {
      kind: "WELCOME",
      stage: "WELCOME",
      purpose: "WELCOME",
      priority: 25,
      recipientPhoneE164: recipient.phoneE164,
      recipientIds: [recipient.id],
      studentIds: [student.id],
      paymentIds: [],
      paymentResolutionEventId: null,
      managedTemplateKey,
      values,
      scheduledFor: message.scheduledFor,
      localDate: getWhatsAppLocalDateParts(
        message.scheduledFor,
        message.branch.organization.timezone
      ),
      cycleDueDate: null,
      identity: { kind: "welcome-v1", studentId: student.id },
      fingerprintFacts: {
        studentId: student.id,
        enrollmentSource: student.enrollmentSource,
        status: student.status,
        joinedAt: student.joinedAt,
        allocation: allocation ? {
          id: allocation.id,
          seatId: allocation.seatId,
          shiftId: allocation.shiftId,
          multiShiftId: allocation.multiShiftId,
          startDate: allocation.startDate,
          endDate: allocation.endDate,
        } : null,
      },
    };
  } else if (
    message.automationStage === "PAYMENT_CONFIRMATION"
    || message.automationStage === "PAYMENT_CORRECTION"
  ) {
    const event = message.paymentResolutionEvent;
    if (!event || event.occurredAt < settings.automationEnabledAt) {
      return invalidAutomaticSource();
    }
    const recipient = byStudent.get(event.payment.studentId);
    if (!recipient) return invalidAutomaticSource("RECIPIENT_ASSOCIATION_STALE");
    if (message.automationStage === "PAYMENT_CONFIRMATION") {
      if (
        event.source !== "PAYMENT_ACTION"
        || event.toStatus !== "PAID"
        || event.payment.status !== "PAID"
      ) return invalidAutomaticSource("PAYMENT_RESOLVED");
      candidate = {
        kind: "PAYMENT_CONFIRMATION",
        stage: "PAYMENT_CONFIRMATION",
        purpose: "PAYMENT_CONFIRMATION",
        priority: 450,
        recipientPhoneE164: recipient.phoneE164,
        recipientIds: [recipient.id],
        studentIds: [event.payment.studentId],
        paymentIds: [event.paymentId],
        paymentResolutionEventId: event.id,
        managedTemplateKey: "PAYMENT_CONFIRMATION",
        values: {
          studentName: event.payment.student.name,
          amount: formatAmount(event.amount, language),
          branchName: message.branch.name,
          paymentDate: formatDate(
            event.paidAt ?? event.occurredAt,
            language,
            message.branch.organization.timezone
          ),
          paymentMethod: formatPaymentMethod(event.paymentMethod),
        },
        scheduledFor: message.scheduledFor,
        localDate: getWhatsAppLocalDateParts(
          message.scheduledFor,
          message.branch.organization.timezone
        ),
        cycleDueDate: null,
        identity: { kind: "payment-confirmation-v1", paymentResolutionEventId: event.id },
        fingerprintFacts: {
          eventId: event.id,
          paymentId: event.paymentId,
          source: event.source,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          amount: event.amount,
          paidAt: event.paidAt,
          paymentMethod: event.paymentMethod,
          occurredAt: event.occurredAt,
        },
      };
    } else {
      if (
        event.source !== "PAYMENT_ACTION"
        || event.fromStatus !== "PAID"
        || event.toStatus !== "WAIVED"
        || event.payment.status !== "WAIVED"
      ) return invalidAutomaticSource();
      const earlierPaid = await input.tx.paymentResolutionEvent.findFirst({
        where: earlierPaymentActionPaidEventWhere(event),
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const confirmation = earlierPaid
        ? await input.tx.whatsAppMessage.findFirst({
            where: {
              senderId: message.senderId,
              paymentResolutionEventId: earlierPaid.id,
              automationStage: "PAYMENT_CONFIRMATION",
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, status: true, submissionStartedAt: true },
          })
        : null;
      if (!confirmation || paymentCorrectionAction(confirmation) !== "CORRECT") {
        return invalidAutomaticSource();
      }
      candidate = {
        kind: "PAYMENT_CORRECTION",
        stage: "PAYMENT_CORRECTION",
        purpose: "PAYMENT_CORRECTION",
        priority: 500,
        recipientPhoneE164: recipient.phoneE164,
        recipientIds: [recipient.id],
        studentIds: [event.payment.studentId],
        paymentIds: [event.paymentId],
        paymentResolutionEventId: event.id,
        managedTemplateKey: "PAYMENT_CORRECTION",
        values: {
          amount: formatAmount(event.amount, language),
          studentName: event.payment.student.name,
          branchName: message.branch.name,
          paymentDate: formatDate(
            event.paidAt ?? event.occurredAt,
            language,
            message.branch.organization.timezone
          ),
          newStatus: "waived",
        },
        scheduledFor: message.scheduledFor,
        localDate: getWhatsAppLocalDateParts(
          message.scheduledFor,
          message.branch.organization.timezone
        ),
        cycleDueDate: null,
        identity: { kind: "payment-correction-v1", paymentResolutionEventId: event.id },
        fingerprintFacts: {
          eventId: event.id,
          paymentId: event.paymentId,
          source: event.source,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          amount: event.amount,
          paidAt: event.paidAt,
          occurredAt: event.occurredAt,
          confirmationMessageId: confirmation.id,
        },
      };
    }
  }

  if (
    !candidate
    || candidate.stage !== message.automationStage
    || candidate.purpose !== message.purpose
    || candidate.managedTemplateKey !== message.managedTemplateKey
    || (candidate.studentIds.length === 1
      ? message.studentId !== candidate.studentIds[0]
      : message.studentId !== null)
    || !sameStringSet(candidate.paymentIds, message.paymentSources.map(source => source.paymentId))
    || !sameCanonicalValue(candidate.values, message.templateVariables)
    || message.localScheduleDate.getTime() !== utcLocalDate(candidate.localDate).getTime()
  ) return invalidAutomaticSource();

  const expectedFingerprint = createAutomaticMessageSourceFingerprint({
    organizationId: message.organizationId,
    branchId: message.branchId,
    senderId: message.senderId,
    recipientPhoneE164: message.recipientPhoneE164,
    recipientIds: candidate.recipientIds,
    settingsRevision: settings.configurationRevision,
    templateBindingId: message.templateBinding.id,
    templateId: message.templateBinding.templateId,
    templateVersion: message.templateBinding.template.version,
    catalogVersion: message.catalogVersion,
    catalogHash: message.catalogHash,
    stage: message.automationStage,
    templateVariables: candidate.values,
    facts: candidate.fingerprintFacts,
  });
  if (expectedFingerprint !== message.sourceFingerprint) return invalidAutomaticSource();

  const dailyCount = await input.tx.whatsAppMessage.count({
    where: {
      branchId: message.branchId,
      trigger: "AUTOMATION",
      localScheduleDate: message.localScheduleDate,
      status: { notIn: ["CANCELLED", "SUPPRESSED"] },
    },
  });
  if (dailyCount > settings.dailyAutomaticMessageLimit) {
    return invalidAutomaticSource("DAILY_LIMIT_EXCEEDED");
  }
  if (candidate.kind === "COLLECTION" && candidate.cycleDueDate) {
    const cycleCount = await collectionCycleCount({
      tx: input.tx,
      branchId: message.branchId,
      senderId: message.senderId,
      phoneE164: message.recipientPhoneE164,
      cycleDueDate: candidate.cycleDueDate,
    });
    if (cycleCount > settings.maxAutomaticCollectionMessagesPerCycle) {
      return invalidAutomaticSource("CYCLE_LIMIT_EXCEEDED");
    }
  }
  return { valid: true as const };
}

export class WhatsAppPlannerService {
  static async claimNextBranch(input: {
    now: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }): Promise<PlannerClaim | null> {
    if (!isWhatsAppAutomationPlannerEnabled(input.env)) return null;
    const providerMode = resolveWhatsAppProviderMode(input.env);
    const leaseToken = randomUUID();
    const dueBefore = addMinutes(input.now, -WHATSAPP_PLANNER_BRANCH_INTERVAL_MINUTES);
    const leaseUntil = addMinutes(input.now, WHATSAPP_PLANNER_LEASE_MINUTES);
    return prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ branchId: string }>>(Prisma.sql`
        SELECT settings."branchId"
        FROM "BranchWhatsAppSettings" AS settings
        INNER JOIN "Branch" AS branch
          ON branch."id" = settings."branchId"
          AND branch."organizationId" = settings."organizationId"
        INNER JOIN "WhatsAppSender" AS sender
          ON sender."id" = settings."senderId"
          AND sender."organizationId" = settings."organizationId"
          AND sender."provider" = 'META_CLOUD'::"WhatsAppProvider"
          AND sender."providerMode" = ${providerMode}::"WhatsAppProviderMode"
          AND sender."status" = 'ACTIVE'::"WhatsAppSenderStatus"
        WHERE settings."enabled" = TRUE
          AND settings."automationEnabledAt" IS NOT NULL
          AND (settings."plannerLeaseUntil" IS NULL OR settings."plannerLeaseUntil" <= ${input.now})
          AND (settings."lastPlannedAt" IS NULL OR settings."lastPlannedAt" <= ${dueBefore})
        ORDER BY settings."lastPlannedAt" ASC NULLS FIRST, settings."branchId" ASC
        FOR UPDATE OF settings SKIP LOCKED
        LIMIT 1
      `);
      const branchId = rows[0]?.branchId;
      if (!branchId) return null;
      await tx.branchWhatsAppSettings.update({
        where: { branchId },
        data: { plannerLeaseToken: leaseToken, plannerLeaseUntil: leaseUntil },
      });
      return { branchId, leaseToken };
    });
  }

  static async failClaim(input: {
    claim: PlannerClaim;
    now: Date;
    code: string;
  }) {
    await prisma.branchWhatsAppSettings.updateMany({
      where: {
        branchId: input.claim.branchId,
        plannerLeaseToken: input.claim.leaseToken,
      },
      data: {
        plannerLeaseToken: null,
        plannerLeaseUntil: null,
        lastPlannedAt: input.now,
        lastPlannerErrorCode: input.code,
      },
    });
  }

  static async planClaimedBranch(input: {
    claim: PlannerClaim;
    now: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }): Promise<BranchPlanResult> {
    if (!isWhatsAppAutomationPlannerEnabled(input.env)) {
      return {
        plannedMessages: 0,
        skippedCandidates: 0,
        cancelledMessages: 0,
        errorCode: "PLANNER_DISABLED",
      };
    }
    const providerMode = resolveWhatsAppProviderMode(input.env);
    const horizonEnd = addHours(input.now, WHATSAPP_PLANNER_HORIZON_HOURS);
    const rateCard = readWhatsAppRateCard(input.env);

    return prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "branchId"
        FROM "BranchWhatsAppSettings"
        WHERE "branchId" = ${input.claim.branchId}
        FOR UPDATE
      `);
      const settings = await tx.branchWhatsAppSettings.findUnique({
        where: { branchId: input.claim.branchId },
        include: {
          branch: {
            include: { organization: { select: { id: true, timezone: true } } },
          },
          sender: true,
        },
      });
      if (!settings || settings.plannerLeaseToken !== input.claim.leaseToken) {
        return {
          plannedMessages: 0,
          skippedCandidates: 0,
          cancelledMessages: 0,
          errorCode: "PLANNER_LEASE_LOST",
        };
      }
      if (
        settings.organizationId !== settings.branch.organizationId
        || settings.organizationId !== settings.branch.organization.id
        || !settings.enabled
        || !settings.automationEnabledAt
        || settings.automationEnabledAt > input.now
      ) {
        return disqualifyBranch({
          tx,
          claim: input.claim,
          now: input.now,
          code: "AUTOMATION_NOT_ACTIVE",
          cancelPending: true,
        });
      }
      try {
        await EntitlementService.assertBranchEntitlement(
          input.claim.branchId,
          "WHATSAPP_AUTOMATION",
          tx
        );
        await EntitlementService.assertBranchWritable(input.claim.branchId, tx);
      } catch {
        return disqualifyBranch({
          tx,
          claim: input.claim,
          now: input.now,
          code: "BRANCH_NOT_ELIGIBLE",
          cancelPending: true,
        });
      }
      if (
        !settings.sender
        || settings.senderId !== settings.sender.id
        || settings.sender.organizationId !== settings.organizationId
        || settings.sender.provider !== "META_CLOUD"
        || settings.sender.providerMode !== providerMode
        || settings.sender.status !== "ACTIVE"
      ) {
        return disqualifyBranch({
          tx,
          claim: input.claim,
          now: input.now,
          code: "SENDER_UNAVAILABLE",
          cancelPending: true,
        });
      }
      const language = normalizeLanguage(settings.defaultLanguage);
      if (!language) {
        return disqualifyBranch({
          tx,
          claim: input.claim,
          now: input.now,
          code: "LANGUAGE_UNAVAILABLE",
          cancelPending: false,
        });
      }
      let budgetMicros: bigint;
      try {
        if (
          !Number.isSafeInteger(settings.configurationRevision)
          || settings.configurationRevision < 1
          || !Number.isSafeInteger(settings.dailyAutomaticMessageLimit)
          || settings.dailyAutomaticMessageLimit < 1
          || settings.dailyAutomaticMessageLimit > 200
          || !Number.isSafeInteger(settings.maxAutomaticCollectionMessagesPerCycle)
          || settings.maxAutomaticCollectionMessagesPerCycle < 1
          || settings.maxAutomaticCollectionMessagesPerCycle > 4
          || !["polite", "friendly", "firm"].includes(settings.defaultTone)
        ) throw new Error("PLANNER_CONFIGURATION_INVALID");
        budgetMicros = BigInt(paiseToInrMicros(
          validateWhatsAppMonthlyBudgetMinor(settings.monthlyBudgetMinor)
        ));
        plannerSlots({
          now: input.now,
          horizonEnd,
          timeZone: settings.branch.organization.timezone,
          sendTimeLocal: settings.sendTimeLocal,
        });
      } catch {
        return disqualifyBranch({
          tx,
          claim: input.claim,
          now: input.now,
          code: "PLANNER_CONFIGURATION_INVALID",
          cancelPending: false,
        });
      }

      const cancelledForRevision = await reconcileConfigurationRevision({
        tx,
        branchId: input.claim.branchId,
        settingsRevision: settings.configurationRevision,
        now: input.now,
      });
      const rules = await tx.whatsAppAutomationRule.findMany({
        where: {
          branchId: input.claim.branchId,
          organizationId: settings.organizationId,
          enabled: true,
        },
        select: { stage: true },
      });
      const enabledStages = new Set(rules.map(rule => rule.stage));
      if (enabledStages.size === 0) {
        await tx.branchWhatsAppSettings.updateMany({
          where: {
            branchId: input.claim.branchId,
            plannerLeaseToken: input.claim.leaseToken,
          },
          data: {
            plannerLeaseToken: null,
            plannerLeaseUntil: null,
            lastPlannedAt: input.now,
            lastPlannerErrorCode: null,
          },
        });
        return {
          plannedMessages: 0,
          skippedCandidates: 0,
          cancelledMessages: cancelledForRevision,
          errorCode: null,
        };
      }
      const bindings = await loadValidBindings(tx, settings.sender.id, language);
      const sourcePage = await loadPlannerCollectionSourcePage({
        tx,
        branchId: input.claim.branchId,
        senderId: settings.sender.id,
        now: input.now,
        horizonEnd,
        recipientCursorPhoneE164: settings.plannerRecipientCursorPhoneE164,
      });
      const recipients = sourcePage.recipients.filter(recipient =>
        recipient.organizationId === settings.organizationId
        && recipient.consent.senderId === settings.sender!.id
        && recipient.consent.phoneE164 === recipient.phoneE164
        && validCurrentPhone(recipient.student.phone, recipient.phoneE164)
      );
      const { byStudent } = candidateRecipientGroups(recipients);
      const studentIds = [...byStudent.keys()];
      const payments = sourcePage.payments;
      const slots = plannerSlots({
        now: input.now,
        horizonEnd,
        timeZone: settings.branch.organization.timezone,
        sendTimeLocal: settings.sendTimeLocal,
      });
      const existingWelcomeRows = enabledStages.has("WELCOME") && studentIds.length > 0
        ? await tx.whatsAppMessage.findMany({
            where: {
              senderId: settings.sender.id,
              studentId: { in: studentIds },
              automationStage: "WELCOME",
            },
            select: { studentId: true },
          })
        : [];
      const welcomeCandidates = buildWelcomeCandidates({
        recipients,
        enabledStages,
        existingStudentIds: new Set(existingWelcomeRows.flatMap(row => row.studentId ? [row.studentId] : [])),
        activationAt: settings.automationEnabledAt,
        now: input.now,
        horizonEnd,
        sendTimeLocal: settings.sendTimeLocal,
        timeZone: settings.branch.organization.timezone,
        language,
        branchName: settings.branch.name,
      });
      const collectionCandidates = buildCollectionCandidates({
        recipients,
        payments,
        enabledStages,
        slots,
        now: input.now,
        horizonEnd,
        timeZone: settings.branch.organization.timezone,
        language,
        branchName: settings.branch.name,
        tone: settings.defaultTone,
      });
      const eventResult = await paymentEventCandidates({
        tx,
        enabledStages,
        organizationId: settings.organizationId,
        branchId: input.claim.branchId,
        senderId: settings.sender.id,
        activationAt: settings.automationEnabledAt,
        now: input.now,
        horizonEnd,
        sendTimeLocal: settings.sendTimeLocal,
        timeZone: settings.branch.organization.timezone,
        language,
        branchName: settings.branch.name,
        correctionCursor: readPlannerEventCursor(
          settings.plannerCorrectionCursorAt,
          settings.plannerCorrectionCursorId
        ),
        paidCursor: readPlannerEventCursor(
          settings.plannerPaidCursorAt,
          settings.plannerPaidCursorId
        ),
      });
      const result = await planCandidates({
        tx,
        organizationId: settings.organizationId,
        branchId: input.claim.branchId,
        senderId: settings.sender.id,
        settingsRevision: settings.configurationRevision,
        timeZone: settings.branch.organization.timezone,
        language,
        bindings,
        rateCard,
        budgetMicros,
        dailyLimit: settings.dailyAutomaticMessageLimit,
        cycleLimit: settings.maxAutomaticCollectionMessagesPerCycle,
        candidates: [
          ...eventResult.candidates,
          ...collectionCandidates,
          ...welcomeCandidates,
        ],
        env: input.env,
      });
      await tx.branchWhatsAppSettings.updateMany({
        where: {
          branchId: input.claim.branchId,
          plannerLeaseToken: input.claim.leaseToken,
        },
        data: {
          plannerLeaseToken: null,
          plannerLeaseUntil: null,
          lastPlannedAt: input.now,
          plannerRecipientCursorPhoneE164: sourcePage.nextRecipientCursorPhoneE164,
          plannerCorrectionCursorAt: eventResult.nextCorrectionCursor?.occurredAt ?? null,
          plannerCorrectionCursorId: eventResult.nextCorrectionCursor?.id ?? null,
          plannerPaidCursorAt: eventResult.nextPaidCursor?.occurredAt ?? null,
          plannerPaidCursorId: eventResult.nextPaidCursor?.id ?? null,
          lastPlannerErrorCode: null,
        },
      });
      return {
        ...result,
        skippedCandidates: result.skippedCandidates + sourcePage.skippedSourceGroups,
        cancelledMessages: cancelledForRevision + eventResult.cancelledMessages,
        errorCode: null,
      };
    }, { isolationLevel: "Serializable" });
  }

  static async run(input: {
    now?: Date;
    limit?: number;
    env?: Readonly<Record<string, string | undefined>>;
  } = {}): Promise<PlannerRunResult> {
    if (!isWhatsAppAutomationPlannerEnabled(input.env)) {
      return {
        held: true,
        claimedBranches: 0,
        completedBranches: 0,
        failedBranches: 0,
        plannedMessages: 0,
        skippedCandidates: 0,
        cancelledMessages: 0,
        limitReached: false,
      };
    }
    const now = input.now ?? new Date();
    const limit = input.limit ?? WHATSAPP_PLANNER_MAX_BRANCHES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WHATSAPP_PLANNER_MAX_BRANCHES) {
      throw new Error("PLANNER_LIMIT_INVALID");
    }
    let claimedBranches = 0;
    let completedBranches = 0;
    let failedBranches = 0;
    let plannedMessages = 0;
    let skippedCandidates = 0;
    let cancelledMessages = 0;
    for (; claimedBranches < limit;) {
      const claim = await this.claimNextBranch({ now, env: input.env });
      if (!claim) break;
      claimedBranches += 1;
      try {
        const result = await this.planClaimedBranch({ claim, now, env: input.env });
        plannedMessages += result.plannedMessages;
        skippedCandidates += result.skippedCandidates;
        cancelledMessages += result.cancelledMessages;
        if (result.errorCode) failedBranches += 1;
        else completedBranches += 1;
      } catch (error) {
        failedBranches += 1;
        try {
          await this.failClaim({ claim, now, code: safePlannerErrorCode(error) });
        } catch {
          // A stale worker must not clear a lease it no longer owns.
        }
      }
    }
    return {
      held: false,
      claimedBranches,
      completedBranches,
      failedBranches,
      plannedMessages,
      skippedCandidates,
      cancelledMessages,
      limitReached: claimedBranches >= limit,
    };
  }
}
