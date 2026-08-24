import { createHash } from "node:crypto";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { pageFromRows, type DateIdCursor } from "@/lib/cursorPagination";
import {
  assertWhatsAppDeliverySchemaAccessEnabled,
  assertWhatsAppIntegrationEnabled,
  assertWhatsAppMessageWritesEnabled,
} from "@/lib/whatsappFeature";
import {
  estimateWhatsAppUtilityCostMicros,
  paiseToInrMicros,
  resolveWhatsAppUtilityRate,
  validateWhatsAppMonthlyBudgetMinor,
} from "@/lib/whatsappCost";
import {
  getManagedWhatsAppTemplate,
  managedProviderTemplateMatches,
  prepareManagedWhatsAppTemplate,
  type WhatsAppManagedTemplateKey,
  type WhatsAppManagedTemplateLanguage,
} from "@/lib/whatsappManagedTemplates";
import {
  WhatsAppConflictError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";
import {
  getWhatsAppLocalDateParts,
  manualWhatsAppAvailableAt,
  whatsappBudgetMonth,
  whatsappLocalDateKey,
} from "@/lib/whatsappSchedule";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";

export const MAX_WHATSAPP_MANUAL_PAYMENT_IDS = 100;
export const MAX_WHATSAPP_MANUAL_RECIPIENT_GROUPS = 50;
export const WHATSAPP_MANUAL_REQUEST_VERSION = 1 as const;

type DatabaseClient = Prisma.TransactionClient | typeof prisma;

type ManualSuppressionReason =
  | "STUDENT_INACTIVE"
  | "PAYMENT_NOT_DUE"
  | "PAYMENT_ALREADY_RESOLVED"
  | "NO_PHONE"
  | "INVALID_PHONE"
  | "NO_RECIPIENT_ASSOCIATION"
  | "CONSENT_UNKNOWN"
  | "CONSENT_OPTED_OUT"
  | "SENDER_UNAVAILABLE"
  | "BRANCH_DISABLED"
  | "TEMPLATE_UNAVAILABLE"
  | "BUDGET_UNAVAILABLE"
  | "RATE_UNAVAILABLE"
  | "DESTINATION_UNSUPPORTED";

type ManualSuppression = {
  paymentId: string;
  reason: ManualSuppressionReason;
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertBoundedPaymentIds(paymentIds: readonly string[]) {
  if (
    !Array.isArray(paymentIds)
    || paymentIds.length < 1
    || paymentIds.length > MAX_WHATSAPP_MANUAL_PAYMENT_IDS
    || new Set(paymentIds).size !== paymentIds.length
    || paymentIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  ) {
    throw new WhatsAppValidationError("Select between 1 and 100 unique payments");
  }
  return [...paymentIds].sort();
}

function assertIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new WhatsAppValidationError("Idempotency-Key is invalid");
  }
  return value;
}

export function createWhatsAppManualRequestHash(branchId: string, paymentIds: readonly string[]) {
  return sha256(JSON.stringify({
    version: WHATSAPP_MANUAL_REQUEST_VERSION,
    branchId,
    purpose: "MANUAL_REMINDER",
    paymentIds: [...paymentIds].sort(),
  }));
}

function isGenericAuthorizationFailure(error: unknown) {
  return error instanceof Error
    && (error.message === "Branch not found" || error.message.startsWith("Unauthorized:"));
}

async function authorizeManualSend(
  actorUserId: string,
  branchId: string,
  client: DatabaseClient = prisma
) {
  try {
    await StaffService.authorize(actorUserId, branchId, "view_payments", client);
    await StaffService.authorize(actorUserId, branchId, "view_whatsapp", client);
    await StaffService.authorize(actorUserId, branchId, "send_whatsapp", client);
  } catch (error) {
    if (isGenericAuthorizationFailure(error)) throw new WhatsAppResourceNotFoundError();
    throw error;
  }
  await EntitlementService.assertBranchEntitlement(
    branchId,
    "WHATSAPP_AUTOMATION",
    client
  );
  await EntitlementService.assertBranchWritable(branchId, client);
  const branch = await client.branch.findUnique({
    where: { id: branchId },
    select: { id: true, organizationId: true, name: true, organization: { select: { timezone: true } } },
  });
  if (!branch) throw new WhatsAppResourceNotFoundError();
  return branch;
}

function normalizeLanguage(value: string): WhatsAppManagedTemplateLanguage {
  if (value === "en") return "en_IN";
  if (value === "en_IN" || value === "hi") return value;
  throw new WhatsAppValidationError("Unsupported WhatsApp language");
}

