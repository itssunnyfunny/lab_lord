import { createHash } from "node:crypto";

import {
  Prisma,
  type WhatsAppManagedTemplateKey,
  type WhatsAppReportScope,
} from "@/app/generated/prisma/client";
import {
  getWhatsAppDailyReportMetrics,
} from "@/analytics/whatsapp-report.analytics";
import { prisma } from "@/lib/prisma";
import {
  estimateWhatsAppUtilityCostMicros,
  paiseToInrMicros,
  resolveWhatsAppUtilityRate,
  validateWhatsAppMonthlyBudgetMinor,
} from "@/lib/whatsappCost";
import {
  assertWhatsAppMessageWritesEnabled,
  assertWhatsAppReportsEnabled,
  isWhatsAppLiveAutomationOrganizationEnabled,
  isWhatsAppOperationsUiEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  getManagedWhatsAppTemplate,
  managedProviderTemplateMatches,
  prepareManagedWhatsAppTemplate,
  WHATSAPP_MANAGED_TEMPLATE_LANGUAGES,
  type WhatsAppManagedTemplateLanguage,
} from "@/lib/whatsappManagedTemplates";
import {
  WhatsAppConflictError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { normalizeWhatsAppPhone } from "@/lib/whatsappPhone";
import {
  generateWhatsAppReportConfirmationCode,
  hashWhatsAppReportConfirmationCode,
  matchesWhatsAppReportConfirmationHash,
  normalizeWhatsAppReportConfirmationCode,
  WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION,
  WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS,
  WHATSAPP_REPORT_CONFIRMATION_TTL_MS,
} from "@/lib/whatsappReportConfirmation";
import {
  canonicalizeWhatsAppReportMetrics,
  createWhatsAppReportSourceFingerprint,
  hashWhatsAppReportMetrics,
  WHATSAPP_REPORT_METRICS_VERSION,
  type WhatsAppReportMetrics,
} from "@/lib/whatsappReportMetrics";
import {
  getWhatsAppLocalDateParts,
  getWhatsAppLocalDateTimeParts,
  getWhatsAppReportCatchUpEndsAt,
  getWhatsAppReportPlanningWindow,
  parseWhatsAppReportSendTime,
  scheduleWhatsAppReportForLocalDate,
  whatsappBudgetMonth,
} from "@/lib/whatsappSchedule";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";

type DatabaseClient = Prisma.TransactionClient | typeof prisma;

export type WhatsAppReportScopeInput =
  | Readonly<{ scope: "BRANCH"; branchId: string }>
  | Readonly<{ scope: "ORGANIZATION"; organizationId: string }>;

export type WhatsAppReportSubscriptionMutationInput = WhatsAppReportScopeInput & Readonly<{
  actorUserId: string;
  phone: string;
  language: string;
  sendTimeLocal: string;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type WhatsAppReportPreviewInput = WhatsAppReportScopeInput & Readonly<{
  actorUserId: string;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type WhatsAppReportQueueInput = WhatsAppReportPreviewInput & Readonly<{
  idempotencyKey: string;
}>;

export type WhatsAppReportConfirmationInput = Readonly<{
  tx: Prisma.TransactionClient;
  senderId: string;
  phoneE164: string;
  code: string;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type WhatsAppOrganizationReportSettingsUpdate = Readonly<{
  senderId?: string | null;
  enabled?: boolean;
  monthlyBudgetMinor?: number | null;
}>;

const MAX_CONFIRMATION_CANDIDATES = 25;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class WhatsAppReportMetricsUnavailableError extends WhatsAppConflictError {
  constructor() {
    super("A trustworthy daily report is unavailable for this schedule");
    this.name = "WhatsAppReportMetricsUnavailableError";
  }
}

function isReportMetricsIntegrityError(error: unknown) {
  return error instanceof WhatsAppReportMetricsUnavailableError
    || (error instanceof Error && (
      error.name === "ZodError"
      || /^REPORT_[A-Z0-9_]+$/.test(error.message)
    ));
}

function assertTrustworthyReportMetricsAsOf(input: {
  scheduledCutoffAt: Date;
  metricsAsOfAt: Date;
  timeZone: string;
}) {
  const catchUpEndsAt = getWhatsAppReportCatchUpEndsAt({
    scheduledCutoffAt: input.scheduledCutoffAt,
    timeZone: input.timeZone,
  });
  if (
    Number.isNaN(input.metricsAsOfAt.getTime())
    || input.metricsAsOfAt.getTime() < input.scheduledCutoffAt.getTime()
    || input.metricsAsOfAt.getTime() >= catchUpEndsAt.getTime()
  ) {
    throw new WhatsAppReportMetricsUnavailableError();
  }
  return catchUpEndsAt;
}

async function resolveReportMetricsAsOfAt(
  tx: Prisma.TransactionClient,
  override?: Date
) {
  if (override) {
    if (Number.isNaN(override.getTime())) {
      throw new WhatsAppReportMetricsUnavailableError();
    }
    return override;
  }
  const rows = await tx.$queryRaw<Array<{ metricsAsOfAt: Date }>>(Prisma.sql`
    SELECT statement_timestamp() AS "metricsAsOfAt"
  `);
  const metricsAsOfAt = rows[0]?.metricsAsOfAt;
  if (rows.length !== 1 || !metricsAsOfAt || Number.isNaN(metricsAsOfAt.getTime())) {
    throw new WhatsAppReportMetricsUnavailableError();
  }
  return metricsAsOfAt;
}

function assertId(value: string) {
  if (!ID_PATTERN.test(value)) throw new WhatsAppValidationError();
  return value;
}

function normalizeReportLanguage(value: string): WhatsAppManagedTemplateLanguage {
  if (!(WHATSAPP_MANAGED_TEMPLATE_LANGUAGES as readonly string[]).includes(value)) {
    throw new WhatsAppValidationError("Report language is unavailable");
  }
  return value as WhatsAppManagedTemplateLanguage;
}

function normalizeReportTime(value: string) {
  try {
    parseWhatsAppReportSendTime(value);
    return value;
  } catch {
    throw new WhatsAppValidationError(
      "Report time must be between 18:00 and 23:30 local time"
    );
  }
}

function maskPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length < 4 ? "••••" : `••••••${digits.slice(-4)}`;
}

function scopeIdentity(input: WhatsAppReportScopeInput) {
  return input.scope === "BRANCH"
    ? { scope: "BRANCH" as const, scopeKey: assertId(input.branchId), branchId: input.branchId }
    : {
        scope: "ORGANIZATION" as const,
        scopeKey: assertId(input.organizationId),
        branchId: null,
      };
}

function isGenericAuthorizationFailure(error: unknown) {
  return error instanceof Error
    && (error.message === "Branch not found" || error.message.startsWith("Unauthorized:"));
}

async function authorizeBranchReport(
  actorUserId: string,
  branchId: string,
  client: DatabaseClient,
  writable: boolean
) {
  try {
    await StaffService.authorize(actorUserId, branchId, "view_whatsapp", client);
    await StaffService.authorize(actorUserId, branchId, "receive_whatsapp_reports", client);
    await StaffService.authorize(actorUserId, branchId, "view_payments", client);
    await StaffService.authorize(actorUserId, branchId, "analytics", client);
  } catch (error) {
    if (isGenericAuthorizationFailure(error)) throw new WhatsAppResourceNotFoundError();
    throw error;
  }
  await EntitlementService.assertBranchEntitlement(branchId, "WHATSAPP_AUTOMATION", client);
  if (writable) await EntitlementService.assertBranchWritable(branchId, client);
  const branch = await client.branch.findUnique({
    where: { id: branchId },
    select: {
      id: true,
      name: true,
      organizationId: true,
      organization: { select: { timezone: true, ownerId: true } },
    },
  });
  if (!branch) throw new WhatsAppResourceNotFoundError();
  return branch;
}

async function authorizeReportScope(input: {
  actorUserId: string;
  scope: WhatsAppReportScopeInput;
  client: DatabaseClient;
  writable: boolean;
}) {
  const identity = scopeIdentity(input.scope);
  if (input.scope.scope === "BRANCH") {
    const branch = await authorizeBranchReport(
      input.actorUserId,
      input.scope.branchId,
      input.client,
      input.writable
    );
    return {
      ...identity,
      organizationId: branch.organizationId,
      timeZone: branch.organization.timezone,
      ownerId: branch.organization.ownerId,
    };
  }
  if (input.writable) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.scope.organizationId,
      input.client
    );
  } else {
    await WhatsAppAuthorizationService.assertOwnerEntitled(
      input.actorUserId,
      input.scope.organizationId,
      input.client
    );
  }
  const organization = await input.client.organization.findUnique({
    where: { id: input.scope.organizationId },
    select: { id: true, timezone: true, ownerId: true },
  });
  if (!organization) throw new WhatsAppResourceNotFoundError();
  return {
    ...identity,
    organizationId: organization.id,
    timeZone: organization.timezone,
    ownerId: organization.ownerId,
  };
}

type AuthorizedReportScope = Awaited<ReturnType<typeof authorizeReportScope>>;

async function resolveReportDeliveryState(input: {
  client: DatabaseClient;
  scope: AuthorizedReportScope;
  requireEnabled: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const providerMode = resolveWhatsAppProviderMode(input.env);
  if (input.scope.scope === "BRANCH") {
    const settings = await input.client.branchWhatsAppSettings.findFirst({
      where: {
        branchId: input.scope.branchId!,
        organizationId: input.scope.organizationId,
      },
      include: { sender: { include: { safetyState: true } } },
    });
    if (
      !settings
      || !settings.sender
      || settings.senderId !== settings.sender.id
      || settings.sender.organizationId !== input.scope.organizationId
      || settings.sender.provider !== "META_CLOUD"
      || settings.sender.providerMode !== providerMode
      || settings.sender.status !== "ACTIVE"
      || (input.requireEnabled && !settings.enabled)
    ) {
      throw new WhatsAppResourceNotFoundError();
    }
    return {
      sender: settings.sender,
      enabled: settings.enabled,
      monthlyBudgetMinor: settings.monthlyBudgetMinor,
      configurationRevision: settings.configurationRevision,
      dailyAutomaticMessageLimit: settings.dailyAutomaticMessageLimit,
    };
  }
  const settings = await input.client.organizationWhatsAppReportSettings.findUnique({
    where: { organizationId: input.scope.organizationId },
    include: { sender: { include: { safetyState: true } } },
  });
  if (
    !settings
    || !settings.sender
    || settings.senderId !== settings.sender.id
    || settings.sender.organizationId !== input.scope.organizationId
    || settings.sender.provider !== "META_CLOUD"
    || settings.sender.providerMode !== providerMode
    || settings.sender.status !== "ACTIVE"
    || (input.requireEnabled && !settings.enabled)
  ) {
    throw new WhatsAppResourceNotFoundError();
  }
  return {
    sender: settings.sender,
    enabled: settings.enabled,
    monthlyBudgetMinor: settings.monthlyBudgetMinor,
    configurationRevision: settings.configurationRevision,
    dailyAutomaticMessageLimit: null,
  };
}

function serializeSubscription(subscription: {
  id: string;
  organizationId: string;
  branchId: string | null;
  scope: WhatsAppReportScope;
  senderId: string;
  phoneE164: string;
  language: string;
  sendTimeLocal: string;
  status: string;
  confirmationExpiresAt: Date | null;
  confirmationAttemptCount: number;
  activatedAt: Date | null;
  pausedAt: Date | null;
  revokedAt: Date | null;
  staleAt: Date | null;
  lastPlannedAt: Date | null;
  lastPlannedLocalDate: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: subscription.id,
    organizationId: subscription.organizationId,
    branchId: subscription.branchId,
    scope: subscription.scope,
    senderId: subscription.senderId,
    maskedPhone: maskPhone(subscription.phoneE164),
    language: subscription.language,
    sendTimeLocal: subscription.sendTimeLocal,
    status: subscription.status,
    confirmationExpiresAt: subscription.confirmationExpiresAt?.toISOString() ?? null,
    confirmationAttemptCount: subscription.confirmationAttemptCount,
    activatedAt: subscription.activatedAt?.toISOString() ?? null,
    pausedAt: subscription.pausedAt?.toISOString() ?? null,
    revokedAt: subscription.revokedAt?.toISOString() ?? null,
    staleAt: subscription.staleAt?.toISOString() ?? null,
    lastPlannedAt: subscription.lastPlannedAt?.toISOString() ?? null,
    lastPlannedLocalDate: subscription.lastPlannedLocalDate,
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}

async function cancelUnsubmittedReportMessages(input: {
  tx: Prisma.TransactionClient;
  organizationId: string;
  branchId?: string | null;
  senderId?: string;
  reportSubscriptionId?: string;
  now: Date;
  code: string;
}) {
  const scope = {
    organizationId: input.organizationId,
    ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
    ...(input.senderId ? { senderId: input.senderId } : {}),
    ...(input.reportSubscriptionId
      ? { reportSubscriptionId: input.reportSubscriptionId }
      : {}),
    purpose: { in: ["DAILY_BRANCH_REPORT" as const, "DAILY_ORGANIZATION_REPORT" as const] },
    OR: [
      { status: "SCHEDULED" as const },
      { status: "CLAIMED" as const, submissionStartedAt: null },
    ],
  } satisfies Prisma.WhatsAppMessageWhereInput;
  const reserved = await input.tx.whatsAppMessage.updateMany({
    where: { ...scope, budgetState: "RESERVED" },
    data: {
      status: "CANCELLED",
      cancelledAt: input.now,
      failureCode: input.code,
      budgetState: "RELEASED",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  const unreserved = await input.tx.whatsAppMessage.updateMany({
    where: { ...scope, budgetState: { not: "RESERVED" } },
    data: {
      status: "CANCELLED",
      cancelledAt: input.now,
      failureCode: input.code,
      leaseToken: null,
      leaseUntil: null,
    },
  });
  return reserved.count + unreserved.count;
}

function reportManagedKey(scope: WhatsAppReportScope): WhatsAppManagedTemplateKey {
  return scope === "BRANCH" ? "DAILY_BRANCH_REPORT" : "DAILY_ORGANIZATION_REPORT";
}

async function resolveReportBinding(input: {
  client: DatabaseClient;
  senderId: string;
  scope: WhatsAppReportScope;
  language: WhatsAppManagedTemplateLanguage;
}) {
  const managedKey = reportManagedKey(input.scope);
  const definition = getManagedWhatsAppTemplate(managedKey, input.language);
  const binding = await input.client.whatsAppTemplateBinding.findUnique({
    where: {
      senderId_managedKey_language: {
        senderId: input.senderId,
        managedKey,
        language: input.language,
      },
    },
    include: { template: true, provisioning: true },
  });
  if (
    !binding
    || !binding.active
    || binding.senderId !== input.senderId
    || binding.managedKey !== managedKey
    || binding.language !== input.language
    || binding.catalogVersion !== definition.catalogVersion
    || binding.catalogHash !== definition.catalogHash
    || binding.templateId !== binding.template.id
    || binding.template.senderId !== input.senderId
    || binding.provisioningId !== binding.provisioning.id
    || binding.provisioning.senderId !== input.senderId
    || binding.provisioning.managedKey !== managedKey
    || binding.provisioning.language !== input.language
    || binding.provisioning.catalogVersion !== definition.catalogVersion
    || binding.provisioning.catalogHash !== definition.catalogHash
    || binding.provisioning.status !== "READY"
    || binding.provisioning.providerTemplateId !== binding.template.providerTemplateId
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
    throw new WhatsAppConflictError("Daily report template is unavailable");
  }
  return { binding, definition, managedKey };
}

function reportTemplateValues(metrics: WhatsAppReportMetrics) {
  const formatNumber = (value: number) => new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(value);
  const common = {
    reportDate: metrics.localReportDate,
    asOfTime: metrics.asOfLocalTime,
    paidCount: formatNumber(metrics.paymentsRecordedTodayCount),
    paidAmount: formatNumber(metrics.paymentsRecordedTodayAmount),
    newStudents: formatNumber(metrics.newStudentsToday),
    activeStudents: formatNumber(metrics.activeStudents),
    usedSlots: formatNumber(metrics.usedShiftSlots),
    totalSlots: formatNumber(metrics.totalShiftCapacity),
    dueCount: formatNumber(metrics.openDueCount),
    dueAmount: formatNumber(metrics.openDueAmount),
    overdueCount: formatNumber(metrics.overdueCount),
    overdueAmount: formatNumber(metrics.overdueAmount),
    deliveredCount: formatNumber(metrics.whatsAppDeliveredToday),
    attentionCount: formatNumber(
      metrics.whatsAppFailedToday + metrics.whatsAppUnknownToday
    ),
  };
  return "branchName" in metrics
    ? { branchName: metrics.branchName, ...common }
    : { organizationName: metrics.organizationName, branchCount: formatNumber(metrics.branchCount), ...common };
}

function reportDedupeKey(input: {
  senderId: string;
  subscriptionId: string;
  localReportDate: string;
  scheduledCutoffAt: Date;
}) {
  return sha256(JSON.stringify({
    kind: "whatsapp-daily-report-v2",
    senderId: input.senderId,
    subscriptionId: input.subscriptionId,
    localReportDate: input.localReportDate,
    scheduledCutoffAt: input.scheduledCutoffAt.toISOString(),
    metricsVersion: WHATSAPP_REPORT_METRICS_VERSION,
  }));
}

function reportMessageSourceFingerprint(input: {
  organizationId: string;
  branchId: string | null;
  scope: WhatsAppReportScope;
  snapshotSourceFingerprint: string;
  metricsHash: string;
  subscriptionId: string;
  senderId: string;
  recipientPhoneE164: string;
  settingsRevision: number;
  templateBindingId: string;
  templateId: string;
  templateVersion: number;
  managedTemplateKey: WhatsAppManagedTemplateKey;
  language: WhatsAppManagedTemplateLanguage;
  templateVariables: Readonly<Record<string, string>>;
  catalogVersion: number;
  catalogHash: string;
}) {
  return sha256(JSON.stringify({
    kind: "whatsapp-report-message-v1",
    ...input,
    templateVariables: Object.fromEntries(
      Object.entries(input.templateVariables).sort(([left], [right]) => left.localeCompare(right))
    ),
  }));
}

function assertIdempotencyKey(value: string) {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new WhatsAppValidationError("Idempotency-Key is invalid");
  }
  return value;
}

async function lockReportBudgetScope(
  tx: Prisma.TransactionClient,
  scope: AuthorizedReportScope
) {
  if (scope.scope === "BRANCH") {
    await tx.$queryRaw(Prisma.sql`
      SELECT "branchId"
      FROM "BranchWhatsAppSettings"
      WHERE "branchId" = ${scope.branchId}
        AND "organizationId" = ${scope.organizationId}
      FOR UPDATE
    `);
    return;
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "organizationId"
    FROM "OrganizationWhatsAppReportSettings"
    WHERE "organizationId" = ${scope.organizationId}
    FOR UPDATE
  `);
}

async function issueConfirmationInTransaction(input: {
  tx: Prisma.TransactionClient;
  subscriptionId: string;
  senderId: string;
  phoneE164: string;
  now: Date;
}) {
  const confirmationCode = generateWhatsAppReportConfirmationCode();
  const confirmationCodeHash = hashWhatsAppReportConfirmationCode({
    senderId: input.senderId,
    subscriptionId: input.subscriptionId,
    phoneE164: input.phoneE164,
    code: confirmationCode,
  });
  const confirmationExpiresAt = new Date(
    input.now.getTime() + WHATSAPP_REPORT_CONFIRMATION_TTL_MS
  );
  const subscription = await input.tx.whatsAppReportSubscription.update({
    where: { id: input.subscriptionId },
    data: {
      status: "PENDING_CONFIRMATION",
      confirmationCodeHash,
      confirmationExpiresAt,
      confirmationIssuedAt: input.now,
      confirmationAttemptCount: 0,
      activatedAt: null,
      pausedAt: null,
      revokedAt: null,
      staleAt: null,
      plannerLeaseToken: null,
      plannerLeaseUntil: null,
      lastPlannerErrorCode: null,
    },
  });
  return { subscription, confirmationCode };
}

function utcReportLocalDate(value: { year: number; month: number; day: number }) {
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}

function reportPurpose(scope: WhatsAppReportScope) {
  return scope === "BRANCH"
    ? "DAILY_BRANCH_REPORT" as const
    : "DAILY_ORGANIZATION_REPORT" as const;
}

function assertSenderAvailable(delivery: Awaited<ReturnType<typeof resolveReportDeliveryState>>) {
  if (
    delivery.sender.safetyState?.pausedAt
    || delivery.sender.safetyState?.pauseRequestedAt
  ) {
    throw new WhatsAppConflictError("WhatsApp sender delivery is paused");
  }
}

async function loadCurrentReportSubscription(input: {
  client: DatabaseClient;
  scope: AuthorizedReportScope;
  senderId: string;
  userId: string;
  requireActive: boolean;
}) {
  const subscription = await input.client.whatsAppReportSubscription.findUnique({
    where: {
      senderId_userId_scope_scopeKey: {
        senderId: input.senderId,
        userId: input.userId,
        scope: input.scope.scope,
        scopeKey: input.scope.scopeKey,
      },
    },
    include: { consent: true },
  });
  if (
    !subscription
    || subscription.organizationId !== input.scope.organizationId
    || subscription.branchId !== input.scope.branchId
    || subscription.scope !== input.scope.scope
    || subscription.scopeKey !== input.scope.scopeKey
    || subscription.senderId !== input.senderId
    || subscription.userId !== input.userId
  ) {
    throw new WhatsAppResourceNotFoundError();
  }
  normalizeReportLanguage(subscription.language);
  normalizeReportTime(subscription.sendTimeLocal);
  if (input.requireActive && (
    subscription.status !== "ACTIVE"
    || !subscription.activatedAt
    || !subscription.consent
    || subscription.consentId !== subscription.consent.id
    || subscription.consent.senderId !== subscription.senderId
    || subscription.consent.phoneE164 !== subscription.phoneE164
    || subscription.consent.consentType !== "OWNER_REPORT"
    || subscription.consent.status !== "OPTED_IN"
    || subscription.consent.policyVersion !== WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION
  )) {
    throw new WhatsAppConflictError("Confirm an active daily-report subscription first");
  }
  if (
    !input.requireActive
    && !(["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"] as const).includes(
      subscription.status as "PENDING_CONFIRMATION" | "ACTIVE" | "PAUSED"
    )
  ) {
    throw new WhatsAppConflictError("Create a current daily-report subscription first");
  }
  return subscription;
}

function assertEligibleReportWindow(input: {
  subscription: { activatedAt: Date | null; sendTimeLocal: string };
  timeZone: string;
  now: Date;
}) {
  const window = getWhatsAppReportPlanningWindow({
    now: input.now,
    sendTimeLocal: input.subscription.sendTimeLocal,
    timeZone: input.timeZone,
  });
  if (!window.eligible) {
    throw new WhatsAppConflictError(
      window.missed
        ? "Today's daily-report catch-up window has ended"
        : "Today's daily report is not due yet"
    );
  }
  if (
    input.subscription.activatedAt
    && window.scheduledCutoffAt.getTime() < input.subscription.activatedAt.getTime()
  ) {
    throw new WhatsAppConflictError("Daily reports begin after confirmation");
  }
  return window;
}

export async function loadOrCreateWhatsAppReportSnapshotInTransaction(input: {
  tx: Prisma.TransactionClient;
  scope: AuthorizedReportScope;
  localReportDate: string;
  scheduledCutoffAt: Date;
  metricsAsOfAt: Date;
}) {
  assertTrustworthyReportMetricsAsOf({
    scheduledCutoffAt: input.scheduledCutoffAt,
    metricsAsOfAt: input.metricsAsOfAt,
    timeZone: input.scope.timeZone,
  });
  const identity = {
    scope: input.scope.scope,
    scopeKey: input.scope.scopeKey,
    localReportDate: input.localReportDate,
    scheduledCutoffAt: input.scheduledCutoffAt,
    metricsVersion: WHATSAPP_REPORT_METRICS_VERSION,
  } as const;
  const existing = await input.tx.whatsAppDailyReportSnapshot.findUnique({
    where: {
      scope_scopeKey_localReportDate_scheduledCutoffAt_metricsVersion: identity,
    },
  });
  if (existing) {
    let metrics: WhatsAppReportMetrics;
    let expectedAsOfLocalTime: string;
    let expectedSourceFingerprint: string;
    try {
      assertTrustworthyReportMetricsAsOf({
        scheduledCutoffAt: existing.scheduledCutoffAt,
        metricsAsOfAt: existing.metricsAsOfAt,
        timeZone: existing.timeZone,
      });
      metrics = canonicalizeWhatsAppReportMetrics(existing.metrics);
      const asOf = getWhatsAppLocalDateTimeParts(
        existing.metricsAsOfAt,
        existing.timeZone
      );
      expectedAsOfLocalTime = `${String(asOf.hour).padStart(2, "0")}:${String(
        asOf.minute
      ).padStart(2, "0")}`;
      expectedSourceFingerprint = createWhatsAppReportSourceFingerprint({
        scope: existing.scope,
        scopeKey: existing.scopeKey,
        localReportDate: existing.localReportDate,
        scheduledCutoffAt: existing.scheduledCutoffAt,
        metricsAsOfAt: existing.metricsAsOfAt,
        metricsVersion: existing.metricsVersion,
      });
    } catch {
      throw new WhatsAppReportMetricsUnavailableError();
    }
    if (
      existing.organizationId !== input.scope.organizationId
      || existing.branchId !== input.scope.branchId
      || existing.timeZone !== input.scope.timeZone
      || existing.scheduledCutoffAt.getTime() !== input.scheduledCutoffAt.getTime()
      || existing.generatedAt.getTime() !== existing.metricsAsOfAt.getTime()
      || existing.sourceFingerprint !== expectedSourceFingerprint
      || hashWhatsAppReportMetrics(metrics) !== existing.metricsHash
      || metrics.localReportDate !== input.localReportDate
      || metrics.metricsAsOfAt !== existing.metricsAsOfAt.toISOString()
      || existing.localReportDate !== utcReportLocalDate(
        getWhatsAppLocalDateParts(existing.scheduledCutoffAt, existing.timeZone)
      ).toISOString().slice(0, 10)
      || metrics.asOfLocalTime !== expectedAsOfLocalTime
      || (input.scope.scope === "BRANCH") !== ("branchName" in metrics)
    ) {
      throw new WhatsAppReportMetricsUnavailableError();
    }
    return { snapshot: existing, metrics };
  }

  let metrics: WhatsAppReportMetrics;
  try {
    metrics = canonicalizeWhatsAppReportMetrics(
      await getWhatsAppDailyReportMetrics(input.tx, {
        scope: input.scope.scope,
        organizationId: input.scope.organizationId,
        branchId: input.scope.branchId,
        localReportDate: input.localReportDate,
        scheduledCutoffAt: input.scheduledCutoffAt,
        metricsAsOfAt: input.metricsAsOfAt,
      })
    );
  } catch (error) {
    if (!isReportMetricsIntegrityError(error)) throw error;
    throw new WhatsAppReportMetricsUnavailableError();
  }
  const metricsHash = hashWhatsAppReportMetrics(metrics);
  const expectedSourceFingerprint = createWhatsAppReportSourceFingerprint({
    scope: input.scope.scope,
    scopeKey: input.scope.scopeKey,
    localReportDate: input.localReportDate,
    scheduledCutoffAt: input.scheduledCutoffAt,
    metricsAsOfAt: input.metricsAsOfAt,
  });
  const snapshot = await input.tx.whatsAppDailyReportSnapshot.create({
    data: {
      organizationId: input.scope.organizationId,
      branchId: input.scope.branchId,
      scope: input.scope.scope,
      scopeKey: input.scope.scopeKey,
      localReportDate: input.localReportDate,
      timeZone: input.scope.timeZone,
      scheduledCutoffAt: input.scheduledCutoffAt,
      metricsAsOfAt: input.metricsAsOfAt,
      generatedAt: input.metricsAsOfAt,
      metricsVersion: WHATSAPP_REPORT_METRICS_VERSION,
      metrics: metrics as Prisma.InputJsonValue,
      metricsHash,
      sourceFingerprint: expectedSourceFingerprint,
    },
  });
  return { snapshot, metrics };
}

function serializeQueuedReportMessage(message: {
  id: string;
  status: string;
  trigger: string;
  scheduledFor: Date;
  localScheduleDate: Date | null;
  rateCardVersion: string | null;
  estimatedCostMicros: bigint | null;
  dailyReportSnapshotId: string | null;
  reportSubscriptionId: string | null;
  createdAt: Date;
}) {
  return {
    id: message.id,
    status: message.status,
    trigger: message.trigger,
    scheduledFor: message.scheduledFor.toISOString(),
    localScheduleDate: message.localScheduleDate?.toISOString().slice(0, 10) ?? null,
    rateCardVersion: message.rateCardVersion,
    estimatedCostMicros: message.estimatedCostMicros?.toString() ?? null,
    dailyReportSnapshotId: message.dailyReportSnapshotId,
    reportSubscriptionId: message.reportSubscriptionId,
    createdAt: message.createdAt.toISOString(),
  };
}

async function branchDailyAutomaticUsage(input: {
  tx: Prisma.TransactionClient;
  branchId: string;
  localScheduleDate: Date;
}) {
  return input.tx.whatsAppMessage.count({
    where: {
      branchId: input.branchId,
      localScheduleDate: input.localScheduleDate,
      status: { notIn: ["CANCELLED", "SUPPRESSED"] },
      OR: [
        { trigger: "AUTOMATION" },
        { purpose: { in: ["DAILY_BRANCH_REPORT", "DAILY_ORGANIZATION_REPORT"] } },
      ],
    },
  });
}

async function queueCurrentReportInTransaction(input: {
  tx: Prisma.TransactionClient;
  actorUserId: string;
  scopeInput: WhatsAppReportScopeInput;
  trigger: "MANUAL" | "AUTOMATION";
  expectedSubscriptionId?: string;
  metricsAsOfAt?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  assertWhatsAppReportsEnabled(input.env);
  // In production this is the transaction's first application query, so the
  // report label and the RepeatableRead/Serializable database snapshot begin
  // at the same statement boundary.
  const metricsAsOfAt = await resolveReportMetricsAsOfAt(
    input.tx,
    input.metricsAsOfAt
  );
  let authorized = await authorizeReportScope({
    actorUserId: input.actorUserId,
    scope: input.scopeInput,
    client: input.tx,
    writable: true,
  });
  await lockReportBudgetScope(input.tx, authorized);
  authorized = await authorizeReportScope({
    actorUserId: input.actorUserId,
    scope: input.scopeInput,
    client: input.tx,
    writable: true,
  });
  const delivery = await resolveReportDeliveryState({
    client: input.tx,
    scope: authorized,
    requireEnabled: true,
    env: input.env,
  });
  assertWhatsAppMessageWritesEnabled(authorized.organizationId, input.env);
  if (
    input.trigger === "AUTOMATION"
    && !isWhatsAppLiveAutomationOrganizationEnabled(authorized.organizationId, input.env)
  ) {
    throw new WhatsAppConflictError("Automatic daily-report delivery is unavailable");
  }
  assertSenderAvailable(delivery);
  if (
    !Number.isSafeInteger(delivery.configurationRevision)
    || delivery.configurationRevision < 1
  ) throw new WhatsAppConflictError("Daily report settings are unavailable");
  const subscription = await loadCurrentReportSubscription({
    client: input.tx,
    scope: authorized,
    senderId: delivery.sender.id,
    userId: input.actorUserId,
    requireActive: true,
  });
  if (input.expectedSubscriptionId && subscription.id !== input.expectedSubscriptionId) {
    throw new WhatsAppResourceNotFoundError();
  }
  const window = assertEligibleReportWindow({
    subscription,
    timeZone: authorized.timeZone,
    now: metricsAsOfAt,
  });
  assertTrustworthyReportMetricsAsOf({
    scheduledCutoffAt: window.scheduledCutoffAt,
    metricsAsOfAt,
    timeZone: authorized.timeZone,
  });
  const dedupeKey = reportDedupeKey({
    senderId: delivery.sender.id,
    subscriptionId: subscription.id,
    localReportDate: window.localDateKey,
    scheduledCutoffAt: window.scheduledCutoffAt,
  });
  const existing = await input.tx.whatsAppMessage.findUnique({ where: { dedupeKey } });
  if (existing) {
    if (
      existing.organizationId !== authorized.organizationId
      || existing.branchId !== authorized.branchId
      || existing.senderId !== delivery.sender.id
      || existing.reportSubscriptionId !== subscription.id
      || existing.purpose !== reportPurpose(authorized.scope)
      || existing.scheduledFor.getTime() !== window.scheduledCutoffAt.getTime()
    ) {
      throw new WhatsAppConflictError("Daily report deduplication is unavailable");
    }
    await input.tx.whatsAppReportSubscription.update({
      where: { id: subscription.id },
      data: {
        lastPlannedAt: metricsAsOfAt,
        lastPlannedLocalDate: window.localDateKey,
        lastPlannerErrorCode: null,
        plannerLeaseToken: null,
        plannerLeaseUntil: null,
      },
    });
    return {
      replayed: true as const,
      localReportDate: window.localDateKey,
      message: serializeQueuedReportMessage(existing),
    };
  }

  const language = normalizeReportLanguage(subscription.language);
  const { binding, definition, managedKey } = await resolveReportBinding({
    client: input.tx,
    senderId: delivery.sender.id,
    scope: authorized.scope,
    language,
  });
  const rateCard = resolveWhatsAppUtilityRate({
    recipientPhoneE164: subscription.phoneE164,
    at: metricsAsOfAt,
    env: input.env,
  });
  const monthlyBudgetMinor = validateWhatsAppMonthlyBudgetMinor(
    delivery.monthlyBudgetMinor
  );
  const budgetMonth = whatsappBudgetMonth(window.scheduledCutoffAt, authorized.timeZone);
  const localScheduleDate = utcReportLocalDate(window.localDate);
  if (authorized.scope === "BRANCH") {
    if (
      !Number.isSafeInteger(delivery.dailyAutomaticMessageLimit)
      || delivery.dailyAutomaticMessageLimit === null
      || delivery.dailyAutomaticMessageLimit < 1
      || delivery.dailyAutomaticMessageLimit > 200
    ) {
      throw new WhatsAppConflictError("Daily message limit is unavailable");
    }
    const usedToday = await branchDailyAutomaticUsage({
      tx: input.tx,
      branchId: authorized.branchId!,
      localScheduleDate,
    });
    if (usedToday >= delivery.dailyAutomaticMessageLimit) {
      throw new WhatsAppConflictError("Branch daily automatic message limit reached");
    }
  }
  const budgetUsed = await input.tx.whatsAppMessage.aggregate({
    where: authorized.scope === "BRANCH"
      ? {
          branchId: authorized.branchId!,
          budgetMonth,
          budgetState: { in: ["RESERVED", "COMMITTED"] },
        }
      : {
          organizationId: authorized.organizationId,
          branchId: null,
          purpose: "DAILY_ORGANIZATION_REPORT",
          budgetMonth,
          budgetState: { in: ["RESERVED", "COMMITTED"] },
        },
    _sum: { estimatedCostMicros: true },
  });
  const budgetLimitMicros = BigInt(paiseToInrMicros(monthlyBudgetMinor));
  const usedMicros = budgetUsed._sum.estimatedCostMicros ?? 0n;
  if (usedMicros + BigInt(rateCard.rateMicros) > budgetLimitMicros) {
    throw new WhatsAppConflictError("WhatsApp monthly budget would be exceeded");
  }

  const { snapshot, metrics } = await loadOrCreateWhatsAppReportSnapshotInTransaction({
    tx: input.tx,
    scope: authorized,
    localReportDate: window.localDateKey,
    scheduledCutoffAt: window.scheduledCutoffAt,
    metricsAsOfAt,
  });
  const values = reportTemplateValues(metrics);
  const prepared = prepareManagedWhatsAppTemplate(definition, values);
  const sourceFingerprint = reportMessageSourceFingerprint({
    organizationId: authorized.organizationId,
    branchId: authorized.branchId,
    scope: authorized.scope,
    snapshotSourceFingerprint: snapshot.sourceFingerprint,
    metricsHash: snapshot.metricsHash,
    subscriptionId: subscription.id,
    senderId: delivery.sender.id,
    recipientPhoneE164: subscription.phoneE164,
    settingsRevision: delivery.configurationRevision,
    templateBindingId: binding.id,
    templateId: binding.templateId,
    templateVersion: binding.template.version,
    managedTemplateKey: managedKey,
    language,
    templateVariables: values,
    catalogVersion: definition.catalogVersion,
    catalogHash: definition.catalogHash,
  });
  const message = await input.tx.whatsAppMessage.create({
    data: {
      organizationId: authorized.organizationId,
      branchId: authorized.branchId,
      senderId: delivery.sender.id,
      templateId: binding.templateId,
      templateBindingId: binding.id,
      reportSubscriptionId: subscription.id,
      dailyReportSnapshotId: snapshot.id,
      createdByUserId: input.trigger === "MANUAL" ? input.actorUserId : null,
      recipientPhoneE164: subscription.phoneE164,
      purpose: reportPurpose(authorized.scope),
      trigger: input.trigger,
      managedTemplateKey: managedKey,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      templateVersion: binding.template.version,
      templateVariables: values,
      renderedPreview: prepared.renderedPreview,
      scheduledFor: window.scheduledCutoffAt,
      availableAt: metricsAsOfAt,
      localScheduleDate,
      status: "SCHEDULED",
      dedupeKey,
      settingsRevision: delivery.configurationRevision,
      sourceFingerprint,
      budgetMonth,
      budgetState: "RESERVED",
      rateCardVersion: rateCard.version,
      estimatedCostMicros: BigInt(rateCard.rateMicros),
      currency: rateCard.currency,
    },
  });
  await input.tx.whatsAppReportSubscription.update({
    where: { id: subscription.id },
    data: {
      lastPlannedAt: metricsAsOfAt,
      lastPlannedLocalDate: window.localDateKey,
      lastPlannerErrorCode: null,
      plannerLeaseToken: null,
      plannerLeaseUntil: null,
    },
  });
  await input.tx.whatsAppAuditEvent.create({
    data: {
      organizationId: authorized.organizationId,
      branchId: authorized.branchId,
      senderId: delivery.sender.id,
      actorUserId: input.trigger === "MANUAL" ? input.actorUserId : null,
      action: "REPORT_QUEUED",
      details: {
        scope: authorized.scope,
        trigger: input.trigger,
        localReportDate: window.localDateKey,
        metricsVersion: WHATSAPP_REPORT_METRICS_VERSION,
        rateCardVersion: rateCard.version,
      },
    },
  });
  return {
    replayed: false as const,
    localReportDate: window.localDateKey,
    message: serializeQueuedReportMessage(message),
  };
}

function assertSafeReportReason(value: string) {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
    throw new WhatsAppValidationError();
  }
  return value;
}

async function staleReportSubscriptionRows(input: {
  tx: Prisma.TransactionClient;
  subscriptions: Array<{
    id: string;
    organizationId: string;
    branchId: string | null;
    senderId: string;
    userId: string;
    scope: WhatsAppReportScope;
  }>;
  reason: string;
  now: Date;
}) {
  let cancelledMessages = 0;
  let staleSubscriptions = 0;
  for (const subscription of input.subscriptions) {
    const changed = await input.tx.whatsAppReportSubscription.updateMany({
      where: {
        id: subscription.id,
        status: { in: ["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"] },
      },
      data: {
        status: "STALE",
        staleAt: input.now,
        confirmationCodeHash: null,
        confirmationExpiresAt: null,
        plannerLeaseToken: null,
        plannerLeaseUntil: null,
        lastPlannerErrorCode: input.reason,
      },
    });
    if (changed.count !== 1) continue;
    staleSubscriptions += 1;
    cancelledMessages += await cancelUnsubmittedReportMessages({
      tx: input.tx,
      organizationId: subscription.organizationId,
      branchId: subscription.branchId,
      reportSubscriptionId: subscription.id,
      now: input.now,
      code: input.reason,
    });
    await input.tx.whatsAppAuditEvent.create({
      data: {
        organizationId: subscription.organizationId,
        branchId: subscription.branchId,
        senderId: subscription.senderId,
        actorUserId: null,
        action: "REPORT_SUBSCRIPTION_STALE",
        details: { scope: subscription.scope, reason: input.reason },
      },
    });
  }
  return { staleSubscriptions, cancelledMessages };
}

export class WhatsAppReportService {
  static async getSubscription(input: WhatsAppReportScopeInput & {
    actorUserId: string;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppReportsEnabled(input.env);
    const authorized = await authorizeReportScope({
      actorUserId: input.actorUserId,
      scope: input,
      client: prisma,
      writable: false,
    });
    const subscription = await prisma.whatsAppReportSubscription.findFirst({
      where: {
        organizationId: authorized.organizationId,
        branchId: authorized.branchId,
        scope: authorized.scope,
        scopeKey: authorized.scopeKey,
        userId: input.actorUserId,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    return {
      operationsUiEnabled: isWhatsAppOperationsUiEnabled(input.env),
      subscription: subscription ? serializeSubscription(subscription) : null,
    };
  }

  static async createSubscription(input: WhatsAppReportSubscriptionMutationInput) {
    assertWhatsAppReportsEnabled(input.env);
    let phoneE164: string;
    try {
      phoneE164 = normalizeWhatsAppPhone(input.phone, { defaultCountry: "IN" });
    } catch {
      throw new WhatsAppValidationError("Report phone number is invalid");
    }
    const language = normalizeReportLanguage(input.language);
    const sendTimeLocal = normalizeReportTime(input.sendTimeLocal);
    const now = input.now ?? new Date();
    await authorizeReportScope({
      actorUserId: input.actorUserId,
      scope: input,
      client: prisma,
      writable: true,
    });

    return prisma.$transaction(async tx => {
      const authorized = await authorizeReportScope({
        actorUserId: input.actorUserId,
        scope: input,
        client: tx,
        writable: true,
      });
      const delivery = await resolveReportDeliveryState({
        client: tx,
        scope: authorized,
        requireEnabled: false,
        env: input.env,
      });
      const unique = {
        senderId: delivery.sender.id,
        userId: input.actorUserId,
        scope: authorized.scope,
        scopeKey: authorized.scopeKey,
      } as const;
      const existing = await tx.whatsAppReportSubscription.findUnique({
        where: { senderId_userId_scope_scopeKey: unique },
      });
      if (existing?.status === "ACTIVE") {
        throw new WhatsAppConflictError("Daily reports are already active");
      }
      const base = existing
        ? await tx.whatsAppReportSubscription.update({
            where: { id: existing.id },
            data: {
              organizationId: authorized.organizationId,
              branchId: authorized.branchId,
              phoneE164,
              language,
              sendTimeLocal,
              consentId: null,
            },
          })
        : await tx.whatsAppReportSubscription.create({
            data: {
              organizationId: authorized.organizationId,
              branchId: authorized.branchId,
              scope: authorized.scope,
              scopeKey: authorized.scopeKey,
              senderId: delivery.sender.id,
              userId: input.actorUserId,
              phoneE164,
              language,
              sendTimeLocal,
            },
          });
      const issued = await issueConfirmationInTransaction({
        tx,
        subscriptionId: base.id,
        senderId: delivery.sender.id,
        phoneE164,
        now,
      });
      if (!existing) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: authorized.organizationId,
            branchId: authorized.branchId,
            senderId: delivery.sender.id,
            actorUserId: input.actorUserId,
            action: "REPORT_SUBSCRIPTION_CREATED",
            details: { scope: authorized.scope },
          },
        });
      }
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: authorized.organizationId,
          branchId: authorized.branchId,
          senderId: delivery.sender.id,
          actorUserId: input.actorUserId,
          action: "REPORT_CONFIRMATION_ISSUED",
          details: { scope: authorized.scope, expiresInMinutes: 15 },
        },
      });
      return {
        subscription: serializeSubscription(issued.subscription),
        confirmationCode: issued.confirmationCode,
      };
    }, { isolationLevel: "Serializable" });
  }

  static async reissueConfirmation(input: WhatsAppReportScopeInput & {
    actorUserId: string;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppReportsEnabled(input.env);
    const now = input.now ?? new Date();
    return prisma.$transaction(async tx => {
      const authorized = await authorizeReportScope({
        actorUserId: input.actorUserId,
        scope: input,
        client: tx,
        writable: true,
      });
      const delivery = await resolveReportDeliveryState({
        client: tx,
        scope: authorized,
        requireEnabled: false,
        env: input.env,
      });
      const subscription = await tx.whatsAppReportSubscription.findUnique({
        where: {
          senderId_userId_scope_scopeKey: {
            senderId: delivery.sender.id,
            userId: input.actorUserId,
            scope: authorized.scope,
            scopeKey: authorized.scopeKey,
          },
        },
      });
      if (!subscription) throw new WhatsAppResourceNotFoundError();
      if (subscription.status === "ACTIVE") {
        throw new WhatsAppConflictError("Daily reports are already active");
      }
      const issued = await issueConfirmationInTransaction({
        tx,
        subscriptionId: subscription.id,
        senderId: delivery.sender.id,
        phoneE164: subscription.phoneE164,
        now,
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: authorized.organizationId,
          branchId: authorized.branchId,
          senderId: delivery.sender.id,
          actorUserId: input.actorUserId,
          action: "REPORT_CONFIRMATION_ISSUED",
          details: { scope: authorized.scope, expiresInMinutes: 15 },
        },
      });
      return {
        subscription: serializeSubscription(issued.subscription),
        confirmationCode: issued.confirmationCode,
      };
    }, { isolationLevel: "Serializable" });
  }

  static async pauseSubscription(input: WhatsAppReportScopeInput & {
    actorUserId: string;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppReportsEnabled(input.env);
    const now = input.now ?? new Date();
    return prisma.$transaction(async tx => {
      const authorized = await authorizeReportScope({
        actorUserId: input.actorUserId,
        scope: input,
        client: tx,
        writable: false,
      });
      const subscription = await tx.whatsAppReportSubscription.findFirst({
        where: {
          organizationId: authorized.organizationId,
          branchId: authorized.branchId,
          scope: authorized.scope,
          scopeKey: authorized.scopeKey,
          userId: input.actorUserId,
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });
      if (!subscription) throw new WhatsAppResourceNotFoundError();
      const changed = subscription.status !== "PAUSED"
        && subscription.status !== "REVOKED"
        && subscription.status !== "STALE";
      const updated = changed
        ? await tx.whatsAppReportSubscription.update({
            where: { id: subscription.id },
            data: {
              status: "PAUSED",
              pausedAt: now,
              confirmationCodeHash: null,
              confirmationExpiresAt: null,
              plannerLeaseToken: null,
              plannerLeaseUntil: null,
            },
          })
        : subscription;
      const cancelledMessages = await cancelUnsubmittedReportMessages({
        tx,
        organizationId: subscription.organizationId,
        branchId: subscription.branchId,
        reportSubscriptionId: subscription.id,
        now,
        code: "REPORT_SUBSCRIPTION_PAUSED",
      });
      if (changed) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: subscription.organizationId,
            branchId: subscription.branchId,
            senderId: subscription.senderId,
            actorUserId: input.actorUserId,
            action: "REPORT_SUBSCRIPTION_PAUSED",
            details: { scope: subscription.scope, cancelledMessages },
          },
        });
      }
      return { changed, cancelledMessages, subscription: serializeSubscription(updated) };
    });
  }

  static async revokeSubscription(input: WhatsAppReportScopeInput & {
    actorUserId: string;
    subscriptionId?: string;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppReportsEnabled(input.env);
    const now = input.now ?? new Date();
    if (input.subscriptionId) assertId(input.subscriptionId);
    return prisma.$transaction(async tx => {
      const authorized = await authorizeReportScope({
        actorUserId: input.actorUserId,
        scope: input,
        client: tx,
        writable: false,
      });
      const subscription = await tx.whatsAppReportSubscription.findFirst({
        where: {
          ...(input.subscriptionId
            ? { id: input.subscriptionId }
            : { userId: input.actorUserId }),
          organizationId: authorized.organizationId,
          branchId: authorized.branchId,
          scope: authorized.scope,
          scopeKey: authorized.scopeKey,
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });
      if (!subscription) throw new WhatsAppResourceNotFoundError();
      if (subscription.userId !== input.actorUserId && authorized.ownerId !== input.actorUserId) {
        throw new WhatsAppResourceNotFoundError();
      }
      const changed = subscription.status !== "REVOKED";
      const updated = changed
        ? await tx.whatsAppReportSubscription.update({
            where: { id: subscription.id },
            data: {
              status: "REVOKED",
              revokedAt: now,
              confirmationCodeHash: null,
              confirmationExpiresAt: null,
              plannerLeaseToken: null,
              plannerLeaseUntil: null,
            },
          })
        : subscription;
      const cancelledMessages = await cancelUnsubmittedReportMessages({
        tx,
        organizationId: subscription.organizationId,
        branchId: subscription.branchId,
        reportSubscriptionId: subscription.id,
        now,
        code: "REPORT_SUBSCRIPTION_REVOKED",
      });
      if (changed) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: subscription.organizationId,
            branchId: subscription.branchId,
            senderId: subscription.senderId,
            actorUserId: input.actorUserId,
            action: "REPORT_SUBSCRIPTION_REVOKED",
            details: { scope: subscription.scope, cancelledMessages },
          },
        });
      }
      return { changed, cancelledMessages, subscription: serializeSubscription(updated) };
    });
  }

  static async confirmSubscriptionInTransaction(input: WhatsAppReportConfirmationInput) {
    assertWhatsAppReportsEnabled(input.env);
    const now = input.now ?? new Date();
    let phoneE164: string;
    let code: string;
    try {
      phoneE164 = normalizeWhatsAppPhone(input.phoneE164);
      code = normalizeWhatsAppReportConfirmationCode(input.code);
    } catch {
      return { matched: false as const, activated: false as const };
    }
    const candidates = await input.tx.whatsAppReportSubscription.findMany({
      where: {
        senderId: assertId(input.senderId),
        phoneE164,
        status: "PENDING_CONFIRMATION",
        confirmationCodeHash: { not: null },
        confirmationExpiresAt: { gt: now },
        confirmationAttemptCount: { lt: WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS },
      },
      select: {
        id: true,
        confirmationCodeHash: true,
        confirmationAttemptCount: true,
      },
      orderBy: [{ confirmationIssuedAt: "desc" }, { id: "asc" }],
      take: MAX_CONFIRMATION_CANDIDATES + 1,
    });
    if (candidates.length > MAX_CONFIRMATION_CANDIDATES) {
      return { matched: false as const, activated: false as const };
    }
    const matched = candidates.find(candidate => {
      const actual = hashWhatsAppReportConfirmationCode({
        senderId: input.senderId,
        subscriptionId: candidate.id,
        phoneE164,
        code,
      });
      return candidate.confirmationCodeHash
        ? matchesWhatsAppReportConfirmationHash(candidate.confirmationCodeHash, actual)
        : false;
    });
    if (!matched) {
      const retryIds = candidates
        .filter(candidate => candidate.confirmationAttemptCount
          < WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS - 1)
        .map(candidate => candidate.id);
      const expireIds = candidates
        .filter(candidate => candidate.confirmationAttemptCount
          >= WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS - 1)
        .map(candidate => candidate.id);
      if (retryIds.length > 0) {
        await input.tx.whatsAppReportSubscription.updateMany({
          where: {
            id: { in: retryIds },
            status: "PENDING_CONFIRMATION",
            confirmationAttemptCount: { lt: WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS - 1 },
          },
          data: { confirmationAttemptCount: { increment: 1 } },
        });
      }
      if (expireIds.length > 0) {
        await input.tx.whatsAppReportSubscription.updateMany({
          where: {
            id: { in: expireIds },
            status: "PENDING_CONFIRMATION",
            confirmationAttemptCount: {
              gte: WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS - 1,
              lt: WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS,
            },
          },
          data: {
            confirmationAttemptCount: { increment: 1 },
            status: "EXPIRED",
            confirmationCodeHash: null,
            confirmationExpiresAt: null,
          },
        });
      }
      return { matched: false as const, activated: false as const };
    }

    await input.tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "WhatsAppReportSubscription"
      WHERE "id" = ${matched.id}
      FOR UPDATE
    `);
    const subscription = await input.tx.whatsAppReportSubscription.findUnique({
      where: { id: matched.id },
    });
    if (
      !subscription
      || subscription.status !== "PENDING_CONFIRMATION"
      || !subscription.confirmationCodeHash
      || !subscription.confirmationExpiresAt
      || subscription.confirmationExpiresAt.getTime() <= now.getTime()
      || subscription.confirmationAttemptCount >= WHATSAPP_REPORT_CONFIRMATION_MAX_ATTEMPTS
      || subscription.senderId !== input.senderId
      || subscription.phoneE164 !== phoneE164
    ) {
      return { matched: true as const, activated: false as const };
    }
    const currentHash = hashWhatsAppReportConfirmationCode({
      senderId: subscription.senderId,
      subscriptionId: subscription.id,
      phoneE164,
      code,
    });
    if (!matchesWhatsAppReportConfirmationHash(subscription.confirmationCodeHash, currentHash)) {
      return { matched: false as const, activated: false as const };
    }

    const scope: WhatsAppReportScopeInput = subscription.scope === "BRANCH"
      ? { scope: "BRANCH", branchId: subscription.branchId ?? "" }
      : { scope: "ORGANIZATION", organizationId: subscription.organizationId };
    let authorized: AuthorizedReportScope;
    let delivery: Awaited<ReturnType<typeof resolveReportDeliveryState>>;
    try {
      authorized = await authorizeReportScope({
        actorUserId: subscription.userId,
        scope,
        client: input.tx,
        writable: true,
      });
      delivery = await resolveReportDeliveryState({
        client: input.tx,
        scope: authorized,
        requireEnabled: false,
        env: input.env,
      });
      if (
        authorized.organizationId !== subscription.organizationId
        || authorized.branchId !== subscription.branchId
        || authorized.scopeKey !== subscription.scopeKey
        || delivery.sender.id !== subscription.senderId
      ) {
        throw new WhatsAppResourceNotFoundError();
      }
    } catch {
      await input.tx.whatsAppReportSubscription.update({
        where: { id: subscription.id },
        data: {
          status: "STALE",
          staleAt: now,
          confirmationCodeHash: null,
          confirmationExpiresAt: null,
        },
      });
      await input.tx.whatsAppAuditEvent.create({
        data: {
          organizationId: subscription.organizationId,
          branchId: subscription.branchId,
          senderId: subscription.senderId,
          actorUserId: subscription.userId,
          action: "REPORT_SUBSCRIPTION_STALE",
          details: { scope: subscription.scope, reason: "CONFIRMATION_REVALIDATION_FAILED" },
        },
      });
      return { matched: true as const, activated: false as const };
    }

    const existingConsent = await input.tx.whatsAppConsent.findUnique({
      where: {
        senderId_phoneE164_consentType: {
          senderId: subscription.senderId,
          phoneE164,
          consentType: "OWNER_REPORT",
        },
      },
    });
    const previousStatus = existingConsent?.status ?? "UNKNOWN";
    const consent = existingConsent
      ? existingConsent.status === "OPTED_IN"
        && existingConsent.policyVersion === WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION
        && existingConsent.revokedAt === null
        ? existingConsent
        : await input.tx.whatsAppConsent.update({
          where: { id: existingConsent.id },
          data: {
            status: "OPTED_IN",
            source: "WHATSAPP_REPLY",
            policyVersion: WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION,
            grantedAt: now,
            revokedAt: null,
            recordedByUserId: subscription.userId,
          },
        })
      : await input.tx.whatsAppConsent.create({
          data: {
            senderId: subscription.senderId,
            phoneE164,
            consentType: "OWNER_REPORT",
            status: "OPTED_IN",
            source: "WHATSAPP_REPLY",
            policyVersion: WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION,
            grantedAt: now,
            recordedByUserId: subscription.userId,
          },
        });
    if (
      previousStatus !== "OPTED_IN"
      || existingConsent?.policyVersion !== WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION
    ) {
      await input.tx.whatsAppConsentEvent.create({
        data: {
          consentId: consent.id,
          senderId: subscription.senderId,
          phoneE164,
          consentType: "OWNER_REPORT",
          actorUserId: subscription.userId,
          previousStatus,
          nextStatus: "OPTED_IN",
          source: "WHATSAPP_REPLY",
          policyVersion: WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION,
          details: { reportConfirmation: true },
          occurredAt: now,
        },
      });
    }
    await input.tx.whatsAppReportSubscription.update({
      where: { id: subscription.id },
      data: {
        consentId: consent.id,
        status: "ACTIVE",
        activatedAt: now,
        pausedAt: null,
        revokedAt: null,
        staleAt: null,
        confirmationCodeHash: null,
        confirmationExpiresAt: null,
        confirmationAttemptCount: 0,
      },
    });
    await input.tx.whatsAppAuditEvent.create({
      data: {
        organizationId: subscription.organizationId,
        branchId: subscription.branchId,
        senderId: subscription.senderId,
        actorUserId: subscription.userId,
        action: "REPORT_SUBSCRIPTION_CONFIRMED",
        details: { scope: subscription.scope },
      },
    });
    return {
      matched: true as const,
      activated: true as const,
      subscriptionId: subscription.id,
    };
  }

  static async getOrganizationSettings(input: {
    actorUserId: string;
    organizationId: string;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppReportsEnabled(input.env);
    await WhatsAppAuthorizationService.assertOwnerEntitled(
      input.actorUserId,
      assertId(input.organizationId)
    );
    const settings = await prisma.organizationWhatsAppReportSettings.findUnique({
      where: { organizationId: input.organizationId },
      include: { sender: { select: { id: true, verifiedName: true, displayPhoneNumber: true, status: true } } },
    });
    return {
      operationsUiEnabled: isWhatsAppOperationsUiEnabled(input.env),
      settings: settings
        ? {
            enabled: settings.enabled,
            sender: settings.sender
              ? {
                  id: settings.sender.id,
                  verifiedName: settings.sender.verifiedName,
                  maskedPhone: maskPhone(settings.sender.displayPhoneNumber),
                  status: settings.sender.status,
                }
              : null,
            monthlyBudgetMinor: settings.monthlyBudgetMinor,
            configurationRevision: settings.configurationRevision,
            updatedAt: settings.updatedAt.toISOString(),
          }
        : {
            enabled: false,
            sender: null,
            monthlyBudgetMinor: null,
            configurationRevision: 0,
            updatedAt: null,
          },
    };
  }

  static async updateOrganizationSettings(input: {
    actorUserId: string;
    organizationId: string;
    changes: WhatsAppOrganizationReportSettingsUpdate;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    assertWhatsAppReportsEnabled(input.env);
    const organizationId = assertId(input.organizationId);
    const keys = Object.keys(input.changes);
    if (
      keys.length < 1
      || keys.some(key => !["senderId", "enabled", "monthlyBudgetMinor"].includes(key))
      || (input.changes.senderId !== undefined
        && input.changes.senderId !== null
        && !ID_PATTERN.test(input.changes.senderId))
      || (input.changes.enabled !== undefined && typeof input.changes.enabled !== "boolean")
      || (input.changes.monthlyBudgetMinor !== undefined
        && input.changes.monthlyBudgetMinor !== null
        && !Number.isSafeInteger(input.changes.monthlyBudgetMinor))
    ) {
      throw new WhatsAppValidationError();
    }
    const now = input.now ?? new Date();
    return prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        organizationId,
        tx
      );
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
      `);
      const current = await tx.organizationWhatsAppReportSettings.findUnique({
        where: { organizationId },
      });
      const senderId = input.changes.senderId !== undefined
        ? input.changes.senderId
        : current?.senderId ?? null;
      const enabled = input.changes.enabled ?? current?.enabled ?? false;
      const monthlyBudgetMinor = input.changes.monthlyBudgetMinor !== undefined
        ? input.changes.monthlyBudgetMinor
        : current?.monthlyBudgetMinor ?? null;
      if (senderId) {
        const sender = await tx.whatsAppSender.findFirst({
          where: {
            id: senderId,
            organizationId,
            provider: "META_CLOUD",
            providerMode: resolveWhatsAppProviderMode(input.env),
            status: "ACTIVE",
          },
          select: { id: true },
        });
        if (!sender) throw new WhatsAppResourceNotFoundError();
      }
      if (enabled) {
        if (!senderId) throw new WhatsAppValidationError("Select an active sender first");
        validateWhatsAppMonthlyBudgetMinor(monthlyBudgetMinor);
      } else if (monthlyBudgetMinor !== null) {
        validateWhatsAppMonthlyBudgetMinor(monthlyBudgetMinor);
      }
      const senderChanged = Boolean(current && current.senderId !== senderId);
      const updated = await tx.organizationWhatsAppReportSettings.upsert({
        where: { organizationId },
        create: {
          organizationId,
          senderId,
          enabled,
          monthlyBudgetMinor,
        },
        update: {
          senderId,
          enabled,
          monthlyBudgetMinor,
          configurationRevision: { increment: 1 },
        },
      });
      let staleSubscriptions = 0;
      let cancelledMessages = 0;
      if (senderChanged && current?.senderId) {
        const subscriptions = await tx.whatsAppReportSubscription.findMany({
          where: {
            organizationId,
            branchId: null,
            scope: "ORGANIZATION",
            senderId: current.senderId,
            status: { in: ["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"] },
          },
          orderBy: { id: "asc" },
          take: 201,
          select: {
            id: true,
            organizationId: true,
            branchId: true,
            senderId: true,
            userId: true,
            scope: true,
          },
        });
        if (subscriptions.length > 200) throw new WhatsAppConflictError();
        const stale = await staleReportSubscriptionRows({
          tx,
          subscriptions,
          reason: "REPORT_SENDER_CHANGED",
          now,
        });
        staleSubscriptions = stale.staleSubscriptions;
        cancelledMessages += stale.cancelledMessages;
      }
      if (!enabled) {
        cancelledMessages += await cancelUnsubmittedReportMessages({
          tx,
          organizationId,
          branchId: null,
          now,
          code: "ORGANIZATION_REPORTS_DISABLED",
        });
      }
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId,
          senderId,
          actorUserId: input.actorUserId,
          action: "REPORT_SETTINGS_CHANGED",
          details: {
            changedFields: keys.sort(),
            enabled,
            senderChanged,
            staleSubscriptions,
            cancelledMessages,
          },
        },
      });
      return {
        updated: true as const,
        settings: {
          enabled: updated.enabled,
          senderId: updated.senderId,
          monthlyBudgetMinor: updated.monthlyBudgetMinor,
          configurationRevision: updated.configurationRevision,
          updatedAt: updated.updatedAt.toISOString(),
        },
        staleSubscriptions,
        cancelledMessages,
      };
    }, { isolationLevel: "Serializable" });
  }

  static async preview(input: WhatsAppReportPreviewInput) {
    assertWhatsAppReportsEnabled(input.env);
    return prisma.$transaction(async tx => {
      const metricsAsOfAt = await resolveReportMetricsAsOfAt(tx, input.now);
      const authorized = await authorizeReportScope({
        actorUserId: input.actorUserId,
        scope: input,
        client: tx,
        writable: true,
      });
      const delivery = await resolveReportDeliveryState({
        client: tx,
        scope: authorized,
        requireEnabled: true,
        env: input.env,
      });
      assertWhatsAppMessageWritesEnabled(authorized.organizationId, input.env);
      assertSenderAvailable(delivery);
      if (
        !Number.isSafeInteger(delivery.configurationRevision)
        || delivery.configurationRevision < 1
        || (authorized.scope === "BRANCH" && (
          delivery.dailyAutomaticMessageLimit === null
          || !Number.isSafeInteger(delivery.dailyAutomaticMessageLimit)
          || delivery.dailyAutomaticMessageLimit < 1
          || delivery.dailyAutomaticMessageLimit > 200
        ))
      ) throw new WhatsAppConflictError("Daily report settings are unavailable");
      validateWhatsAppMonthlyBudgetMinor(delivery.monthlyBudgetMinor);
      const subscription = await loadCurrentReportSubscription({
        client: tx,
        scope: authorized,
        senderId: delivery.sender.id,
        userId: input.actorUserId,
        requireActive: false,
      });
      const window = assertEligibleReportWindow({
        subscription,
        timeZone: authorized.timeZone,
        now: metricsAsOfAt,
      });
      assertTrustworthyReportMetricsAsOf({
        scheduledCutoffAt: window.scheduledCutoffAt,
        metricsAsOfAt,
        timeZone: authorized.timeZone,
      });
      const language = normalizeReportLanguage(subscription.language);
      const { definition, managedKey } = await resolveReportBinding({
        client: tx,
        senderId: delivery.sender.id,
        scope: authorized.scope,
        language,
      });
      const rateCard = resolveWhatsAppUtilityRate({
        recipientPhoneE164: subscription.phoneE164,
        at: metricsAsOfAt,
        env: input.env,
      });
      const existingSnapshot = await tx.whatsAppDailyReportSnapshot.findUnique({
        where: {
          scope_scopeKey_localReportDate_scheduledCutoffAt_metricsVersion: {
            scope: authorized.scope,
            scopeKey: authorized.scopeKey,
            localReportDate: window.localDateKey,
            scheduledCutoffAt: window.scheduledCutoffAt,
            metricsVersion: WHATSAPP_REPORT_METRICS_VERSION,
          },
        },
        select: { id: true },
      });
      const metrics = existingSnapshot
        ? (await loadOrCreateWhatsAppReportSnapshotInTransaction({
            tx,
            scope: authorized,
            localReportDate: window.localDateKey,
            scheduledCutoffAt: window.scheduledCutoffAt,
            metricsAsOfAt,
          })).metrics
        : await (async () => {
            try {
              return canonicalizeWhatsAppReportMetrics(
                await getWhatsAppDailyReportMetrics(tx, {
                  scope: authorized.scope,
                  organizationId: authorized.organizationId,
                  branchId: authorized.branchId,
                  localReportDate: window.localDateKey,
                  scheduledCutoffAt: window.scheduledCutoffAt,
                  metricsAsOfAt,
                })
              );
            } catch (error) {
              if (!isReportMetricsIntegrityError(error)) throw error;
              throw new WhatsAppReportMetricsUnavailableError();
            }
          })();
      const values = reportTemplateValues(metrics);
      const prepared = prepareManagedWhatsAppTemplate(definition, values);
      const dedupeKey = reportDedupeKey({
        senderId: delivery.sender.id,
        subscriptionId: subscription.id,
        localReportDate: window.localDateKey,
        scheduledCutoffAt: window.scheduledCutoffAt,
      });
      const alreadyQueued = Boolean(await tx.whatsAppMessage.findUnique({
        where: { dedupeKey },
        select: { id: true },
      }));
      return {
        scope: authorized.scope,
        localReportDate: window.localDateKey,
        scheduledCutoffAt: window.scheduledCutoffAt.toISOString(),
        metricsAsOfAt: metrics.metricsAsOfAt,
        catchUpEndsAt: window.catchUpEndsAt.toISOString(),
        metricsVersion: WHATSAPP_REPORT_METRICS_VERSION,
        metrics,
        template: {
          managedKey,
          language,
          renderedPreview: prepared.renderedPreview,
        },
        estimate: {
          currency: rateCard.currency,
          estimatedCostMicros: estimateWhatsAppUtilityCostMicros({
            messageCount: 1,
            rateMicros: rateCard.rateMicros,
          }).toString(),
          rateCardVersion: rateCard.version,
          rateCardExpiresAt: rateCard.expiresAt.toISOString(),
          disclaimer: "Estimate only. Meta's final invoice is authoritative.",
        },
        alreadyQueued,
      };
    }, { isolationLevel: "RepeatableRead" });
  }

  static async queueToday(input: WhatsAppReportQueueInput) {
    assertWhatsAppReportsEnabled(input.env);
    assertIdempotencyKey(input.idempotencyKey);
    return prisma.$transaction(tx => queueCurrentReportInTransaction({
      tx,
      actorUserId: input.actorUserId,
      scopeInput: input,
      trigger: "MANUAL",
      metricsAsOfAt: input.now,
      env: input.env,
    }), { isolationLevel: "Serializable" });
  }

  static async staleBranchSubscriptionsForUserInTransaction(input: {
    tx: Prisma.TransactionClient;
    branchId: string;
    userId: string;
    reason: string;
    now?: Date;
  }) {
    const branchId = assertId(input.branchId);
    const userId = assertId(input.userId);
    const reason = assertSafeReportReason(input.reason);
    const subscriptions = await input.tx.whatsAppReportSubscription.findMany({
      where: {
        branchId,
        userId,
        scope: "BRANCH",
        status: { in: ["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"] },
      },
      orderBy: { id: "asc" },
      take: 101,
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        senderId: true,
        userId: true,
        scope: true,
      },
    });
    if (subscriptions.length > 100) throw new WhatsAppConflictError();
    return staleReportSubscriptionRows({
      tx: input.tx,
      subscriptions,
      reason,
      now: input.now ?? new Date(),
    });
  }

  static async staleSubscriptionsForSenderInTransaction(input: {
    tx: Prisma.TransactionClient;
    organizationId: string;
    senderId: string;
    branchId?: string | null;
    reason: string;
    now?: Date;
  }) {
    const organizationId = assertId(input.organizationId);
    const senderId = assertId(input.senderId);
    if (typeof input.branchId === "string") assertId(input.branchId);
    const reason = assertSafeReportReason(input.reason);
    const subscriptions = await input.tx.whatsAppReportSubscription.findMany({
      where: {
        organizationId,
        senderId,
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        status: { in: ["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"] },
      },
      orderBy: { id: "asc" },
      take: 201,
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        senderId: true,
        userId: true,
        scope: true,
      },
    });
    if (subscriptions.length > 200) throw new WhatsAppConflictError();
    return staleReportSubscriptionRows({
      tx: input.tx,
      subscriptions,
      reason,
      now: input.now ?? new Date(),
    });
  }

  static async planClaimedSubscriptionInTransaction(input: {
    tx: Prisma.TransactionClient;
    subscriptionId: string;
    leaseToken: string;
    now: Date;
    metricsAsOfAt?: Date;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    const subscriptionId = assertId(input.subscriptionId);
    const leaseToken = assertId(input.leaseToken);
    const metricsAsOfAt = await resolveReportMetricsAsOfAt(
      input.tx,
      input.metricsAsOfAt
    );
    const claimed = await input.tx.whatsAppReportSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (
      !claimed
      || claimed.plannerLeaseToken !== leaseToken
      || !claimed.plannerLeaseUntil
      || claimed.plannerLeaseUntil.getTime() < input.now.getTime()
    ) {
      return { outcome: "LEASE_LOST" as const };
    }
    if (claimed.status !== "ACTIVE" || !claimed.activatedAt) {
      await input.tx.whatsAppReportSubscription.updateMany({
        where: { id: claimed.id, plannerLeaseToken: leaseToken },
        data: { plannerLeaseToken: null, plannerLeaseUntil: null },
      });
      return { outcome: "INACTIVE" as const };
    }
    const scopeInput: WhatsAppReportScopeInput = claimed.scope === "BRANCH"
      ? { scope: "BRANCH", branchId: claimed.branchId ?? "" }
      : { scope: "ORGANIZATION", organizationId: claimed.organizationId };
    const staleClaimed = () => staleReportSubscriptionRows({
      tx: input.tx,
      subscriptions: [{
        id: claimed.id,
        organizationId: claimed.organizationId,
        branchId: claimed.branchId,
        senderId: claimed.senderId,
        userId: claimed.userId,
        scope: claimed.scope,
      }],
      reason: "REPORT_AUTHORIZATION_CHANGED",
      now: input.now,
    });
    let authorized: AuthorizedReportScope;
    try {
      authorized = await authorizeReportScope({
        actorUserId: claimed.userId,
        scope: scopeInput,
        client: input.tx,
        writable: true,
      });
    } catch (error) {
      if (!(error instanceof WhatsAppResourceNotFoundError)) throw error;
      return { outcome: "STALE" as const, ...await staleClaimed() };
    }

    // Keep the same lock order as manual queueing: settings/budget first,
    // subscription second. This avoids a planner/manual deadlock.
    await lockReportBudgetScope(input.tx, authorized);
    await input.tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "WhatsAppReportSubscription"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
    const subscription = await input.tx.whatsAppReportSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (
      !subscription
      || subscription.plannerLeaseToken !== leaseToken
      || !subscription.plannerLeaseUntil
      || subscription.plannerLeaseUntil.getTime() < input.now.getTime()
    ) return { outcome: "LEASE_LOST" as const };
    if (subscription.status !== "ACTIVE" || !subscription.activatedAt) {
      await input.tx.whatsAppReportSubscription.updateMany({
        where: { id: subscription.id, plannerLeaseToken: leaseToken },
        data: { plannerLeaseToken: null, plannerLeaseUntil: null },
      });
      return { outcome: "INACTIVE" as const };
    }

    let delivery: Awaited<ReturnType<typeof resolveReportDeliveryState>>;
    try {
      delivery = await resolveReportDeliveryState({
        client: input.tx,
        scope: authorized,
        requireEnabled: true,
        env: input.env,
      });
      assertWhatsAppMessageWritesEnabled(authorized.organizationId, input.env);
      assertSenderAvailable(delivery);
      const current = await loadCurrentReportSubscription({
        client: input.tx,
        scope: authorized,
        senderId: delivery.sender.id,
        userId: claimed.userId,
        requireActive: true,
      });
      if (current.id !== subscription.id || delivery.sender.id !== subscription.senderId) {
        throw new WhatsAppResourceNotFoundError();
      }
    } catch (error) {
      if (!(error instanceof WhatsAppResourceNotFoundError)) throw error;
      return { outcome: "STALE" as const, ...await staleClaimed() };
    }

    const window = getWhatsAppReportPlanningWindow({
      now: metricsAsOfAt,
      sendTimeLocal: subscription.sendTimeLocal,
      timeZone: authorized.timeZone,
    });
    const skipUntrustworthyReport = async (
      safeCode: "REPORT_TRUST_WINDOW_MISSED" | "REPORT_METRICS_UNAVAILABLE"
    ) => {
      await input.tx.whatsAppReportSubscription.updateMany({
        where: { id: subscription.id, plannerLeaseToken: leaseToken },
        data: {
          lastPlannedAt: metricsAsOfAt,
          lastPlannedLocalDate: window.localDateKey,
          lastPlannerErrorCode: safeCode,
          plannerLeaseToken: null,
          plannerLeaseUntil: null,
        },
      });
      await WhatsAppIncidentService.createOrTouchInTransaction({
        tx: input.tx,
        organizationId: subscription.organizationId,
        branchId: subscription.branchId,
        senderId: subscription.senderId,
        type: "REPORT_FAILURE",
        severity: "WARNING",
        dedupeKey: `report-untrustworthy:${sha256(JSON.stringify([
          subscription.id,
          window.localDateKey,
          window.scheduledCutoffAt.toISOString(),
          WHATSAPP_REPORT_METRICS_VERSION,
          safeCode,
        ]))}`,
        safeCode,
        details: {
          scope: subscription.scope,
          localDate: window.localDateKey,
        },
        now: metricsAsOfAt,
      });
      return {
        outcome: safeCode === "REPORT_TRUST_WINDOW_MISSED"
          ? "MISSED" as const
          : "SKIPPED" as const,
        localReportDate: window.localDateKey,
      };
    };
    if (
      subscription.lastPlannedLocalDate
      && subscription.lastPlannedLocalDate >= window.localDateKey
    ) {
      await input.tx.whatsAppReportSubscription.updateMany({
        where: { id: subscription.id, plannerLeaseToken: leaseToken },
        data: {
          plannerLeaseToken: null,
          plannerLeaseUntil: null,
          lastPlannedAt: metricsAsOfAt,
          lastPlannerErrorCode: null,
        },
      });
      return { outcome: "ALREADY_PLANNED" as const, localReportDate: window.localDateKey };
    }
    if (window.scheduledCutoffAt.getTime() < subscription.activatedAt.getTime()) {
      await input.tx.whatsAppReportSubscription.updateMany({
        where: { id: subscription.id, plannerLeaseToken: leaseToken },
        data: {
          lastPlannedAt: metricsAsOfAt,
          lastPlannedLocalDate: window.localDateKey,
          lastPlannerErrorCode: null,
          plannerLeaseToken: null,
          plannerLeaseUntil: null,
        },
      });
      return { outcome: "BEFORE_ACTIVATION" as const, localReportDate: window.localDateKey };
    }
    if (window.missed) {
      return skipUntrustworthyReport("REPORT_TRUST_WINDOW_MISSED");
    }
    if (!window.eligible) {
      await input.tx.whatsAppReportSubscription.updateMany({
        where: { id: subscription.id, plannerLeaseToken: leaseToken },
        data: { plannerLeaseToken: null, plannerLeaseUntil: null },
      });
      return { outcome: "NOT_DUE" as const, localReportDate: window.localDateKey };
    }
    let queued: Awaited<ReturnType<typeof queueCurrentReportInTransaction>>;
    try {
      queued = await queueCurrentReportInTransaction({
        tx: input.tx,
        actorUserId: subscription.userId,
        scopeInput,
        trigger: "AUTOMATION",
        expectedSubscriptionId: subscription.id,
        metricsAsOfAt,
        env: input.env,
      });
    } catch (error) {
      if (!(error instanceof WhatsAppReportMetricsUnavailableError)) throw error;
      return skipUntrustworthyReport("REPORT_METRICS_UNAVAILABLE");
    }
    return { outcome: queued.replayed ? "DEDUPED" as const : "QUEUED" as const, ...queued };
  }
}

function invalidReportSource(code = "REPORT_SOURCE_CHANGED") {
  return { valid: false as const, code };
}

function reportJsonRecord(value: Prisma.JsonValue): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function sameReportValues(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
) {
  const ordered = (value: Readonly<Record<string, string>>) => Object.fromEntries(
    Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  );
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

export type WhatsAppReportMessageSourceValidationResult =
  | Readonly<{ valid: true; language: WhatsAppManagedTemplateLanguage }>
  | Readonly<{ valid: false; code: string }>;

/**
 * Strict, read-only send-time validation for a report outbox row. The
 * dispatcher calls this inside its locked pre-submission transaction. No Meta
 * call and no report/source write is performed here.
 */
export async function verifyWhatsAppReportMessageSource(input: {
  tx: Prisma.TransactionClient;
  messageId: string;
  now: Date;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<WhatsAppReportMessageSourceValidationResult> {
  if (!ID_PATTERN.test(input.messageId) || Number.isNaN(input.now.getTime())) {
    return invalidReportSource();
  }
  const message = await input.tx.whatsAppMessage.findUnique({
    where: { id: input.messageId },
    include: {
      sender: { include: { safetyState: true } },
      reportSubscription: { include: { consent: true } },
      dailyReportSnapshot: true,
      templateBinding: { include: { template: true, provisioning: true } },
      paymentSources: { select: { paymentId: true } },
    },
  });
  if (
    !message
    || !["DAILY_BRANCH_REPORT", "DAILY_ORGANIZATION_REPORT"].includes(message.purpose)
    || !message.reportSubscription
    || !message.reportSubscriptionId
    || !message.dailyReportSnapshot
    || !message.dailyReportSnapshotId
    || !message.templateBinding
    || !message.templateBindingId
    || !message.templateId
    || !message.managedTemplateKey
    || message.catalogVersion === null
    || !message.catalogHash
    || message.templateVersion === null
    || message.settingsRevision === null
    || !message.localScheduleDate
    || message.studentId !== null
    || message.paymentId !== null
    || message.paymentResolutionEventId !== null
    || message.manualSendRequestId !== null
    || message.serviceNoticeId !== null
    || message.automationStage !== null
    || message.frequencyKey !== null
    || message.paymentSources.length !== 0
  ) return invalidReportSource();

  const subscription = message.reportSubscription;
  const snapshot = message.dailyReportSnapshot;
  const expectedScope = message.purpose === "DAILY_BRANCH_REPORT" ? "BRANCH" : "ORGANIZATION";
  let catchUpEndsAt: Date;
  try {
    catchUpEndsAt = getWhatsAppReportCatchUpEndsAt({
      scheduledCutoffAt: snapshot.scheduledCutoffAt,
      timeZone: snapshot.timeZone,
    });
  } catch {
    return invalidReportSource("REPORT_METRICS_UNAVAILABLE");
  }
  if (
    subscription.scope !== expectedScope
    || snapshot.scope !== expectedScope
    || (expectedScope === "BRANCH" && !message.branchId)
    || (expectedScope === "ORGANIZATION" && message.branchId !== null)
    || subscription.organizationId !== message.organizationId
    || subscription.branchId !== message.branchId
    || subscription.senderId !== message.senderId
    || subscription.phoneE164 !== message.recipientPhoneE164
    || (message.trigger === "MANUAL"
      ? message.createdByUserId !== subscription.userId
      : message.createdByUserId !== null)
    || snapshot.organizationId !== message.organizationId
    || snapshot.branchId !== message.branchId
    || snapshot.scopeKey !== subscription.scopeKey
    || snapshot.metricsVersion !== WHATSAPP_REPORT_METRICS_VERSION
    || snapshot.scheduledCutoffAt.getTime() !== message.scheduledFor.getTime()
    || input.now.getTime() < snapshot.scheduledCutoffAt.getTime()
    || input.now.getTime() >= catchUpEndsAt.getTime()
    || message.availableAt.getTime() < snapshot.scheduledCutoffAt.getTime()
    || message.availableAt.getTime() >= catchUpEndsAt.getTime()
  ) return invalidReportSource("REPORT_TRUST_WINDOW_EXPIRED");

  const scopeInput: WhatsAppReportScopeInput = expectedScope === "BRANCH"
    ? { scope: "BRANCH", branchId: message.branchId! }
    : { scope: "ORGANIZATION", organizationId: message.organizationId };
  let authorized: AuthorizedReportScope;
  let delivery: Awaited<ReturnType<typeof resolveReportDeliveryState>>;
  try {
    assertWhatsAppReportsEnabled(input.env);
    assertWhatsAppMessageWritesEnabled(message.organizationId, input.env);
    if (
      message.trigger === "AUTOMATION"
      && !isWhatsAppLiveAutomationOrganizationEnabled(message.organizationId, input.env)
    ) return invalidReportSource("REPORT_AUTOMATION_DISABLED");
    authorized = await authorizeReportScope({
      actorUserId: subscription.userId,
      scope: scopeInput,
      client: input.tx,
      writable: true,
    });
    delivery = await resolveReportDeliveryState({
      client: input.tx,
      scope: authorized,
      requireEnabled: true,
      env: input.env,
    });
  } catch {
    return invalidReportSource("REPORT_AUTHORIZATION_CHANGED");
  }
  if (
    authorized.organizationId !== message.organizationId
    || authorized.branchId !== message.branchId
    || authorized.scopeKey !== subscription.scopeKey
    || authorized.timeZone !== snapshot.timeZone
    || delivery.sender.id !== message.senderId
    || message.sender.organizationId !== message.organizationId
    || message.sender.provider !== "META_CLOUD"
    || message.sender.providerMode !== resolveWhatsAppProviderMode(input.env)
    || message.sender.status !== "ACTIVE"
    || message.sender.safetyState?.pausedAt
    || message.sender.safetyState?.pauseRequestedAt
    || !Number.isSafeInteger(delivery.configurationRevision)
    || delivery.configurationRevision < 1
    || delivery.configurationRevision !== message.settingsRevision
  ) return invalidReportSource("REPORT_DELIVERY_CHANGED");

  if (
    subscription.status !== "ACTIVE"
    || !subscription.activatedAt
    || subscription.activatedAt.getTime() > snapshot.scheduledCutoffAt.getTime()
    || !subscription.consent
    || subscription.consentId !== subscription.consent.id
    || subscription.consent.senderId !== message.senderId
    || subscription.consent.phoneE164 !== message.recipientPhoneE164
    || subscription.consent.consentType !== "OWNER_REPORT"
    || subscription.consent.status !== "OPTED_IN"
    || subscription.consent.policyVersion !== WHATSAPP_OWNER_REPORT_CONSENT_POLICY_VERSION
  ) return invalidReportSource("REPORT_CONSENT_CHANGED");

  let expectedSnapshotSource: string;
  let expectedLocalScheduleDate: Date;
  let currentSubscriptionCutoff: Date;
  let expectedAsOfLocalTime: string;
  let metrics: WhatsAppReportMetrics;
  try {
    expectedSnapshotSource = createWhatsAppReportSourceFingerprint({
      scope: expectedScope,
      scopeKey: snapshot.scopeKey,
      localReportDate: snapshot.localReportDate,
      scheduledCutoffAt: snapshot.scheduledCutoffAt,
      metricsAsOfAt: snapshot.metricsAsOfAt,
      metricsVersion: snapshot.metricsVersion,
    });
    expectedLocalScheduleDate = utcReportLocalDate(
      getWhatsAppLocalDateParts(snapshot.scheduledCutoffAt, snapshot.timeZone)
    );
    currentSubscriptionCutoff = scheduleWhatsAppReportForLocalDate({
      localDate: getWhatsAppLocalDateParts(snapshot.scheduledCutoffAt, snapshot.timeZone),
      sendTimeLocal: subscription.sendTimeLocal,
      timeZone: snapshot.timeZone,
    });
    assertTrustworthyReportMetricsAsOf({
      scheduledCutoffAt: snapshot.scheduledCutoffAt,
      metricsAsOfAt: snapshot.metricsAsOfAt,
      timeZone: snapshot.timeZone,
    });
    const asOf = getWhatsAppLocalDateTimeParts(
      snapshot.metricsAsOfAt,
      snapshot.timeZone
    );
    expectedAsOfLocalTime = `${String(asOf.hour).padStart(2, "0")}:${String(
      asOf.minute
    ).padStart(2, "0")}`;
    metrics = canonicalizeWhatsAppReportMetrics(snapshot.metrics);
  } catch {
    return invalidReportSource("REPORT_METRICS_UNAVAILABLE");
  }
  if (
    snapshot.sourceFingerprint !== expectedSnapshotSource
    || hashWhatsAppReportMetrics(metrics) !== snapshot.metricsHash
    || (expectedScope === "BRANCH") !== ("branchName" in metrics)
    || metrics.localReportDate !== snapshot.localReportDate
    || metrics.metricsAsOfAt !== snapshot.metricsAsOfAt.toISOString()
    || snapshot.localReportDate !== expectedLocalScheduleDate.toISOString().slice(0, 10)
    || currentSubscriptionCutoff.getTime() !== snapshot.scheduledCutoffAt.getTime()
    || metrics.asOfLocalTime !== expectedAsOfLocalTime
    || snapshot.generatedAt.getTime() !== snapshot.metricsAsOfAt.getTime()
    || snapshot.metricsAsOfAt.getTime() > input.now.getTime()
    || message.localScheduleDate.getTime() !== expectedLocalScheduleDate.getTime()
  ) return invalidReportSource("REPORT_METRICS_UNAVAILABLE");

  let language: WhatsAppManagedTemplateLanguage;
  try {
    language = normalizeReportLanguage(subscription.language);
  } catch {
    return invalidReportSource();
  }
  let currentBinding: Awaited<ReturnType<typeof resolveReportBinding>>;
  try {
    currentBinding = await resolveReportBinding({
      client: input.tx,
      senderId: message.senderId,
      scope: expectedScope,
      language,
    });
  } catch {
    return invalidReportSource("REPORT_TEMPLATE_UNAVAILABLE");
  }
  if (
    currentBinding.binding.id !== message.templateBindingId
    || currentBinding.binding.templateId !== message.templateId
    || currentBinding.binding.template.version !== message.templateVersion
    || currentBinding.managedKey !== message.managedTemplateKey
    || currentBinding.definition.catalogVersion !== message.catalogVersion
    || currentBinding.definition.catalogHash !== message.catalogHash
    || message.templateBinding.id !== currentBinding.binding.id
  ) return invalidReportSource("REPORT_TEMPLATE_UNAVAILABLE");

  const values = reportTemplateValues(metrics);
  const storedValues = reportJsonRecord(message.templateVariables);
  if (!storedValues || !sameReportValues(storedValues, values)) {
    return invalidReportSource();
  }
  let prepared: ReturnType<typeof prepareManagedWhatsAppTemplate>;
  try {
    prepared = prepareManagedWhatsAppTemplate(currentBinding.definition, values);
  } catch {
    return invalidReportSource();
  }
  const expectedMessageSource = reportMessageSourceFingerprint({
    organizationId: message.organizationId,
    branchId: message.branchId,
    scope: expectedScope,
    snapshotSourceFingerprint: snapshot.sourceFingerprint,
    metricsHash: snapshot.metricsHash,
    subscriptionId: subscription.id,
    senderId: message.senderId,
    recipientPhoneE164: message.recipientPhoneE164,
    settingsRevision: message.settingsRevision,
    templateBindingId: currentBinding.binding.id,
    templateId: currentBinding.binding.templateId,
    templateVersion: currentBinding.binding.template.version,
    managedTemplateKey: currentBinding.managedKey,
    language,
    templateVariables: values,
    catalogVersion: currentBinding.definition.catalogVersion,
    catalogHash: currentBinding.definition.catalogHash,
  });
  if (
    expectedMessageSource !== message.sourceFingerprint
    || reportDedupeKey({
      senderId: message.senderId,
      subscriptionId: subscription.id,
      localReportDate: snapshot.localReportDate,
      scheduledCutoffAt: snapshot.scheduledCutoffAt,
    }) !== message.dedupeKey
    || prepared.renderedPreview !== message.renderedPreview
    || message.budgetState !== "RESERVED"
    || !message.budgetMonth
    || !message.rateCardVersion
    || message.estimatedCostMicros === null
  ) return invalidReportSource();

  let rateCard: ReturnType<typeof resolveWhatsAppUtilityRate>;
  try {
    rateCard = resolveWhatsAppUtilityRate({
      recipientPhoneE164: message.recipientPhoneE164,
      at: input.now,
      env: input.env,
    });
  } catch {
    return invalidReportSource("REPORT_RATE_UNAVAILABLE");
  }
  try {
    if (
      rateCard.version !== message.rateCardVersion
      || BigInt(rateCard.rateMicros) !== message.estimatedCostMicros
      || message.currency !== rateCard.currency
      || message.budgetMonth !== whatsappBudgetMonth(
        snapshot.scheduledCutoffAt,
        snapshot.timeZone
      )
    ) return invalidReportSource("REPORT_RATE_CHANGED");
  } catch {
    return invalidReportSource("REPORT_RATE_CHANGED");
  }

  let budgetMinor: number;
  try {
    budgetMinor = validateWhatsAppMonthlyBudgetMinor(delivery.monthlyBudgetMinor);
  } catch {
    return invalidReportSource("REPORT_BUDGET_INVALID");
  }
  const budgetAggregate = await input.tx.whatsAppMessage.aggregate({
    where: expectedScope === "BRANCH"
      ? {
          branchId: message.branchId!,
          budgetMonth: message.budgetMonth,
          budgetState: { in: ["RESERVED", "COMMITTED"] },
        }
      : {
          organizationId: message.organizationId,
          branchId: null,
          purpose: "DAILY_ORGANIZATION_REPORT",
          budgetMonth: message.budgetMonth,
          budgetState: { in: ["RESERVED", "COMMITTED"] },
        },
    _sum: { estimatedCostMicros: true },
  });
  if (
    (budgetAggregate._sum.estimatedCostMicros ?? 0n)
    > BigInt(paiseToInrMicros(budgetMinor))
  ) return invalidReportSource("REPORT_BUDGET_EXCEEDED");

  if (expectedScope === "BRANCH") {
    if (
      delivery.dailyAutomaticMessageLimit === null
      || !Number.isSafeInteger(delivery.dailyAutomaticMessageLimit)
      || delivery.dailyAutomaticMessageLimit < 1
      || delivery.dailyAutomaticMessageLimit > 200
      || await branchDailyAutomaticUsage({
        tx: input.tx,
        branchId: message.branchId!,
        localScheduleDate: message.localScheduleDate,
      }) > delivery.dailyAutomaticMessageLimit
    ) return invalidReportSource("REPORT_DAILY_LIMIT_EXCEEDED");
  }
  return { valid: true, language };
}
