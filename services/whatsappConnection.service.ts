import { createHash, randomBytes } from "node:crypto";
import type { WhatsAppSenderStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getMetaWhatsAppClient,
  readMetaWhatsAppConfiguration,
} from "@/lib/metaWhatsApp";
import {
  assertWhatsAppIntegrationEnabled,
  assertWhatsAppOnboardingWritesEnabled,
  assertWhatsAppWebhookIngestEnabled,
  isWhatsAppWebhookIngestEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  WhatsAppConflictError,
  WhatsAppProviderOperationError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";
import { EntitlementService } from "@/services/entitlement.service";
import type { MetaDebugToken, MetaPhoneNumber, MetaWaba } from "@/types";

const INTENT_TTL_MS = 10 * 60 * 1_000;
const INTENT_LEASE_MS = 2 * 60 * 1_000;
const MAX_INTENT_ATTEMPTS = 5;
const PROVIDER_ID_PATTERN = /^[0-9]{1,64}$/;
const REQUIRED_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
] as const;

function hashState(state: string) {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function validateProviderId(value: string | null | undefined, field: string) {
  if (value == null) return null;
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new WhatsAppValidationError(`Invalid ${field}`);
  }
  return value;
}

function chooseWaba(wabas: MetaWaba[], hint: string | null) {
  if (hint) {
    const matching = wabas.find(item => item.id === hint);
    if (!matching) throw new WhatsAppValidationError("Connected account could not be verified");
    return matching;
  }
  if (wabas.length !== 1) {
    throw new WhatsAppValidationError("Connected account selection is ambiguous");
  }
  return wabas[0];
}

function choosePhone(phones: MetaPhoneNumber[], hint: string | null) {
  if (hint) {
    const matching = phones.find(item => item.id === hint);
    if (!matching) throw new WhatsAppValidationError("Connected phone could not be verified");
    return matching;
  }
  if (phones.length !== 1) {
    throw new WhatsAppValidationError("Connected phone selection is ambiguous");
  }
  return phones[0];
}

export function assertWhatsAppTokenAuthorization(
  debug: MetaDebugToken,
  expectedAppId: string,
  wabaId: string
) {
  if (!debug.isValid || debug.appId !== expectedAppId) {
    throw new WhatsAppValidationError("Embedded Signup authorization could not be verified");
  }
  if (!debug.expiresAt || debug.expiresAt <= new Date()) {
    throw new WhatsAppValidationError("Embedded Signup authorization expired");
  }
  const scopes = new Set(debug.scopes);
  for (const required of REQUIRED_SCOPES) {
    if (scopes.has(required)) continue;
    const granular = debug.granularScopes.find(item => item.scope === required);
    if (!granular?.targetIds.includes(wabaId)) {
      throw new WhatsAppValidationError("Embedded Signup asset access could not be verified");
    }
  }
}

export function assertWhatsAppProviderModeMatches(
  waba: MetaWaba,
  providerMode: "TEST" | "LIVE"
) {
  const accountMode = waba.accountMode?.trim().toUpperCase();
  if (!accountMode) return;
  const normalizedMode = accountMode === "SANDBOX" ? "TEST" : accountMode;
  if (normalizedMode !== "TEST" && normalizedMode !== "LIVE") {
    throw new WhatsAppValidationError("Connected account mode could not be verified");
  }
  if (normalizedMode !== providerMode) {
    throw new WhatsAppValidationError("Connected account mode does not match this environment");
  }
}

function assertCloudPhonePlatform(phone: MetaPhoneNumber) {
  const platform = phone.platformType?.trim().toUpperCase();
  if (platform && platform !== "CLOUD_API") {
    throw new WhatsAppValidationError("Connected phone platform is not supported");
  }
}

function phoneIsRegistered(phone: MetaPhoneNumber) {
  const status = phone.registrationStatus?.toUpperCase() ?? phone.status?.toUpperCase();
  return status === "CONNECTED" || status === "REGISTERED" || status === "READY";
}

function providerIsRestricted(waba: MetaWaba, phone: MetaPhoneNumber) {
  const restricted = new Set(["BLOCKED", "DISABLED", "RESTRICTED", "SUSPENDED"]);
  return restricted.has(waba.accountMode?.trim().toUpperCase() ?? "")
    || restricted.has(phone.status?.trim().toUpperCase() ?? "");
}