function formatAmount(value: number, language: WhatsAppManagedTemplateLanguage) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WhatsAppValidationError();
  return new Intl.NumberFormat(language === "hi" ? "hi-IN" : "en-IN", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(
  value: Date,
  language: WhatsAppManagedTemplateLanguage,
  timeZone: string
) {
  return new Intl.DateTimeFormat(language === "hi" ? "hi-IN" : "en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(value).replace(/\s+/g, " ").trim();
}

export function maskWhatsAppPhone(phoneE164: string) {
  return phoneE164.length <= 6
    ? "••••"
    : `${phoneE164.slice(0, 3)}••••••${phoneE164.slice(-4)}`;
}

function collectionTemplateKey(input: {
  studentCount: number;
  anyPastDue: boolean;
  tone: string;
}): WhatsAppManagedTemplateKey {
  if (input.studentCount > 1) return "MULTI_STUDENT_COLLECTION_SUMMARY";
  if (input.anyPastDue) return input.tone === "firm" ? "PAST_DUE_FIRM" : "PAST_DUE_POLITE";
  return input.tone === "friendly" ? "FEE_RENEWAL_FRIENDLY" : "FEE_RENEWAL_POLITE";
}

type ManualCollectionPaymentFact = Readonly<{
  id: string;
  amount: number;
  dueDate: Date;
  student: Readonly<{ id: string; name: string }>;
}>;

export type WhatsAppCollectionMessageRefresh = Readonly<{
  paymentIds: string[];
  studentIds: string[];
  managedTemplateKey: WhatsAppManagedTemplateKey;
  templateId: string;
  templateBindingId: string;
  templateVersion: number;
  catalogVersion: number;
  catalogHash: string;
  templateVariables: Record<string, string>;
  renderedPreview: string;
  sourceFingerprint: string;
  settingsRevision: number;
}>;

export type WhatsAppCollectionMessageRefreshResult =
  | Readonly<{ valid: true; refresh: WhatsAppCollectionMessageRefresh }>
  | Readonly<{ valid: false; code: string }>;

export function deriveWhatsAppManualCollectionContent(input: {
  payments: readonly ManualCollectionPaymentFact[];
  language: WhatsAppManagedTemplateLanguage;
  tone: string;
  branchName: string;
  timeZone: string;
  at: Date;
}) {
  if (input.payments.length < 1) throw new WhatsAppValidationError();
  const paymentIds = input.payments.map(payment => payment.id).sort();
  const studentIds = [...new Set(input.payments.map(payment => payment.student.id))].sort();
  const totalAmount = input.payments.reduce((total, payment) => total + payment.amount, 0);
  if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0) {
    throw new WhatsAppValidationError();
  }
  const earliestDueDate = [...input.payments]
    .sort((left, right) => left.dueDate.getTime() - right.dueDate.getTime())[0]!.dueDate;
  const todayKey = whatsappLocalDateKey(input.at, input.timeZone);
  const anyPastDue = input.payments.some(payment =>
    whatsappLocalDateKey(payment.dueDate, input.timeZone) < todayKey
  );
  const managedTemplateKey = collectionTemplateKey({
    studentCount: studentIds.length,
    anyPastDue,
    tone: input.tone,
  });
  const values: Record<string, string> = studentIds.length > 1
    ? {
        studentCount: String(studentIds.length),
        amount: formatAmount(totalAmount, input.language),
        branchName: input.branchName,
        earliestDueDate: formatDate(earliestDueDate, input.language, input.timeZone),
      }
    : anyPastDue
      ? {
          studentName: input.payments[0]!.student.name,
          amount: formatAmount(totalAmount, input.language),
          branchName: input.branchName,
          oldestDueDate: formatDate(earliestDueDate, input.language, input.timeZone),
        }
      : {
          studentName: input.payments[0]!.student.name,
          amount: formatAmount(totalAmount, input.language),
          branchName: input.branchName,
          dueDate: formatDate(earliestDueDate, input.language, input.timeZone),
        };
  return {
    paymentIds,
    studentIds,
    totalAmount,
    earliestDueDate,
    anyPastDue,
    managedTemplateKey,
    values,
  };
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeFingerprintValue(nested)])
    );
  }
  return value;
}

export function createWhatsAppManualSourceFingerprint(input: {
  branchId: string;
  branchName: string;
  senderId: string;
  recipientIds: readonly string[];
  paymentFacts: readonly {
    id: string;
    status: string;
    amount: number;
    dueDate: Date;
    studentId: string;
    studentName: string;
  }[];
  templateBindingId: string;
  catalogHash: string;
  settingsRevision: number;
  managedTemplateKey: WhatsAppManagedTemplateKey;
  templateVariables: Readonly<Record<string, string>>;
}) {
  return sha256(JSON.stringify(canonicalizeFingerprintValue({
    version: 2,
    branchId: input.branchId,
    branchName: input.branchName,
    senderId: input.senderId,
    recipientIds: [...input.recipientIds].sort(),
    paymentFacts: [...input.paymentFacts].sort((left, right) => left.id.localeCompare(right.id)),
    templateBindingId: input.templateBindingId,
    catalogHash: input.catalogHash,
    settingsRevision: input.settingsRevision,
    managedTemplateKey: input.managedTemplateKey,
    templateVariables: input.templateVariables,
  })));
}

