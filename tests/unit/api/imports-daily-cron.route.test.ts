import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    purgeExpiredStaging: vi.fn(),
    countExpiredStaging: vi.fn(),
}));

vi.mock("@/importing/services/import-retention.service", () => ({
    ImportRetentionService: {
        purgeExpiredStaging: mocks.purgeExpiredStaging,
        countExpiredStaging: mocks.countExpiredStaging,
    },
}));

describe("GET /api/cron/imports/daily", () => {
    const originalSecret = process.env.CRON_SECRET;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.CRON_SECRET = "imports-secret";
        mocks.countExpiredStaging.mockResolvedValue(0);
    });

    afterEach(() => {
        if (originalSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = originalSecret;
    });

    it("fails closed when CRON_SECRET is absent or the bearer token is wrong", async () => {
        const { GET } = await import("@/app/api/cron/imports/daily/route");
        delete process.env.CRON_SECRET;
        const missingSecret = await GET(new Request("http://test.local/api/cron/imports/daily"));
        process.env.CRON_SECRET = "imports-secret";
        const wrongSecret = await GET(new Request("http://test.local/api/cron/imports/daily", {
            headers: { authorization: "Bearer wrong" },
        }));

        expect(missingSecret.status).toBe(401);
        expect(wrongSecret.status).toBe(401);
        expect(mocks.purgeExpiredStaging).not.toHaveBeenCalled();
    });

    it("drains successive bounded batches and returns aggregate/backlog totals", async () => {
        mocks.purgeExpiredStaging
            .mockResolvedValueOnce({
                selectedCount: 100,
                scrubbedRunItemCount: 180,
                purgedSessionCount: 100,
                hasMore: true,
            })
            .mockResolvedValueOnce({
                selectedCount: 2,
                scrubbedRunItemCount: 4,
                purgedSessionCount: 2,
                hasMore: false,
            });
        const { GET } = await import("@/app/api/cron/imports/daily/route");

        const response = await GET(new Request("http://test.local/api/cron/imports/daily", {
            headers: { authorization: "Bearer imports-secret" },
        }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            ok: true,
            batchesProcessed: 2,
            batchSize: 100,
            maxBatches: 20,
            selectedCount: 102,
            scrubbedRunItemCount: 184,
            purgedSessionCount: 102,
            remainingBacklog: 0,
            hasMore: false,
            limitReached: false,
        });
        expect(mocks.purgeExpiredStaging).toHaveBeenCalledTimes(2);
        expect(mocks.purgeExpiredStaging).toHaveBeenNthCalledWith(1, {
            now: expect.any(Date),
            limit: 100,
        });
        expect(mocks.countExpiredStaging).toHaveBeenCalledWith(expect.any(Date));
    });

    it("stops at the explicit high ceiling and reports remaining backlog", async () => {
        mocks.purgeExpiredStaging.mockResolvedValue({
            selectedCount: 100,
            scrubbedRunItemCount: 100,
            purgedSessionCount: 100,
            hasMore: true,
        });
        mocks.countExpiredStaging.mockResolvedValue(37);
        const { GET } = await import("@/app/api/cron/imports/daily/route");

        const response = await GET(new Request("http://test.local/api/cron/imports/daily", {
            headers: { authorization: "Bearer imports-secret" },
        }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.purgeExpiredStaging).toHaveBeenCalledTimes(20);
        expect(body).toMatchObject({
            batchesProcessed: 20,
            selectedCount: 2_000,
            remainingBacklog: 37,
            hasMore: true,
            limitReached: true,
        });
    });

    it("fails closed when the final backlog check fails", async () => {
        mocks.purgeExpiredStaging.mockResolvedValue({
            selectedCount: 0,
            scrubbedRunItemCount: 0,
            purgedSessionCount: 0,
            hasMore: false,
        });
        mocks.countExpiredStaging.mockRejectedValueOnce(new Error("database unavailable"));
        const { GET } = await import("@/app/api/cron/imports/daily/route");

        const response = await GET(new Request("http://test.local/api/cron/imports/daily", {
            headers: { authorization: "Bearer imports-secret" },
        }));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: "Import staging retention failed" });
    });
});