function systemUserReady(
  users: Array<{ id: string; tasks: string[] }>,
  expectedSystemUserId: string
) {
  return users.some(user => user.id === expectedSystemUserId && user.tasks.includes("MANAGE"));
}

function appSubscribed(apps: Array<{ id: string }>, expectedAppId: string) {
  return apps.some(app => app.id === expectedAppId);
}

function safeIntentFailureCode(error: unknown) {
  if (error instanceof WhatsAppValidationError) return "PROVIDER_STATE_INVALID";
  if (error instanceof WhatsAppConflictError) return "PROVIDER_IDENTITY_CONFLICT";
  if (error instanceof WhatsAppResourceNotFoundError) return "AUTHORIZATION_CHANGED";
  return "PROVIDER_VERIFICATION_FAILED";
}

export type CompleteWhatsAppConnectionInput = {
  actorUserId: string;
  organizationId: string;
  intentId: string;
  state: string;
  code: string;
  businessId?: string | null;
  wabaId: string;
  phoneNumberId: string;
};

export class WhatsAppConnectionService {
  static async browserConfig(actorUserId: string, organizationId: string) {
    assertWhatsAppIntegrationEnabled();
    await WhatsAppAuthorizationService.assertOwner(actorUserId, organizationId);
    const profile = await EntitlementService.getOrganizationProfile(organizationId);
    if (!profile.entitlements.includes("WHATSAPP_AUTOMATION")) {
      return {
        enabled: true,
        providerMode: null,
        appId: null,
        embeddedSignupConfigId: null,
        graphApiVersion: null,
        connectionAvailability: "UNAVAILABLE" as const,
        safeReason: "WhatsApp requires the Standard plan.",
      };
    }
    try {
      const configuration = readMetaWhatsAppConfiguration();
      return {
        enabled: true,
        providerMode: configuration.providerMode,
        appId: configuration.appId,
        embeddedSignupConfigId: configuration.embeddedSignupConfigId,
        graphApiVersion: configuration.graphApiVersion,
        connectionAvailability: "AVAILABLE" as const,
        safeReason: null,
      };
    } catch {
      return {
        enabled: true,
        providerMode: null,
        appId: null,
        embeddedSignupConfigId: null,
        graphApiVersion: null,
        connectionAvailability: "UNAVAILABLE" as const,
        safeReason: "Meta onboarding is not configured for this environment.",
      };
    }
  }

  static async createIntent(actorUserId: string, organizationId: string) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(actorUserId, organizationId);
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppOnboardingWritesEnabled(organizationId);
    const providerMode = resolveWhatsAppProviderMode();
    readMetaWhatsAppConfiguration();

