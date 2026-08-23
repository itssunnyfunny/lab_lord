import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertIntegrationEnabled: vi.fn(),
  authorize: vi.fn(),
  assertBranchEntitlement: vi.fn(),
  assertBranchWritable: vi.fn(),
  transaction: vi.fn(),
  branchFindUnique: vi.fn(),
  senderFindFirst: vi.fn(),
  consentFindUnique: vi.fn(),
  consentCreate: vi.fn(),
  consentUpdate: vi.fn(),
  consentEventCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/whatsappFeature", () => ({
  assertWhatsAppIntegrationEnabled: mocks.assertIntegrationEnabled,
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

import { WhatsAppConsentService } from "@/services/whatsappConsent.service";

const INPUT = {
  actorUserId: "user_1",
  branchId: "branch_1",
  senderId: "sender_1",
  phone: "(98765) 43210",
  consentType: "OPERATIONAL" as const,
  nextStatus: "OPTED_IN" as const,
  source: "OWNER_CONFIGURATION" as const,
  details: { reason: "written form" },
};

const tx = {
  branch: { findUnique: mocks.branchFindUnique },
  whatsAppSender: { findFirst: mocks.senderFindFirst },
  whatsAppConsent: {
    findUnique: mocks.consentFindUnique,
    create: mocks.consentCreate,
    update: mocks.consentUpdate,
  },
  whatsAppConsentEvent: { create: mocks.consentEventCreate },
  whatsAppAuditEvent: { create: mocks.auditCreate },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branchFindUnique.mockResolvedValue({ organizationId: "org_1" });
  mocks.senderFindFirst.mockResolvedValue({ id: "sender_1" });
  mocks.consentFindUnique.mockResolvedValue(null);
  mocks.consentCreate.mockResolvedValue({
    id: "consent_1",
    status: "OPTED_IN",
  });
  mocks.consentUpdate.mockResolvedValue({
    id: "consent_1",
    status: "OPTED_IN",
  });
  mocks.consentEventCreate.mockResolvedValue({ id: "event_1" });
  mocks.auditCreate.mockResolvedValue({ id: "audit_1" });
  mocks.transaction.mockImplementation(async callback => callback(tx));
});

describe("WhatsAppConsentService.record", () => {
  it("fails closed at the integration gate before entitlement or database work", async () => {
    mocks.assertIntegrationEnabled.mockImplementationOnce(() => {
      throw new Error("integration disabled");
    });

    await expect(WhatsAppConsentService.record(INPUT)).rejects.toThrow(
      "integration disabled"
    );
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.assertBranchEntitlement).not.toHaveBeenCalled();
    expect(mocks.assertBranchWritable).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the branch lacks the WhatsApp entitlement", async () => {
    mocks.assertBranchEntitlement.mockRejectedValueOnce(
      new Error("entitlement unavailable")
    );

    await expect(WhatsAppConsentService.record(INPUT)).rejects.toThrow(
      "entitlement unavailable"
    );
    expect(mocks.assertBranchEntitlement).toHaveBeenCalledWith(
      "branch_1",
      "WHATSAPP_AUTOMATION"
    );
    expect(mocks.assertBranchWritable).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("normalizes the recipient and creates consent, immutable event, and audit in one transaction", async () => {
    await expect(WhatsAppConsentService.record(INPUT)).resolves.toMatchObject({
      changed: true,
      consent: { id: "consent_1" },
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.consentFindUnique).toHaveBeenCalledWith({
      where: {
        senderId_phoneE164_consentType: {
          senderId: "sender_1",
          phoneE164: "+919876543210",
          consentType: "OPERATIONAL",
        },
      },
    });
    expect(mocks.consentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        senderId: "sender_1",
        phoneE164: "+919876543210",
        status: "OPTED_IN",
        grantedAt: expect.any(Date),
        revokedAt: null,
      }),
    });
    expect(mocks.consentEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consentId: "consent_1",
        senderId: "sender_1",
        phoneE164: "+919876543210",
        previousStatus: "UNKNOWN",
        nextStatus: "OPTED_IN",
        details: { reason: "written form" },
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org_1",
        branchId: "branch_1",
        senderId: "sender_1",
        action: "CONSENT_CHANGED",
      }),
    });
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.assertBranchEntitlement).toHaveBeenCalledTimes(2);
    expect(mocks.assertBranchWritable).toHaveBeenCalledTimes(2);
  });

  it("returns an unchanged result without appending an event or audit for a no-op status", async () => {
    const existing = {
      id: "consent_1",
      status: "OPTED_IN",
      grantedAt: new Date("2026-08-01T00:00:00.000Z"),
      revokedAt: null,
    };
    mocks.consentFindUnique.mockResolvedValue(existing);

    await expect(WhatsAppConsentService.record(INPUT)).resolves.toEqual({
      consent: existing,
      changed: false,
    });
    expect(mocks.consentCreate).not.toHaveBeenCalled();
    expect(mocks.consentUpdate).not.toHaveBeenCalled();
    expect(mocks.consentEventCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
