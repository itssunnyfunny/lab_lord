import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    whatsAppReportSubscription: { updateMany: mocks.updateMany },
  },
}));

import { WhatsAppReportPlannerService } from "@/services/whatsappReportPlanner.service";

const ENABLED_ENV = {
  WHATSAPP_INTEGRATION_ENABLED: "true",
  WHATSAPP_REPORTS_ENABLED: "true",
  WHATSAPP_REPORT_PLANNER_ENABLED: "true",
  META_WHATSAPP_MODE: "TEST",
  NODE_ENV: "test",
};

describe("WhatsApp report planner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async callback => callback({ $queryRaw: mocks.queryRaw }));
  });

  it("holds without touching report state when planner flags are off", async () => {
    await expect(WhatsAppReportPlannerService.run({
      now: new Date("2026-08-23T15:30:00.000Z"),
      env: { ...ENABLED_ENV, WHATSAPP_REPORT_PLANNER_ENABLED: "false" },
    })).resolves.toMatchObject({ held: true, claimedSubscriptions: 0 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("claims one bounded leased subscription from the fair SQL selection", async () => {
    mocks.queryRaw.mockResolvedValue([{ id: "subscription_1" }]);
    const claim = await WhatsAppReportPlannerService.claimNextSubscription({
      now: new Date("2026-08-23T15:30:00.000Z"),
      env: ENABLED_ENV,
    });
    expect(claim).toEqual({
      subscriptionId: "subscription_1",
      leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });
});
