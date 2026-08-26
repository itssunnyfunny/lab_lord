import { randomUUID } from "node:crypto";

import { Prisma, type WhatsAppProviderMode } from "@/app/generated/prisma/client";
import {
  getMetaWhatsAppClient,
  MetaWhatsAppProviderError,
  readMetaWhatsAppConfiguration,
  type MetaWhatsAppProviderClient,
} from "@/lib/metaWhatsApp";
import { prisma } from "@/lib/prisma";
import {
  configuredWhatsAppHealthCanaryOrganizationIds,
  isWhatsAppHealthReconciliationEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  getManagedWhatsAppTemplate,
  hasCompleteManagedWhatsAppTemplateCatalog,
  hashWhatsAppTemplateComponents,
  WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
  WhatsAppManagedTemplateError,
} from "@/lib/whatsappManagedTemplates";
import { WhatsAppValidationError } from "@/lib/whatsappHttp";
import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";
import { WhatsAppJobRunService, type WhatsAppJobCounts } from "@/services/whatsappJobRun.service";
import { WhatsAppSenderSafetyService } from "@/services/whatsappSenderSafety.service";
import type { MetaMessageTemplate, MetaPhoneNumber, MetaWaba } from "@/types/whatsapp";

export const WHATSAPP_HEALTH_BATCH_LIMIT = 10;
export const WHATSAPP_HEALTH_LEASE_MS = 2 * 60 * 1_000;
export const WHATSAPP_HEALTH_READ_TIMEOUT_MS = 15_000;
export const WHATSAPP_WEBHOOK_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1_000;
export const WHATSAPP_WEBHOOK_ACTIVITY_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
export const WHATSAPP_HEALTH_ELIGIBLE_SENDER_STATUSES = [
  "ACTIVE",
  "RESTRICTED",
] as const;

export const WHATSAPP_HEALTH_PROVIDER_READ_METHODS = [
  "fetchWaba",
  "fetchPhoneNumber",
  "listSubscribedApps",
  "listMessageTemplates",
] as const satisfies readonly (keyof MetaWhatsAppProviderClient)[];

export type WhatsAppHealthProvider = Pick<
  MetaWhatsAppProviderClient,
  (typeof WHATSAPP_HEALTH_PROVIDER_READ_METHODS)[number]
>;

type ClaimedSender = {
  id: string;
  organizationId: string;
  providerMode: WhatsAppProviderMode;
  wabaId: string;
  phoneNumberId: string;
  status: string;
  healthLeaseToken: string;
  lastWebhookReceivedAt: Date | null;
};

type ProviderHealthSnapshot = {
  waba: MetaWaba;
  phone: MetaPhoneNumber;
  appSubscribed: boolean;
  templates: MetaMessageTemplate[];
  restrictionCode: string | null;
};

function boundedBatchSize(value: number | undefined) {
  const batchSize = value ?? WHATSAPP_HEALTH_BATCH_LIMIT;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > WHATSAPP_HEALTH_BATCH_LIMIT) {
    throw new WhatsAppValidationError();
  }
  return batchSize;
}

function boundedToken(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._:-]{0,63}$/.test(normalized) ? normalized : "UNKNOWN";
}

function normalizeCategory(value: string) {
  const normalized = boundedToken(value);
  return normalized === "AUTHENTICATION"
    || normalized === "MARKETING"
    || normalized === "UTILITY"
    ? normalized
    : "UNKNOWN";
}

function normalizeTemplateStatus(value: string) {
  const normalized = boundedToken(value);
  return normalized === "APPROVED"
    || normalized === "PENDING"
    || normalized === "REJECTED"
    || normalized === "PAUSED"
    || normalized === "DISABLED"
    ? normalized
    : "UNKNOWN";
}

