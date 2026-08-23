import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "@/app/generated/prisma/client";
import {
  getManagedWhatsAppTemplate,
  hashWhatsAppTemplateComponents,
} from "@/lib/whatsappManagedTemplates";
import { PaymentService } from "@/services/payment.service";
import { deriveWhatsAppManualCollectionMessageRefresh } from "@/services/whatsappMessage.service";
import { verifyAutomaticMessageSource } from "@/services/whatsappPlanner.service";
import { createBranch, createOrg, createPayment, createStudent, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";
import { freezeTime, restoreTime } from "@/tests/setup/time";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const SCHEDULED_FOR = new Date("2026-01-01T04:30:00.000Z");
const PHONE_E164 = "+919999999999";

async function installManagedBinding(
  senderId: string,
  managedKey: "MULTI_STUDENT_COLLECTION_SUMMARY" | "FEE_RENEWAL_POLITE"
) {
  const definition = getManagedWhatsAppTemplate(managedKey, "en_IN");
  const provisioning = await testPrisma.whatsAppManagedTemplateProvisioning.create({
    data: {
      senderId,
      managedKey,
      language: definition.language,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      providerTemplateName: definition.providerTemplateName,
      providerTemplateId: `provider-${managedKey}`,
      status: "READY",
    },
  });
  const template = await testPrisma.whatsAppTemplate.create({
    data: {
      senderId,
      providerTemplateId: `provider-${managedKey}`,
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

async function createReconciliationWorld() {
  const owner = await createUser();
  const organization = await createOrg({ ownerId: owner.id, name: "Collections Org" });
  const branch = await createBranch({ organizationId: organization.id, name: "Central" });
  const sender = await testPrisma.whatsAppSender.create({
    data: {
      organizationId: organization.id,
      provider: "META_CLOUD",
      providerMode: "TEST",
      wabaId: "waba-reconciliation",
      phoneNumberId: "phone-reconciliation",
      displayPhoneNumber: PHONE_E164,
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
      automationEnabledAt: new Date("2025-12-31T00:00:00.000Z"),
      automationEnabledByUserId: owner.id,
      configurationRevision: 1,
    },
  });
  await testPrisma.whatsAppAutomationRule.create({
    data: {
      organizationId: organization.id,
      branchId: branch.id,
      stage: "FEE_DUE_TODAY",
      enabled: true,
    },
  });
  const multiBinding = await installManagedBinding(
    sender.id,
    "MULTI_STUDENT_COLLECTION_SUMMARY"
  );
  const singleBinding = await installManagedBinding(sender.id, "FEE_RENEWAL_POLITE");

  const studentA = await createStudent({
    branchId: branch.id,
    id: "student-a",
    name: "Student A",
    phone: "9999999999",
  });
  const studentB = await createStudent({
    branchId: branch.id,
    id: "student-b",
    name: "Student B",
    phone: "9999999999",
  });
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
    id: "payment-a",
    branchId: branch.id,
    studentId: studentA.id,
    amount: 1_000,
    status: "DUE",
    dueDate: NOW,
    periodStart: new Date("2025-12-01T00:00:00.000Z"),
    periodEnd: NOW,
  });
  const paymentB = await createPayment({
    id: "payment-b",
    branchId: branch.id,
    studentId: studentB.id,
    amount: 2_000,
    status: "DUE",
    dueDate: NOW,
    periodStart: new Date("2025-12-01T00:00:00.000Z"),
    periodEnd: NOW,
  });
  const laterPayment = await createPayment({
    id: "payment-later",
    branchId: branch.id,
    studentId: studentB.id,
    amount: 2_000,
    status: "DUE",
    dueDate: new Date("2026-02-01T00:00:00.000Z"),
    periodStart: NOW,
    periodEnd: new Date("2026-02-01T00:00:00.000Z"),
  });
  const manualRequest = await testPrisma.whatsAppManualSendRequest.create({
    data: {
      organizationId: organization.id,
      branchId: branch.id,
      actorUserId: owner.id,
      idempotencyKey: "payment-reconciliation-manual",
      requestHash: "request-hash",
      status: "QUEUED",
      selectedPaymentCount: 2,
      eligibleRecipientCount: 1,
      queuedMessageCount: 1,
      estimatedCostMicros: 800_000n,
    },
  });
  const common = {
    organizationId: organization.id,
    branchId: branch.id,
    senderId: sender.id,
    recipientPhoneE164: PHONE_E164,
    managedTemplateKey: "MULTI_STUDENT_COLLECTION_SUMMARY" as const,
    templateId: multiBinding.template.id,
    templateBindingId: multiBinding.binding.id,
    catalogVersion: multiBinding.definition.catalogVersion,
    catalogHash: multiBinding.definition.catalogHash,
    templateVersion: multiBinding.template.version,
    templateVariables: {
      studentCount: "2",
      amount: "3,000",
      branchName: branch.name,
      earliestDueDate: "01 Jan 2026",
    },
    renderedPreview: "original grouped preview",
    scheduledFor: SCHEDULED_FOR,
    availableAt: SCHEDULED_FOR,
    localScheduleDate: NOW,
    settingsRevision: 1,
    sourceFingerprint: "original-grouped-fingerprint",
    budgetMonth: "2026-01",
    budgetState: "RESERVED" as const,
    rateCardVersion: "test-rate-v1",
    estimatedCostMicros: 800_000n,
    currency: "INR",
  };
  const manualMessage = await testPrisma.whatsAppMessage.create({
    data: {
      ...common,
      manualSendRequestId: manualRequest.id,
      createdByUserId: owner.id,
      purpose: "MANUAL_REMINDER",
      trigger: "MANUAL",
      status: "SCHEDULED",
      dedupeKey: "manual-grouped-dedupe",
      paymentSources: {
        create: [{ paymentId: paymentA.id }, { paymentId: paymentB.id }],
      },
    },
  });
  const automaticMessage = await testPrisma.whatsAppMessage.create({
    data: {
      ...common,
      purpose: "FEE_RENEWAL",
      trigger: "AUTOMATION",
      automationStage: "FEE_DUE_TODAY",
      status: "CLAIMED",
      dedupeKey: "automatic-grouped-dedupe",
      frequencyKey: "automatic-grouped-frequency",
      leaseToken: "pre-submission-claim",
      leaseUntil: new Date("2026-01-01T00:10:00.000Z"),
      claimedAt: NOW,
      submissionStartedAt: null,
      paymentSources: {
        create: [{ paymentId: paymentA.id }, { paymentId: paymentB.id }],
      },
    },
  });
  const submittedMessage = await testPrisma.whatsAppMessage.create({
    data: {
      ...common,
      studentId: studentA.id,
      paymentId: paymentA.id,
      purpose: "MANUAL_REMINDER",
      trigger: "MANUAL",
      status: "ACCEPTED",
      dedupeKey: "submitted-payment-dedupe",
      providerMessageId: "wamid.submitted-payment",
      submissionStartedAt: new Date("2025-12-31T23:59:00.000Z"),
      acceptedAt: NOW,
      budgetState: "COMMITTED",
      paymentSources: { create: [{ paymentId: paymentA.id }] },
    },
  });
  const laterMessage = await testPrisma.whatsAppMessage.create({
    data: {
      ...common,
      studentId: studentB.id,
      paymentId: laterPayment.id,
      purpose: "MANUAL_REMINDER",
      trigger: "MANUAL",
      status: "SCHEDULED",
      dedupeKey: "later-payment-dedupe",
      scheduledFor: new Date("2026-02-01T04:30:00.000Z"),
      availableAt: new Date("2026-02-01T04:30:00.000Z"),
      localScheduleDate: new Date("2026-02-01T00:00:00.000Z"),
      budgetMonth: "2026-02",
      paymentSources: { create: [{ paymentId: laterPayment.id }] },
    },
  });

  return {
    owner,
    paymentA,
    paymentB,
    laterPayment,
    manualMessage,
    automaticMessage,
    submittedMessage,
    laterMessage,
    singleBinding,
  };
}

describe("payment-transition WhatsApp grouped-message reconciliation", () => {
  beforeEach(async () => {
    freezeTime(NOW);
    await resetDatabase();
  });

  afterAll(async () => {
    restoreTime();
    await disconnectDatabase();
  });

  it("refreshes MANUAL and pre-submission CLAIMED AUTOMATION groups around the remaining DUE payment", async () => {
    const world = await createReconciliationWorld();

    await PaymentService.markPaymentAsPaid(world.owner.id, world.paymentA.id, "CASH");

    const rows = await testPrisma.whatsAppMessage.findMany({
      where: { id: { in: [world.manualMessage.id, world.automaticMessage.id] } },
      orderBy: { trigger: "asc" },
      include: { paymentSources: { orderBy: { paymentId: "asc" } } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "SCHEDULED",
        budgetState: "RESERVED",
        paymentId: world.paymentB.id,
        studentId: "student-b",
        managedTemplateKey: "FEE_RENEWAL_POLITE",
        templateId: world.singleBinding.template.id,
        templateBindingId: world.singleBinding.binding.id,
        templateVariables: {
          studentName: "Student B",
          amount: "2,000",
          branchName: "Central",
        },
        leaseToken: null,
        leaseUntil: null,
        failureCode: null,
      });
      expect(row.renderedPreview).toContain("Student B");
      expect(row.renderedPreview).not.toContain("3,000");
      expect(row.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(row.paymentSources.map(source => source.paymentId)).toEqual([world.paymentB.id]);
    }
    expect(rows.find(row => row.trigger === "AUTOMATION")).toMatchObject({
      automationStage: "FEE_DUE_TODAY",
      purpose: "FEE_RENEWAL",
    });

    await expect(testPrisma.$transaction(tx => verifyAutomaticMessageSource({
      tx,
      messageId: world.automaticMessage.id,
      now: NOW,
    }))).resolves.toEqual({ valid: true });
    const manualTruth = await testPrisma.$transaction(tx =>
      deriveWhatsAppManualCollectionMessageRefresh({
        tx,
        messageId: world.manualMessage.id,
        now: NOW,
      })
    );
    expect(manualTruth).toMatchObject({ valid: true });
    if (manualTruth.valid) {
      expect(manualTruth.refresh.sourceFingerprint).toBe(
        rows.find(row => row.trigger === "MANUAL")!.sourceFingerprint
      );
    }

    await expect(testPrisma.payment.findUniqueOrThrow({ where: { id: world.paymentA.id } }))
      .resolves.toMatchObject({ status: "PAID" });
    await expect(testPrisma.payment.findUniqueOrThrow({ where: { id: world.paymentB.id } }))
      .resolves.toMatchObject({ status: "DUE" });
    await expect(testPrisma.payment.findUniqueOrThrow({ where: { id: world.laterPayment.id } }))
      .resolves.toMatchObject({ status: "DUE" });
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({ where: { id: world.laterMessage.id } }))
      .resolves.toMatchObject({ status: "SCHEDULED", budgetState: "RESERVED" });
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({ where: { id: world.submittedMessage.id } }))
      .resolves.toMatchObject({
        status: "ACCEPTED",
        budgetState: "COMMITTED",
        paymentId: world.paymentA.id,
        providerMessageId: "wamid.submitted-payment",
      });
  });

  it("waiving the last valid source cancels and releases the grouped rows without touching a later reminder", async () => {
    const world = await createReconciliationWorld();
    await testPrisma.payment.update({
      where: { id: world.paymentB.id },
      data: { status: "PAID", paidAt: NOW },
    });

    await PaymentService.markPaymentAsWaived(world.owner.id, world.paymentA.id);

    const rows = await testPrisma.whatsAppMessage.findMany({
      where: { id: { in: [world.manualMessage.id, world.automaticMessage.id] } },
      include: { paymentSources: true },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "CANCELLED",
        budgetState: "RELEASED",
        failureCode: "PAYMENT_RESOLVED",
        leaseToken: null,
        leaseUntil: null,
      });
      // Cancellation preserves the original grouped source history.
      expect(new Set(row.paymentSources.map(source => source.paymentId))).toEqual(
        new Set([world.paymentA.id, world.paymentB.id])
      );
    }
    await expect(testPrisma.payment.findUniqueOrThrow({ where: { id: world.paymentA.id } }))
      .resolves.toMatchObject({ status: "WAIVED" });
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({ where: { id: world.laterMessage.id } }))
      .resolves.toMatchObject({ status: "SCHEDULED", budgetState: "RESERVED" });
    await expect(testPrisma.whatsAppMessage.findUniqueOrThrow({ where: { id: world.submittedMessage.id } }))
      .resolves.toMatchObject({
        status: "ACCEPTED",
        budgetState: "COMMITTED",
        providerMessageId: "wamid.submitted-payment",
      });
  });
});
