import { describe, expect, it } from "vitest";
import { getUtilizationStatus } from "@/lib/utilizationStatus";

describe("getUtilizationStatus", () => {
    it.each([
        [0, "underused", "Underused", "warning"],
        [39.99, "underused", "Underused", "warning"],
        [40, "balanced", "Balanced", "success"],
        [79.99, "balanced", "Balanced", "success"],
        [80, "near_capacity", "Near capacity", "warning"],
        [99.99, "near_capacity", "Near capacity", "warning"],
        [100, "full", "Full", "danger"],
        [125, "full", "Full", "danger"],
    ] as const)("classifies %s%% as %s", (percent, key, label, tone) => {
        expect(getUtilizationStatus(percent)).toEqual({ key, label, tone });
    });
});