function validateProviderTemplates(templates: MetaMessageTemplate[]) {
  if (templates.length > 2_000) throw new WhatsAppValidationError();
  const providerIds = new Set<string>();
  const identities = new Set<string>();
  return templates.map(template => {
    if (
      !/^[0-9]{1,64}$/.test(template.id)
      || template.name.length < 1
      || template.name.length > 512
      || !/^[A-Za-z0-9_-]{1,64}$/.test(template.language)
      || !Array.isArray(template.components)
      || template.components.length > 100
      || Buffer.byteLength(JSON.stringify(template.components), "utf8") > 65_536
    ) throw new WhatsAppValidationError();
    const identity = `${template.name}\u0000${template.language}`;
    if (providerIds.has(template.id) || identities.has(identity)) {
      throw new WhatsAppValidationError();
    }
    providerIds.add(template.id);
    identities.add(identity);
    return {
      providerTemplateId: template.id,
      name: template.name,
      language: template.language,
      category: normalizeCategory(template.category),
      providerStatus: normalizeTemplateStatus(template.status),
      components: template.components as Prisma.InputJsonArray,
      componentHash: hashWhatsAppTemplateComponents(template.components),
    } as const;
  });
}

function phoneRestrictionCode(phone: MetaPhoneNumber, appSubscribed: boolean) {
  if (!appSubscribed) return "APP_SUBSCRIPTION_MISSING";
  const registration = boundedToken(phone.registrationStatus);
  const status = boundedToken(phone.status);
  const quality = boundedToken(phone.qualityRating);
  const healthyRegistration = new Set(["CONNECTED", "REGISTERED", "VERIFIED", "MIGRATED"]);
  if (!registration || !healthyRegistration.has(registration)) return "PHONE_REGISTRATION_UNSAFE";
  if (status && !healthyRegistration.has(status)) return "PHONE_STATUS_UNSAFE";
  if (!quality || quality === "UNKNOWN" || quality === "NA" || quality === "RED") {
    return "PHONE_QUALITY_UNSAFE";
  }
  return null;
}

function safeHealthErrorCode(error: unknown) {
  if (error instanceof MetaWhatsAppProviderError) {
    if (error.kind === "RATE_LIMIT") return "HEALTH_RATE_LIMIT";
    if (error.kind === "TIMEOUT") return "HEALTH_TIMEOUT";
    if (error.kind === "AUTHENTICATION") return "HEALTH_AUTHENTICATION_FAILED";
    if (error.kind === "NOT_FOUND") return "HEALTH_ASSET_NOT_FOUND";
    if (error.kind === "NETWORK") return "HEALTH_NETWORK_FAILED";
    return "HEALTH_PROVIDER_FAILED";
  }
  if (error instanceof Error && error.name === "WhatsAppHealthReadTimeoutError") {
    return "HEALTH_TIMEOUT";
  }
  return "HEALTH_RECONCILIATION_FAILED";
}

