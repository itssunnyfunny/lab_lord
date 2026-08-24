import { createHmac } from "node:crypto";

import type { Prisma } from "@/app/generated/prisma/client";
import {
  MetaWhatsAppAmbiguousMutationError,
  MetaWhatsAppProviderError,
  type MetaWhatsAppProviderClient,
} from "@/lib/metaWhatsApp";
import {
  getManagedWhatsAppTemplate,
  hashWhatsAppTemplateComponents,
} from "@/lib/whatsappManagedTemplates";
import { WhatsAppDispatcherService } from "@/services/whatsappDispatcher.service";
import { WhatsAppMessageService } from "@/services/whatsappMessage.service";
import { WhatsAppWebhookService } from "@/services/whatsappWebhook.service";
import {
  createBranch,
  createOrg,
  createPayment,
  createSaasSubscription,
  createStudent,
  createUser,
} from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";
import { freezeTime, restoreTime } from "@/tests/setup/time";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-08-23T04:30:00.000Z"); // 10:00 Asia/Kolkata.
const PHONE_E164 = "+919876543210";
const META_APP_SECRET = "whatsapp-delivery-integration-secret";
const RATE_MICROS = 800_000;

const DELIVERY_ENV = Object.freeze({
  NODE_ENV: "test",
  VERCEL_ENV: "preview",
  META_WHATSAPP_MODE: "TEST",
  WHATSAPP_INTEGRATION_ENABLED: "true",
  WHATSAPP_META_MESSAGE_WRITES_ENABLED: "true",
  WHATSAPP_WEBHOOK_INGEST_ENABLED: "true",
  WHATSAPP_UTILITY_RATE_MICROS_INR: String(RATE_MICROS),
  WHATSAPP_RATE_CARD_VERSION: "integration-rate-v1",
  WHATSAPP_RATE_CARD_EFFECTIVE_AT: "2026-01-01T00:00:00.000Z",
} as const);

type ManagedKey = "MULTI_STUDENT_COLLECTION_SUMMARY";

async function installManagedBinding(senderId: string, managedKey: ManagedKey) {
  const definition = getManagedWhatsAppTemplate(managedKey, "en_IN");
  const provisioning = await testPrisma.whatsAppManagedTemplateProvisioning.create({
    data: {
      senderId,
      managedKey,
      language: definition.language,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      providerTemplateName: definition.providerTemplateName,
      providerTemplateId: `provider-${managedKey.toLowerCase()}`,
      status: "READY",
    },
  });
  const template = await testPrisma.whatsAppTemplate.create({
    data: {
      senderId,
      providerTemplateId: provisioning.providerTemplateId!,
      name: definition.providerTemplateName,
      language: definition.language,
      category: "UTILITY",
      providerStatus: "APPROVED",
      version: definition.catalogVersion,
      components: definition.components as unknown as Prisma.InputJsonValue,
      componentHash: hashWhatsAppTemplateComponents(definition.components),
      lastSyncedAt: NOW,
    },
  });
  const binding = await testPrisma.whatsAppTemplateBinding.create({
    data: {
      senderId,
      templateId: template.id,
      provisioningId: provisioning.id,
      managedKey,
      language: definition.language,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      active: true,
    },
  });
  return { definition, template, binding };
}

