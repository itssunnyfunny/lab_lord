import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getMetaWhatsAppClient } from "@/lib/metaWhatsApp";
import {
  assertWhatsAppIntegrationEnabled,
  assertWhatsAppOnboardingWritesEnabled,
  isWhatsAppDeliverySchemaAccessEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  WhatsAppConflictError,
  WhatsAppProviderOperationError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import {
  getManagedWhatsAppTemplate,
  hashWhatsAppTemplateComponents,
  WhatsAppManagedTemplateError,
} from "@/lib/whatsappManagedTemplates";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";
import type { MetaMessageTemplate } from "@/types";

const MAX_TEMPLATE_COMPONENTS = 10;
const MAX_TEMPLATE_COMPONENT_BYTES = 65_536;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LANGUAGE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

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

function normalizeCategory(value: string) {
  const normalized = value.toUpperCase();
  return normalized === "AUTHENTICATION"
    || normalized === "MARKETING"
    || normalized === "UTILITY"
    ? normalized
    : "UNKNOWN";
}

function normalizeStatus(value: string) {
  const normalized = value.toUpperCase();
  return normalized === "APPROVED"
    || normalized === "PENDING"
    || normalized === "REJECTED"
    || normalized === "PAUSED"
    || normalized === "DISABLED"
    ? normalized
    : "UNKNOWN";
}

function normalizeProviderTemplate(template: MetaMessageTemplate) {
  if (!PROVIDER_ID_PATTERN.test(template.id)) {
    throw new WhatsAppValidationError("Provider returned an invalid template identifier");
  }
  if (!template.name || template.name.length > 512) {
    throw new WhatsAppValidationError("Provider returned an invalid template name");
  }
  if (!LANGUAGE_PATTERN.test(template.language)) {
    throw new WhatsAppValidationError("Provider returned an invalid template language");
  }
  if (!Array.isArray(template.components) || template.components.length > MAX_TEMPLATE_COMPONENTS) {
    throw new WhatsAppValidationError("Provider returned too many template components");
  }

  const canonicalComponents = canonicalize(template.components);
  const serialized = JSON.stringify(canonicalComponents);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TEMPLATE_COMPONENT_BYTES) {
    throw new WhatsAppValidationError("Provider returned an oversized template");
  }

  return {
    providerTemplateId: template.id,
    name: template.name,
    language: template.language,
    category: normalizeCategory(template.category),
    providerStatus: normalizeStatus(template.status),
    components: JSON.parse(serialized) as Prisma.InputJsonValue,
    componentHash: hashWhatsAppTemplateComponents(canonicalComponents),
  } as const;
}

export class WhatsAppTemplateService {
  static async sync(input: {
    actorUserId: string;
    organizationId: string;
    senderId: string;
  }) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppOnboardingWritesEnabled(input.organizationId);
    const deliverySchemaAccessEnabled = isWhatsAppDeliverySchemaAccessEnabled();
    const providerMode = resolveWhatsAppProviderMode();

    const sender = await prisma.whatsAppSender.findFirst({
      where: {
        id: input.senderId,
        organizationId: input.organizationId,
        provider: "META_CLOUD",
        providerMode,
        status: { not: "DISCONNECTED" },
      },
      select: { id: true, wabaId: true },
    });
    if (!sender) throw new WhatsAppResourceNotFoundError();

    let providerTemplates: MetaMessageTemplate[];
    try {
      providerTemplates = await getMetaWhatsAppClient().listMessageTemplates({
        wabaId: sender.wabaId,
      });
    } catch {
      throw new WhatsAppProviderOperationError();
    }
    const templates = providerTemplates.map(normalizeProviderTemplate);
    const providerIds = new Set<string>();
    const identities = new Set<string>();
    for (const template of templates) {
      const identity = `${template.name}\u0000${template.language}`;
      if (providerIds.has(template.providerTemplateId) || identities.has(identity)) {
        throw new WhatsAppValidationError("Provider returned duplicate template identities");
      }
      providerIds.add(template.providerTemplateId);
      identities.add(identity);
    }

