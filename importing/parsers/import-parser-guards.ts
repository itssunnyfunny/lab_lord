import { ImportParserError } from "@/importing/utils/import-errors";
import {
    MAX_IMPORT_ROWS,
    importRowLimitMessage,
} from "@/importing/constants/import-limits";

export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_COLUMNS = 64;
export const MAX_IMPORT_CELL_BYTES = 8 * 1024;
export const MAX_IMPORT_WORKBOOK_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

export { MAX_IMPORT_ROWS } from "@/importing/constants/import-limits";

export type ImportFileSignature = "PDF" | "ZIP_WORKBOOK" | "OLE_WORKBOOK" | "TEXT" | "UNKNOWN_BINARY";

const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const ZIP_SIGNATURES = [
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function startsWith(buffer: Buffer, signature: Buffer) {
    return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function containsPdfSignature(buffer: Buffer) {
    return buffer.subarray(0, Math.min(buffer.length, 1024)).indexOf(PDF_SIGNATURE) >= 0;
}

export function assertImportFileSize(byteLength: number, label = "Import source") {
    if (!Number.isFinite(byteLength) || byteLength < 0) {
        throw new ImportParserError(`${label} size is invalid.`);
    }
    if (byteLength > MAX_IMPORT_FILE_BYTES) {
        throw new ImportParserError(`${label} is larger than the 4 MiB import limit.`);
    }
}

export function assertImportColumnCount(columnCount: number) {
    if (columnCount > MAX_IMPORT_COLUMNS) {
        throw new ImportParserError(`Import sources can contain at most ${MAX_IMPORT_COLUMNS} columns.`);
    }
}

export function assertImportDataRowCount(rowCount: number) {
    if (rowCount > MAX_IMPORT_ROWS) {
        throw new ImportParserError(importRowLimitMessage(rowCount));
    }
}

export function assertImportCell(value: string, location?: string) {
    if (Buffer.byteLength(value, "utf8") > MAX_IMPORT_CELL_BYTES) {
        throw new ImportParserError(
            `${location ? `${location} ` : "A cell "}is larger than the 8 KiB per-cell import limit.`
        );
    }
}

export function assertWorkbookContentSize(byteLength: number) {
    if (byteLength > MAX_IMPORT_WORKBOOK_UNCOMPRESSED_BYTES) {
        throw new ImportParserError("Workbook content is larger than the 32 MiB expanded-content limit.");
    }
}

function looksLikeText(buffer: Buffer) {
    if (buffer.length === 0) return true;
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    if (sample.includes(0)) return false;
    let suspicious = 0;
    for (const byte of sample) {
        if (byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)) suspicious++;
    }
    return suspicious / sample.length < 0.02;
}

export function detectImportFileSignature(buffer: Buffer): ImportFileSignature {
    if (containsPdfSignature(buffer)) return "PDF";
    if (ZIP_SIGNATURES.some(signature => startsWith(buffer, signature))) return "ZIP_WORKBOOK";
    if (startsWith(buffer, OLE_SIGNATURE)) return "OLE_WORKBOOK";
    return looksLikeText(buffer) ? "TEXT" : "UNKNOWN_BINARY";
}

export function decodeUtf8ImportText(buffer: Buffer, label = "Text import"): string {
    assertImportFileSize(buffer.byteLength, label);
    if (detectImportFileSignature(buffer) !== "TEXT") {
        throw new ImportParserError(`${label} is not a plain UTF-8 text file.`);
    }

    let decoded: string;
    try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
        throw new ImportParserError(`${label} must use valid UTF-8 encoding.`);
    }

    return validateDecodedImportText(decoded, label);
}

export function validateDecodedImportText(input: string, label = "Text import") {
    assertImportFileSize(Buffer.byteLength(input, "utf8"), label);
    const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    if (withoutBom.includes("\u0000") || withoutBom.includes("\uFFFD")) {
        throw new ImportParserError(`${label} must use valid UTF-8 text without binary data.`);
    }
    return withoutBom;
}

export type NormalizedImportHeader = {
    index: number;
    original: string;
    column: string;
    wasBlank: boolean;
    duplicateOf?: string;
};

