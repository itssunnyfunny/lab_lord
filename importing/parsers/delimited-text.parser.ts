import type { ParsedImportSource } from "@/importing/contracts/import-session.contract";
import { ImportParserError } from "@/importing/utils/import-errors";
import {
    assertImportCell,
    assertImportDataRowCount,
    normalizeImportHeaders,
    rowFromPositionalCells,
    type NormalizedImportHeader,
} from "./import-parser-guards";

export type DelimitedImportMetadata = {
    format: "CSV" | "PASTED_TABLE";
    delimiter: "comma" | "tab" | "pipe";
    encoding: "utf-8";
    headers: NormalizedImportHeader[];
};

export type ParsedDelimitedImportSource = ParsedImportSource & {
    parserMetadata: DelimitedImportMetadata;
};

type ParsedRow = {
    cells: string[];
    sourceLine: number;
};

function delimiterLabel(delimiter: string): DelimitedImportMetadata["delimiter"] {
    if (delimiter === "\t") return "tab";
    if (delimiter === "|") return "pipe";
    return "comma";
}

function isBlankRow(row: ParsedRow) {
    return row.cells.every(cell => cell.trim().length === 0);
}

export function parseDelimitedRows(input: string, delimiter: "," | "\t" | "|"): ParsedRow[] {
    const rows: ParsedRow[] = [];
    let cells: string[] = [];
    let current = "";
    let decodedCellBeforeNormalization = "";
    let inQuotes = false;
    let justClosedQuote = false;
    let line = 1;
    let rowStartLine = 1;

    const finishCell = () => {
        assertImportCell(decodedCellBeforeNormalization, `Line ${line}`);
        const value = current.trim();
        cells.push(value);
        current = "";
        decodedCellBeforeNormalization = "";
        justClosedQuote = false;
    };
    const finishRow = () => {
        finishCell();
        const row = { cells, sourceLine: rowStartLine };
        if (!isBlankRow(row)) {
            // `rows` already contains the header, so its current length is the
            // prospective number of data rows for this append.
            assertImportDataRowCount(rows.length);
            rows.push(row);
        }
        cells = [];
        rowStartLine = line + 1;
    };

    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        const next = input[index + 1];

        if (inQuotes) {
            if (char === "\"" && next === "\"") {
                current += "\"";
                decodedCellBeforeNormalization += "\"";
                index++;
                continue;
            }
            if (char === "\"") {
                inQuotes = false;
                justClosedQuote = true;
                continue;
            }
            if (char === "\n") {
                decodedCellBeforeNormalization += char;
                line++;
            }
            if (char === "\r" && next === "\n") {
                current += "\n";
                decodedCellBeforeNormalization += "\r\n";
                index++;
                line++;
                continue;
            }
            if (char === "\r") line++;
            current += char;
            if (char !== "\n") decodedCellBeforeNormalization += char;
            continue;
        }

        if (justClosedQuote) {
            if (char === delimiter) {
                finishCell();
                continue;
            }
            if (char === "\r" || char === "\n") {
                if (char === "\r" && next === "\n") index++;
                finishRow();
                line++;
                continue;
            }
            if (/\s/.test(char)) {
                decodedCellBeforeNormalization += char;
                continue;
            }
            throw new ImportParserError(`Malformed quoted value near line ${line}.`);
        }

        if (char === "\"") {
            if (current.trim().length > 0) {
                throw new ImportParserError(`Malformed quote in an unquoted value near line ${line}.`);
            }
            current = "";
            inQuotes = true;
            continue;
        }
        if (char === delimiter) {
            finishCell();
            continue;
        }
        if (char === "\r" || char === "\n") {
            if (char === "\r" && next === "\n") index++;
            finishRow();
            line++;
            continue;
        }
        current += char;
        decodedCellBeforeNormalization += char;
    }

    if (inQuotes) throw new ImportParserError(`Malformed CSV: quoted value starting near line ${rowStartLine} is not closed.`);
    if (current.length > 0 || cells.length > 0 || justClosedQuote) finishRow();
    return rows;
}

export function parsedSourceFromDelimitedRows(input: {
    rows: ParsedRow[];
    delimiter: "," | "\t" | "|";
    format: DelimitedImportMetadata["format"];
    emptyMessage: string;
}): ParsedDelimitedImportSource {
    if (input.rows.length < 2) throw new ImportParserError(input.emptyMessage);
    assertImportDataRowCount(input.rows.length - 1);
    const headerRow = input.rows[0];
    const normalized = normalizeImportHeaders(headerRow.cells);
    const rows = input.rows.slice(1)
        .filter(row => !isBlankRow(row))
        .map(row => rowFromPositionalCells(normalized.columns, row.cells, row.sourceLine));

    if (rows.length === 0) throw new ImportParserError(input.emptyMessage);
    return {
        columns: normalized.columns,
        rows,
        rowNumbers: input.rows.slice(1)
            .filter(row => !isBlankRow(row))
            .map(row => row.sourceLine),
        parserMetadata: {
            format: input.format,
            delimiter: delimiterLabel(input.delimiter),
            encoding: "utf-8",
            headers: normalized.headers,
        },
    };
}
