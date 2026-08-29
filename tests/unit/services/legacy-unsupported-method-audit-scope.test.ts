import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  fetchSubscription: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organizationBillingChange: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
  },
}));

vi.mock("@/lib/razorpay", () => ({
  resolveRazorpayMode: () => "TEST",
  getRazorpayClient: () => ({ fetchSubscription: mocks.fetchSubscription }),
}));

import { LegacyUnsupportedMethodAuditService } from "@/services/legacyUnsupportedMethodAudit.service";

describe("legacy unsupported-method audit organization scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
  });

  it("filters the candidate query before any provider fetch", async () => {
    await expect(LegacyUnsupportedMethodAuditService.run({
      apply: true,
      organizationIds: ["org_a", "org_b"],
    })).resolves.toMatchObject({ apply: true, count: 0 });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organizationId: { in: ["org_a", "org_b"] },
      }),
    }));
    expect(mocks.fetchSubscription).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
