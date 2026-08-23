import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  authorize: vi.fn(),
  assertIntegrationEnabled: vi.fn(),
  assertDeliverySchemaAccessEnabled: vi.fn(),
  resolveProviderMode: vi.fn(),
  assertBranchEntitlement: vi.fn(),
  assertBranchWritable: vi.fn(),
  recordConsent: vi.fn(),
  branchFindUnique: vi.fn(),
  branchFindFirst: vi.fn(),
  settingsFindFirst: vi.fn(),
  senderFindFirst: vi.fn(),
  studentFindFirst: vi.fn(),
  studentFindMany: vi.fn(),
  recipientFindUnique: vi.fn(),
  recipientFindFirst: vi.fn(),
  recipientFindMany: vi.fn(),
  recipientUpsert: vi.fn(),
  recipientUpdate: vi.fn(),
  recipientUpdateMany: vi.fn(),
  messageUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  auditCreateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    branch: { findUnique: mocks.branchFindUnique },
    branchWhatsAppSettings: { findFirst: mocks.settingsFindFirst },
    student: { findFirst: mocks.studentFindFirst },
    whatsAppStudentRecipient: { findFirst: mocks.recipientFindFirst },
  },
}));

vi.mock("@/lib/whatsappFeature", () => ({
  assertWhatsAppDeliverySchemaAccessEnabled: mocks.assertDeliverySchemaAccessEnabled,
  assertWhatsAppIntegrationEnabled: mocks.assertIntegrationEnabled,
  resolveWhatsAppProviderMode: mocks.resolveProviderMode,
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    assertBranchEntitlement: mocks.assertBranchEntitlement,
    assertBranchWritable: mocks.assertBranchWritable,
  },
}));

vi.mock("@/services/whatsappConsent.service", () => ({
  WhatsAppConsentService: { recordInTransaction: mocks.recordConsent },
}));

import {
  WhatsAppResourceNotFoundError,
  WhatsAppValidationError,
} from "@/lib/whatsappHttp";
import {
  MAX_WHATSAPP_RECIPIENT_BULK_SIZE,
  WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
  WHATSAPP_OPERATIONAL_CONSENT_STATEMENT,
  WhatsAppRecipientService,
} from "@/services/whatsappRecipient.service";

const tx = {
  $queryRaw: mocks.queryRaw,
  branch: { findUnique: mocks.branchFindUnique, findFirst: mocks.branchFindFirst },
  branchWhatsAppSettings: { findFirst: mocks.settingsFindFirst },
  whatsAppSender: { findFirst: mocks.senderFindFirst },
  student: {
    findFirst: mocks.studentFindFirst,
    findMany: mocks.studentFindMany,
  },
  whatsAppStudentRecipient: {
    findUnique: mocks.recipientFindUnique,
    findFirst: mocks.recipientFindFirst,
    findMany: mocks.recipientFindMany,
    upsert: mocks.recipientUpsert,
    update: mocks.recipientUpdate,
    updateMany: mocks.recipientUpdateMany,
  },
  whatsAppMessage: { updateMany: mocks.messageUpdateMany },
  whatsAppAuditEvent: {
    create: mocks.auditCreate,
    createMany: mocks.auditCreateMany,
  },
};

const ACTIVE_STUDENT = {
  id: "student_1",
  branchId: "branch_1",
  phone: "+91 98765 43210",
  status: "ACTIVE" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveProviderMode.mockReturnValue("TEST");
  mocks.queryRaw.mockResolvedValue([{ senderId: "sender_1" }]);
  mocks.branchFindUnique.mockResolvedValue({ id: "branch_1", organizationId: "org_1" });
  mocks.branchFindFirst.mockResolvedValue({ id: "branch_1" });
  mocks.settingsFindFirst.mockResolvedValue({ senderId: "sender_1" });
  mocks.senderFindFirst.mockResolvedValue({ id: "sender_1" });
  mocks.studentFindFirst.mockResolvedValue(ACTIVE_STUDENT);
  mocks.studentFindMany.mockResolvedValue([ACTIVE_STUDENT]);
  mocks.recipientFindUnique.mockResolvedValue(null);
  mocks.recipientFindMany.mockResolvedValue([]);
  mocks.recipientUpsert.mockResolvedValue({
    id: "recipient_1",
    studentId: "student_1",
    relationship: "GUARDIAN",
    status: "ACTIVE",
  });
  mocks.recipientUpdateMany.mockResolvedValue({ count: 0 });
  mocks.messageUpdateMany.mockResolvedValue({ count: 0 });
  mocks.auditCreate.mockResolvedValue({ id: "audit_1" });
  mocks.auditCreateMany.mockResolvedValue({ count: 0 });
  mocks.recordConsent.mockResolvedValue({
    consent: { id: "consent_1", status: "OPTED_IN" },
    changed: true,
  });
  mocks.transaction.mockImplementation(async callback => callback(tx));
});