    const state = randomBytes(32).toString("base64url");
    const stateHash = hashState(state);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INTENT_TTL_MS);

    const intent = await prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(actorUserId, organizationId, tx);
      assertWhatsAppOnboardingWritesEnabled(organizationId);
      if (resolveWhatsAppProviderMode() !== providerMode) {
        throw new WhatsAppResourceNotFoundError();
      }
      await tx.whatsAppConnectionIntent.updateMany({
        where: {
          organizationId,
          status: { in: ["CREATED", "PROCESSING", "FAILED"] },
        },
        data: {
          status: "CANCELLED",
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: "SUPERSEDED",
        },
      });
      const created = await tx.whatsAppConnectionIntent.create({
        data: {
          organizationId,
          actorUserId,
          providerMode,
          stateHash,
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId,
          actorUserId,
          action: "CONNECTION_STARTED",
          details: { providerMode },
        },
      });
      return created;
    });

    return { intentId: intent.id, state, expiresAt: intent.expiresAt };
  }

  private static async claim(input: CompleteWhatsAppConnectionInput) {
    const stateHash = hashState(input.state);
    const now = new Date();
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseUntil = new Date(now.getTime() + INTENT_LEASE_MS);

    const result = await prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        input.organizationId,
        tx
      );
      assertWhatsAppOnboardingWritesEnabled(input.organizationId);
      const providerMode = resolveWhatsAppProviderMode();
      const intent = await tx.whatsAppConnectionIntent.findFirst({
        where: {
          id: input.intentId,
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          stateHash,
          providerMode,
        },
      });
      if (!intent) throw new WhatsAppResourceNotFoundError();

      if (intent.status === "COMPLETED" && intent.phoneNumberId) {
        const sender = await tx.whatsAppSender.findFirst({
          where: {
            organizationId: input.organizationId,
            provider: "META_CLOUD",
            providerMode,
            phoneNumberId: intent.phoneNumberId,
          },
          select: { id: true, status: true },
        });
        if (!sender) throw new WhatsAppResourceNotFoundError();
        return { expired: false as const, replay: true as const, sender };
      }
      if (intent.expiresAt <= now) {
        await tx.whatsAppConnectionIntent.update({
          where: { id: intent.id },
          data: { status: "EXPIRED", leaseToken: null, leaseUntil: null },
        });
        return { expired: true as const };
      }
      if (intent.attemptCount >= MAX_INTENT_ATTEMPTS) {
        throw new WhatsAppConflictError("Connection intent attempt limit reached");
      }
      if (intent.status === "PROCESSING" && intent.leaseUntil && intent.leaseUntil > now) {
        throw new WhatsAppConflictError("Connection intent is already processing");
      }
      if (!(["CREATED", "FAILED", "PROCESSING"] as const).includes(
        intent.status as "CREATED" | "FAILED" | "PROCESSING"
      )) {
        throw new WhatsAppResourceNotFoundError();
      }

      const claimed = await tx.whatsAppConnectionIntent.updateMany({
        where: {
          id: intent.id,
          status: intent.status,
          attemptCount: intent.attemptCount,
          OR: [
            { leaseToken: null },
            { leaseUntil: null },
            { leaseUntil: { lte: now } },
          ],
        },
        data: {
          status: "PROCESSING",
          leaseToken,
          leaseUntil,
          attemptCount: { increment: 1 },
          lastErrorCode: null,
        },
      });
      if (claimed.count !== 1) {
        throw new WhatsAppConflictError("Connection intent is already processing");
      }
      return {
        expired: false as const,
        replay: false as const,
        intentId: intent.id,
        providerMode,
        leaseToken,
      };
    });
    if (result.expired) throw new WhatsAppValidationError("Connection intent expired");
    return result;
  }

  private static async assertClaimCanMutate(input: {
    actorUserId: string;
    organizationId: string;
    intentId: string;
    providerMode: "TEST" | "LIVE";
    leaseToken: string;
  }) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppOnboardingWritesEnabled(input.organizationId);
    if (resolveWhatsAppProviderMode() !== input.providerMode) {
      throw new WhatsAppResourceNotFoundError();
    }
    const activeLease = await prisma.whatsAppConnectionIntent.findFirst({
      where: {
        id: input.intentId,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        providerMode: input.providerMode,
        status: "PROCESSING",
        leaseToken: input.leaseToken,
        leaseUntil: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!activeLease) throw new WhatsAppConflictError("Connection intent lease expired");
  }

  static async complete(input: CompleteWhatsAppConnectionInput) {
    if (!input.state || input.state.length > 256 || !input.code || input.code.length > 4_096) {
      throw new WhatsAppValidationError();
    }
    const businessHint = validateProviderId(input.businessId, "business ID");
    const wabaHint = validateProviderId(input.wabaId, "WABA ID");
    const phoneHint = validateProviderId(input.phoneNumberId, "phone number ID");

    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppOnboardingWritesEnabled(input.organizationId);
    const claim = await this.claim(input);
    if (claim.replay) {
      return { senderId: claim.sender.id, status: claim.sender.status, replay: true };
    }

    const configuration = readMetaWhatsAppConfiguration();
    const provider = getMetaWhatsAppClient();
    let temporaryAccessToken: string | null = null;
    let systemUserAssignmentCreated = false;
    let subscriptionCreated = false;
    try {
      const exchange = await provider.exchangeEmbeddedSignupCode({ code: input.code });
      temporaryAccessToken = exchange.accessToken;
      const debug = await provider.debugAccessToken({ accessToken: temporaryAccessToken });
      const businessId = businessHint ?? configuration.businessId;
      const sharedWabas = await provider.listOrResolveSharedWabas({
        businessId,
        accessToken: temporaryAccessToken,
      });
      const selectedWaba = chooseWaba(sharedWabas, wabaHint);
      const authoritativeWaba = await provider.fetchWaba({
        wabaId: selectedWaba.id,
        accessToken: temporaryAccessToken,
      });
      if (authoritativeWaba.id !== selectedWaba.id) {
        throw new WhatsAppValidationError("Connected account could not be verified");
      }
      assertWhatsAppProviderModeMatches(authoritativeWaba, claim.providerMode);
      assertWhatsAppTokenAuthorization(debug, configuration.appId, authoritativeWaba.id);

      const phones = await provider.listPhoneNumbers({
        wabaId: authoritativeWaba.id,
        accessToken: temporaryAccessToken,
      });
      const selectedPhone = choosePhone(phones, phoneHint);
      const authoritativePhone = await provider.fetchPhoneNumber({
        wabaId: authoritativeWaba.id,
        phoneNumberId: selectedPhone.id,
        accessToken: temporaryAccessToken,
      });
      if (
        authoritativePhone.id !== selectedPhone.id
        || authoritativePhone.wabaId !== authoritativeWaba.id
      ) {
        throw new WhatsAppValidationError("Connected phone membership could not be verified");
      }
      assertCloudPhonePlatform(authoritativePhone);

      let assignedUsers = await provider.listAssignedSystemUsers({ wabaId: authoritativeWaba.id });
      if (!systemUserReady(assignedUsers, configuration.systemUserId)) {
        await this.assertClaimCanMutate({
          actorUserId: input.actorUserId,
          organizationId: input.organizationId,
          intentId: claim.intentId,
          providerMode: claim.providerMode,
          leaseToken: claim.leaseToken,
        });
        try {
          await provider.assignSystemUserToWaba({ wabaId: authoritativeWaba.id });
        } catch {
          // The mutation may have committed despite a lost response. Reconcile below.
        }
        assignedUsers = await provider.listAssignedSystemUsers({ wabaId: authoritativeWaba.id });
        if (!systemUserReady(assignedUsers, configuration.systemUserId)) {
          throw new WhatsAppProviderOperationError();
        }
        systemUserAssignmentCreated = true;
      }

      let webhookSubscribed = false;
      if (isWhatsAppWebhookIngestEnabled()) {
        let subscribedApps = await provider.listSubscribedApps({ wabaId: authoritativeWaba.id });
        webhookSubscribed = appSubscribed(subscribedApps, configuration.appId);
        if (!webhookSubscribed) {
          await this.assertClaimCanMutate({
            actorUserId: input.actorUserId,
            organizationId: input.organizationId,
            intentId: claim.intentId,
            providerMode: claim.providerMode,
            leaseToken: claim.leaseToken,
          });
          assertWhatsAppWebhookIngestEnabled();
          try {
            await provider.subscribeAppToWaba({ wabaId: authoritativeWaba.id });
          } catch {
            // Reconcile an ambiguous provider outcome exactly once.
          }
          subscribedApps = await provider.listSubscribedApps({ wabaId: authoritativeWaba.id });
          webhookSubscribed = appSubscribed(subscribedApps, configuration.appId);
          if (!webhookSubscribed) throw new WhatsAppProviderOperationError();
          subscriptionCreated = true;
        }
      }

      const registered = phoneIsRegistered(authoritativePhone);
      const now = new Date();
      const sender = await prisma.$transaction(async tx => {
        await WhatsAppAuthorizationService.assertOwnerCanWrite(
          input.actorUserId,
          input.organizationId,
          tx
        );
        assertWhatsAppOnboardingWritesEnabled(input.organizationId);
        if (resolveWhatsAppProviderMode() !== claim.providerMode) {
          throw new WhatsAppResourceNotFoundError();
        }
        const intent = await tx.whatsAppConnectionIntent.findFirst({
          where: {
            id: claim.intentId,
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            status: "PROCESSING",
            leaseToken: claim.leaseToken,
            leaseUntil: { gt: now },
          },
          select: { id: true },
        });
        if (!intent) throw new WhatsAppConflictError("Connection intent lease expired");

        const identity = await tx.whatsAppSender.findUnique({
          where: {
            provider_providerMode_phoneNumberId: {
              provider: "META_CLOUD",
              providerMode: claim.providerMode,
              phoneNumberId: authoritativePhone.id,
            },
          },
        });
        if (identity && identity.organizationId !== input.organizationId) {
          throw new WhatsAppConflictError();
        }
        const phoneRegisteredAt = registered ? identity?.phoneRegisteredAt ?? now : null;
        const webhookSubscribedAt = webhookSubscribed
          ? identity?.webhookSubscribedAt ?? now
          : null;
        const status: WhatsAppSenderStatus = providerIsRestricted(
          authoritativeWaba,
          authoritativePhone
        )
          ? "RESTRICTED"
          : !registered
            ? "NEEDS_REGISTRATION"
            : webhookSubscribed
              ? "ACTIVE"
              : "PENDING";
        const senderData = {
          organizationId: input.organizationId,
          provider: "META_CLOUD" as const,
          providerMode: claim.providerMode,
          providerBusinessId: businessId,
          wabaId: authoritativeWaba.id,
          phoneNumberId: authoritativePhone.id,
          displayPhoneNumber: authoritativePhone.displayPhoneNumber,
          verifiedName: authoritativePhone.verifiedName,
          qualityRating: authoritativePhone.qualityRating,
          accountMode: authoritativeWaba.accountMode,
          status,
          phoneRegisteredAt,
          webhookSubscribedAt,
          connectedByUserId: input.actorUserId,
          connectedAt: identity?.connectedAt ?? now,
          disconnectedAt: null,
          lastSyncedAt: now,
          lastHealthCheckAt: now,
          lastErrorCode: null,
        };
        const persisted = identity
          ? await tx.whatsAppSender.update({ where: { id: identity.id }, data: senderData })
          : await tx.whatsAppSender.create({ data: senderData });

        if (subscriptionCreated) {
          await tx.whatsAppAuditEvent.create({
            data: {
              organizationId: input.organizationId,
              senderId: persisted.id,
              actorUserId: input.actorUserId,
              action: "WEBHOOK_SUBSCRIBED",
            },
          });
        }
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: input.organizationId,
            senderId: persisted.id,
            actorUserId: input.actorUserId,
            action: "CONNECTION_COMPLETED",
            details: {
              providerMode: claim.providerMode,
              status,
              systemUserAssignmentCreated,
              webhookSubscriptionCreated: subscriptionCreated,
            },
          },
        });
        await tx.whatsAppConnectionIntent.update({
          where: { id: intent.id },
          data: {
            status: "COMPLETED",
            leaseToken: null,
            leaseUntil: null,
            providerBusinessId: businessId,
            wabaId: authoritativeWaba.id,
            phoneNumberId: authoritativePhone.id,
            consumedAt: now,
            lastErrorCode: null,
          },
        });
        return persisted;
      });

      return { senderId: sender.id, status: sender.status, replay: false };
    } catch (error) {
      const failureCode = safeIntentFailureCode(error);
      await prisma.$transaction(async tx => {
        const failed = await tx.whatsAppConnectionIntent.updateMany({
          where: {
            id: claim.intentId,
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            status: "PROCESSING",
            leaseToken: claim.leaseToken,
          },
          data: {
            status: "FAILED",
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: failureCode,
          },
        });
        if (failed.count === 1) {
          await tx.whatsAppAuditEvent.create({
            data: {
              organizationId: input.organizationId,
              actorUserId: input.actorUserId,
              action: "CONNECTION_FAILED",
              details: {
                errorCode: failureCode,
                systemUserAssignmentCreated,
                webhookSubscriptionCreated: subscriptionCreated,
              },
            },
          });
        }
      });
      if (
        error instanceof WhatsAppValidationError
        || error instanceof WhatsAppConflictError
        || error instanceof WhatsAppResourceNotFoundError
        || error instanceof WhatsAppProviderOperationError
      ) {
        throw error;
      }
      throw new WhatsAppProviderOperationError();
    } finally {
      temporaryAccessToken = null;
    }
  }
}
