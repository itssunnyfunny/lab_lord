import type { ParsedImportSource } from "@/importing/contracts/import-session.contract";
import { ImportParserError } from "@/importing/utils/import-errors";
import { parseDelimitedRows, parsedSourceFromDelimitedRows } from "./delimited-text.parser";
import {
    assertImportCell,
    assertImportDataRowCount,
    normalizeImportHeaders,
    rowFromPositionalCells,
    validateDecodedImportText,
    type NormalizedImportHeader,
} from "./import-parser-guards";

export type PastedTableFormat = "comma" | "tab" | "pipe" | "multi-space";

export type ParsedPastedTableSource = ParsedImportSource & {
    parserMetadata: {
        format: "PASTED_TABLE";
        delimiter: PastedTableFormat;
        encoding: "utf-8";
        headers: NormalizedImportHeader[];
    };
};

function* physicalLines(input: string) {
    let lineStart = 0;
    let lineNumber = 1;
    for (let index = 0; index <= input.length; index++) {
        if (index < input.length && input[index] !== "\n" && input[index] !== "\r") continue;
        const line = input.slice(lineStart, index);
        yield { line, lineNumber };
        if (input[index] === "\r" && input[index + 1] === "\n") index++;
        lineStart = index + 1;
        lineNumber++;
    }
}

function firstNonEmptyLine(input: string) {
    for (const { line } of physicalLines(input)) {
        if (line.trim().length > 0) return line;
    }
    return "";
}

function countUnquoted(line: string, delimiter: string) {
    let count = 0;
    let inQuotes = false;
    for (let index = 0; index < line.length; index++) {
        if (line[index] === "\"" && line[index + 1] === "\"" && inQuotes) {
            index++;
            continue;
        }
        if (line[index] === "\"") inQuotes = !inQuotes;
        else if (!inQuotes && line[index] === delimiter) count++;
    }
    if (inQuotes) throw new ImportParserError("Malformed pasted header: quoted value is not closed.");
    return count;
}

export function detectPastedTableFormat(input: string): PastedTableFormat {
    const header = firstNonEmptyLine(input);
    if (!header) throw new ImportParserError("Paste a table with headers and rows.");

    const candidates: Array<{ format: Exclude<PastedTableFormat, "multi-space">; delimiter: string; count: number; priority: number }> = [
        { format: "tab", delimiter: "\t", count: countUnquoted(header, "\t"), priority: 3 },
        { format: "pipe", delimiter: "|", count: countUnquoted(header, "|"), priority: 2 },
        { format: "comma", delimiter: ",", count: countUnquoted(header, ","), priority: 1 },
    ];
    const best = candidates
        .filter(candidate => candidate.count > 0)
        .sort((left, right) => right.count - left.count || right.priority - left.priority)[0];
    if (best) return best.format;
    if (/\S\s{2,}\S/.test(header)) return "multi-space";
    throw new ImportParserError("Could not detect table columns. Paste tab-, comma-, pipe-, or aligned multi-space data.");
}

function parseMultiSpace(text: string): ParsedPastedTableSource {
    const positionalRows: Array<{ sourceLine: number; cells: string[] }> = [];
    for (const { line, lineNumber } of physicalLines(text)) {
        const cells = line.split(/\s{2,}/).map((cell, columnIndex) => {
            assertImportCell(cell, `Line ${lineNumber}, column ${columnIndex + 1}`);
            return cell.trim();
        });
        if (!cells.some(Boolean)) continue;
        // The first retained row is the header. Check before retaining the
        // first row that would put the table over the data-row ceiling.
        assertImportDataRowCount(positionalRows.length);
        positionalRows.push({ sourceLine: lineNumber, cells });
    }
    if (positionalRows.length < 2) {
        throw new ImportParserError("Pasted table must include headers and at least one data row.");
    }
    const normalized = normalizeImportHeaders(positionalRows[0].cells);
    const rows = positionalRows.slice(1).map(row =>
        rowFromPositionalCells(normalized.columns, row.cells, row.sourceLine)
    );
    return {
        columns: normalized.columns,
        rows,
        rowNumbers: positionalRows.slice(1).map(row => row.sourceLine),
        parserMetadata: {
            format: "PASTED_TABLE",
            delimiter: "multi-space",
            encoding: "utf-8",
            headers: normalized.headers,
        },
    };
}

export function parsePastedTable(input: string): ParsedPastedTableSource {
    const text = validateDecodedImportText(input, "Pasted table");
    if (!text.trim()) throw new ImportParserError("Paste a table with headers and rows.");
    const format = detectPastedTableFormat(text);
    if (format === "multi-space") return parseMultiSpace(text);

    const delimiter = format === "tab" ? "\t" : format === "pipe" ? "|" : ",";
    const parsed = parsedSourceFromDelimitedRows({
        rows: parseDelimitedRows(text, delimiter),
        delimiter,
        format: "PASTED_TABLE",
        emptyMessage: "Pasted table must include headers and at least one data row.",
    });
    return {
        ...parsed,
        parserMetadata: {
            ...parsed.parserMetadata,
            format: "PASTED_TABLE",
            delimiter: format,
        },
    };
}
