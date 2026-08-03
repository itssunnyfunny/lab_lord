import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/services/billingDeadline.service", () => ({
  BillingDeadlineService: { run: mocks.run },
}));

describe("GET /api/cron/billing/hourly", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "billing-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("rejects missing or invalid authorization", async () => {
    const { GET } = await import("@/app/api/cron/billing/hourly/route");
    const response = await GET(new Request("http://test.local/api/cron/billing/hourly"));
    expect(response.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("runs reconciliation with the configured bearer secret", async () => {
    mocks.run.mockResolvedValue({ expiredTrials: 1, errors: [] });
    const { GET } = await import("@/app/api/cron/billing/hourly/route");
    const response = await GET(new Request("http://test.local/api/cron/billing/hourly", {
      headers: { authorization: "Bearer billing-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, expiredTrials: 1, errors: [] });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
