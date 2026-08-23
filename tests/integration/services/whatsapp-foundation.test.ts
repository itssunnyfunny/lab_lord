import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBranch, createOrg, createPayment, createStaff, createStudent, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

async function foundationCounts() {
  const [
    senders,
    connectionIntents,
    branchSettings,
    templates,
    consents,
    consentEvents,
    messages,
    messageEvents,
    webhookReceipts,
    auditEvents,
  ] = await Promise.all([
    testPrisma.whatsAppSender.count(),
    testPrisma.whatsAppConnectionIntent.count(),
    testPrisma.branchWhatsAppSettings.count(),
    testPrisma.whatsAppTemplate.count(),
    testPrisma.whatsAppConsent.count(),
    testPrisma.whatsAppConsentEvent.count(),
    testPrisma.whatsAppMessage.count(),
    testPrisma.whatsAppMessageEvent.count(),
    testPrisma.whatsAppWebhookReceipt.count(),
    testPrisma.whatsAppAuditEvent.count(),
  ]);

  return {
    senders,
    connectionIntents,
    branchSettings,
    templates,
    consents,
    consentEvents,
    messages,
    messageEvents,
    webhookReceipts,
    auditEvents,
  };
}

async function existingDomainCounts() {
  const [organizations, branches, payments, paymentResolutionEvents, staffPermissionOverrides] =
    await Promise.all([
      testPrisma.organization.count(),
      testPrisma.branch.count(),
      testPrisma.payment.count(),
      testPrisma.paymentResolutionEvent.count(),
      testPrisma.staffPermissionOverride.count(),
    ]);

  return { organizations, branches, payments, paymentResolutionEvents, staffPermissionOverrides };
}

async function expectUniqueViolation(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({ code: "P2002" });
}

async function createSender(input: {
  organizationId: string;
  providerMode?: "TEST" | "LIVE";
  phoneNumberId: string;
  wabaId?: string;
}) {
  return testPrisma.whatsAppSender.create({
    data: {
      organizationId: input.organizationId,
      provider: "META_CLOUD",
      providerMode: input.providerMode ?? "TEST",
      wabaId: input.wabaId ?? `waba-${input.phoneNumberId}`,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: "+91 98765 43210",
    },
  });
}