function invalidManualCollectionRefresh(code = "SOURCE_CHANGED") {
  return { valid: false as const, code };
}

/**
 * Re-derives a queued manual collection message from its still-DUE source
 * rows. This is deliberately transaction-aware and provider-free so payment
 * resolution can refresh a shared-phone group under the message lock without
 * deleting its durable outbox/history row.
 */
export async function deriveWhatsAppManualCollectionMessageRefresh(input: {
  tx: Prisma.TransactionClient;
  messageId: string;
  now: Date;
}): Promise<WhatsAppCollectionMessageRefreshResult> {
  const message = await input.tx.whatsAppMessage.findUnique({
    where: { id: input.messageId },
    include: {
      branch: { include: { organization: { select: { id: true, timezone: true } } } },
      paymentSources: { include: { payment: { include: { student: true } } } },
    },
  });
  if (
    !message
    || message.trigger !== "MANUAL"
    || message.purpose !== "MANUAL_REMINDER"
    || !message.branch
    || !message.branchId
    || message.branch.organizationId !== message.organizationId
    || message.branch.organization.id !== message.organizationId
    || message.settingsRevision === null
  ) return invalidManualCollectionRefresh();
  if (message.paymentSources.length > MAX_WHATSAPP_MANUAL_PAYMENT_IDS) {
    return invalidManualCollectionRefresh("SOURCE_PAYMENT_LIMIT_EXCEEDED");
  }

  const settings = await input.tx.branchWhatsAppSettings.findFirst({
    where: {
      branchId: message.branchId,
      organizationId: message.organizationId,
      senderId: message.senderId,
    },
    include: { sender: true },
  });
  if (
    !settings?.enabled
    || settings.configurationRevision !== message.settingsRevision
    || !settings.sender
    || settings.sender.organizationId !== message.organizationId
    || settings.sender.status !== "ACTIVE"
    || !["polite", "friendly", "firm"].includes(settings.defaultTone)
  ) return invalidManualCollectionRefresh("SETTINGS_REVISION_CHANGED");

  let language: WhatsAppManagedTemplateLanguage;
  try {
    language = normalizeLanguage(settings.defaultLanguage);
  } catch {
    return invalidManualCollectionRefresh();
  }

  const eligibleSources = message.paymentSources.filter(source => {
    const payment = source.payment;
    if (
      payment.branchId !== message.branchId
      || payment.status !== "DUE"
      || payment.amount <= 0
      || payment.student.branchId !== message.branchId
      || payment.student.status !== "ACTIVE"
      || !payment.student.phone
    ) return false;
    try {
      return normalizeWhatsAppPhone(payment.student.phone, { defaultCountry: "IN" })
        === message.recipientPhoneE164;
    } catch {
      return false;
    }
  });
  if (eligibleSources.length === 0) {
    return invalidManualCollectionRefresh("PAYMENT_RESOLVED");
  }

  const eligibleStudentIds = [...new Set(
    eligibleSources.map(source => source.payment.studentId)
  )].sort();
  const recipients = await input.tx.whatsAppStudentRecipient.findMany({
    where: {
      organizationId: message.organizationId,
      branchId: message.branchId,
      senderId: message.senderId,
      phoneE164: message.recipientPhoneE164,
      studentId: { in: eligibleStudentIds },
      status: "ACTIVE",
      consent: {
        senderId: message.senderId,
        phoneE164: message.recipientPhoneE164,
        consentType: "OPERATIONAL",
        status: "OPTED_IN",
      },
    },
    select: { id: true, studentId: true },
  });
  const recipientByStudent = new Map(recipients.map(recipient => [recipient.studentId, recipient]));
  const validSources = eligibleSources.filter(source =>
    recipientByStudent.has(source.payment.studentId)
  );
  if (validSources.length === 0) {
    return invalidManualCollectionRefresh("RECIPIENT_ASSOCIATION_STALE");
  }

  const validStudentIds = [...new Set(
    validSources.map(source => source.payment.studentId)
  )].sort();
  const effectiveAt = message.availableAt > input.now ? message.availableAt : input.now;
  let content: ReturnType<typeof deriveWhatsAppManualCollectionContent>;
  try {
    content = deriveWhatsAppManualCollectionContent({
      payments: validSources.map(source => source.payment),
      language,
      tone: settings.defaultTone,
      branchName: message.branch.name,
      timeZone: message.branch.organization.timezone,
      at: effectiveAt,
    });
  } catch {
    return invalidManualCollectionRefresh();
  }
  const definition = getManagedWhatsAppTemplate(content.managedTemplateKey, language);
  const bindings = await input.tx.whatsAppTemplateBinding.findMany({
    where: {
      senderId: message.senderId,
      managedKey: content.managedTemplateKey,
      language,
      active: true,
    },
    include: { template: true, provisioning: true },
  });
  const binding = bindings.find(row =>
    row.catalogVersion === definition.catalogVersion
    && row.catalogHash === definition.catalogHash
    && row.provisioning.status === "READY"
    && row.template.providerStatus === "APPROVED"
    && row.template.category === "UTILITY"
    && row.template.staleAt === null
    && Array.isArray(row.template.components)
    && managedProviderTemplateMatches({
      name: row.template.name,
      language: row.template.language,
      category: row.template.category,
      components: row.template.components,
    }, definition)
  );
  if (!binding) return invalidManualCollectionRefresh("TEMPLATE_NOT_APPROVED");

  let prepared: ReturnType<typeof prepareManagedWhatsAppTemplate>;
  try {
    prepared = prepareManagedWhatsAppTemplate(definition, content.values);
  } catch {
    return invalidManualCollectionRefresh();
  }
  const recipientIds = validStudentIds.map(studentId => recipientByStudent.get(studentId)!.id);
  return {
    valid: true,
    refresh: {
      paymentIds: content.paymentIds,
      studentIds: content.studentIds,
      managedTemplateKey: content.managedTemplateKey,
      templateId: binding.templateId,
      templateBindingId: binding.id,
      templateVersion: binding.template.version,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      templateVariables: content.values,
      renderedPreview: prepared.renderedPreview,
      sourceFingerprint: createWhatsAppManualSourceFingerprint({
        branchId: message.branchId,
        branchName: message.branch.name,
        senderId: message.senderId,
        recipientIds,
        paymentFacts: validSources.map(source => ({
          id: source.payment.id,
          status: source.payment.status,
          amount: source.payment.amount,
          dueDate: source.payment.dueDate,
          studentId: source.payment.studentId,
          studentName: source.payment.student.name,
        })),
        templateBindingId: binding.id,
        catalogHash: definition.catalogHash,
        settingsRevision: settings.configurationRevision,
        managedTemplateKey: content.managedTemplateKey,
        templateVariables: content.values,
      }),
      settingsRevision: settings.configurationRevision,
    },
  };
}

