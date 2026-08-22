import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getText: vi.fn(),
    destroy: vi.fn(),
}));

vi.mock("pdf-parse", () => ({
    PDFParse: class {
        getText = mocks.getText;
        destroy = mocks.destroy;
    },
}));

import { parsePdf } from "@/importing/parsers/pdf.parser";
import { MAX_IMPORT_ROWS } from "@/importing/constants/import-limits";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.destroy.mockResolvedValue(undefined);
});

describe("PDF text import metadata", () => {
    it("marks successful PDF text extraction as beta and records its detected table shape", async () => {
        mocks.getText.mockResolvedValue({ text: "\nName\tPhone\n\nAsha\t9876543210" });

        const parsed = await parsePdf(Buffer.from("%PDF-1.7\nplaceholder"));

        expect(parsed.rows[0]).toEqual({ Name: "Asha", Phone: "9876543210" });
        expect(parsed.rowNumbers).toEqual([4]);
        expect(parsed.parserMetadata).toMatchObject({
            format: "PDF_TEXT_BETA",
            beta: true,
            extraction: "TEXT_ONLY",
            detectedTableFormat: "tab",
        });
        expect(parsed.parserMetadata.limitations).toHaveLength(3);
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });

    it("destroys the parser when extracted text is unusable", async () => {
        mocks.getText.mockResolvedValue({ text: "" });

        await expect(parsePdf(Buffer.from("%PDF-1.7\nplaceholder"))).rejects.toThrow("Could not read this PDF");
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });

    it("preserves the parser row-limit error for oversized extracted tables", async () => {
        const rows = Array.from(
            { length: MAX_IMPORT_ROWS + 1 },
            (_, index) => `Student ${index + 1}\t9876543210`
        ).join("\n");
        mocks.getText.mockResolvedValue({ text: `Name\tPhone\n${rows}` });

        await expect(parsePdf(Buffer.from("%PDF-1.7\nplaceholder"))).rejects.toThrow("2,000 rows");
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });
});