describe("WhatsApp foundation database integration", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it("starts with all foundation tables empty and does not auto-enable branches", async () => {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id });
    await createBranch({ organizationId: organization.id, name: "North Branch" });
    await createBranch({ organizationId: organization.id, name: "South Branch" });

    expect(await foundationCounts()).toEqual({
      senders: 0,
      connectionIntents: 0,
      branchSettings: 0,
      templates: 0,
      consents: 0,
      consentEvents: 0,
      messages: 0,
      messageEvents: 0,
      webhookReceipts: 0,
      auditEvents: 0,
    });
    expect(await testPrisma.branchWhatsAppSettings.count({ where: { enabled: true } })).toBe(0);
  });

  it("partitions sender identity by provider mode and permits one sender across several branches", async () => {
    const owner = await createUser();
    const organization = await createOrg({ ownerId: owner.id });
    const otherOrganization = await createOrg({ ownerId: owner.id, name: "Other Organization" });
    const north = await createBranch({ organizationId: organization.id, name: "North Branch" });
    const south = await createBranch({ organizationId: organization.id, name: "South Branch" });
    const testSender = await createSender({
      organizationId: organization.id,
      providerMode: "TEST",
      phoneNumberId: "10001",
    });

    await expectUniqueViolation(
      createSender({
        organizationId: otherOrganization.id,
        providerMode: "TEST",
        phoneNumberId: "10001",
        wabaId: "other-waba",
      })
    );
    await expect(
      createSender({
        organizationId: organization.id,
        providerMode: "LIVE",
        phoneNumberId: "10001",
        wabaId: "live-waba",
      })
    ).resolves.toMatchObject({ providerMode: "LIVE", phoneNumberId: "10001" });

    await testPrisma.branchWhatsAppSettings.createMany({
      data: [
        { branchId: north.id, organizationId: organization.id, senderId: testSender.id },
        { branchId: south.id, organizationId: organization.id, senderId: testSender.id },
      ],
    });
    expect(
      await testPrisma.branchWhatsAppSettings.findMany({
        where: { senderId: testSender.id },
        orderBy: { branchId: "asc" },
      })
    ).toHaveLength(2);

    const alternateSender = await createSender({
      organizationId: organization.id,
      providerMode: "TEST",
      phoneNumberId: "10002",
    });
    await expectUniqueViolation(
      testPrisma.branchWhatsAppSettings.create({
        data: {
          branchId: north.id,
          organizationId: organization.id,
          senderId: alternateSender.id,
        },
      })
    );
  });

  it("enforces consent and dedupe identities without changing existing-domain counts", async () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    const owner = await createUser();
    const staffUser = await createUser();
    const organization = await createOrg({ ownerId: owner.id });
    const branch = await createBranch({ organizationId: organization.id });
    const student = await createStudent({ branchId: branch.id, phone: "9876543210" });
    const payment = await createPayment({
      branchId: branch.id,
      studentId: student.id,
      status: "PAID",
      dueDate: now,
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-31T23:59:59.999Z"),
      paidAt: now,
      paymentMethod: "CASH",
    });
    const paymentResolution = await testPrisma.paymentResolutionEvent.create({
      data: {
        paymentId: payment.id,
        branchId: branch.id,
        actorUserId: owner.id,
        source: "PAYMENT_ACTION",
        fromStatus: "DUE",
        toStatus: "PAID",
        amount: payment.amount,
        paymentType: payment.type,
        periodStart: payment.periodStart,
        dueDate: payment.dueDate,
        paidAt: now,
        paymentMethod: "CASH",
      },
    });
    const staff = await createStaff({ userId: staffUser.id, branchId: branch.id });
    await testPrisma.staffPermissionOverride.create({
      data: { staffId: staff.id, action: "VIEW_WHATSAPP", allowed: true },
    });
    const baseline = await existingDomainCounts();

    const sender = await createSender({ organizationId: organization.id, phoneNumberId: "20001" });
    await testPrisma.branchWhatsAppSettings.create({
      data: { branchId: branch.id, organizationId: organization.id, senderId: sender.id },
    });
    await testPrisma.whatsAppConsent.create({
      data: {
        senderId: sender.id,
        phoneE164: "+919876543210",
        consentType: "OPERATIONAL",
        status: "OPTED_IN",
        source: "IN_PERSON",
        grantedAt: now,
        recordedByUserId: owner.id,
      },
    });
    await expectUniqueViolation(
      testPrisma.whatsAppConsent.create({
        data: {
          senderId: sender.id,
          phoneE164: "+919876543210",
          consentType: "OPERATIONAL",
          source: "OWNER_CONFIGURATION",
        },
      })
    );
    await expect(
      testPrisma.whatsAppConsent.create({
        data: {
          senderId: sender.id,
          phoneE164: "+919876543210",
          consentType: "MARKETING",
          source: "IN_PERSON",
        },
      })
    ).resolves.toMatchObject({ consentType: "MARKETING" });

    const messageData = {
      organizationId: organization.id,
      branchId: branch.id,
      senderId: sender.id,
      studentId: student.id,
      paymentId: payment.id,
      paymentResolutionEventId: paymentResolution.id,
      createdByUserId: owner.id,
      recipientPhoneE164: "+919876543210",
      purpose: "PAYMENT_CONFIRMATION" as const,
      trigger: "MANUAL" as const,
      sourceFingerprint: "message-source-fingerprint-20001",
      templateVariables: {},
      scheduledFor: now,
      availableAt: now,
      dedupeKey: "message-dedupe-20001",
    };
    await testPrisma.whatsAppMessage.create({ data: messageData });
    await expectUniqueViolation(
      testPrisma.whatsAppMessage.create({
        data: { ...messageData, recipientPhoneE164: "+919999999999" },
      })
    );

    const receiptData = {
      providerMode: "TEST" as const,
      dedupeKey: "webhook-dedupe-20001",
      payloadHash: "webhook-payload-hash-20001",
      signatureVersion: "sha256",
      organizationId: organization.id,
      senderId: sender.id,
      wabaId: sender.wabaId,
      phoneNumberId: sender.phoneNumberId,
      eventType: "messages",
    };
    await testPrisma.whatsAppWebhookReceipt.create({ data: receiptData });
    await expectUniqueViolation(
      testPrisma.whatsAppWebhookReceipt.create({
        data: { ...receiptData, payloadHash: "different-payload-hash" },
      })
    );

    expect(await foundationCounts()).toEqual({
      senders: 1,
      connectionIntents: 0,
      branchSettings: 1,
      templates: 0,
      consents: 2,
      consentEvents: 0,
      messages: 1,
      messageEvents: 0,
      webhookReceipts: 1,
      auditEvents: 0,
    });
    expect(await existingDomainCounts()).toEqual(baseline);
  });
});
