import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildChartSummary, MainChart } from "@/components/snapshot/MainChart";

const formatValue = (value: number) => `${value}%`;

describe("buildChartSummary", () => {
    it("describes the displayed range with the lowest and highest labels", () => {
        const summary = buildChartSummary({
            title: "Seat utilization",
            contextLabel: "Seat utilization for the last 30 days",
            valueFormatter: formatValue,
            data: [
                { date: "2026-08-01", displayDate: "Aug 1", value: 64 },
                { date: "2026-08-02", displayDate: "Aug 2", value: 82 },
                { date: "2026-08-03", displayDate: "Aug 3", value: 71 },
            ],
        });

        expect(summary).toBe(
            "Seat utilization for the last 30 days. 3 data points ranging from 64% at Aug 1 to 82% at Aug 2."
        );
    });

    it("describes a single category without implying a trend", () => {
        expect(buildChartSummary({
            title: "Student snapshot",
            valueFormatter: value => value.toString(),
            data: [{ date: "Active", category: "Active", displayDate: "Active", value: 18 }],
        })).toBe("Student snapshot. Active: 18.");
    });

    it("reports when all displayed values are equal", () => {
        expect(buildChartSummary({
            title: "Collected trend",
            valueFormatter: value => `Rs ${value}`,
            data: [
                { date: "2026-08-01", displayDate: "Aug 1", value: 500 },
                { date: "2026-08-02", displayDate: "Aug 2", value: 500 },
            ],
        })).toBe("Collected trend. 2 data points, all at Rs 500.");
    });

    it("renders an accessible summary and keyboard-reachable data table alternative", () => {
        const html = renderToStaticMarkup(createElement(MainChart, {
            title: "Student snapshot",
            contextLabel: "Current student status distribution",
            variant: "bar",
            dataLabel: "Student status",
            data: [
                { date: "Active", category: "Active", value: 18 },
                { date: "Inactive", category: "Inactive", value: 4 },
            ],
        }));

        expect(html).toContain('role="img"');
        expect(html).toContain("Current student status distribution");
        expect(html).toContain("View chart data");
        expect(html).toContain('role="region"');
        expect(html).toContain('tabindex="0"');
        expect(html).toContain("Student status");
        expect(html).toContain("Data displayed in the Student snapshot chart");
    });
});
