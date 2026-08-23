import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertBranchEntitlement: vi.fn(),
  assertBranchWritable: vi.fn(),
  getBranchAccess: vi.fn(),
  staffAuthorize: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    assertBranchEntitlement: mocks.assertBranchEntitlement,
    assertBranchWritable: mocks.assertBranchWritable,
  },
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: {
    authorize: mocks.staffAuthorize,
    getBranchAccess: mocks.getBranchAccess,
  },
}));

import { WhatsAppAutomationService } from "@/services/whatsappAutomation.service";
import { WhatsAppMessageService } from "@/services/whatsappMessage.service";

describe("WhatsApp automation entitlement boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WHATSAPP_INTEGRATION_ENABLED", "true");
    vi.stubEnv("WHATSAPP_META_TEMPLATE_WRITES_ENABLED", "true");
    vi.stubEnv("WHATSAPP_META_MESSAGE_WRITES_ENABLED", "true");
    vi.stubEnv("WHATSAPP_AUTOMATION_PLANNER_ENABLED", "true");
    vi.stubEnv("META_WHATSAPP_MODE", "TEST");
    mocks.staffAuthorize.mockResolvedValue(undefined);
    mocks.assertBranchEntitlement.mockRejectedValue(
      new Error("whatsapp automation requires an upgraded subscription plan")
    );
  });

  it("denies settings reads before querying delivery state", async () => {
    await expect(WhatsAppAutomationService.get({
      actorUserId: "user_basic",
      branchId: "branch_basic",
    })).rejects.toThrow("upgraded subscription plan");

    expect(mocks.assertBranchEntitlement).toHaveBeenCalledWith(
      "branch_basic",
      "WHATSAPP_AUTOMATION",
      expect.anything()
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("denies settings mutations before opening their transaction", async () => {
    await expect(WhatsAppAutomationService.update({
      actorUserId: "user_basic",
      branchId: "branch_basic",
      changes: { sendTimeLocal: "10:30" },
    })).rejects.toThrow("upgraded subscription plan");

    expect(mocks.assertBranchWritable).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("denies manual preview and queueing before any reservation transaction", async () => {
    await expect(WhatsAppMessageService.previewPaymentReminders({
      actorUserId: "user_basic",
      branchId: "branch_basic",
      paymentIds: ["payment_1"],
    })).rejects.toThrow("upgraded subscription plan");
    await expect(WhatsAppMessageService.queuePaymentReminders({
      actorUserId: "user_basic",
      branchId: "branch_basic",
      paymentIds: ["payment_1"],
      idempotencyKey: "basic-request-0001",
    })).rejects.toThrow("upgraded subscription plan");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("denies message history before access or message queries", async () => {
    await expect(WhatsAppMessageService.history({
      actorUserId: "user_basic",
      branchId: "branch_basic",
      cursor: null,
      limit: 20,
    })).rejects.toThrow("upgraded subscription plan");

    expect(mocks.getBranchAccess).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