async function buildManualPaymentPreview(input: {
  branchId: string;
  paymentIds: readonly string[];
  client: DatabaseClient;
  now: Date;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const settings = await input.client.branchWhatsAppSettings.findUnique({
    where: { branchId: input.branchId },
    include: {
      branch: {
        select: {
          id: true,
          organizationId: true,
          name: true,
          organization: { select: { timezone: true } },
        },
      },
      sender: { select: { id: true, organizationId: true, status: true } },
    },
  });
  if (!settings || settings.organizationId !== settings.branch.organizationId) {
    throw new WhatsAppResourceNotFoundError();
  }

  const payments = await input.client.payment.findMany({
    where: { branchId: input.branchId, id: { in: [...input.paymentIds] } },
    include: {
      student: {
        select: {
          id: true,
          name: true,
          phone: true,
          status: true,
          whatsAppRecipients: {
            where: { senderId: settings.senderId ?? "" },
            include: { consent: true },
          },
        },
      },
    },
  });
  if (payments.length !== input.paymentIds.length) throw new WhatsAppResourceNotFoundError();

  const suppressed: ManualSuppression[] = [];
  if (!settings.enabled) {
    return {
      settings,
      groups: [],
      suppressed: input.paymentIds.map(paymentId => ({ paymentId, reason: "BRANCH_DISABLED" as const })),
      rateCard: null,
      estimatedCostMicros: 0,
      budgetMonth: whatsappBudgetMonth(input.now, settings.branch.organization.timezone),
    };
  }
  if (
    !settings.sender
    || settings.sender.status !== "ACTIVE"
    || settings.sender.organizationId !== settings.organizationId
  ) {
    return {
      settings,
      groups: [],
      suppressed: input.paymentIds.map(paymentId => ({ paymentId, reason: "SENDER_UNAVAILABLE" as const })),
      rateCard: null,
      estimatedCostMicros: 0,
      budgetMonth: whatsappBudgetMonth(input.now, settings.branch.organization.timezone),
    };
  }

  type PaymentRow = (typeof payments)[number];
  type EligiblePayment = { payment: PaymentRow; phoneE164: string; recipientId: string };
  const grouped = new Map<string, { phoneE164: string; payments: EligiblePayment[] }>();
  for (const payment of payments.sort((left, right) => left.id.localeCompare(right.id))) {
    if (payment.status !== "DUE") {
      suppressed.push({ paymentId: payment.id, reason: "PAYMENT_ALREADY_RESOLVED" });
      continue;
    }
    if (payment.amount <= 0) {
      suppressed.push({ paymentId: payment.id, reason: "PAYMENT_NOT_DUE" });
      continue;
    }
    if (payment.student.status !== "ACTIVE") {
      suppressed.push({ paymentId: payment.id, reason: "STUDENT_INACTIVE" });
      continue;
    }
    if (!payment.student.phone) {
      suppressed.push({ paymentId: payment.id, reason: "NO_PHONE" });
      continue;
    }
    let phoneE164: string;
    try {
      phoneE164 = normalizeWhatsAppPhone(payment.student.phone, { defaultCountry: "IN" });
    } catch {
      suppressed.push({ paymentId: payment.id, reason: "INVALID_PHONE" });
      continue;
    }
    const recipient = payment.student.whatsAppRecipients.find(item =>
      item.organizationId === settings.organizationId
      && item.branchId === input.branchId
      && item.senderId === settings.sender!.id
      && item.phoneE164 === phoneE164
      && item.status === "ACTIVE"
    );
    if (!recipient) {
      suppressed.push({ paymentId: payment.id, reason: "NO_RECIPIENT_ASSOCIATION" });
      continue;
    }
    if (recipient.consent.consentType !== "OPERATIONAL" || recipient.consent.status === "UNKNOWN") {
      suppressed.push({ paymentId: payment.id, reason: "CONSENT_UNKNOWN" });
      continue;
    }
    if (
      recipient.consent.status === "OPTED_OUT"
      || recipient.consent.senderId !== settings.sender.id
      || recipient.consent.phoneE164 !== phoneE164
    ) {
      suppressed.push({ paymentId: payment.id, reason: "CONSENT_OPTED_OUT" });
      continue;
    }
    const group = grouped.get(phoneE164) ?? { phoneE164, payments: [] };
    group.payments.push({ payment, phoneE164, recipientId: recipient.id });
    grouped.set(phoneE164, group);
  }

  if (grouped.size > MAX_WHATSAPP_MANUAL_RECIPIENT_GROUPS) {
    throw new WhatsAppValidationError("A manual batch may contain at most 50 recipient groups");
  }
  const language = normalizeLanguage(settings.defaultLanguage);
  const bindings = await input.client.whatsAppTemplateBinding.findMany({
    where: { senderId: settings.sender.id, language, active: true },
    include: { template: true, provisioning: true },
  });
  const bindingsByKey = new Map(bindings.map(binding => [binding.managedKey, binding]));
  const timeZone = settings.branch.organization.timezone;
  const availableAt = manualWhatsAppAvailableAt({
    now: input.now,
    sendTimeLocal: settings.sendTimeLocal,
    timeZone,
  });

  const groups: Array<{
    phoneE164: string;
    paymentIds: string[];
    studentIds: string[];
    studentName: string | null;
    managedTemplateKey: WhatsAppManagedTemplateKey;
    templateId: string;
    templateBindingId: string;
    templateVersion: number;
    catalogVersion: number;
    catalogHash: string;
    values: Record<string, string>;
    renderedPreview: string;
    sourceFingerprint: string;
    availableAt: Date;
  }> = [];

  for (const group of grouped.values()) {
    const content = deriveWhatsAppManualCollectionContent({
      payments: group.payments.map(item => item.payment),
      language,
      tone: settings.defaultTone,
      branchName: settings.branch.name,
      timeZone,
      // Content and its fingerprint must describe the facts at the actual
      // scheduled execution time. A request queued after the daily cutoff can
      // otherwise cross a local-date boundary and be suppressed immediately
      // by the dispatcher's send-time re-derivation.
      at: availableAt,
    });
    const { studentIds, paymentIds, managedTemplateKey, values } = content;
    const definition = getManagedWhatsAppTemplate(managedTemplateKey, language);
    const binding = bindingsByKey.get(managedTemplateKey);
    if (
      !binding
      || binding.catalogVersion !== definition.catalogVersion
      || binding.catalogHash !== definition.catalogHash
      || binding.provisioning.status !== "READY"
      || binding.template.providerStatus !== "APPROVED"
      || binding.template.category !== "UTILITY"
      || binding.template.staleAt !== null
      || !Array.isArray(binding.template.components)
      || !managedProviderTemplateMatches({
        name: binding.template.name,
        language: binding.template.language,
        category: binding.template.category,
        components: binding.template.components,
      }, definition)
    ) {
      suppressed.push(...paymentIds.map(paymentId => ({
        paymentId,
        reason: "TEMPLATE_UNAVAILABLE" as const,
      })));
      continue;
    }
    const prepared = prepareManagedWhatsAppTemplate(definition, values);
    groups.push({
      phoneE164: group.phoneE164,
      paymentIds,
      studentIds,
      studentName: studentIds.length === 1 ? group.payments[0]!.payment.student.name : null,
      managedTemplateKey,
      templateId: binding.templateId,
      templateBindingId: binding.id,
      templateVersion: binding.template.version,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      values,
      renderedPreview: prepared.renderedPreview,
      sourceFingerprint: createWhatsAppManualSourceFingerprint({
        branchId: input.branchId,
        branchName: settings.branch.name,
        senderId: settings.sender.id,
        recipientIds: [...new Set(group.payments.map(item => item.recipientId))],
        paymentFacts: group.payments.map(item => ({
          id: item.payment.id,
          status: item.payment.status,
          amount: item.payment.amount,
          dueDate: item.payment.dueDate,
          studentId: item.payment.student.id,
          studentName: item.payment.student.name,
        })),
        templateBindingId: binding.id,
        catalogHash: definition.catalogHash,
        settingsRevision: settings.configurationRevision,
        managedTemplateKey,
        templateVariables: values,
      }),
      availableAt,
    });
  }

  let rateCard: ReturnType<typeof resolveWhatsAppUtilityRate> | null = null;
  if (groups.length > 0) {
    try {
      rateCard = resolveWhatsAppUtilityRate({
        recipientPhoneE164: groups[0]!.phoneE164,
        at: availableAt,
        env: input.env,
      });
      for (const group of groups.slice(1)) {
        resolveWhatsAppUtilityRate({
          recipientPhoneE164: group.phoneE164,
          at: availableAt,
          env: input.env,
        });
      }
    } catch (error) {
      const reason: ManualSuppressionReason = error instanceof Error
        && "code" in error
        && error.code === "DESTINATION_UNSUPPORTED"
        ? "DESTINATION_UNSUPPORTED"
        : "RATE_UNAVAILABLE";
      suppressed.push(...groups.flatMap(group =>
        group.paymentIds.map(paymentId => ({ paymentId, reason }))
      ));
      groups.length = 0;
    }
  }

  const budgetMonth = whatsappBudgetMonth(availableAt, timeZone);
  const estimatedCostMicros = rateCard
    ? estimateWhatsAppUtilityCostMicros({ messageCount: groups.length, rateMicros: rateCard.rateMicros })
    : 0;
  if (groups.length > 0) {
    let budgetMicros: number;
    try {
      budgetMicros = paiseToInrMicros(validateWhatsAppMonthlyBudgetMinor(settings.monthlyBudgetMinor));
    } catch {
      suppressed.push(...groups.flatMap(group => group.paymentIds.map(paymentId => ({
        paymentId,
        reason: "BUDGET_UNAVAILABLE" as const,
      }))));
      groups.length = 0;
      rateCard = null;
      return { settings, groups, suppressed, rateCard, estimatedCostMicros: 0, budgetMonth };
    }
    const used = await input.client.whatsAppMessage.aggregate({
      where: {
        branchId: input.branchId,
        budgetMonth,
        budgetState: { in: ["RESERVED", "COMMITTED"] },
      },
      _sum: { estimatedCostMicros: true },
    });
    if ((used._sum.estimatedCostMicros ?? 0n) + BigInt(estimatedCostMicros) > BigInt(budgetMicros)) {
      suppressed.push(...groups.flatMap(group => group.paymentIds.map(paymentId => ({
        paymentId,
        reason: "BUDGET_UNAVAILABLE" as const,
      }))));
      groups.length = 0;
      rateCard = null;
      return { settings, groups, suppressed, rateCard, estimatedCostMicros: 0, budgetMonth };
    }
  }
  return { settings, groups, suppressed, rateCard, estimatedCostMicros, budgetMonth };
}

function publicPreview(result: Awaited<ReturnType<typeof buildManualPaymentPreview>>) {
  return {
    selectedPaymentCount: result.groups.reduce((count, group) => count + group.paymentIds.length, 0)
      + result.suppressed.length,
    eligibleRecipientCount: result.groups.length,
    suppressedCount: result.suppressed.length,
    estimatedCostMicros: String(result.estimatedCostMicros),
    rateCardVersion: result.rateCard?.version ?? null,
    currency: "INR" as const,
    groups: result.groups.map(group => ({
      maskedPhone: maskWhatsAppPhone(group.phoneE164),
      paymentCount: group.paymentIds.length,
      studentCount: group.studentIds.length,
      studentName: group.studentName,
      managedTemplateKey: group.managedTemplateKey,
      renderedPreview: group.renderedPreview,
      scheduledFor: group.availableAt,
    })),
    suppressed: result.suppressed,
    estimateDisclaimer:
      "Estimated Meta usage for messages sent through Lab Lords. Final charges are determined by Meta in the customer’s Meta account.",
  };
}

function serializeManualRequest(request: {
  id: string;
  status: string;
  selectedPaymentCount: number;
  eligibleRecipientCount: number;
  queuedMessageCount: number;
  suppressedCount: number;
  estimatedCostMicros: bigint;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    ...request,
    estimatedCostMicros: request.estimatedCostMicros.toString(),
  };
}

export class WhatsAppMessageService {
  static async previewPaymentReminders(input: {
    actorUserId: string;
    branchId: string;
    paymentIds: string[];
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    const paymentIds = assertBoundedPaymentIds(input.paymentIds);
    assertWhatsAppIntegrationEnabled(input.env);
    const branch = await authorizeManualSend(input.actorUserId, input.branchId);
    assertWhatsAppMessageWritesEnabled(branch.organizationId, input.env);
    return publicPreview(await buildManualPaymentPreview({
      branchId: input.branchId,
      paymentIds,
      client: prisma,
      now: input.now ?? new Date(),
      env: input.env,
    }));
  }

  static async queuePaymentReminders(input: {
    actorUserId: string;
    branchId: string;
    paymentIds: string[];
    idempotencyKey: string;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    const paymentIds = assertBoundedPaymentIds(input.paymentIds);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestHash = createWhatsAppManualRequestHash(input.branchId, paymentIds);
    const now = input.now ?? new Date();
    assertWhatsAppIntegrationEnabled(input.env);
    const branch = await authorizeManualSend(input.actorUserId, input.branchId);
    assertWhatsAppMessageWritesEnabled(branch.organizationId, input.env);

    return prisma.$transaction(async tx => {
      await authorizeManualSend(input.actorUserId, input.branchId, tx);
      await tx.$queryRaw(Prisma.sql`
        SELECT "branchId"
        FROM "BranchWhatsAppSettings"
        WHERE "branchId" = ${input.branchId}
        FOR UPDATE
      `);
      const existing = await tx.whatsAppManualSendRequest.findUnique({
        where: { branchId_idempotencyKey: { branchId: input.branchId, idempotencyKey } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new WhatsAppConflictError("Idempotency-Key was already used for another request");
        }
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: existing.organizationId,
            branchId: existing.branchId,
            actorUserId: input.actorUserId,
            action: "MANUAL_SEND_REPLAYED",
            details: { manualSendRequestId: existing.id },
          },
        });
        return { replayed: true as const, request: serializeManualRequest(existing) };
      }

      const preview = await buildManualPaymentPreview({
        branchId: input.branchId,
        paymentIds,
        client: tx,
        now,
        env: input.env,
      });
      const status = preview.groups.length === 0
        ? "COMPLETED" as const
        : preview.suppressed.length > 0
          ? "PARTIAL" as const
          : "QUEUED" as const;
      const request = await tx.whatsAppManualSendRequest.create({
        data: {
          organizationId: preview.settings.organizationId,
          branchId: input.branchId,
          actorUserId: input.actorUserId,
          idempotencyKey,
          requestHash,
          status,
          selectedPaymentCount: paymentIds.length,
          eligibleRecipientCount: preview.groups.length,
          queuedMessageCount: preview.groups.length,
          suppressedCount: preview.suppressed.length,
          estimatedCostMicros: BigInt(preview.estimatedCostMicros),
          completedAt: preview.groups.length === 0 ? now : null,
        },
      });

      for (const group of preview.groups) {
        const scheduleDate = getWhatsAppLocalDateParts(
          group.availableAt,
          preview.settings.branch.organization.timezone
        );
        const dedupeKey = sha256(JSON.stringify({
          kind: "manual-payment-reminder-v1",
          branchId: input.branchId,
          requestId: request.id,
          paymentIds: group.paymentIds,
          recipientHash: sha256(group.phoneE164),
        }));
        await tx.whatsAppMessage.create({
          data: {
            organizationId: preview.settings.organizationId,
            branchId: input.branchId,
            senderId: preview.settings.senderId!,
            studentId: group.studentIds.length === 1 ? group.studentIds[0] : null,
            paymentId: group.paymentIds.length === 1 ? group.paymentIds[0] : null,
            templateId: group.templateId,
            templateBindingId: group.templateBindingId,
            manualSendRequestId: request.id,
            createdByUserId: input.actorUserId,
            recipientPhoneE164: group.phoneE164,
            purpose: "MANUAL_REMINDER",
            trigger: "MANUAL",
            managedTemplateKey: group.managedTemplateKey,
            catalogVersion: group.catalogVersion,
            catalogHash: group.catalogHash,
            templateVersion: group.templateVersion,
            templateVariables: group.values,
            renderedPreview: group.renderedPreview,
            scheduledFor: group.availableAt,
            availableAt: group.availableAt,
            localScheduleDate: new Date(Date.UTC(
              scheduleDate.year,
              scheduleDate.month - 1,
              scheduleDate.day
            )),
            status: "SCHEDULED",
            dedupeKey,
            settingsRevision: preview.settings.configurationRevision,
            sourceFingerprint: group.sourceFingerprint,
            budgetMonth: preview.budgetMonth,
            budgetState: "RESERVED",
            rateCardVersion: preview.rateCard!.version,
            estimatedCostMicros: BigInt(preview.rateCard!.rateMicros),
            currency: "INR",
            paymentSources: {
              create: group.paymentIds.map(paymentId => ({ paymentId })),
            },
          },
        });
      }
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: preview.settings.organizationId,
          branchId: input.branchId,
          senderId: preview.settings.senderId,
          actorUserId: input.actorUserId,
          action: "MANUAL_SEND_QUEUED",
          details: {
            manualSendRequestId: request.id,
            selectedPaymentCount: paymentIds.length,
            queuedMessageCount: preview.groups.length,
            suppressedCount: preview.suppressed.length,
            rateCardVersion: preview.rateCard?.version ?? null,
          },
        },
      });
      return {
        replayed: false as const,
        request: serializeManualRequest(request),
        preview: publicPreview(preview),
      };
    }, { isolationLevel: "Serializable" });
  }

  static async history(input: {
    actorUserId: string;
    branchId: string;
    cursor: DateIdCursor | null;
    limit: number;
  }) {
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppDeliverySchemaAccessEnabled();
    try {
      await StaffService.authorize(input.actorUserId, input.branchId, "view_whatsapp");
    } catch (error) {
      if (isGenericAuthorizationFailure(error)) throw new WhatsAppResourceNotFoundError();
      throw error;
    }
    await EntitlementService.assertBranchEntitlement(
      input.branchId,
      "WHATSAPP_AUTOMATION"
    );
    const access = await StaffService.getBranchAccess(input.actorUserId, input.branchId);
    const canViewPayments = access.permissions.view_payments;
    const where: Prisma.WhatsAppMessageWhereInput = {
      branchId: input.branchId,
      ...(input.cursor
        ? {
            OR: [
              { createdAt: { lt: input.cursor.sort } },
              { createdAt: input.cursor.sort, id: { lt: input.cursor.id } },
            ],
          }
        : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.whatsAppMessage.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        include: {
          student: { select: { id: true, name: true } },
          template: { select: { name: true, language: true } },
          createdBy: { select: { id: true, name: true } },
          paymentResolutionEvent: canViewPayments
            ? {
                select: {
                  id: true,
                  source: true,
                  fromStatus: true,
                  toStatus: true,
                  occurredAt: true,
                },
              }
            : false,
          paymentSources: canViewPayments
            ? { select: { payment: { select: { id: true, status: true, amount: true, dueDate: true } } } }
            : false,
        },
      }),
      prisma.whatsAppMessage.count({ where: { branchId: input.branchId } }),
    ]);
    return pageFromRows(
      rows.map(row => ({
        id: row.id,
        student: row.student,
        maskedPhone: maskWhatsAppPhone(row.recipientPhoneE164),
        purpose: row.purpose,
        trigger: row.trigger,
        automationStage: row.automationStage,
        managedTemplateKey: row.managedTemplateKey,
        template: row.template,
        status: row.status,
        scheduledFor: row.scheduledFor,
        submissionStartedAt: row.submissionStartedAt,
        acceptedAt: row.acceptedAt,
        sentAt: row.sentAt,
        deliveredAt: row.deliveredAt,
        readAt: row.readAt,
        failedAt: row.failedAt,
        safeFailureCode: row.failureCode,
        estimatedCostMicros: row.estimatedCostMicros?.toString() ?? null,
        providerBillable: row.providerBillable,
        providerPricingCategory: row.providerPricingCategory,
        createdBy: row.createdBy,
        paymentResolutionEvent: canViewPayments && row.paymentResolutionEvent
          ? row.paymentResolutionEvent
          : undefined,
        payments: canViewPayments && row.paymentSources
          ? row.paymentSources.flatMap(source =>
              "payment" in source ? [source.payment] : []
            )
          : undefined,
        createdAt: row.createdAt,
      })),
      input.limit,
      total,
      row => ({ sort: row.createdAt, id: row.id })
    );
  }
}
