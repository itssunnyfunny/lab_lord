import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn() },
  tx: {
    whatsAppOperationalIncident: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    whatsAppAuditEvent: { create: vi.fn() },
  },
  authorize: vi.fn(),
  assertBranchWritable: vi.fn(),
  assertOwnerEntitled: vi.fn(),
  assertOwnerCanWrite: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));
vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    assertBranchEntitlement: vi.fn(),
    assertBranchWritable: mocks.assertBranchWritable,
  },
}));
vi.mock("@/services/whatsappAuthorization.service", () => ({
  WhatsAppAuthorizationService: {
    assertOwnerEntitled: mocks.assertOwnerEntitled,
    assertOwnerCanWrite: mocks.assertOwnerCanWrite,
  },
}));

import { WhatsAppIncidentService } from "@/services/whatsappIncident.service";

const openIncident = {
  id: "incident_1",
  organizationId: "org_1",
  branchId: "branch_1",
  senderId: "sender_1",
  type: "UNKNOWN_OUTCOME",
  severity: "WARNING",
  status: "OPEN",
};

describe("WhatsApp incident acknowledgement authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async callback => callback(mocks.tx));
    mocks.authorize.mockResolvedValue(true);
    mocks.assertBranchWritable.mockResolvedValue({ canWrite: true });
    mocks.assertOwnerCanWrite.mockResolvedValue({ id: "org_1" });
    mocks.tx.whatsAppOperationalIncident.findFirst.mockResolvedValue(openIncident);
    mocks.tx.whatsAppOperationalIncident.update.mockResolvedValue({
      ...openIncident,
      status: "ACKNOWLEDGED",
    });
    mocks.tx.whatsAppAuditEvent.create.mockResolvedValue({ id: "audit_1" });
  });

  it("rechecks branch writability before and inside the acknowledgement transaction", async () => {
    await expect(WhatsAppIncidentService.acknowledge({
      actorUserId: "user_1",
      branchId: "branch_1",
      incidentId: "incident_1",
    })).resolves.toMatchObject({ status: "ACKNOWLEDGED" });

    expect(mocks.authorize).toHaveBeenNthCalledWith(
      1,
      "user_1",
      "branch_1",
      "manage_whatsapp"
    );
    expect(mocks.authorize).toHaveBeenNthCalledWith(
      2,
      "user_1",
      "branch_1",
      "manage_whatsapp",
      mocks.tx
    );
    expect(mocks.assertBranchWritable).toHaveBeenNthCalledWith(1, "branch_1");
    expect(mocks.assertBranchWritable).toHaveBeenNthCalledWith(2, "branch_1", mocks.tx);
  });

  it("uses writable owner authorization before and inside the acknowledgement transaction", async () => {
    await expect(WhatsAppIncidentService.acknowledge({
      actorUserId: "owner_1",
      organizationId: "org_1",
      incidentId: "incident_1",
    })).resolves.toMatchObject({ status: "ACKNOWLEDGED" });

    expect(mocks.assertOwnerCanWrite).toHaveBeenNthCalledWith(1, "owner_1", "org_1");
    expect(mocks.assertOwnerCanWrite).toHaveBeenNthCalledWith(
      2,
      "owner_1",
      "org_1",
      mocks.tx
    );
    expect(mocks.assertOwnerEntitled).not.toHaveBeenCalled();
  });
});
