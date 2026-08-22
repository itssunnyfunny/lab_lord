import type { ParsedImportSource } from "@/importing/contracts/import-session.contract";
import { ImportParserError, PDF_PARSE_ERROR } from "@/importing/utils/import-errors";
import { assertImportFileSize, detectImportFileSignature } from "./import-parser-guards";
import { parsePastedTable, type PastedTableFormat } from "./pasted-table.parser";

export type ParsedPdfSource = ParsedImportSource & {
    parserMetadata: {
        format: "PDF_TEXT_BETA";
        beta: true;
        extraction: "TEXT_ONLY";
        detectedTableFormat: PastedTableFormat;
        limitations: string[];
    };
};

export async function parsePdf(buffer: Buffer): Promise<ParsedPdfSource> {
    assertImportFileSize(buffer.byteLength, "PDF file");
    if (detectImportFileSignature(buffer) !== "PDF") {
        throw new ImportParserError("PDF file signature is missing or invalid.");
    }

    let parser: InstanceType<(typeof import("pdf-parse"))["PDFParse"]> | null = null;
    try {
        const { PDFParse } = await import("pdf-parse");
        parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        const text = result.text;
        if (!text?.trim()) throw new ImportParserError(PDF_PARSE_ERROR);
        const parsed = parsePastedTable(text);
        return {
            columns: parsed.columns,
            rows: parsed.rows,
            rowNumbers: parsed.rowNumbers,
            parserMetadata: {
                format: "PDF_TEXT_BETA",
                beta: true,
                extraction: "TEXT_ONLY",
                detectedTableFormat: parsed.parserMetadata.delimiter,
                limitations: [
                    "Text extraction does not preserve visual table boundaries.",
                    "Scanned PDFs require OCR before import.",
                    "Every extracted row must be reviewed before commit.",
                ],
            },
        };
    } catch (error) {
        if (error instanceof ImportParserError && (
            error.message.includes("4 MiB") ||
            error.message.includes("8 KiB") ||
            error.message.includes("64 columns") ||
            error.message.includes("2,000 rows")
        )) throw error;
        throw new ImportParserError(PDF_PARSE_ERROR);
    } finally {
        await parser?.destroy().catch(() => undefined);
    }
}