export function normalizeImportHeaders(headers: string[]) {
    assertImportColumnCount(headers.length);
    const used = new Set<string>();
    const firstByBase = new Map<string, string>();
    const metadata: NormalizedImportHeader[] = [];

    const columns = headers.map((header, index) => {
        assertImportCell(header, `Header ${index + 1}`);
        const original = header.trim();
        const base = original || `Column ${index + 1}`;
        const baseKey = base.toLocaleLowerCase("en-IN");
        let column = base;
        let suffix = 2;

        while (used.has(column.toLocaleLowerCase("en-IN"))) {
            column = `${base} (${suffix})`;
            suffix++;
        }

        const duplicateOf = firstByBase.get(baseKey);
        if (!duplicateOf) firstByBase.set(baseKey, column);
        used.add(column.toLocaleLowerCase("en-IN"));
        metadata.push({
            index,
            original,
            column,
            wasBlank: original.length === 0,
            ...(duplicateOf ? { duplicateOf } : {}),
        });
        return column;
    });

    return { columns, headers: metadata };
}

export function rowFromPositionalCells(columns: string[], cells: string[], rowNumber: number) {
    if (cells.length > columns.length) {
        throw new ImportParserError(`Row ${rowNumber} has more cells than the header row.`);
    }
    return Object.fromEntries(columns.map((column, index) => {
        const value = cells[index] ?? "";
        assertImportCell(value, `Row ${rowNumber}, column ${index + 1}`);
        return [column, value];
    }));
}

function findEndOfCentralDirectory(buffer: Buffer) {
    const minimumOffset = Math.max(0, buffer.length - 65_557);
    for (let offset = buffer.length - 22; offset >= minimumOffset; offset--) {
        if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
        const commentLength = buffer.readUInt16LE(offset + 20);
        if (offset + 22 + commentLength === buffer.length) return offset;
    }
    return -1;
}

export function assertZipWorkbookDeclaredSize(buffer: Buffer) {
    const endOffset = findEndOfCentralDirectory(buffer);
    if (endOffset < 0 || endOffset + 22 > buffer.length) {
        throw new ImportParserError("Workbook ZIP metadata is missing or malformed.");
    }

    const diskNumber = buffer.readUInt16LE(endOffset + 4);
    const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
    const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
    const entryCount = buffer.readUInt16LE(endOffset + 10);
    const centralSize = buffer.readUInt32LE(endOffset + 12);
    const centralOffset = buffer.readUInt32LE(endOffset + 16);
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
        throw new ImportParserError("Multi-disk workbook ZIP archives are not supported for imports.");
    }
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        throw new ImportParserError("ZIP64 workbooks are not supported for imports.");
    }
    const centralEnd = centralOffset + centralSize;
    if (centralEnd !== endOffset) {
        throw new ImportParserError("Workbook ZIP directory is malformed.");
    }

    let offset = centralOffset;
    let totalUncompressed = 0;
    for (let entry = 0; entry < entryCount; entry++) {
        if (offset + 46 > centralEnd || buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new ImportParserError("Workbook ZIP directory is malformed.");
        }
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const startingDisk = buffer.readUInt16LE(offset + 34);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        if (
            compressedSize === 0xffffffff
            || uncompressedSize === 0xffffffff
            || startingDisk === 0xffff
            || localHeaderOffset === 0xffffffff
        ) {
            throw new ImportParserError("ZIP64 workbook entries are not supported for imports.");
        }
        if (startingDisk !== 0) {
            throw new ImportParserError("Multi-disk workbook ZIP archives are not supported for imports.");
        }
        totalUncompressed += uncompressedSize;
        assertWorkbookContentSize(totalUncompressed);

        const fileNameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const entryEnd = offset + 46 + fileNameLength + extraLength + commentLength;
        if (entryEnd > centralEnd) {
            throw new ImportParserError("Workbook ZIP directory is malformed.");
        }
        offset = entryEnd;
    }

    if (offset !== centralEnd) {
        throw new ImportParserError("Workbook ZIP directory is malformed.");
    }
    return totalUncompressed;
}
