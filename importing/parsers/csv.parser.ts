import type { ParsedImportSource } from "@/importing/contracts/import-session.contract";
import { decodeUtf8ImportText, validateDecodedImportText } from "./import-parser-guards";
import {
    parseDelimitedRows,
    parsedSourceFromDelimitedRows,
    type ParsedDelimitedImportSource,
} from "./delimited-text.parser";

export type ParsedCsvSource = ParsedDelimitedImportSource;

export function parseCsv(input: string | Buffer): ParsedCsvSource {
    const text = Buffer.isBuffer(input)
        ? decodeUtf8ImportText(input, "CSV file")
        : validateDecodedImportText(input, "CSV file");
    return parsedSourceFromDelimitedRows({
        rows: parseDelimitedRows(text, ","),
        delimiter: ",",
        format: "CSV",
        emptyMessage: "CSV must include a header row and at least one data row.",
    });
}

export function parseCsvBuffer(buffer: Buffer): ParsedImportSource {
    return parseCsv(buffer);
}
