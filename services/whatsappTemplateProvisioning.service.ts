import { randomBytes } from "node:crypto";

import type {
  Prisma,
  WhatsAppManagedTemplateProvisioningStatus,
  WhatsAppTemplateCategory,
  WhatsAppTemplateProviderStatus,
} from "@/app/generated/prisma/client";
import {
  getMetaWhatsAppClient,
  META_GRAPH_MAX_TIMEOUT_MS,
  MetaWhatsAppAmbiguousMutationError,
  MetaWhatsAppProviderError,
} from "@/lib/metaWhatsApp";
import { prisma } from "@/lib/prisma";
import {
  assertWhatsAppIntegrationEnabled,
  assertWhatsAppTemplateWritesEnabled,
  isWhatsAppDeliverySchemaAccessEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  hashWhatsAppTemplateComponents,
  listManagedWhatsAppTemplates,
  resolveExactManagedWhatsAppTemplateDefinition,
  WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
  type WhatsAppManagedTemplateDefinition,
  type WhatsAppManagedTemplateLanguage,
} from "@/lib/whatsappManagedTemplates";
import {
  WhatsAppConflictError,
  WhatsAppProviderOperationError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { isWhatsAppDeliverySchemaReady } from "@/lib/whatsappSchema";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";
import type { MetaMessageTemplate } from "@/types/whatsapp";

const PROVISIONING_LEASE_MS = Math.max(2 * 60_000, META_GRAPH_MAX_TIMEOUT_MS * 2);
const MAX_PROVISIONING_ATTEMPTS = 5;

type PrismaClient = Prisma.TransactionClient | typeof prisma;

type ProvisioningClaim = {
  provisioningId: string;
  leaseToken: string;
  definition: WhatsAppManagedTemplateDefinition;
};

export type InstallManagedWhatsAppTemplatesInput = {
  actorUserId: string;
  organizationId: string;
  senderId: string;
  languages: readonly WhatsAppManagedTemplateLanguage[];
  catalogVersion: number;
};

export type GetManagedWhatsAppTemplateStatusInput = {
  actorUserId: string;
  organizationId: string;
  senderId: string;
};

function safeProvisioningErrorCode(value: string | null) {
  return value && /^[A-Z0-9_]{1,128}$/.test(value)
    ? value
    : value
      ? "PROVISIONING_ERROR"
      : null;
}

function normalizeTemplateCategory(value: string): WhatsAppTemplateCategory {
  const normalized = value.trim().toUpperCase();
  if (normalized === "AUTHENTICATION" || normalized === "MARKETING" || normalized === "UTILITY") {
    return normalized;
  }
  return "UNKNOWN";
}

function normalizeTemplateStatus(value: string): WhatsAppTemplateProviderStatus {
  const normalized = value.trim().toUpperCase();
  if (
    normalized === "APPROVED"
    || normalized === "PENDING"
    || normalized === "REJECTED"
    || normalized === "PAUSED"
    || normalized === "DISABLED"
  ) {
    return normalized;
  }
  return "UNKNOWN";
}

function safeProviderErrorCode(error: unknown) {
  if (error instanceof MetaWhatsAppAmbiguousMutationError) return "PROVIDER_RESULT_AMBIGUOUS";
  if (error instanceof MetaWhatsAppProviderError) {
    const suffix = error.providerCode === null ? "" : `_${error.providerCode}`;
    return `META_${error.kind}${suffix}`.slice(0, 128);
  }
  return "PROVIDER_OPERATION_FAILED";
}

function jsonComponents(components: readonly unknown[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(components)) as Prisma.InputJsonValue;
}

function templateContentMatches(
  providerTemplate: MetaMessageTemplate,
  definition: WhatsAppManagedTemplateDefinition
) {
  const canonical = resolveExactManagedWhatsAppTemplateDefinition(definition);
  return providerTemplate.name === canonical.providerTemplateName
    && providerTemplate.language === canonical.language
    && hashWhatsAppTemplateComponents(providerTemplate.components)
      === hashWhatsAppTemplateComponents(canonical.components);
}

function provisioningProjection(
  providerTemplate: MetaMessageTemplate,
  definition: WhatsAppManagedTemplateDefinition
): {
  compatible: boolean;
  status: WhatsAppManagedTemplateProvisioningStatus;
  errorCode: string | null;
} {
  if (!templateContentMatches(providerTemplate, definition)) {
    return { compatible: false, status: "FAILED", errorCode: "PROVIDER_TEMPLATE_MISMATCH" };
  }
  if (normalizeTemplateCategory(providerTemplate.category) !== "UTILITY") {
    return { compatible: false, status: "FAILED", errorCode: "PROVIDER_CATEGORY_NOT_UTILITY" };
  }
  const status = normalizeTemplateStatus(providerTemplate.status);
  if (status === "APPROVED") {
    return { compatible: true, status: "READY", errorCode: null };
  }
  if (status === "PENDING") {
    return { compatible: true, status: "WAITING_APPROVAL", errorCode: null };
  }
  if (status === "REJECTED") {
    return { compatible: true, status: "REJECTED", errorCode: "PROVIDER_TEMPLATE_REJECTED" };
  }
  return { compatible: true, status: "FAILED", errorCode: "PROVIDER_TEMPLATE_INACTIVE" };
}

async function assertCurrentSender(
  input: InstallManagedWhatsAppTemplatesInput,
  providerMode: "TEST" | "LIVE",
  client: PrismaClient
) {
  await WhatsAppAuthorizationService.assertOwnerCanWrite(
    input.actorUserId,
    input.organizationId,
    client
  );
  assertWhatsAppIntegrationEnabled();
  assertWhatsAppTemplateWritesEnabled(input.organizationId);
  if (resolveWhatsAppProviderMode() !== providerMode) throw new WhatsAppResourceNotFoundError();
  const sender = await client.whatsAppSender.findFirst({
    where: {
      id: input.senderId,
      organizationId: input.organizationId,
      provider: "META_CLOUD",
      providerMode,
      status: "ACTIVE",
    },
    select: { id: true, wabaId: true, providerMode: true },
  });
  if (!sender) throw new WhatsAppResourceNotFoundError();
  return sender;
}

async function findOrPersistProviderTemplate(
  tx: Prisma.TransactionClient,
  senderId: string,
  providerTemplate: MetaMessageTemplate,
  now: Date
) {
  const category = normalizeTemplateCategory(providerTemplate.category);
  const providerStatus = normalizeTemplateStatus(providerTemplate.status);
  const components = jsonComponents(providerTemplate.components);
  const componentHash = hashWhatsAppTemplateComponents(providerTemplate.components);
  const matches = await tx.whatsAppTemplate.findMany({
    where: {
      senderId,
      OR: [
        { providerTemplateId: providerTemplate.id },
        { name: providerTemplate.name, language: providerTemplate.language },
      ],
    },
  });
  const distinctMatches = new Map(matches.map(template => [template.id, template]));
  if (distinctMatches.size > 1) {
    throw new WhatsAppConflictError("Template registry identity conflict");
  }
  const existing = [...distinctMatches.values()][0];
  if (!existing) {
    return tx.whatsAppTemplate.create({
      data: {
        senderId,
        providerTemplateId: providerTemplate.id,
        name: providerTemplate.name,
        language: providerTemplate.language,
        category,
        providerStatus,
        components,
        componentHash,
        lastSyncedAt: now,
      },
    });
  }
  const changed = existing.providerTemplateId !== providerTemplate.id
    || existing.name !== providerTemplate.name
    || existing.language !== providerTemplate.language
    || existing.category !== category
    || existing.providerStatus !== providerStatus
    || existing.componentHash !== componentHash;
  return tx.whatsAppTemplate.update({
    where: { id: existing.id },
    data: {
      providerTemplateId: providerTemplate.id,
      name: providerTemplate.name,
      language: providerTemplate.language,
      category,
      providerStatus,
      components,
      componentHash,
      version: changed ? { increment: 1 } : existing.version,
      lastSyncedAt: now,
      staleAt: null,
    },
  });
}

export class WhatsAppTemplateProvisioningService {
  private static validateInput(input: InstallManagedWhatsAppTemplatesInput) {
    if (
      input.catalogVersion !== WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION
      || input.languages.length < 1
      || input.languages.length > 2
      || new Set(input.languages).size !== input.languages.length
    ) {
      throw new WhatsAppValidationError();
    }
    try {
      return listManagedWhatsAppTemplates({
        languages: input.languages,
        catalogVersion: input.catalogVersion,
      });
    } catch {
      throw new WhatsAppValidationError();
    }
  }

  private static async claim(
    input: InstallManagedWhatsAppTemplatesInput,
    definitions: readonly WhatsAppManagedTemplateDefinition[],
    providerMode: "TEST" | "LIVE"
  ) {
    const now = new Date();
    return prisma.$transaction(async tx => {
      const sender = await assertCurrentSender(input, providerMode, tx);
      const claims: ProvisioningClaim[] = [];
      for (const definition of definitions) {
        const row = await tx.whatsAppManagedTemplateProvisioning.upsert({
          where: {
            senderId_managedKey_language_catalogVersion: {
              senderId: sender.id,
              managedKey: definition.managedKey,
              language: definition.language,
              catalogVersion: definition.catalogVersion,
            },
          },
          create: {
            senderId: sender.id,
            managedKey: definition.managedKey,
            language: definition.language,
            catalogVersion: definition.catalogVersion,
            catalogHash: definition.catalogHash,
            providerTemplateName: definition.providerTemplateName,
          },
          update: {},
        });
        if (
          row.catalogHash !== definition.catalogHash
          || row.providerTemplateName !== definition.providerTemplateName
        ) {
          throw new WhatsAppConflictError("Managed template catalogue identity conflict");
        }
        if (row.status === "UNKNOWN") continue;
        if (row.status === "CREATING" && row.leaseUntil && row.leaseUntil > now) continue;
        if (row.attemptCount >= MAX_PROVISIONING_ATTEMPTS && row.status !== "READY") continue;

        const leaseToken = randomBytes(32).toString("base64url");
        const claimed = await tx.whatsAppManagedTemplateProvisioning.updateMany({
          where: {
            id: row.id,
            status: row.status,
            attemptCount: row.attemptCount,
            OR: [
              { leaseToken: null },
              { leaseUntil: null },
              { leaseUntil: { lte: now } },
            ],
          },
          data: {
            status: "CREATING",
            attemptCount: { increment: 1 },
            leaseToken,
            leaseUntil: new Date(now.getTime() + PROVISIONING_LEASE_MS),
            lastAttemptAt: now,
            lastErrorCode: null,
          },
        });
        if (claimed.count === 1) {
          claims.push({ provisioningId: row.id, leaseToken, definition });
        }
      }
      if (claims.length > 0) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: input.organizationId,
            senderId: sender.id,
            actorUserId: input.actorUserId,
            action: "MANAGED_TEMPLATE_INSTALL_STARTED",
            details: {
              catalogVersion: input.catalogVersion,
              languageCount: input.languages.length,
              templateCount: claims.length,
            },
          },
        });
      }
      return { sender, claims };
    });
  }

  private static async renewClaimForProviderMutation(
    input: InstallManagedWhatsAppTemplatesInput,
    providerMode: "TEST" | "LIVE",
    claim: ProvisioningClaim
  ) {
    await assertCurrentSender(input, providerMode, prisma);
    const now = new Date();
    const renewed = await prisma.whatsAppManagedTemplateProvisioning.updateMany({
      where: {
        id: claim.provisioningId,
        senderId: input.senderId,
        status: "CREATING",
        leaseToken: claim.leaseToken,
        leaseUntil: { gt: now },
      },
      data: {
        leaseUntil: new Date(now.getTime() + PROVISIONING_LEASE_MS),
      },
    });
    if (renewed.count !== 1) {
      throw new WhatsAppConflictError("Managed template lease expired");
    }
  }

  private static async finalizeProviderTemplate(
    input: InstallManagedWhatsAppTemplatesInput,
    providerMode: "TEST" | "LIVE",
    claim: ProvisioningClaim,
    providerTemplate: MetaMessageTemplate
  ) {
    const projection = provisioningProjection(providerTemplate, claim.definition);
    const now = new Date();
    await prisma.$transaction(async tx => {
      const sender = await assertCurrentSender(input, providerMode, tx);
      const lease = await tx.whatsAppManagedTemplateProvisioning.findFirst({
        where: {
          id: claim.provisioningId,
          senderId: sender.id,
          status: "CREATING",
          leaseToken: claim.leaseToken,
          leaseUntil: { gt: now },
        },
        select: { id: true },
      });
      if (!lease) throw new WhatsAppConflictError("Managed template lease expired");

      const template = await findOrPersistProviderTemplate(tx, sender.id, providerTemplate, now);
      if (projection.compatible) {
        await tx.whatsAppTemplateBinding.upsert({
          where: {
            senderId_managedKey_language: {
              senderId: sender.id,
              managedKey: claim.definition.managedKey,
              language: claim.definition.language,
            },
          },
          create: {
            senderId: sender.id,
            templateId: template.id,
            provisioningId: claim.provisioningId,
            managedKey: claim.definition.managedKey,
            language: claim.definition.language,
            catalogVersion: claim.definition.catalogVersion,
            catalogHash: claim.definition.catalogHash,
            active: projection.status === "READY",
          },
          update: {
            templateId: template.id,
            provisioningId: claim.provisioningId,
            catalogVersion: claim.definition.catalogVersion,
            catalogHash: claim.definition.catalogHash,
            active: projection.status === "READY",
          },
        });
      } else {
        await tx.whatsAppTemplateBinding.updateMany({
          where: {
            senderId: sender.id,
            managedKey: claim.definition.managedKey,
            language: claim.definition.language,
          },
          data: { active: false },
        });
      }
      const updated = await tx.whatsAppManagedTemplateProvisioning.updateMany({
        where: {
          id: claim.provisioningId,
          status: "CREATING",
          leaseToken: claim.leaseToken,
        },
        data: {
          providerTemplateId: providerTemplate.id,
          status: projection.status,
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: projection.errorCode,
        },
      });
      if (updated.count !== 1) throw new WhatsAppConflictError("Managed template lease expired");
    });
  }

  private static async finalizeWithoutTemplate(
    input: InstallManagedWhatsAppTemplatesInput,
    providerMode: "TEST" | "LIVE",
    claim: ProvisioningClaim,
    status: "FAILED" | "UNKNOWN",
    errorCode: string
  ) {
    await prisma.$transaction(async tx => {
      const sender = await assertCurrentSender(input, providerMode, tx);
      const updated = await tx.whatsAppManagedTemplateProvisioning.updateMany({
        where: {
          id: claim.provisioningId,
          senderId: sender.id,
          status: "CREATING",
          leaseToken: claim.leaseToken,
        },
        data: {
          status,
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: errorCode.slice(0, 128),
        },
      });
      if (updated.count !== 1) throw new WhatsAppConflictError("Managed template lease expired");
      await tx.whatsAppTemplateBinding.updateMany({
        where: {
          senderId: sender.id,
          managedKey: claim.definition.managedKey,
          language: claim.definition.language,
        },
        data: { active: false },
      });
    });
  }

  private static async auditResult(
    input: InstallManagedWhatsAppTemplatesInput,
    providerMode: "TEST" | "LIVE",
    failed: boolean
  ) {
    const rows = await prisma.$transaction(async tx => {
      const sender = await assertCurrentSender(input, providerMode, tx);
      const current = await tx.whatsAppManagedTemplateProvisioning.findMany({
        where: {
          senderId: sender.id,
          language: { in: [...input.languages] },
          catalogVersion: input.catalogVersion,
        },
        select: { status: true },
      });
      const counts = Object.fromEntries(
        ["PENDING", "CREATING", "WAITING_APPROVAL", "READY", "REJECTED", "FAILED", "UNKNOWN"]
          .map(status => [status, current.filter(row => row.status === status).length])
      );
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          senderId: sender.id,
          actorUserId: input.actorUserId,
          action: failed
            ? "MANAGED_TEMPLATE_INSTALL_FAILED"
            : "MANAGED_TEMPLATE_INSTALL_COMPLETED",
          details: { catalogVersion: input.catalogVersion, counts },
        },
      });
      return current;
    });
    return rows;
  }

  private static async safeResult(
    input: InstallManagedWhatsAppTemplatesInput,
    providerMode: "TEST" | "LIVE"
  ) {
    await assertCurrentSender(input, providerMode, prisma);
    return this.readSafeStatus({
      senderId: input.senderId,
      languages: input.languages,
      catalogVersion: input.catalogVersion,
    });
  }

  private static async readSafeStatus(input: {
    senderId: string;
    languages: readonly WhatsAppManagedTemplateLanguage[];
    catalogVersion: number;
  }) {
    const definitions = listManagedWhatsAppTemplates({
      languages: input.languages,
      catalogVersion: input.catalogVersion,
    });
    const definitionsByIdentity = new Map(
      definitions.map(definition => [
        `${definition.managedKey}:${definition.language}`,
        definition,
      ])
    );
    const rows = await prisma.whatsAppManagedTemplateProvisioning.findMany({
      where: {
        senderId: input.senderId,
        language: { in: [...input.languages] },
        catalogVersion: input.catalogVersion,
      },
      select: {
        managedKey: true,
        language: true,
        catalogVersion: true,
        providerTemplateName: true,
        providerTemplateId: true,
        status: true,
        lastErrorCode: true,
        catalogHash: true,
        binding: {
          select: {
            active: true,
            managedKey: true,
            language: true,
            catalogVersion: true,
            catalogHash: true,
            template: {
              select: {
                name: true,
                language: true,
                category: true,
                providerStatus: true,
                lastSyncedAt: true,
                staleAt: true,
              },
            },
          },
        },
      },
      orderBy: [{ managedKey: "asc" }, { language: "asc" }],
    });
    const templates = rows.flatMap(row => {
      const definition = definitionsByIdentity.get(`${row.managedKey}:${row.language}`);
      if (!definition) return [];

      const provisioningIdentityMatches = row.catalogVersion === definition.catalogVersion
        && row.catalogHash === definition.catalogHash
        && row.providerTemplateName === definition.providerTemplateName;
      const bindingIdentityMatches = Boolean(
        provisioningIdentityMatches
        && row.binding
        && row.binding.managedKey === definition.managedKey
        && row.binding.language === definition.language
        && row.binding.catalogVersion === definition.catalogVersion
        && row.binding.catalogHash === definition.catalogHash
      );
      const template = bindingIdentityMatches ? row.binding?.template : null;
      const providerIdentityMatches = Boolean(
        template
        && template.name === definition.providerTemplateName
        && template.language === definition.language
      );
      const active = Boolean(
        provisioningIdentityMatches
        && bindingIdentityMatches
        && providerIdentityMatches
        && row.status === "READY"
        && row.binding?.active
        && template?.category === "UTILITY"
        && template.providerStatus === "APPROVED"
        && template.staleAt === null
      );

      return [{
        managedKey: definition.managedKey,
        language: definition.language,
        providerTemplateName: definition.providerTemplateName,
        providerTemplateId: provisioningIdentityMatches ? row.providerTemplateId : null,
        status: provisioningIdentityMatches ? row.status : "FAILED" as const,
        active,
        errorCode: provisioningIdentityMatches
          ? safeProvisioningErrorCode(row.lastErrorCode)
          : "MANAGED_CATALOGUE_IDENTITY_MISMATCH",
        providerCategory: providerIdentityMatches ? template?.category ?? null : null,
        providerStatus: providerIdentityMatches ? template?.providerStatus ?? null : null,
        lastSyncedAt: providerIdentityMatches ? template?.lastSyncedAt ?? null : null,
      }];
    });
    return {
      catalogVersion: input.catalogVersion,
      languages: input.languages.filter(language =>
        templates.some(template => template.language === language)
      ),
      templates,
    };
  }

  static async getStatus(input: GetManagedWhatsAppTemplateStatusInput) {
    await WhatsAppAuthorizationService.assertOwnerEntitled(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    const providerMode = resolveWhatsAppProviderMode();
    const sender = await prisma.whatsAppSender.findFirst({
      where: {
        id: input.senderId,
        organizationId: input.organizationId,
        provider: "META_CLOUD",
        providerMode,
      },
      select: { id: true },
    });
    if (!sender) throw new WhatsAppResourceNotFoundError();

    const schemaReady = isWhatsAppDeliverySchemaAccessEnabled()
      || await isWhatsAppDeliverySchemaReady();
    if (!schemaReady) {
      return {
        catalogVersion: WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
        languages: [] as WhatsAppManagedTemplateLanguage[],
        templates: [],
      };
    }
    return this.readSafeStatus({
      senderId: sender.id,
      languages: ["en_IN", "hi"],
      catalogVersion: WHATSAPP_MANAGED_TEMPLATE_CATALOG_VERSION,
    });
  }

  static async install(input: InstallManagedWhatsAppTemplatesInput) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppTemplateWritesEnabled(input.organizationId);
    const definitions = this.validateInput(input);
    const providerMode = resolveWhatsAppProviderMode();
    const { sender, claims } = await this.claim(input, definitions, providerMode);
    if (claims.length === 0) return this.safeResult(input, providerMode);

    const provider = getMetaWhatsAppClient();
    let providerTemplates: MetaMessageTemplate[];
    try {
      providerTemplates = await provider.listMessageTemplates({ wabaId: sender.wabaId });
    } catch {
      for (const claim of claims) {
        await this.finalizeWithoutTemplate(
          input,
          providerMode,
          claim,
          "FAILED",
          "PROVIDER_TEMPLATE_READ_FAILED"
        );
      }
      await this.auditResult(input, providerMode, true);
      throw new WhatsAppProviderOperationError();
    }

    for (const claim of claims) {
      const definition = claim.definition;
      let matching = providerTemplates.find(template =>
        template.name === definition.providerTemplateName
        && template.language === definition.language
      );
      if (matching) {
        await this.finalizeProviderTemplate(input, providerMode, claim, matching);
        continue;
      }

      // Fence the provider POST with an atomic ownership check. A read followed
      // by a POST would let an expired claimant race a newer lease owner.
      await this.renewClaimForProviderMutation(input, providerMode, claim);
      let created: Awaited<ReturnType<typeof provider.createManagedUtilityTemplate>> | null = null;
      try {
        created = await provider.createManagedUtilityTemplate({
          wabaId: sender.wabaId,
          definition,
        });
      } catch (error) {
        if (error instanceof MetaWhatsAppAmbiguousMutationError) {
          try {
            const reconciled = await provider.listMessageTemplates({ wabaId: sender.wabaId });
            matching = reconciled.find(template =>
              template.name === definition.providerTemplateName
              && template.language === definition.language
            );
          } catch {
            matching = undefined;
          }
          if (matching) {
            await this.finalizeProviderTemplate(input, providerMode, claim, matching);
          } else {
            await this.finalizeWithoutTemplate(
              input,
              providerMode,
              claim,
              "UNKNOWN",
              safeProviderErrorCode(error)
            );
          }
        } else {
          await this.finalizeWithoutTemplate(
            input,
            providerMode,
            claim,
            "FAILED",
            safeProviderErrorCode(error)
          );
        }
      }
      if (created) {
        matching = {
          id: created.providerTemplateId,
          name: definition.providerTemplateName,
          language: definition.language,
          category: created.category,
          status: created.providerStatus,
          components: [...definition.components],
        };
        providerTemplates.push(matching);
        await this.finalizeProviderTemplate(input, providerMode, claim, matching);
      }
    }

    const result = await this.safeResult(input, providerMode);
    await this.auditResult(
      input,
      providerMode,
      result.templates.some(template => template.status === "FAILED" || template.status === "UNKNOWN")
    );
    return result;
  }
}
