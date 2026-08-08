import { describe, expect, it } from "vitest";
import { failResourceRefresh, resourceData, startResourceRefresh } from "@/lib/resourceState";
import type { ResourceState } from "@/types";

describe("resource state transitions", () => {
    it("keeps prior data labelled while a refresh is in flight", () => {
        const current: ResourceState<{ filter: string; value: number }> = {
            status: "success",
            data: { filter: "month", value: 42 },
            updatedAt: "2026-08-08T10:00:00.000Z",
        };
        const loading = startResourceRefresh(current);
        expect(loading).toEqual({
            status: "loading",
            previous: { filter: "month", value: 42 },
            previousUpdatedAt: "2026-08-08T10:00:00.000Z",
        });
        expect(resourceData(loading)?.filter).toBe("month");
    });

    it("turns a failed refresh into explicit stale data", () => {
        const loading: ResourceState<{ filter: string; value: number }> = {
            status: "loading",
            previous: { filter: "month", value: 42 },
            previousUpdatedAt: "2026-08-08T10:00:00.000Z",
        };
        expect(failResourceRefresh(loading, "Could not load all time")).toEqual({
            status: "stale",
            data: { filter: "month", value: 42 },
            updatedAt: "2026-08-08T10:00:00.000Z",
            reason: "Could not load all time",
        });
    });

    it("uses an error state when no verified data exists", () => {
        expect(failResourceRefresh({ status: "loading" }, "Offline")).toEqual({
            status: "error",
            message: "Offline",
            retryable: true,
        });
    });
});