async function createDeliveryWorld(providerMode: "TEST" | "LIVE" = "TEST") {
  const owner = await createUser({ id: "whatsapp-delivery-owner" });
  const organization = await createOrg({
    id: "whatsapp-delivery-org",
    ownerId: owner.id,
    name: "Delivery Integration Org",
  });
  await createSaasSubscription({ organizationId: organization.id, plan: "PRO" });
  const branch = await createBranch({
    id: "whatsapp-delivery-branch",
    organizationId: organization.id,
    name: "Central Branch",
  });
  const sender = await testPrisma.whatsAppSender.create({
    data: {
      id: "whatsapp-delivery-sender",
      organizationId: organization.id,
      provider: "META_CLOUD",
      providerMode,
      wabaId: "waba_delivery_1",
      phoneNumberId: "phone_delivery_1",
      displayPhoneNumber: "+91 90000 00000",
      status: "ACTIVE",
    },
  });
  await testPrisma.branchWhatsAppSettings.create({
    data: {
      branchId: branch.id,
      organizationId: organization.id,
      senderId: sender.id,
      enabled: true,
      defaultLanguage: "en",
      defaultTone: "polite",
      monthlyBudgetMinor: 50_000,
      sendTimeLocal: "10:00",
      configurationRevision: 1,
    },
  });
  const managed = await installManagedBinding(sender.id, "MULTI_STUDENT_COLLECTION_SUMMARY");
  const consent = await testPrisma.whatsAppConsent.create({
    data: {
      senderId: sender.id,
      phoneE164: PHONE_E164,
      consentType: "OPERATIONAL",
      status: "OPTED_IN",
      source: "IN_PERSON",
      policyVersion: "operational-collections-v1",
      grantedAt: NOW,
      recordedByUserId: owner.id,
    },
  });
  const studentA = await createStudent({
    id: "whatsapp-delivery-student-a",
    branchId: branch.id,
    name: "Student A",
    phone: "9876543210",
  });
  const studentB = await createStudent({
    id: "whatsapp-delivery-student-b",
    branchId: branch.id,
    name: "Student B",
    phone: "9876543210",
  });
  await testPrisma.whatsAppStudentRecipient.createMany({
    data: [studentA, studentB].map(student => ({
      organizationId: organization.id,
      branchId: branch.id,
      studentId: student.id,
      senderId: sender.id,
      consentId: consent.id,
      phoneE164: PHONE_E164,
      relationship: "GUARDIAN" as const,
      status: "ACTIVE" as const,
      verifiedAt: NOW,
      createdByUserId: owner.id,
    })),
  });
  const paymentA = await createPayment({
    id: "whatsapp-delivery-payment-a",
    branchId: branch.id,
    studentId: studentA.id,
    amount: 1_000,
    status: "DUE",
    dueDate: NOW,
    periodStart: new Date("2026-07-23T00:00:00.000Z"),
    periodEnd: NOW,
  });
  const paymentB = await createPayment({
    id: "whatsapp-delivery-payment-b",
    branchId: branch.id,
    studentId: studentB.id,
    amount: 2_000,
    status: "DUE",
    dueDate: NOW,
    periodStart: new Date("2026-07-24T00:00:00.000Z"),
    periodEnd: NOW,
  });

  return {
    owner,
    organization,
    branch,
    sender,
    consent,
    students: [studentA, studentB] as const,
    payments: [paymentA, paymentB] as const,
    managed,
  };
}

async function queueGroupedReminder(
  world: Awaited<ReturnType<typeof createDeliveryWorld>>,
  idempotencyKey: string,
  env: Readonly<Record<string, string | undefined>> = DELIVERY_ENV
) {
  return WhatsAppMessageService.queuePaymentReminders({
    actorUserId: world.owner.id,
    branchId: world.branch.id,
    paymentIds: world.payments.map(payment => payment.id),
    idempotencyKey,
    now: NOW,
    env,
  });
}

function fakeProvider() {
  const sendApprovedUtilityTemplate = vi
    .fn<MetaWhatsAppProviderClient["sendApprovedUtilityTemplate"]>()
    .mockResolvedValue({
      providerMessageId: "wamid.delivery.integration.accepted",
      providerRecipientWaId: "919876543210",
      submissionStatus: "ACCEPTED",
    });
  return {
    sendApprovedUtilityTemplate,
    provider: { sendApprovedUtilityTemplate } as unknown as MetaWhatsAppProviderClient,
  };
}

function rejectingProvider(error: Error) {
  const sendApprovedUtilityTemplate = vi
    .fn<MetaWhatsAppProviderClient["sendApprovedUtilityTemplate"]>()
    .mockRejectedValue(error);
  return {
    sendApprovedUtilityTemplate,
    provider: { sendApprovedUtilityTemplate } as unknown as MetaWhatsAppProviderClient,
  };
}