async function withReadTimeout<T>(operation: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("Provider health read timed out");
          error.name = "WhatsAppHealthReadTimeoutError";
          reject(error);
        }, WHATSAPP_HEALTH_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function claimNextSender(input: {
  mode: WhatsAppProviderMode;
  allowedOrganizationIds: readonly string[] | null;
  excludedSenderIds: readonly string[];
  startedAt: Date;
  now: Date;
}): Promise<ClaimedSender | null> {
  return prisma.$transaction(async tx => {
    const sender = await tx.whatsAppSender.findFirst({
      where: {
        provider: "META_CLOUD",
        providerMode: input.mode,
        // Health reconciliation must not complete onboarding. PENDING,
        // NEEDS_REGISTRATION, and ERROR senders require the owner-controlled
        // onboarding checks (including foundational system-user access).
        status: { in: [...WHATSAPP_HEALTH_ELIGIBLE_SENDER_STATUSES] },
        ...(input.allowedOrganizationIds
          ? { organizationId: { in: [...input.allowedOrganizationIds] } }
          : {}),
        ...(input.excludedSenderIds.length > 0
          ? { id: { notIn: [...input.excludedSenderIds] } }
          : {}),
        OR: [{ healthLeaseUntil: null }, { healthLeaseUntil: { lt: input.now } }],
        AND: [{
          OR: [
            { lastHealthCheckAt: null },
            { lastHealthCheckAt: { lt: input.startedAt } },
          ],
        }],
      },
      orderBy: [{ lastHealthCheckAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        organizationId: true,
        providerMode: true,
        wabaId: true,
        phoneNumberId: true,
        status: true,
        lastWebhookReceivedAt: true,
      },
    });
    if (!sender) return null;
    const healthLeaseToken = randomUUID();
    const claimed = await tx.whatsAppSender.updateMany({
      where: {
        id: sender.id,
        providerMode: input.mode,
        OR: [{ healthLeaseUntil: null }, { healthLeaseUntil: { lt: input.now } }],
      },
      data: {
        healthLeaseToken,
        healthLeaseUntil: new Date(input.now.getTime() + WHATSAPP_HEALTH_LEASE_MS),
      },
    });
    if (claimed.count !== 1) return null;
    return { ...sender, healthLeaseToken };
  });
}

async function readProviderHealth(input: {
  sender: ClaimedSender;
  provider: WhatsAppHealthProvider;
  systemUserAccessToken: string;
  appId: string;
}) {
  const [waba, phone, subscribedApps, templates] = await Promise.all([
    withReadTimeout(input.provider.fetchWaba({
      wabaId: input.sender.wabaId,
      accessToken: input.systemUserAccessToken,
    })),
    withReadTimeout(input.provider.fetchPhoneNumber({
      wabaId: input.sender.wabaId,
      phoneNumberId: input.sender.phoneNumberId,
      accessToken: input.systemUserAccessToken,
    })),
    withReadTimeout(input.provider.listSubscribedApps({ wabaId: input.sender.wabaId })),
    withReadTimeout(input.provider.listMessageTemplates({ wabaId: input.sender.wabaId })),
  ]);
  if (
    waba.id !== input.sender.wabaId
    || phone.id !== input.sender.phoneNumberId
    || phone.wabaId !== input.sender.wabaId
  ) throw new WhatsAppValidationError();
  const appSubscribed = subscribedApps.some(app => app.id === input.appId);
  validateProviderTemplates(templates);
  return {
    waba,
    phone,
    appSubscribed,
    templates,
    restrictionCode: phoneRestrictionCode(phone, appSubscribed),
  } satisfies ProviderHealthSnapshot;
}

async function reconcileProviderTemplates(input: {
  tx: Prisma.TransactionClient;
  senderId: string;
  templates: MetaMessageTemplate[];
  now: Date;
}) {
  const normalized = validateProviderTemplates(input.templates);
  const existing = await input.tx.whatsAppTemplate.findMany({
    where: { senderId: input.senderId },
  });
  const byProviderId = new Map(existing.map(item => [item.providerTemplateId, item]));
  const byIdentity = new Map(existing.map(item => [`${item.name}\u0000${item.language}`, item]));
  const providerIds = new Set(normalized.map(item => item.providerTemplateId));
  let templatesChanged = 0;
  for (const template of normalized) {
    const providerMatch = byProviderId.get(template.providerTemplateId);
    const identityMatch = byIdentity.get(`${template.name}\u0000${template.language}`);
    if (providerMatch && identityMatch && providerMatch.id !== identityMatch.id) {
      throw new WhatsAppValidationError();
    }
    const target = providerMatch ?? identityMatch;
    if (target) {
      const changed = target.providerTemplateId !== template.providerTemplateId
        || target.name !== template.name
        || target.language !== template.language
        || target.category !== template.category
        || target.providerStatus !== template.providerStatus
        || target.componentHash !== template.componentHash
        || target.staleAt !== null;
      await input.tx.whatsAppTemplate.update({
        where: { id: target.id },
        data: {
          ...template,
          version: changed ? { increment: 1 } : target.version,
          lastSyncedAt: input.now,
          staleAt: null,
        },
      });
      if (changed) templatesChanged += 1;
    } else {
      await input.tx.whatsAppTemplate.create({
        data: { senderId: input.senderId, ...template, lastSyncedAt: input.now },
      });
      templatesChanged += 1;
    }
  }
  const stale = await input.tx.whatsAppTemplate.updateMany({
    where: {
      senderId: input.senderId,
      providerTemplateId: { notIn: [...providerIds] },
      staleAt: null,
    },
    data: { staleAt: input.now },
  });
  templatesChanged += stale.count;

  const [provisionings, synchronized] = await Promise.all([
    input.tx.whatsAppManagedTemplateProvisioning.findMany({
      where: { senderId: input.senderId, status: { not: "CREATING" } },
    }),
    input.tx.whatsAppTemplate.findMany({ where: { senderId: input.senderId } }),
  ]);
  const synchronizedById = new Map(synchronized.map(item => [item.providerTemplateId, item]));
  const synchronizedByIdentity = new Map(
    synchronized.map(item => [`${item.name}\u0000${item.language}`, item])
  );
  let bindingsDeactivated = 0;
  for (const provisioning of provisionings) {
    let definition;
    try {
      definition = getManagedWhatsAppTemplate(
        provisioning.managedKey,
        provisioning.language as never,
        provisioning.catalogVersion
      );
    } catch (error) {
      if (!(error instanceof WhatsAppManagedTemplateError)) throw error;
      const deactivated = await input.tx.whatsAppTemplateBinding.updateMany({
        where: { provisioningId: provisioning.id, active: true },
        data: { active: false },
      });
      bindingsDeactivated += deactivated.count;
      continue;
    }
    const template = provisioning.providerTemplateId
      ? synchronizedById.get(provisioning.providerTemplateId)
        ?? synchronizedByIdentity.get(`${definition.providerTemplateName}\u0000${definition.language}`)
      : synchronizedByIdentity.get(`${definition.providerTemplateName}\u0000${definition.language}`);
    const exact = Boolean(
      template
      && template.name === definition.providerTemplateName
      && template.language === definition.language
      && template.staleAt === null
      && template.componentHash === hashWhatsAppTemplateComponents(definition.components)
      && provisioning.catalogHash === definition.catalogHash
    );
    const ready = Boolean(
      exact
      && template?.providerStatus === "APPROVED"
      && template.category === "UTILITY"
    );
    const nextStatus = ready
      ? "READY" as const
      : exact && template?.providerStatus === "PENDING"
        ? "WAITING_APPROVAL" as const
        : exact && template?.providerStatus === "REJECTED"
          ? "REJECTED" as const
          : "FAILED" as const;
    await input.tx.whatsAppManagedTemplateProvisioning.update({
      where: { id: provisioning.id },
      data: {
        providerTemplateId: template?.providerTemplateId ?? provisioning.providerTemplateId,
        status: nextStatus,
        lastErrorCode: ready || nextStatus === "WAITING_APPROVAL"
          ? null
          : nextStatus === "REJECTED"
            ? "PROVIDER_TEMPLATE_REJECTED"
            : !exact
              ? "PROVIDER_TEMPLATE_MISMATCH"
              : template?.category !== "UTILITY"
                ? "PROVIDER_CATEGORY_NOT_UTILITY"
                : "PROVIDER_TEMPLATE_INACTIVE",
      },
    });
    const currentBinding = await input.tx.whatsAppTemplateBinding.findUnique({
      where: { provisioningId: provisioning.id },
    });
    if (exact && template) {
      await input.tx.whatsAppTemplateBinding.upsert({
        where: {
          senderId_managedKey_language: {
            senderId: input.senderId,
            managedKey: definition.managedKey,
            language: definition.language,
          },
        },
        create: {
          senderId: input.senderId,
          templateId: template.id,
          provisioningId: provisioning.id,
          managedKey: definition.managedKey,
          language: definition.language,
          catalogVersion: definition.catalogVersion,
          catalogHash: definition.catalogHash,
          active: ready,
        },
        update: {
          templateId: template.id,
          provisioningId: provisioning.id,
          catalogVersion: definition.catalogVersion,
          catalogHash: definition.catalogHash,
          active: ready,
        },
      });
      if (currentBinding?.active && !ready) bindingsDeactivated += 1;
    } else {
      const deactivated = await input.tx.whatsAppTemplateBinding.updateMany({
        where: { provisioningId: provisioning.id, active: true },
        data: { active: false },
      });
      bindingsDeactivated += deactivated.count;
    }
  }

  const invalidBindings = await input.tx.whatsAppTemplateBinding.findMany({
    where: { senderId: input.senderId, active: false },
    select: { id: true },
  });
  const invalidIds = invalidBindings.map(item => item.id);
  let messagesSuppressed = 0;
  if (invalidIds.length > 0) {
    const reserved = await input.tx.whatsAppMessage.updateMany({
      where: {
        senderId: input.senderId,
        templateBindingId: { in: invalidIds },
        budgetState: "RESERVED",
        OR: [{ status: "SCHEDULED" }, { status: "CLAIMED", submissionStartedAt: null }],
      },
      data: {
        status: "SUPPRESSED",
        suppressedAt: input.now,
        failureCode: "TEMPLATE_UNAVAILABLE",
        budgetState: "RELEASED",
        leaseToken: null,
        leaseUntil: null,
      },
    });
    const unreserved = await input.tx.whatsAppMessage.updateMany({
      where: {
        senderId: input.senderId,
        templateBindingId: { in: invalidIds },
        budgetState: { not: "RESERVED" },
        OR: [{ status: "SCHEDULED" }, { status: "CLAIMED", submissionStartedAt: null }],
      },
      data: {
        status: "SUPPRESSED",
        suppressedAt: input.now,
        failureCode: "TEMPLATE_UNAVAILABLE",
        leaseToken: null,
        leaseUntil: null,
      },
    });
    messagesSuppressed = reserved.count + unreserved.count;
  }
  const currentProvisionings = await input.tx.whatsAppManagedTemplateProvisioning.findMany({
    where: {
      senderId: input.senderId,
      catalogVersion: WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
    },
    select: {
      managedKey: true,
      language: true,
      catalogVersion: true,
      status: true,
    },
  });
  const activeBindings = await input.tx.whatsAppTemplateBinding.findMany({
    where: {
      senderId: input.senderId,
      active: true,
      catalogVersion: WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
      template: { providerStatus: "APPROVED", category: "UTILITY", staleAt: null },
    },
    select: { managedKey: true, language: true, catalogVersion: true },
  });
  const completeProvisioningCatalog = hasCompleteManagedWhatsAppTemplateCatalog(
    currentProvisionings
  );
  return {
    templatesFetched: normalized.length,
    templatesChanged,
    bindingsDeactivated,
    messagesSuppressed,
    templatesHealthy: completeProvisioningCatalog
      && currentProvisionings.every(item => item.status === "READY")
      && hasCompleteManagedWhatsAppTemplateCatalog(activeBindings),
  };
}

async function finalizeHealthSuccess(input: {
  sender: ClaimedSender;
  snapshot: ProviderHealthSnapshot;
  now: Date;
}) {
  return prisma.$transaction(async tx => {
    const sender = await tx.whatsAppSender.findFirst({
      where: {
        id: input.sender.id,
        organizationId: input.sender.organizationId,
        providerMode: input.sender.providerMode,
        wabaId: input.sender.wabaId,
        phoneNumberId: input.sender.phoneNumberId,
        healthLeaseToken: input.sender.healthLeaseToken,
        status: { in: [...WHATSAPP_HEALTH_ELIGIBLE_SENDER_STATUSES] },
      },
      include: { safetyState: true },
    });
    if (!sender) return { stale: true as const };
    const templateResult = await reconcileProviderTemplates({
      tx,
      senderId: sender.id,
      templates: input.snapshot.templates,
      now: input.now,
    });
    const restricted = input.snapshot.restrictionCode !== null;
    await tx.whatsAppSender.update({
      where: { id: sender.id },
      data: {
        verifiedName: input.snapshot.phone.verifiedName,
        qualityRating: boundedToken(input.snapshot.phone.qualityRating),
        accountMode: boundedToken(input.snapshot.waba.accountMode),
        providerRegistrationStatus: boundedToken(input.snapshot.phone.registrationStatus),
        providerRestrictionCode: input.snapshot.restrictionCode,
        status: restricted ? "RESTRICTED" : "ACTIVE",
        lastHealthCheckAt: input.now,
        lastSyncedAt: input.now,
        lastTemplateSyncAt: input.now,
        lastErrorCode: null,
        healthLeaseToken: null,
        healthLeaseUntil: null,
      },
    });
    await tx.whatsAppSenderSafetyState.upsert({
      where: { senderId: sender.id },
      create: {
        senderId: sender.id,
        lastHealthCheckAt: input.now,
        ...(!restricted ? { lastHealthyAt: input.now } : {}),
      },
      update: {
        lastHealthCheckAt: input.now,
        // Freshness proves that the bounded provider reads succeeded and that
        // the sender is unrestricted. Resume separately checks only templates
        // required by queued work and currently enabled configuration.
        ...(!restricted ? { lastHealthyAt: input.now } : {}),
      },
    });
    if (restricted) {
      await WhatsAppSenderSafetyService.pauseForProviderRestrictionInTransaction({
        tx,
        organizationId: sender.organizationId,
        senderId: sender.id,
        now: input.now,
      });
      await WhatsAppIncidentService.createOrTouchInTransaction({
        tx,
        organizationId: sender.organizationId,
        senderId: sender.id,
        type: "SENDER_RESTRICTED",
        severity: "CRITICAL",
        dedupeKey: `sender:${sender.id}:provider-restricted`,
        safeCode: input.snapshot.restrictionCode!,
        details: { appSubscribed: input.snapshot.appSubscribed },
        now: input.now,
      });
    } else {
      await WhatsAppIncidentService.resolveInTransaction({
        tx,
        dedupeKey: `sender:${sender.id}:provider-restricted`,
        resolutionCode: "PROVIDER_HEALTHY",
        now: input.now,
      });
    }
    if (!templateResult.templatesHealthy) {
      await WhatsAppIncidentService.createOrTouchInTransaction({
        tx,
        organizationId: sender.organizationId,
        senderId: sender.id,
        type: "TEMPLATE_UNAVAILABLE",
        severity: "WARNING",
        dedupeKey: `sender:${sender.id}:templates-unhealthy`,
        safeCode: "TEMPLATES_UNHEALTHY",
        details: {
          bindingsDeactivated: templateResult.bindingsDeactivated,
          messagesSuppressed: templateResult.messagesSuppressed,
        },
        now: input.now,
      });
    } else {
      await WhatsAppIncidentService.resolveInTransaction({
        tx,
        dedupeKey: `sender:${sender.id}:templates-unhealthy`,
        resolutionCode: "TEMPLATES_HEALTHY",
        now: input.now,
      });
    }
    const lastAcceptedAt = sender.safetyState?.lastAcceptedAt ?? null;
    const expectedWebhook = lastAcceptedAt
      && input.now.getTime() - lastAcceptedAt.getTime() >= WHATSAPP_WEBHOOK_STALE_THRESHOLD_MS
      && input.now.getTime() - lastAcceptedAt.getTime() <= WHATSAPP_WEBHOOK_ACTIVITY_LOOKBACK_MS
      && (!sender.lastWebhookReceivedAt
        || sender.lastWebhookReceivedAt.getTime() < lastAcceptedAt.getTime());
    if (expectedWebhook) {
      await WhatsAppIncidentService.createOrTouchInTransaction({
        tx,
        organizationId: sender.organizationId,
        senderId: sender.id,
        type: "WEBHOOK_STALE",
        severity: "WARNING",
        dedupeKey: `sender:${sender.id}:webhook-stale`,
        safeCode: "EXPECTED_WEBHOOK_MISSING",
        details: { expectedRecentActivity: true },
        now: input.now,
      });
    } else {
      await WhatsAppIncidentService.resolveInTransaction({
        tx,
        dedupeKey: `sender:${sender.id}:webhook-stale`,
        resolutionCode: "WEBHOOK_EVIDENCE_CURRENT",
        now: input.now,
      });
    }
    return {
      stale: false as const,
      restricted,
      ...templateResult,
    };
  });
}

async function finalizeHealthFailure(input: {
  sender: ClaimedSender;
  now: Date;
  safeErrorCode: string;
}) {
  return prisma.$transaction(async tx => {
    const current = await tx.whatsAppSender.findFirst({
      where: {
        id: input.sender.id,
        organizationId: input.sender.organizationId,
        healthLeaseToken: input.sender.healthLeaseToken,
      },
      select: { id: true },
    });
    if (!current) return false;
    await tx.whatsAppSender.update({
      where: { id: current.id },
      data: {
        lastHealthCheckAt: input.now,
        lastErrorCode: input.safeErrorCode,
        healthLeaseToken: null,
        healthLeaseUntil: null,
      },
    });
    await tx.whatsAppSenderSafetyState.upsert({
      where: { senderId: current.id },
      create: { senderId: current.id, lastHealthCheckAt: input.now },
      update: { lastHealthCheckAt: input.now },
    });
    return true;
  });
}

function replayResult(run: {
  status: string;
  counts: unknown;
  safeErrorCode: string | null;
}) {
  return {
    held: run.status === "HELD",
    replayed: true as const,
    status: run.status,
    counts: run.counts,
    safeErrorCode: run.safeErrorCode,
  };
}

export class WhatsAppHealthService {
  static async run(input: {
    invocationId: string;
    batchSize?: number;
    now?: Date;
    env?: Readonly<Record<string, string | undefined>>;
    provider?: WhatsAppHealthProvider;
  }) {
    if (!isWhatsAppHealthReconciliationEnabled(input.env)) {
      return { held: true as const, replayed: false as const, status: "HELD" as const, counts: {} };
    }
    const now = input.now ?? new Date();
    const batchSize = boundedBatchSize(input.batchSize);
    const mode = resolveWhatsAppProviderMode(input.env);
    const started = await WhatsAppJobRunService.start({
      jobType: "HEALTH_RECONCILIATION",
      invocationId: input.invocationId,
      providerMode: mode,
      now,
    });
    if (!started.created) return replayResult(started.run);
    const counts: Record<string, number> = {
      sendersClaimed: 0,
      sendersHealthy: 0,
      sendersRestricted: 0,
      sendersFailed: 0,
      staleFinalizations: 0,
      templatesFetched: 0,
      templatesChanged: 0,
      bindingsDeactivated: 0,
      messagesSuppressed: 0,
    };
    try {
      const configuration = readMetaWhatsAppConfiguration(input.env);
      const provider = input.provider ?? getMetaWhatsAppClient();
      const allowedOrganizationIds = mode === "LIVE"
        ? [...configuredWhatsAppHealthCanaryOrganizationIds(input.env)]
        : null;
      const claimedIds: string[] = [];
      for (let index = 0; index < batchSize; index += 1) {
        const sender = await claimNextSender({
          mode,
          allowedOrganizationIds,
          excludedSenderIds: claimedIds,
          startedAt: started.run.startedAt,
          now: new Date(now.getTime() + index),
        });
        if (!sender) break;
        claimedIds.push(sender.id);
        counts.sendersClaimed += 1;
        try {
          const snapshot = await readProviderHealth({
            sender,
            provider,
            systemUserAccessToken: configuration.systemUserAccessToken,
            appId: configuration.appId,
          });
          const finalized = await finalizeHealthSuccess({ sender, snapshot, now: new Date() });
          if (finalized.stale) {
            counts.staleFinalizations += 1;
            continue;
          }
          if (finalized.restricted) counts.sendersRestricted += 1;
          else if (finalized.templatesHealthy) counts.sendersHealthy += 1;
          else counts.sendersFailed += 1;
          counts.templatesFetched += finalized.templatesFetched;
          counts.templatesChanged += finalized.templatesChanged;
          counts.bindingsDeactivated += finalized.bindingsDeactivated;
          counts.messagesSuppressed += finalized.messagesSuppressed;
        } catch (error) {
          counts.sendersFailed += 1;
          const finalized = await finalizeHealthFailure({
            sender,
            now: new Date(),
            safeErrorCode: safeHealthErrorCode(error),
          });
          if (!finalized) counts.staleFinalizations += 1;
        }
      }
      const status = counts.sendersFailed > 0 || counts.staleFinalizations > 0
        ? "PARTIAL" as const
        : "SUCCEEDED" as const;
      await WhatsAppJobRunService.finish({
        runId: started.run.id,
        status,
        counts: counts as WhatsAppJobCounts,
        now: new Date(),
      });
      return { held: false as const, replayed: false as const, status, counts };
    } catch (error) {
      await WhatsAppJobRunService.finish({
        runId: started.run.id,
        status: "FAILED",
        counts: counts as WhatsAppJobCounts,
        safeErrorCode: safeHealthErrorCode(error),
        now: new Date(),
      });
      throw error;
    }
  }
}