describe("WhatsAppRecipientService association", () => {
  it("derives the current sender and atomically records consent plus an active mapping", async () => {
    await expect(WhatsAppRecipientService.associate({
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
      relationship: "GUARDIAN",
      attestation: true,
    })).resolves.toMatchObject({
      recipient: { id: "recipient_1", studentId: "student_1", status: "ACTIVE" },
      changed: true,
      consentChanged: true,
    });

    expect(mocks.authorize).toHaveBeenCalledWith(
      "user_1",
      "branch_1",
      "manage_whatsapp",
      tx
    );
    expect(mocks.senderFindFirst).toHaveBeenCalledWith({
      where: {
        id: "sender_1",
        organizationId: "org_1",
        provider: "META_CLOUD",
        providerMode: "TEST",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    expect(mocks.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: "branch_1",
        senderId: "sender_1",
        phone: "+919876543210",
        consentType: "OPERATIONAL",
        nextStatus: "OPTED_IN",
        policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
      }),
      tx,
      { authorizationAlreadyVerified: true, writeAudit: true }
    );
    expect(mocks.recipientUpsert).toHaveBeenCalledWith({
      where: {
        studentId_senderId: { studentId: "student_1", senderId: "sender_1" },
      },
      create: expect.objectContaining({
        organizationId: "org_1",
        branchId: "branch_1",
        studentId: "student_1",
        senderId: "sender_1",
        consentId: "consent_1",
        phoneE164: "+919876543210",
        relationship: "GUARDIAN",
        status: "ACTIVE",
      }),
      update: expect.objectContaining({
        consentId: "consent_1",
        phoneE164: "+919876543210",
        status: "ACTIVE",
      }),
    });
  });

  it("requires attestation and enforces the bulk bound before database work", async () => {
    await expect(WhatsAppRecipientService.associate({
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
      relationship: "SELF",
      attestation: false,
    })).rejects.toThrow("Invalid WhatsApp request");

    await expect(WhatsAppRecipientService.associateBulk({
      actorUserId: "user_1",
      branchId: "branch_1",
      attestation: true,
      recipients: Array.from(
        { length: MAX_WHATSAPP_RECIPIENT_BULK_SIZE + 1 },
        (_, index) => ({ studentId: `student_${index}`, relationship: "SELF" as const })
      ),
    })).rejects.toThrow("Invalid WhatsApp request");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails the whole bulk operation generically when any selected student is foreign", async () => {
    mocks.studentFindMany.mockResolvedValue([ACTIVE_STUDENT]);

    await expect(WhatsAppRecipientService.associateBulk({
      actorUserId: "user_1",
      branchId: "branch_1",
      attestation: true,
      recipients: [
        { studentId: "student_1", relationship: "SELF" },
        { studentId: "foreign_student", relationship: "GUARDIAN" },
      ],
    })).rejects.toBeInstanceOf(WhatsAppResourceNotFoundError);
    expect(mocks.recordConsent).not.toHaveBeenCalled();
    expect(mocks.recipientUpsert).not.toHaveBeenCalled();
  });

  it("skips inactive and invalid-phone students with bounded reasons", async () => {
    mocks.studentFindMany.mockResolvedValue([
      { ...ACTIVE_STUDENT, id: "inactive", status: "INACTIVE" },
      { ...ACTIVE_STUDENT, id: "invalid", phone: "not-a-phone" },
    ]);

    await expect(WhatsAppRecipientService.associateBulk({
      actorUserId: "user_1",
      branchId: "branch_1",
      attestation: true,
      recipients: [
        { studentId: "inactive", relationship: "SELF" },
        { studentId: "invalid", relationship: "GUARDIAN" },
      ],
    })).resolves.toEqual({
      requestedCount: 2,
      associatedCount: 0,
      unchangedCount: 0,
      skipped: [
        { studentId: "inactive", reason: "STUDENT_INACTIVE" },
        { studentId: "invalid", reason: "INVALID_PHONE" },
      ],
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "BULK_OPERATIONAL_CONSENT_RECORDED",
        details: expect.objectContaining({ requestedCount: 2, skippedCount: 2 }),
      }),
    });
  });
});

