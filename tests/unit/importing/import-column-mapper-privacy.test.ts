import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    callGeminiJson: vi.fn(),
}));

vi.mock("@/ai/llm/gemini.client", () => ({
    callGeminiJson: mocks.callGeminiJson,
    resolveGeminiProModel: () => "gemini-test",
}));

import {
    buildRedactedImportMappingInput,
    mapImportColumns,
} from "@/importing/ai/import-column-mapper.ai";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("import column mapping privacy", () => {
    const sensitiveInput = {
        branchContext: {
            defaultFee: 1200,
            seats: ["PRIVATE-SEAT-A1"],
            shifts: [{ name: "PRIVATE-MORNING", price: 1200 }],
            multiShifts: [],
        },
        sourceProfile: {
            rowCount: 500,
            columns: [{ column: "Legacy Value", sampleValues: ["Asha Sharma"] }],
        },
        columns: ["Name", "Legacy Value"],
        sampleRows: [{
            Name: "Asha Sharma",
            "Legacy Value": "asha.private@example.com",
        }],
    };

    it("builds deterministic mappings first and emits only structural masked samples", () => {
        const redacted = buildRedactedImportMappingInput(sensitiveInput);
        const serialized = JSON.stringify(redacted.promptInput);

        expect(redacted.deterministicMappings.find(mapping => mapping.sourceColumn === "Name")).toMatchObject({
            targetField: "student.name",
            source: "DETERMINISTIC",
        });
        expect(redacted.ambiguousColumns).toEqual(["Legacy Value"]);
        expect(redacted.promptInput.columns).toEqual(["column_2: Legacy Value"]);
        expect(serialized).toContain("[email-like:length=");
        expect(serialized).not.toContain("Asha Sharma");
        expect(serialized).not.toContain("asha.private@example.com");
        expect(serialized).not.toContain("PRIVATE-SEAT-A1");
        expect(serialized).not.toContain("PRIVATE-MORNING");
        expect(serialized).not.toContain("1200");
    });

    it("redacts name-like tokens when a data row is accidentally selected as a header", () => {
        const redacted = buildRedactedImportMappingInput({
            branchContext: {},
            columns: ["Asha Sharma"],
            sampleRows: [{ "Asha Sharma": "private value" }],
        });

        expect(redacted.promptInput.columns).toEqual([
            "column_1: [redacted-token] [redacted-token]",
        ]);
        expect(JSON.stringify(redacted.promptInput)).not.toContain("Asha Sharma");
    });

    it("does not call AI when every column has a safe deterministic mapping", async () => {
        const result = await mapImportColumns({
            branchContext: sensitiveInput.branchContext,
            sourceProfile: { rowCount: 1 },
            columns: ["Name", "Mobile"],
            sampleRows: [{ Name: "Asha Sharma", Mobile: "9876543210" }],
        });

        expect(mocks.callGeminiJson).not.toHaveBeenCalled();
        expect(result.columnMappings.map(mapping => mapping.source)).toEqual(["DETERMINISTIC", "DETERMINISTIC"]);
        expect(result.usedFallback).toBe(false);
    });

    it("sends only ambiguous aliases and maps a sanitized AI response back to the source column", async () => {
        mocks.callGeminiJson.mockImplementationOnce(async (prompt: string) => {
            expect(prompt).toContain("column_2: Legacy Value");
            expect(prompt).not.toContain("Asha Sharma");
            expect(prompt).not.toContain("asha.private@example.com");
            expect(prompt).not.toContain("PRIVATE-SEAT-A1");
            expect(prompt).not.toContain("PRIVATE-MORNING");
            return {
                ok: true,
                rawText: "{}",
                data: {
                    entityTypesDetected: ["STUDENT"],
                    columnMappings: [{
                        sourceColumn: "column_2: Legacy Value",
                        targetField: "student.phone",
                        confidence: 90,
                        reason: "Structural summary resembles an identifier.",
                    }],
                    questions: [],
                    warnings: [],
                },
            };
        });

        const result = await mapImportColumns(sensitiveInput);

        expect(mocks.callGeminiJson).toHaveBeenCalledOnce();
        expect(result.columnMappings).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceColumn: "Name", targetField: "student.name", source: "DETERMINISTIC" }),
            expect.objectContaining({ sourceColumn: "Legacy Value", targetField: "student.phone", source: "AI" }),
        ]));
    });
});