function signedWebhookRequest(payload: unknown) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", META_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  return new Request("https://app.example.test/api/whatsapp/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: rawBody,
  });
}

function messagesEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba_delivery_1",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "phone_delivery_1" },
          ...value,
        },
      }],
    }],
  };
}

async function rejectionShape(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return {
        name: error.name,
        code: (error as Error & { code: unknown }).code,
        message: error.message,
      };
    }
    throw error;
  }
  throw new Error("Expected the operation to reject");
}

beforeEach(async () => {
  freezeTime(NOW);
  for (const [name, value] of Object.entries({
    ...DELIVERY_ENV,
    META_APP_SECRET,
  })) {
    vi.stubEnv(name, value);
  }
  await resetDatabase();
});

afterEach(() => {
  restoreTime();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await disconnectDatabase();
});

describe("WhatsApp durable delivery integration", () => {
  it("previews and queues one reserved shared-phone row, replays idempotently, and hides foreign payment identity", async () => {
    const world = await createDeliveryWorld();
    const paymentIds = world.payments.map(payment => payment.id);

    const preview = await WhatsAppMessageService.previewPaymentReminders({
      actorUserId: world.owner.id,
      branchId: world.branch.id,
      paymentIds,
      now: NOW,
      env: DELIVERY_ENV,
    });
    expect(preview).toMatchObject({
      selectedPaymentCount: 2,
      eligibleRecipientCount: 1,
      suppressedCount: 0,
      estimatedCostMicros: String(RATE_MICROS),
      rateCardVersion: "integration-rate-v1",
      groups: [{
        paymentCount: 2,
        studentCount: 2,
        managedTemplateKey: "MULTI_STUDENT_COLLECTION_SUMMARY",
      }],
    });

    const first = await queueGroupedReminder(world, "manual-delivery-request-1");
    const replay = await WhatsAppMessageService.queuePaymentReminders({
      actorUserId: world.owner.id,
      branchId: world.branch.id,
      paymentIds: [...paymentIds].reverse(),
      idempotencyKey: "manual-delivery-request-1",
      now: NOW,
      env: DELIVERY_ENV,
    });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      request: { id: first.request.id, queuedMessageCount: 1 },
    });

    const [requests, messages] = await Promise.all([
      testPrisma.whatsAppManualSendRequest.findMany(),
      testPrisma.whatsAppMessage.findMany({
        include: { paymentSources: { orderBy: { paymentId: "asc" } } },
      }),
    ]);
    expect(requests).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      organizationId: world.organization.id,
      branchId: world.branch.id,
      senderId: world.sender.id,
      studentId: null,
      paymentId: null,
      recipientPhoneE164: PHONE_E164,
      trigger: "MANUAL",
      purpose: "MANUAL_REMINDER",
      status: "SCHEDULED",
      budgetState: "RESERVED",
      budgetMonth: "2026-08",
      rateCardVersion: "integration-rate-v1",
      estimatedCostMicros: BigInt(RATE_MICROS),
    });
    expect(messages[0]!.paymentSources.map(source => source.paymentId)).toEqual(
      [...paymentIds].sort()
    );

    const foreignOrganization = await createOrg({
      id: "foreign-whatsapp-org",
      ownerId: world.owner.id,
      name: "Foreign Org",
    });
    const foreignBranch = await createBranch({
      id: "foreign-whatsapp-branch",
      organizationId: foreignOrganization.id,
    });
    const foreignStudent = await createStudent({
      id: "foreign-whatsapp-student",
      branchId: foreignBranch.id,
    });
    const foreignPayment = await createPayment({
      id: "foreign-whatsapp-payment",
      branchId: foreignBranch.id,
      studentId: foreignStudent.id,
      dueDate: NOW,
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: NOW,
    });
    const foreignError = await rejectionShape(
      WhatsAppMessageService.previewPaymentReminders({
        actorUserId: world.owner.id,
        branchId: world.branch.id,
        paymentIds: [foreignPayment.id],
        now: NOW,
        env: DELIVERY_ENV,
      })
    );
    const missingError = await rejectionShape(
      WhatsAppMessageService.previewPaymentReminders({
        actorUserId: world.owner.id,
        branchId: world.branch.id,
        paymentIds: ["missing-whatsapp-payment"],
        now: NOW,
        env: DELIVERY_ENV,
      })
    );
    expect(foreignError).toEqual(missingError);
    expect(foreignError).toEqual({
      name: "WhatsAppResourceNotFoundError",
      code: "WHATSAPP_RESOURCE_NOT_FOUND",
      message: "WhatsApp resource not found",
    });
    await expect(testPrisma.whatsAppManualSendRequest.count()).resolves.toBe(1);
    await expect(testPrisma.whatsAppMessage.count()).resolves.toBe(1);
  });

  it("dispatches an eligible row only through the injected provider and commits its reservation", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-request-2");
    const { provider, sendApprovedUtilityTemplate } = fakeProvider();

    const result = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });

    expect(result).toMatchObject({
      held: false,
      messagesClaimed: 1,
      messagesAccepted: 1,
      messagesSuppressed: 0,
      messagesUnknown: 0,
      backlogRemaining: 0,
    });
    expect(sendApprovedUtilityTemplate).toHaveBeenCalledTimes(1);
    expect(sendApprovedUtilityTemplate).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumberId: world.sender.phoneNumberId,
      recipientPhoneE164: PHONE_E164,
      correlationId: expect.any(String),
      definition: expect.objectContaining({
        managedKey: "MULTI_STUDENT_COLLECTION_SUMMARY",
        category: "UTILITY",
      }),
    }));

    const message = await testPrisma.whatsAppMessage.findFirstOrThrow({
      include: { events: true, paymentSources: true },
    });
    expect(message).toMatchObject({
      status: "ACCEPTED",
      providerMessageId: "wamid.delivery.integration.accepted",
      providerRecipientWaId: "919876543210",
      budgetState: "COMMITTED",
      estimatedCostMicros: BigInt(RATE_MICROS),
      attemptCount: 1,
      leaseToken: null,
      leaseUntil: null,
    });
    expect(message.paymentSources).toHaveLength(2);
    expect(message.events).toEqual([
      expect.objectContaining({
        source: "PROVIDER_RESPONSE",
        status: "ACCEPTED",
        providerMessageId: "wamid.delivery.integration.accepted",
      }),
    ]);
  });

  it("suppresses a queued row when its synchronized template version changes", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-template-version-change");
    await testPrisma.whatsAppTemplate.update({
      where: { id: world.managed.template.id },
      data: { version: { increment: 1 } },
    });
    const { provider, sendApprovedUtilityTemplate } = fakeProvider();

    const result = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });

    expect(result).toMatchObject({
      messagesClaimed: 1,
      messagesAccepted: 0,
      messagesSuppressed: 1,
    });
    expect(sendApprovedUtilityTemplate).not.toHaveBeenCalled();
    await expect(testPrisma.whatsAppMessage.findFirstOrThrow()).resolves.toMatchObject({
      status: "SUPPRESSED",
      failureCode: "TEMPLATE_COMPONENT_MISMATCH",
      budgetState: "RELEASED",
    });
  });

  it("keeps a throttled provider attempt reserved and schedules only a bounded later retry", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-rate-limit");
    const { provider, sendApprovedUtilityTemplate } = rejectingProvider(
      new MetaWhatsAppProviderError("rate limited", {
        kind: "RATE_LIMIT",
        status: 429,
        retryAfterSeconds: 90,
      })
    );

    const first = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });
    const second = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });

    expect(first).toMatchObject({ messagesClaimed: 1, messagesRetried: 1 });
    expect(second).toMatchObject({ messagesClaimed: 0, messagesRetried: 0 });
    expect(sendApprovedUtilityTemplate).toHaveBeenCalledTimes(1);
    await expect(testPrisma.whatsAppMessage.findFirstOrThrow()).resolves.toMatchObject({
      status: "SCHEDULED",
      budgetState: "RESERVED",
      failureCode: "PROVIDER_RATE_LIMIT",
      attemptCount: 1,
      submissionStartedAt: null,
      availableAt: new Date(NOW.getTime() + 90_000),
    });
  });

  it("releases a proven provider rejection and never automatically retries it", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-provider-rejection");
    const { provider, sendApprovedUtilityTemplate } = rejectingProvider(
      new MetaWhatsAppProviderError("request rejected", {
        kind: "REQUEST",
        status: 400,
      })
    );

    const first = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });
    const second = await WhatsAppDispatcherService.run({
      now: new Date(NOW.getTime() + 60_000),
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });

    expect(first).toMatchObject({ messagesClaimed: 1, messagesFailed: 1 });
    expect(second).toMatchObject({ messagesClaimed: 0 });
    expect(sendApprovedUtilityTemplate).toHaveBeenCalledTimes(1);
    await expect(testPrisma.whatsAppMessage.findFirstOrThrow()).resolves.toMatchObject({
      status: "FAILED",
      budgetState: "RELEASED",
      failureCode: "PROVIDER_REJECTED",
      failedAt: NOW,
      attemptCount: 1,
    });
  });

  it("commits an ambiguous provider outcome as UNKNOWN and never automatically retries it", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-provider-ambiguity");
    const { provider, sendApprovedUtilityTemplate } = rejectingProvider(
      new MetaWhatsAppAmbiguousMutationError({ status: 503 })
    );

    const first = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });
    const second = await WhatsAppDispatcherService.run({
      now: new Date(NOW.getTime() + 60_000),
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });

    expect(first).toMatchObject({ messagesClaimed: 1, messagesUnknown: 1 });
    expect(second).toMatchObject({ messagesClaimed: 0 });
    expect(sendApprovedUtilityTemplate).toHaveBeenCalledTimes(1);
    await expect(testPrisma.whatsAppMessage.findFirstOrThrow()).resolves.toMatchObject({
      status: "UNKNOWN",
      budgetState: "COMMITTED",
      failureCode: "PROVIDER_UNKNOWN_OUTCOME",
      attemptCount: 1,
      providerMessageId: null,
    });
  });

  it("lets concurrent dispatcher runs claim one message only once", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-concurrent-dispatch");
    const { provider, sendApprovedUtilityTemplate } = fakeProvider();

    const results = await Promise.all([
      WhatsAppDispatcherService.run({ now: NOW, limit: 10, env: DELIVERY_ENV, provider }),
      WhatsAppDispatcherService.run({ now: NOW, limit: 10, env: DELIVERY_ENV, provider }),
    ]);

    expect(results.reduce((count, result) => count + result.messagesClaimed, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.messagesAccepted, 0)).toBe(1);
    expect(sendApprovedUtilityTemplate).toHaveBeenCalledTimes(1);
    await expect(testPrisma.whatsAppMessage.findFirstOrThrow()).resolves.toMatchObject({
      status: "ACCEPTED",
      budgetState: "COMMITTED",
      providerMessageId: "wamid.delivery.integration.accepted",
    });
  });

  it("recovers a stale pre-submission claim and terminalizes a stale submission without retrying it", async () => {
    const world = await createDeliveryWorld();
    const recoverableRequest = await queueGroupedReminder(
      world,
      "manual-delivery-request-stale-claimed"
    );
    const ambiguousRequest = await queueGroupedReminder(
      world,
      "manual-delivery-request-stale-submitting"
    );
    const recoverableMessage = await testPrisma.whatsAppMessage.findFirstOrThrow({
      where: { manualSendRequestId: recoverableRequest.request.id },
    });
    const ambiguousMessage = await testPrisma.whatsAppMessage.findFirstOrThrow({
      where: { manualSendRequestId: ambiguousRequest.request.id },
    });
    const staleAt = new Date(NOW.getTime() - 60_000);
    await testPrisma.whatsAppMessage.update({
      where: { id: recoverableMessage.id },
      data: {
        status: "CLAIMED",
        claimedAt: staleAt,
        leaseToken: "stale-pre-submission-lease",
        leaseUntil: staleAt,
      },
    });
    await testPrisma.whatsAppMessage.update({
      where: { id: ambiguousMessage.id },
      data: {
        status: "SUBMITTING",
        claimedAt: staleAt,
        submissionStartedAt: staleAt,
        leaseToken: "stale-provider-submission-lease",
        leaseUntil: staleAt,
      },
    });
    const { provider, sendApprovedUtilityTemplate } = fakeProvider();

    const result = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });

    expect(result).toMatchObject({
      staleClaimsRecovered: 1,
      staleSubmissionsMarkedUnknown: 1,
      messagesClaimed: 1,
      messagesAccepted: 1,
      messagesUnknown: 1,
    });
    expect(sendApprovedUtilityTemplate).toHaveBeenCalledTimes(1);
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({
      where: { id: recoverableMessage.id },
    })).resolves.toMatchObject({
      status: "ACCEPTED",
      budgetState: "COMMITTED",
      providerMessageId: "wamid.delivery.integration.accepted",
      leaseToken: null,
      leaseUntil: null,
    });
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({
      where: { id: ambiguousMessage.id },
    })).resolves.toMatchObject({
      status: "UNKNOWN",
      budgetState: "COMMITTED",
      failureCode: "PROVIDER_UNKNOWN_OUTCOME",
      providerMessageId: null,
      leaseToken: null,
      leaseUntil: null,
    });
  });

  it("recovers stale leases after a Live organization is removed from the delivery canary", async () => {
    const liveCanaryEnvironment = {
      ...DELIVERY_ENV,
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      META_WHATSAPP_MODE: "LIVE",
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "whatsapp-delivery-org",
    } as const;
    const removedCanaryEnvironment = {
      ...liveCanaryEnvironment,
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "",
    } as const;
    const world = await createDeliveryWorld("LIVE");
    const recoverableRequest = await queueGroupedReminder(
      world,
      "manual-delivery-live-canary-stale-claimed",
      liveCanaryEnvironment
    );
    const ambiguousRequest = await queueGroupedReminder(
      world,
      "manual-delivery-live-canary-stale-submitting",
      liveCanaryEnvironment
    );
    const recoverableMessage = await testPrisma.whatsAppMessage.findFirstOrThrow({
      where: { manualSendRequestId: recoverableRequest.request.id },
    });
    const ambiguousMessage = await testPrisma.whatsAppMessage.findFirstOrThrow({
      where: { manualSendRequestId: ambiguousRequest.request.id },
    });
    const staleAt = new Date(NOW.getTime() - 60_000);
    await testPrisma.whatsAppMessage.update({
      where: { id: recoverableMessage.id },
      data: {
        status: "CLAIMED",
        claimedAt: staleAt,
        leaseToken: "removed-canary-pre-submission-lease",
        leaseUntil: staleAt,
      },
    });
    await testPrisma.whatsAppMessage.update({
      where: { id: ambiguousMessage.id },
      data: {
        status: "SUBMITTING",
        claimedAt: staleAt,
        submissionStartedAt: staleAt,
        leaseToken: "removed-canary-provider-submission-lease",
        leaseUntil: staleAt,
      },
    });
    const { provider, sendApprovedUtilityTemplate } = fakeProvider();

    const result = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: removedCanaryEnvironment,
      provider,
    });

    expect(result).toMatchObject({
      staleClaimsRecovered: 1,
      staleSubmissionsMarkedUnknown: 1,
      messagesClaimed: 0,
      messagesAccepted: 0,
      messagesUnknown: 1,
    });
    expect(sendApprovedUtilityTemplate).not.toHaveBeenCalled();
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({
      where: { id: recoverableMessage.id },
    })).resolves.toMatchObject({
      status: "SCHEDULED",
      budgetState: "RESERVED",
      leaseToken: null,
      leaseUntil: null,
    });
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({
      where: { id: ambiguousMessage.id },
    })).resolves.toMatchObject({
      status: "UNKNOWN",
      budgetState: "COMMITTED",
      failureCode: "PROVIDER_UNKNOWN_OUTCOME",
      leaseToken: null,
      leaseUntil: null,
    });
  });

  it("suppresses tenant-mismatched and disabled rows without calling the provider", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-request-3");
    const foreignOrganization = await createOrg({
      id: "dispatch-foreign-org",
      ownerId: world.owner.id,
    });
    const foreignMessage = await testPrisma.whatsAppMessage.create({
      data: {
        organizationId: foreignOrganization.id,
        branchId: world.branch.id,
        senderId: world.sender.id,
        recipientPhoneE164: PHONE_E164,
        purpose: "MANUAL_REMINDER",
        trigger: "MANUAL",
        templateVariables: {},
        scheduledFor: NOW,
        availableAt: NOW,
        dedupeKey: "dispatch-foreign-message",
        sourceFingerprint: "dispatch-foreign-source",
        budgetMonth: "2026-08",
        budgetState: "RESERVED",
        rateCardVersion: "integration-rate-v1",
        estimatedCostMicros: BigInt(RATE_MICROS),
      },
    });
    await testPrisma.branchWhatsAppSettings.update({
      where: { branchId: world.branch.id },
      data: { enabled: false },
    });
    const { provider, sendApprovedUtilityTemplate } = fakeProvider();

    const result = await WhatsAppDispatcherService.run({
      now: NOW,
      limit: 10,
      env: DELIVERY_ENV,
      provider,
    });

    expect(result).toMatchObject({
      messagesClaimed: 2,
      messagesAccepted: 0,
      messagesSuppressed: 2,
    });
    expect(sendApprovedUtilityTemplate).not.toHaveBeenCalled();
    const messages = await testPrisma.whatsAppMessage.findMany({
      orderBy: { dedupeKey: "asc" },
    });
    expect(messages).toHaveLength(2);
    expect(messages.find(message => message.id === foreignMessage.id)).toMatchObject({
      status: "SUPPRESSED",
      failureCode: "TENANT_MISMATCH",
      budgetState: "RELEASED",
    });
    expect(messages.find(message => message.id !== foreignMessage.id)).toMatchObject({
      status: "SUPPRESSED",
      failureCode: "BRANCH_DISABLED",
      budgetState: "RELEASED",
    });
    const systemEvents = await testPrisma.whatsAppMessageEvent.findMany({
      where: { source: "SYSTEM" },
      orderBy: { safeErrorCode: "asc" },
    });
    expect(systemEvents).toHaveLength(2);
    expect(systemEvents.map(event => event.safeErrorCode)).toEqual([
      "BRANCH_DISABLED",
      "TENANT_MISMATCH",
    ]);
    expect(systemEvents.every(event => event.status === "SUPPRESSED")).toBe(true);
  });

  it("projects signed delivery and exact STOP once while preserving submitted history", async () => {
    const world = await createDeliveryWorld();
    await queueGroupedReminder(world, "manual-delivery-request-4-accepted");
    const acceptedMessage = await testPrisma.whatsAppMessage.findFirstOrThrow();
    await testPrisma.whatsAppMessage.update({
      where: { id: acceptedMessage.id },
      data: {
        status: "ACCEPTED",
        providerMessageId: "wamid.delivery.integration.webhook",
        providerRecipientWaId: "919876543210",
        acceptedAt: NOW,
        budgetState: "COMMITTED",
      },
    });
    await queueGroupedReminder(world, "manual-delivery-request-4-future");
    const futureMessage = await testPrisma.whatsAppMessage.findFirstOrThrow({
      where: { providerMessageId: null },
    });
    await testPrisma.whatsAppMessageEvent.createMany({
      data: [
        ...Array.from({ length: 101 }, (_, index) => ({
          senderId: world.sender.id,
          providerMessageId: `wamid.delivery.integration.expired-orphan-${index}`,
          eventKey: `delivery-integration-expired-orphan-${index}`,
          source: "PROVIDER_WEBHOOK" as const,
          status: "SENT" as const,
          payloadHash: "expired-orphan-payload",
          expiresAt: new Date(NOW.getTime() - 1),
        })),
        {
          senderId: world.sender.id,
          providerMessageId: "wamid.delivery.integration.fresh-orphan",
          eventKey: "delivery-integration-fresh-orphan",
          source: "PROVIDER_WEBHOOK" as const,
          status: "SENT" as const,
          payloadHash: "fresh-orphan-payload",
          expiresAt: new Date(NOW.getTime() + 60_000),
        },
      ],
    });

    const statusPayload = messagesEnvelope({
      statuses: [{
        id: "wamid.delivery.integration.webhook",
        status: "delivered",
        timestamp: String(Math.floor(NOW.getTime() / 1_000)),
        recipient_id: "919876543210",
        pricing: { billable: true, category: "utility" },
      }],
    });
    await expect(WhatsAppWebhookService.handle(signedWebhookRequest(statusPayload)))
      .resolves.toEqual({ accepted: true });
    await expect(WhatsAppWebhookService.handle(signedWebhookRequest(statusPayload)))
      .resolves.toEqual({ accepted: true });
    await expect(testPrisma.whatsAppMessageEvent.count({
      where: {
        senderId: world.sender.id,
        messageId: null,
        expiresAt: { lte: NOW },
      },
    })).resolves.toBe(1);

    const stopPayload = messagesEnvelope({
      messages: [{
        id: "wamid.delivery.integration.stop",
        from: "919876543210",
        timestamp: String(Math.floor(NOW.getTime() / 1_000)),
        type: "text",
        text: { body: " STOP " },
      }],
    });
    await expect(WhatsAppWebhookService.handle(signedWebhookRequest(stopPayload)))
      .resolves.toEqual({ accepted: true });
    await expect(WhatsAppWebhookService.handle(signedWebhookRequest(stopPayload)))
      .resolves.toEqual({ accepted: true });

    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({
      where: { id: acceptedMessage.id },
    })).resolves.toMatchObject({
      status: "DELIVERED",
      providerMessageId: "wamid.delivery.integration.webhook",
      providerRecipientWaId: "919876543210",
      providerBillable: true,
      providerPricingCategory: "UTILITY",
      budgetState: "COMMITTED",
      actualCostMicros: null,
    });
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({
      where: { id: futureMessage.id },
    })).resolves.toMatchObject({
      status: "CANCELLED",
      failureCode: "OPERATIONAL_CONSENT_OPTED_OUT",
      budgetState: "RELEASED",
    });
    const consents = await testPrisma.whatsAppConsent.findMany({
      where: { senderId: world.sender.id, phoneE164: PHONE_E164 },
      orderBy: { consentType: "asc" },
    });
    expect(consents).toHaveLength(3);
    expect(consents.every(consent => consent.status === "OPTED_OUT")).toBe(true);
    expect(consents.every(consent => consent.source === "WHATSAPP_REPLY")).toBe(true);
    await expect(testPrisma.whatsAppStudentRecipient.count({
      where: { senderId: world.sender.id, phoneE164: PHONE_E164, status: "DISABLED" },
    })).resolves.toBe(2);
    await expect(testPrisma.whatsAppConsentEvent.count({
      where: { senderId: world.sender.id, phoneE164: PHONE_E164 },
    })).resolves.toBe(3);
    await expect(testPrisma.whatsAppMessageEvent.count({
      where: { messageId: acceptedMessage.id, source: "PROVIDER_WEBHOOK" },
    })).resolves.toBe(1);
    await expect(testPrisma.whatsAppMessageEvent.count({
      where: {
        senderId: world.sender.id,
        messageId: null,
        expiresAt: { lte: NOW },
      },
    })).resolves.toBe(0);
    await expect(testPrisma.whatsAppMessageEvent.count({
      where: {
        senderId: world.sender.id,
        messageId: null,
        expiresAt: { gt: NOW },
      },
    })).resolves.toBe(1);
    await expect(testPrisma.whatsAppWebhookReceipt.count()).resolves.toBe(2);
  });
});
