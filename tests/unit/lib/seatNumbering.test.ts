import { describe, expect, it } from "vitest";
import {
    compareSeatLabels,
    generateSeatLabels,
    generateSeatLabelsForSeatCount,
    validateSeatNumberingConfig,
} from "@/lib/seatNumbering";

describe("seatNumbering", () => {
    it("generates default numeric labels", () => {
        const result = generateSeatLabels({ mode: "SIMPLE", count: 5 });

        expect(result).toEqual({ ok: true, value: ["1", "2", "3", "4", "5"] });
    });

    it("generates prefixed and padded range labels", () => {
        const result = generateSeatLabels({
            mode: "RANGE",
            ranges: [{ prefix: "A", start: 1, end: 3, padTo: 3, separator: "" }],
        });

        expect(result).toEqual({ ok: true, value: ["A001", "A002", "A003"] });
    });

    it("generates mixed ranges in configured order", () => {
        const result = generateSeatLabels({
            mode: "RANGE",
            ranges: [
                { prefix: "A", start: 1, end: 2, separator: "" },
                { prefix: "B", start: 1, end: 2, separator: "" },
                { prefix: "C", start: 1, end: 1, separator: "" },
            ],
        });

        expect(result).toEqual({ ok: true, value: ["A1", "A2", "B1", "B2", "C1"] });
    });

    it("rejects duplicate labels across ranges", () => {
        const result = generateSeatLabels({
            mode: "RANGE",
            ranges: [
                { prefix: "A", start: 1, end: 2, separator: "" },
                { prefix: "A", start: 2, end: 3, separator: "" },
            ],
        });

        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.error).toMatch(/duplicate/i);
    });

    it("rejects invalid labels", () => {
        const config = validateSeatNumberingConfig({
            mode: "RANGE",
            ranges: [{ prefix: "#", start: 1, end: 2 }],
        });

        expect(config.ok).toBe(false);
    });

    it("rejects custom ranges that do not match the expected seat count", () => {
        const result = generateSeatLabelsForSeatCount(4, {
            mode: "RANGE",
            ranges: [{ prefix: "A", start: 1, end: 3, separator: "" }],
        });

        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.error).toMatch(/total seats is 4/i);
    });

    it("sorts seat labels naturally", () => {
        const labels = ["A10", "A2", "1", "A1"].sort(compareSeatLabels);

        expect(labels).toEqual(["1", "A1", "A2", "A10"]);
    });
});
