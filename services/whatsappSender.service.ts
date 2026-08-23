import { prisma } from "@/lib/prisma";
import {
  getMetaWhatsAppClient,
  readMetaWhatsAppConfiguration,
} from "@/lib/metaWhatsApp";
import {
  assertWhatsAppIntegrationEnabled,
  assertWhatsAppOnboardingWritesEnabled,
  areWhatsAppOnboardingWritesEnabled,
  resolveWhatsAppProviderMode,
} from "@/lib/whatsappFeature";
import {
  WhatsAppProviderOperationError,
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";
import { WhatsAppAuthorizationService } from "@/services/whatsappAuthorization.service";

const SAFE_SENDER_SELECT = {
  id: true,
  displayPhoneNumber: true,
  verifiedName: true,
  qualityRating: true,
  accountMode: true,
  status: true,
  phoneRegisteredAt: true,
  webhookSubscribedAt: true,
  connectedAt: true,
  disconnectedAt: true,
  lastTemplateSyncAt: true,
  lastHealthCheckAt: true,
  lastErrorCode: true,
} as const;

export function parseWhatsAppRegistrationPin(value: unknown) {
  if (typeof value !== "string" || !/^[0-9]{6}$/.test(value)) {
    throw new WhatsAppValidationError("Registration PIN must contain exactly 6 digits");
  }
  return value;
}

export class WhatsAppSenderService {
  static async listForOwner(actorUserId: string, organizationId: string) {
    assertWhatsAppIntegrationEnabled();
    await WhatsAppAuthorizationService.assertOwner(actorUserId, organizationId);
    const profile = await EntitlementService.getOrganizationProfile(organizationId);
    if (!profile.entitlements.includes("WHATSAPP_AUTOMATION")) {
      return {
        enabled: true,
        canManage: false,
        safeReason: "WhatsApp requires the Standard plan.",
        senders: [],
      };
    }
    const providerMode = resolveWhatsAppProviderMode();
    let providerConfigured = true;
    try {
      readMetaWhatsAppConfiguration();
    } catch {
      providerConfigured = false;
    }
    const writesEnabled = areWhatsAppOnboardingWritesEnabled(organizationId);
    const canManage = profile.canWrite && providerConfigured && writesEnabled;
    const safeReason = !profile.canWrite
      ? "WhatsApp changes are unavailable while this workspace is read-only."
      : !providerConfigured
        ? "Meta onboarding is not configured for this environment."
        : !writesEnabled
          ? "Connection changes are held by the rollout gate."
          : null;

    const senders = await prisma.whatsAppSender.findMany({
      where: { organizationId, provider: "META_CLOUD", providerMode },
      select: {
        ...SAFE_SENDER_SELECT,
        providerMode: true,
        templates: {
          where: { staleAt: null },
          select: { providerStatus: true },
        },
        branchSettings: {
          where: { organizationId },
          select: {
            branch: { select: { id: true, name: true, organizationId: true } },
          },
          orderBy: { branch: { name: "asc" } },
        },
      },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });

    return {
      enabled: true,
      canManage,
      safeReason,
      senders: senders.map(sender => {
        const templateCounts = sender.templates.reduce(
          (counts, template) => {
            const key = template.providerStatus.toLowerCase();
            if (key === "approved" || key === "pending" || key === "rejected") {
              counts[key] += 1;
            } else {
              counts.other += 1;
            }
            counts.total += 1;
            return counts;
          },
          { approved: 0, pending: 0, rejected: 0, other: 0, total: 0 }
        );
        return {
          id: sender.id,
          providerMode: sender.providerMode,
          displayPhoneNumber: sender.displayPhoneNumber,
          verifiedName: sender.verifiedName,
          qualityRating: sender.qualityRating,
          accountMode: sender.accountMode,
          status: sender.status,
          phoneRegisteredAt: sender.phoneRegisteredAt,
          webhookSubscribedAt: sender.webhookSubscribedAt,
          lastHealthCheckAt: sender.lastHealthCheckAt,
          lastTemplateSyncAt: sender.lastTemplateSyncAt,
          templateCounts,
          assignedBranches: sender.branchSettings
            .filter(item => item.branch.organizationId === organizationId)
            .map(item => ({
              id: item.branch.id,
              name: item.branch.name,
              enabled: false as const,
            })),
        };
      }),
    };
  }

  static async getBranchAssignment(
    actorUserId: string,
    organizationId: string,
    branchId: string
  ) {
    assertWhatsAppIntegrationEnabled();
    let access;
    try {
      await StaffService.authorizeRole(actorUserId, branchId, "view_whatsapp");
      access = await StaffService.getBranchAccess(actorUserId, branchId);
    } catch {
      throw new WhatsAppResourceNotFoundError();
    }
    if (access.organizationId !== organizationId) throw new WhatsAppResourceNotFoundError();

    const providerMode = resolveWhatsAppProviderMode();
    const profile = await EntitlementService.getOrganizationProfile(organizationId);
    if (!profile.entitlements.includes("WHATSAPP_AUTOMATION")) {
      return {
        enabled: true,
        canManage: false,
        safeReason: "WhatsApp requires the Standard plan.",
        assignment: null,
        availableSenders: [],
      };
    }
    let branchWritable = true;
    try {
      await EntitlementService.assertBranchWritable(branchId);
    } catch {
      branchWritable = false;
    }
    let providerConfigured = true;
    try {
      readMetaWhatsAppConfiguration();
    } catch {
      providerConfigured = false;
    }
    const writesEnabled = areWhatsAppOnboardingWritesEnabled(organizationId);
    const canManage = Boolean(
      access.isOwner
      && access.permissions.manage_whatsapp
      && profile.canWrite
      && branchWritable
      && providerConfigured
      && writesEnabled
    );
    const safeReason = !access.isOwner
      ? "Only the organization owner can manage sender assignments."
      : !profile.canWrite || !branchWritable
        ? "WhatsApp changes are unavailable while this workspace is read-only."
        : !providerConfigured
          ? "Meta onboarding is not configured for this environment."
          : !writesEnabled
            ? "Connection changes are held by the rollout gate."
            : null;
    const settings = await prisma.branchWhatsAppSettings.findFirst({
      where: { branchId, organizationId: access.organizationId },
      select: {
        enabled: true,
        defaultLanguage: true,
        defaultTone: true,
        monthlyBudgetMinor: true,
        sender: {
          select: {
            ...SAFE_SENDER_SELECT,
            organizationId: true,
            providerMode: true,
          },
        },
      },
    });
    const sender = settings?.sender?.organizationId === organizationId
      && settings.sender.providerMode === providerMode
      ? settings.sender
      : null;
    const availableSenders = await prisma.whatsAppSender.findMany({
      where: {
        organizationId,
        provider: "META_CLOUD",
        providerMode,
        status: "ACTIVE",
      },
      select: { ...SAFE_SENDER_SELECT, providerMode: true },
      orderBy: [{ verifiedName: "asc" }, { createdAt: "asc" }],
    });
    const branchSender = (item: typeof availableSenders[number]) => ({
      id: item.id,
      providerMode: item.providerMode,
      displayPhoneNumber: item.displayPhoneNumber,
      verifiedName: item.verifiedName,
      qualityRating: item.qualityRating,
      status: item.status,
      phoneRegisteredAt: item.phoneRegisteredAt,
      webhookSubscribedAt: item.webhookSubscribedAt,
    });

    return {
      enabled: true,
      canManage,
      safeReason,
      assignment: settings
        ? {
            branchId,
            automationEnabled: false as const,
            defaultLanguage: settings.defaultLanguage,
            defaultTone: settings.defaultTone,
            sender: sender ? branchSender(sender) : null,
          }
        : null,
      availableSenders: availableSenders.map(branchSender),
    };
  }

  static async assignBranch(input: {
    actorUserId: string;
    organizationId: string;
    branchId: string;
    senderId: string;
  }) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppOnboardingWritesEnabled(input.organizationId);
    const providerMode = resolveWhatsAppProviderMode();

    return prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        input.organizationId,
        tx
      );
      assertWhatsAppOnboardingWritesEnabled(input.organizationId);
      const currentMode = resolveWhatsAppProviderMode();
      if (currentMode !== providerMode) throw new WhatsAppResourceNotFoundError();

      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, organizationId: input.organizationId },
        select: { id: true },
      });
      const sender = await tx.whatsAppSender.findFirst({
        where: {
          id: input.senderId,
          organizationId: input.organizationId,
          provider: "META_CLOUD",
          providerMode,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!branch || !sender) throw new WhatsAppResourceNotFoundError();
      await EntitlementService.assertBranchWritable(branch.id, tx);

      const current = await tx.branchWhatsAppSettings.findUnique({
        where: { branchId: branch.id },
        select: { senderId: true },
      });
      if (current?.senderId === sender.id) {
        return { branchId: branch.id, senderId: sender.id, changed: false };
      }
      const previousSender = current?.senderId
        ? await tx.whatsAppSender.findFirst({
            where: {
              id: current.senderId,
              organizationId: input.organizationId,
              provider: "META_CLOUD",
              providerMode,
            },
            select: { id: true },
          })
        : null;
      if (current?.senderId && !previousSender) throw new WhatsAppResourceNotFoundError();

      await tx.branchWhatsAppSettings.upsert({
        where: { branchId: branch.id },
        create: {
          branchId: branch.id,
          organizationId: input.organizationId,
          senderId: sender.id,
          enabled: false,
        },
        update: { senderId: sender.id, enabled: false },
      });
      if (previousSender) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: input.organizationId,
            branchId: branch.id,
            senderId: previousSender.id,
            actorUserId: input.actorUserId,
            action: "BRANCH_UNASSIGNED",
          },
        });
      }
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          branchId: branch.id,
          senderId: sender.id,
          actorUserId: input.actorUserId,
          action: "BRANCH_ASSIGNED",
        },
      });
      return { branchId: branch.id, senderId: sender.id, changed: true };
    });
  }

  static async unassignBranch(input: {
    actorUserId: string;
    organizationId: string;
    branchId: string;
  }) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppOnboardingWritesEnabled(input.organizationId);
    const providerMode = resolveWhatsAppProviderMode();

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
      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, organizationId: input.organizationId },
        select: { id: true },
      });
      if (!branch) throw new WhatsAppResourceNotFoundError();
      await EntitlementService.assertBranchWritable(branch.id, tx);

      const current = await tx.branchWhatsAppSettings.findUnique({
        where: { branchId: branch.id },
        select: { senderId: true },
      });
      if (!current?.senderId) return { branchId: branch.id, changed: false };
      const previousSender = await tx.whatsAppSender.findFirst({
        where: {
          id: current.senderId,
          organizationId: input.organizationId,
          provider: "META_CLOUD",
          providerMode,
        },
        select: { id: true },
      });
      if (!previousSender) throw new WhatsAppResourceNotFoundError();

      await tx.branchWhatsAppSettings.update({
        where: { branchId: branch.id },
        data: { senderId: null, enabled: false },
      });
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          branchId: branch.id,
          senderId: previousSender.id,
          actorUserId: input.actorUserId,
          action: "BRANCH_UNASSIGNED",
        },
      });
      return { branchId: branch.id, changed: true };
    });
  }

  static async disconnectLocal(input: {
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
    const providerMode = resolveWhatsAppProviderMode();

    return prisma.$transaction(async tx => {
      await WhatsAppAuthorizationService.assertOwnerCanWrite(
        input.actorUserId,
        input.organizationId,
        tx
      );
      assertWhatsAppOnboardingWritesEnabled(input.organizationId);
      const sender = await tx.whatsAppSender.findFirst({
        where: {
          id: input.senderId,
          organizationId: input.organizationId,
          provider: "META_CLOUD",
          providerMode,
        },
        select: { id: true, status: true },
      });
      if (!sender) throw new WhatsAppResourceNotFoundError();
      if (sender.status === "DISCONNECTED") return { senderId: sender.id, changed: false };

      const assignments = await tx.branchWhatsAppSettings.findMany({
        where: {
          organizationId: input.organizationId,
          senderId: sender.id,
          branch: { organizationId: input.organizationId },
        },
        select: { branchId: true },
      });
      await tx.branchWhatsAppSettings.updateMany({
        where: {
          organizationId: input.organizationId,
          senderId: sender.id,
          branch: { organizationId: input.organizationId },
        },
        data: { senderId: null, enabled: false },
      });
      await tx.whatsAppSender.update({
        where: { id: sender.id },
        data: {
          status: "DISCONNECTED",
          disconnectedAt: new Date(),
          lastErrorCode: null,
        },
      });
      if (assignments.length > 0) {
        await tx.whatsAppAuditEvent.createMany({
          data: assignments.map(assignment => ({
            organizationId: input.organizationId,
            branchId: assignment.branchId,
            senderId: sender.id,
            actorUserId: input.actorUserId,
            action: "BRANCH_UNASSIGNED" as const,
          })),
        });
      }
      await tx.whatsAppAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          senderId: sender.id,
          actorUserId: input.actorUserId,
          action: "LOCAL_DISCONNECTED",
          details: { providerAccessUnchanged: true },
        },
      });
      return { senderId: sender.id, changed: true, unassignedBranches: assignments.length };
    });
  }

  static async registerPhone(input: {
    actorUserId: string;
    organizationId: string;
    senderId: string;
    pin: string;
  }) {
    await WhatsAppAuthorizationService.assertOwnerCanWrite(
      input.actorUserId,
      input.organizationId
    );
    assertWhatsAppIntegrationEnabled();
    assertWhatsAppOnboardingWritesEnabled(input.organizationId);
    const pin = parseWhatsAppRegistrationPin(input.pin);
    const providerMode = resolveWhatsAppProviderMode();
    const configuration = readMetaWhatsAppConfiguration();
    const sender = await prisma.whatsAppSender.findFirst({
      where: {
        id: input.senderId,
        organizationId: input.organizationId,
        provider: "META_CLOUD",
        providerMode,
        status: { not: "DISCONNECTED" },
      },
      select: {
        id: true,
        wabaId: true,
        phoneNumberId: true,
        phoneRegisteredAt: true,
      },
    });
    if (!sender) throw new WhatsAppResourceNotFoundError();

    const provider = getMetaWhatsAppClient();
    const fetchPhone = () => provider.fetchPhoneNumber({
      wabaId: sender.wabaId,
      phoneNumberId: sender.phoneNumberId,
      accessToken: configuration.systemUserAccessToken,
    });
    const ready = (phone: Awaited<ReturnType<typeof fetchPhone>>) => {
      const registrationStatus = phone.registrationStatus?.toUpperCase()
        ?? phone.status?.toUpperCase();
      return registrationStatus === "CONNECTED"
        || registrationStatus === "REGISTERED"
        || registrationStatus === "READY";
    };

    let authoritativePhone;
    let webhookVerified = false;
    let foundationalAccessVerified = false;
    let providerRestricted = false;
    try {
      const phones = await provider.listPhoneNumbers({
        wabaId: sender.wabaId,
        accessToken: configuration.systemUserAccessToken,
      });
      if (!phones.some(phone => phone.id === sender.phoneNumberId && phone.wabaId === sender.wabaId)) {
        throw new WhatsAppResourceNotFoundError();
      }
      authoritativePhone = await fetchPhone();
      if (
        authoritativePhone.id !== sender.phoneNumberId
        || authoritativePhone.wabaId !== sender.wabaId
      ) {
        throw new WhatsAppResourceNotFoundError();
      }
      if (!ready(authoritativePhone)) {
        await WhatsAppAuthorizationService.assertOwnerCanWrite(
          input.actorUserId,
          input.organizationId
        );
        assertWhatsAppIntegrationEnabled();
        assertWhatsAppOnboardingWritesEnabled(input.organizationId);
        if (resolveWhatsAppProviderMode() !== providerMode) {
          throw new WhatsAppResourceNotFoundError();
        }
        const currentSender = await prisma.whatsAppSender.findFirst({
          where: {
            id: sender.id,
            organizationId: input.organizationId,
            provider: "META_CLOUD",
            providerMode,
            wabaId: sender.wabaId,
            phoneNumberId: sender.phoneNumberId,
            status: { not: "DISCONNECTED" },
          },
          select: { id: true },
        });
        if (!currentSender) throw new WhatsAppResourceNotFoundError();
        try {
          await provider.registerPhoneNumber({
            phoneNumberId: sender.phoneNumberId,
            pin,
          });
        } catch {
          // A response can be lost after Meta commits. Reconcile below without retrying.
        }
        authoritativePhone = await fetchPhone();
        if (!ready(authoritativePhone)) {
          throw new WhatsAppProviderOperationError();
        }
      }
      const authoritativeWaba = await provider.fetchWaba({
        wabaId: sender.wabaId,
        accessToken: configuration.systemUserAccessToken,
      });
      if (authoritativeWaba.id !== sender.wabaId) throw new WhatsAppResourceNotFoundError();
      const accountMode = authoritativeWaba.accountMode?.trim().toUpperCase();
      const normalizedAccountMode = accountMode === "SANDBOX" ? "TEST" : accountMode;
      if (
        normalizedAccountMode
        && (normalizedAccountMode !== "TEST" && normalizedAccountMode !== "LIVE")
      ) {
        throw new WhatsAppValidationError("Connected account mode could not be verified");
      }
      if (normalizedAccountMode && normalizedAccountMode !== providerMode) {
        throw new WhatsAppValidationError("Connected account mode does not match this environment");
      }
      const platformType = authoritativePhone.platformType?.trim().toUpperCase();
      if (platformType && platformType !== "CLOUD_API") {
        throw new WhatsAppValidationError("Connected phone platform is not supported");
      }
      const assignedUsers = await provider.listAssignedSystemUsers({ wabaId: sender.wabaId });
      foundationalAccessVerified = assignedUsers.some(user => (
        user.id === configuration.systemUserId && user.tasks.includes("MANAGE")
      ));
      const subscribedApps = await provider.listSubscribedApps({ wabaId: sender.wabaId });
      webhookVerified = subscribedApps.some(app => app.id === configuration.appId);
      const restrictedStates = new Set(["BLOCKED", "DISABLED", "RESTRICTED", "SUSPENDED"]);
      providerRestricted = restrictedStates.has(accountMode ?? "")
        || restrictedStates.has(authoritativePhone.status?.trim().toUpperCase() ?? "");
    } catch (error) {
      if (
        error instanceof WhatsAppResourceNotFoundError
        || error instanceof WhatsAppProviderOperationError
        || error instanceof WhatsAppValidationError
      ) {
        throw error;
      }
      throw new WhatsAppProviderOperationError();
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
      const current = await tx.whatsAppSender.findFirst({
        where: {
          id: sender.id,
          organizationId: input.organizationId,
          provider: "META_CLOUD",
          providerMode,
          wabaId: sender.wabaId,
          phoneNumberId: sender.phoneNumberId,
          status: { not: "DISCONNECTED" },
        },
        select: { id: true, phoneRegisteredAt: true, webhookSubscribedAt: true },
      });
      if (!current) throw new WhatsAppResourceNotFoundError();
      const status = providerRestricted
        ? "RESTRICTED"
        : foundationalAccessVerified && webhookVerified
          ? "ACTIVE"
          : "PENDING";
      const updated = await tx.whatsAppSender.update({
        where: { id: current.id },
        data: {
          displayPhoneNumber: authoritativePhone.displayPhoneNumber,
          verifiedName: authoritativePhone.verifiedName,
          qualityRating: authoritativePhone.qualityRating,
          phoneRegisteredAt: current.phoneRegisteredAt ?? now,
          webhookSubscribedAt: webhookVerified
            ? current.webhookSubscribedAt ?? now
            : null,
          status,
          lastSyncedAt: now,
          lastHealthCheckAt: now,
          lastErrorCode: null,
        },
        select: { id: true, status: true },
      });
      if (!current.phoneRegisteredAt) {
        await tx.whatsAppAuditEvent.create({
          data: {
            organizationId: input.organizationId,
            senderId: current.id,
            actorUserId: input.actorUserId,
            action: "PHONE_REGISTERED",
          },
        });
      }
      return { senderId: updated.id, status: updated.status, changed: !current.phoneRegisteredAt };
    });
  }
}
