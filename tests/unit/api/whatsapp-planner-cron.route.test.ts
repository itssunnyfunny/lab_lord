import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/services/whatsappPlanner.service", () => ({
  WhatsAppPlannerService: { run: mocks.run },
}));

describe("GET /api/cron/whatsapp/plan", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "planner-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("fails closed when CRON_SECRET is absent or not an exact match", async () => {
    const { GET } = await import("@/app/api/cron/whatsapp/plan/route");
    delete process.env.CRON_SECRET;
    const missing = await GET(new Request("http://test.local/api/cron/whatsapp/plan"));
    process.env.CRON_SECRET = "planner-secret";
    const wrong = await GET(new Request("http://test.local/api/cron/whatsapp/plan", {
      headers: { authorization: "Bearer wrong-secret" },
    }));

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("returns only bounded aggregate planner results", async () => {
    mocks.run.mockResolvedValue({
      held: false,
      claimedBranches: 2,
      completedBranches: 2,
      failedBranches: 0,
      plannedMessages: 7,
      skippedCandidates: 3,
      cancelledMessages: 1,
      limitReached: false,
    });
    const { GET } = await import("@/app/api/cron/whatsapp/plan/route");
    const response = await GET(new Request("http://test.local/api/cron/whatsapp/plan", {
      headers: { authorization: "Bearer planner-secret" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      held: false,
      claimedBranches: 2,
      completedBranches: 2,
      failedBranches: 0,
      plannedMessages: 7,
      skippedCandidates: 3,
      cancelledMessages: 1,
      limitReached: false,
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it("schedules the planner every 15 minutes without replacing existing crons", () => {
    const configuration = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(configuration.crons).toEqual(expect.arrayContaining([
      { path: "/api/cron/payments/daily", schedule: "0 0 * * *" },
      { path: "/api/cron/billing/hourly", schedule: "0 * * * *" },
      { path: "/api/cron/imports/daily", schedule: "30 0 * * *" },
      { path: "/api/cron/whatsapp/plan", schedule: "*/15 * * * *" },
    ]));
  });
});