    const now = new Date();
    return prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        input.organizationId,
        tx
      );
      assertWhatsAppOnboardingWritesEnabled(input.organizationId);
      if (resolveWhatsAppProviderMode() !== providerMode) {
        throw new WhatsAppResourceNotFoundError();
      }
      const currentSender = await tx.whatsAppSender.findFirst({
        where: {
          id: sender.id,
          organizationId: input.organizationId,
          provider: "META_CLOUD",
          providerMode,
          wabaId: sender.wabaId,
          status: { not: "DISCONNECTED" },
        },
        select: { id: true },
      });
      if (!currentSender) throw new WhatsAppResourceNotFoundError();

      const existing = await tx.whatsAppTemplate.findMany({
        where: { senderId: sender.id },
      });
      const byProviderId = new Map(existing.map(item => [item.providerTemplateId, item]));
      const byNameLanguage = new Map(existing.map(item => [`${item.name}\u0000${item.language}`, item]));
      let created = 0;
      let updated = 0;
      let unchanged = 0;

      for (const template of templates) {
        const providerMatch = byProviderId.get(template.providerTemplateId);
        const nameMatch = byNameLanguage.get(`${template.name}\u0000${template.language}`);
        if (providerMatch && nameMatch && providerMatch.id !== nameMatch.id) {
          throw new WhatsAppConflictError("Template registry identity conflict");
        }
        const target = providerMatch ?? nameMatch;
        if (target) {
          const changed = target.providerTemplateId !== template.providerTemplateId
            || target.name !== template.name
            || target.language !== template.language
            || target.category !== template.category
            || target.providerStatus !== template.providerStatus
            || target.componentHash !== template.componentHash;
          await tx.whatsAppTemplate.update({
            where: { id: target.id },
            data: {
              providerTemplateId: template.providerTemplateId,
              name: template.name,
              language: template.language,
              category: template.category,
              providerStatus: template.providerStatus,
              components: template.components,
              componentHash: template.componentHash,
              version: changed ? { increment: 1 } : target.version,
              lastSyncedAt: now,
              staleAt: null,
            },
          });
          if (changed) updated += 1;
          else unchanged += 1;
        } else {
          await tx.whatsAppTemplate.create({
            data: {
              senderId: sender.id,
              ...template,
              lastSyncedAt: now,
            },
          });
          created += 1;
        }
      }

      const stale = await tx.whatsAppTemplate.updateMany({
        where: {
          senderId: sender.id,
          providerTemplateId: { notIn: [...providerIds] },
          staleAt: null,
        },
        data: { staleAt: now },
      });

      if (deliverySchemaAccessEnabled) {
        const [managedProvisionings, synchronizedTemplates] = await Promise.all([
          tx.whatsAppManagedTemplateProvisioning.findMany({
            where: { senderId: sender.id },
          }),
          tx.whatsAppTemplate.findMany({ where: { senderId: sender.id } }),
        ]);
        const synchronizedById = new Map(
          synchronizedTemplates.map(template => [template.providerTemplateId, template])
        );
        const synchronizedByNameLanguage = new Map(
          synchronizedTemplates.map(template => [`${template.name}\u0000${template.language}`, template])
        );
        for (const provisioning of managedProvisionings) {
          if (provisioning.status === "CREATING") continue;
          let definition;
          try {
            definition = getManagedWhatsAppTemplate(
              provisioning.managedKey,
              provisioning.language as never,
              provisioning.catalogVersion
            );
          } catch (error) {
            if (!(error instanceof WhatsAppManagedTemplateError)) throw error;
            await tx.whatsAppTemplateBinding.updateMany({
              where: { provisioningId: provisioning.id },
              data: { active: false },
            });
            continue;
          }
          const template = provisioning.providerTemplateId
            ? synchronizedById.get(provisioning.providerTemplateId)
              ?? synchronizedByNameLanguage.get(
                `${definition.providerTemplateName}\u0000${definition.language}`
              )
            : synchronizedByNameLanguage.get(
              `${definition.providerTemplateName}\u0000${definition.language}`
            );
          const exactContent = Boolean(
            template
            && template.name === definition.providerTemplateName
            && template.language === definition.language
            && template.staleAt === null
            && template.componentHash === hashWhatsAppTemplateComponents(definition.components)
            && provisioning.catalogHash === definition.catalogHash
          );
          const ready = Boolean(
            exactContent
            && template?.category === "UTILITY"
            && template.providerStatus === "APPROVED"
          );
          const unresolvedCreateAmbiguity = provisioning.status === "UNKNOWN"
            && (!template || template.staleAt !== null);
          const nextStatus = ready
            ? "READY"
            : exactContent && template?.providerStatus === "PENDING"
              ? "WAITING_APPROVAL"
              : exactContent && template?.providerStatus === "REJECTED"
                ? "REJECTED"
                : unresolvedCreateAmbiguity
                  ? "UNKNOWN"
                  : "FAILED";
          const lastErrorCode = ready || nextStatus === "WAITING_APPROVAL"
            ? null
            : nextStatus === "REJECTED"
              ? "PROVIDER_TEMPLATE_REJECTED"
              : nextStatus === "UNKNOWN"
                ? provisioning.lastErrorCode ?? "PROVIDER_RESULT_AMBIGUOUS"
                : !exactContent
                  ? "PROVIDER_TEMPLATE_MISMATCH"
                  : template?.category !== "UTILITY"
                    ? "PROVIDER_CATEGORY_NOT_UTILITY"
                    : "PROVIDER_TEMPLATE_INACTIVE";
          await tx.whatsAppManagedTemplateProvisioning.updateMany({
            where: { id: provisioning.id, status: { not: "CREATING" } },
            data: {
              providerTemplateId: template?.providerTemplateId ?? provisioning.providerTemplateId,
              status: nextStatus,
              lastErrorCode,
            },
          });
          if (exactContent && template) {
            await tx.whatsAppTemplateBinding.upsert({
              where: {
                senderId_managedKey_language: {
                  senderId: sender.id,
                  managedKey: definition.managedKey,
                  language: definition.language,
                },
              },
              create: {
                senderId: sender.id,
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
          } else {
            await tx.whatsAppTemplateBinding.updateMany({
              where: { provisioningId: provisioning.id },
              data: { active: false },
            });
          }
        }
      }
      await tx.whatsAppSender.update({
        where: { id: sender.id },
        data: {
          lastTemplateSyncAt: now,
          lastSyncedAt: now,
          lastErrorCode: null,
        },
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          senderId: sender.id,
          actorUserId: input.actorUserId,
          action: "TEMPLATES_SYNCED",
          details: {
            fetched: templates.length,
            inserted: created,
            updated,
            unchanged,
            markedStale: stale.count,
          },
        },
      });
      return {
        fetched: templates.length,
        inserted: created,
        updated,
        unchanged,
        markedStale: stale.count,
      };
    });
  }
}