describe("WhatsAppRecipientService read projection", () => {
  it("tenant-scopes the current sender mapping and returns no raw phone", async () => {
    mocks.settingsFindFirst.mockResolvedValue({
      sender: {
        id: "sender_1",
        organizationId: "org_1",
        providerMode: "TEST",
        status: "ACTIVE",
        displayPhoneNumber: "+919900001234",
        verifiedName: "Central Study Hall",
      },
    });
    mocks.recipientFindFirst.mockResolvedValue({
      id: "recipient_1",
      studentId: "student_1",
      relationship: "GUARDIAN",
      status: "ACTIVE",
      phoneE164: "+919876543210",
      verifiedAt: new Date("2026-08-20T10:00:00.000Z"),
      staleAt: null,
      disabledAt: null,
      consent: {
        status: "OPTED_IN",
        consentType: "OPERATIONAL",
        source: "IN_PERSON",
        policyVersion: "operational-collections-v1",
        grantedAt: new Date("2026-08-20T10:01:00.000Z"),
        revokedAt: null,
        updatedAt: new Date("2026-08-20T10:01:00.000Z"),
      },
    });

    const result = await WhatsAppRecipientService.getForStudent({
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
    });

    expect(mocks.authorize).toHaveBeenCalledWith(
      "user_1",
      "branch_1",
      "view_whatsapp",
      expect.anything()
    );
    expect(mocks.recipientFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        organizationId: "org_1",
        branchId: "branch_1",
        studentId: "student_1",
        senderId: "sender_1",
      },
    }));
    expect(result).toMatchObject({
      studentId: "student_1",
      maskedPhone: "••••••3210",
      studentMaskedPhone: "••••••3210",
      assignedSender: {
        status: "ACTIVE",
        verifiedName: "Central Study Hall",
        maskedPhone: "••••••1234",
      },
      recipient: {
        relationship: "GUARDIAN",
        consentStatus: "OPTED_IN",
        maskedPhone: "••••••3210",
        phoneMatchesCurrentStudent: true,
        consentSource: "IN_PERSON",
        consentRecordedAt: "2026-08-20T10:01:00.000Z",
        verifiedAt: "2026-08-20T10:00:00.000Z",
        staleAt: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("+919876543210");
    expect(JSON.stringify(result)).not.toContain("+919900001234");
    expect(WHATSAPP_OPERATIONAL_CONSENT_STATEMENT).toContain(
      "Promotional messages are not included."
    );
  });

  it("returns bounded stale-phone and opt-out evidence without leaking either raw phone", async () => {
    mocks.studentFindFirst.mockResolvedValue({
      ...ACTIVE_STUDENT,
      phone: "+919999999999",
    });
    mocks.settingsFindFirst.mockResolvedValue({
      sender: {
        id: "sender_1",
        organizationId: "org_1",
        providerMode: "TEST",
        status: "ACTIVE",
        displayPhoneNumber: "+919900001234",
        verifiedName: null,
      },
    });
    mocks.recipientFindFirst.mockResolvedValue({
      id: "recipient_1",
      studentId: "student_1",
      relationship: "GUARDIAN",
      status: "DISABLED",
      phoneE164: "+919876543210",
      verifiedAt: new Date("2026-08-20T10:00:00.000Z"),
      staleAt: new Date("2026-08-21T10:00:00.000Z"),
      disabledAt: new Date("2026-08-22T10:00:00.000Z"),
      consent: {
        status: "OPTED_OUT",
        consentType: "OPERATIONAL",
        source: "WHATSAPP_REPLY",
        policyVersion: "operational-collections-v1",
        grantedAt: new Date("2026-08-20T10:01:00.000Z"),
        revokedAt: new Date("2026-08-22T10:00:00.000Z"),
        updatedAt: new Date("2026-08-22T10:00:00.000Z"),
      },
    });

    const result = await WhatsAppRecipientService.getForStudent({
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
    });

    expect(result).toMatchObject({
      studentMaskedPhone: "••••••9999",
      recipient: {
        status: "DISABLED",
        consentStatus: "OPTED_OUT",
        consentSource: "WHATSAPP_REPLY",
        phoneMatchesCurrentStudent: false,
        staleAt: "2026-08-21T10:00:00.000Z",
        disabledAt: "2026-08-22T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/\+919999999999|\+919876543210/);
  });
});

describe("WhatsAppRecipientService reconciliation", () => {
  it("rejects a cancellation without an explicit tenant boundary", async () => {
    await expect(WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
      tx: tx as never,
      scope: { senderId: "sender_1" },
      reason: "SENDER_DISABLED",
    })).rejects.toBeInstanceOf(WhatsAppValidationError);

    expect(mocks.messageUpdateMany).not.toHaveBeenCalled();
  });

  it("cancels only scheduled or pre-submission claimed messages and releases only reserved cost", async () => {
    mocks.messageUpdateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(WhatsAppRecipientService.cancelUnsubmittedMessagesInTransaction({
      tx: tx as never,
      scope: {
        branchId: "branch_1",
        studentId: "student_1",
        trigger: "AUTOMATION",
        automationStage: "PAST_DUE_PLUS_3",
      },
      reason: "STUDENT_INACTIVE",
      now: new Date("2026-08-23T10:00:00.000Z"),
    })).resolves.toMatchObject({
      affectedCount: 3,
      releasedReservationCount: 2,
    });

    expect(mocks.messageUpdateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        branchId: "branch_1",
        trigger: "AUTOMATION",
        automationStage: "PAST_DUE_PLUS_3",
        budgetState: "RESERVED",
        AND: expect.arrayContaining([
          {
            OR: [
              { status: "SCHEDULED" },
              { status: "CLAIMED", submissionStartedAt: null },
            ],
          },
          {
            OR: [
              { studentId: "student_1" },
              {
                paymentSources: {
                  some: { payment: { studentId: "student_1" } },
                },
              },
            ],
          },
        ]),
      }),
      data: expect.objectContaining({
        status: "CANCELLED",
        failureCode: "STUDENT_INACTIVE",
        budgetState: "RELEASED",
        leaseToken: null,
        leaseUntil: null,
      }),
    });
    expect(mocks.messageUpdateMany).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({ budgetState: { not: "RESERVED" } }),
      data: expect.not.objectContaining({ budgetState: "RELEASED" }),
    });
  });

  it("marks mismatched active mappings stale during a phone change without changing consent", async () => {
    mocks.recipientFindMany.mockResolvedValue([
      { id: "recipient_1", organizationId: "org_1", branchId: "branch_1", senderId: "sender_1" },
    ]);
    mocks.recipientUpdateMany.mockResolvedValue({ count: 1 });

    await WhatsAppRecipientService.reconcileStudentPhoneChangeInTransaction({
      tx: tx as never,
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
      newPhone: "91234 56789",
      now: new Date("2026-08-23T10:00:00.000Z"),
    });

    expect(mocks.recipientFindMany).toHaveBeenCalledWith({
      where: {
        branchId: "branch_1",
        studentId: "student_1",
        status: "ACTIVE",
        phoneE164: { not: "+919123456789" },
      },
      select: { id: true, organizationId: true, branchId: true, senderId: true },
    });
    expect(mocks.recipientUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["recipient_1"] }, status: "ACTIVE" },
      data: { status: "STALE", staleAt: expect.any(Date) },
    });
    expect(mocks.recordConsent).not.toHaveBeenCalled();
  });
});
