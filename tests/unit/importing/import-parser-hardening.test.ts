import { describe, expect, it } from "vitest";
import { parseCsv } from "@/importing/parsers/csv.parser";
import { detectPastedTableFormat, parsePastedTable } from "@/importing/parsers/pasted-table.parser";
import { inspectXlsxWorkbook, parseXlsx } from "@/importing/parsers/xlsx.parser";
import {
    MAX_IMPORT_CELL_BYTES,
    MAX_IMPORT_COLUMNS,
    MAX_IMPORT_FILE_BYTES,
    MAX_IMPORT_ROWS,
    MAX_IMPORT_WORKBOOK_UNCOMPRESSED_BYTES,
    assertZipWorkbookDeclaredSize,
} from "@/importing/parsers/import-parser-guards";

function centralDirectoryEntry(uncompressedBytes = 0) {
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(uncompressedBytes, 24);
    return entry;
}

function zipDirectory(input: {
    entries: Buffer[];
    reportedEntries?: number;
    centralSuffix?: Buffer;
    archiveSuffix?: Buffer;
    entriesOnDisk?: number;
    diskNumber?: number;
}): Buffer {
    const central = Buffer.concat([...input.entries, input.centralSuffix ?? Buffer.alloc(0)]);
    const reportedEntries = input.reportedEntries ?? input.entries.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(input.diskNumber ?? 0, 4);
    end.writeUInt16LE(input.entriesOnDisk ?? reportedEntries, 8);
    end.writeUInt16LE(reportedEntries, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(0, 16);
    return Buffer.concat([central, end, input.archiveSuffix ?? Buffer.alloc(0)]);
}

describe("import parser hardening", () => {
    it("preserves blank and duplicate headers with stable positional aliases", () => {
        const parsed = parseCsv("Name,,Name\nAsha,private-middle,Alias");

        expect(parsed.columns).toEqual(["Name", "Column 2", "Name (2)"]);
        expect(parsed.rows[0]).toEqual({
            Name: "Asha",
            "Column 2": "private-middle",
            "Name (2)": "Alias",
        });
        expect(parsed.parserMetadata.headers[2]).toMatchObject({
            index: 2,
            original: "Name",
            column: "Name (2)",
            duplicateOf: "Name",
        });
    });

    it("rejects malformed CSV quotes instead of silently recovering", () => {
        expect(() => parseCsv('Name,Phone\n"Asha,9876543210')).toThrow("not closed");
        expect(() => parseCsv('Name,Phone\nAs"ha,9876543210')).toThrow("Malformed quote");
        expect(() => parsePastedTable('Name,Phone\n"Asha,9876543210')).toThrow("not closed");
    });

    it("enforces file, column, and cell limits", () => {
        const tooManyColumns = Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, index) => `C${index}`).join(",");
        expect(() => parseCsv(`${tooManyColumns}\n${Array(MAX_IMPORT_COLUMNS + 1).fill("x").join(",")}`)).toThrow("64 columns");
        expect(() => parseCsv(`Name\n${"x".repeat(MAX_IMPORT_CELL_BYTES + 1)}`)).toThrow("8 KiB");
        expect(() => parseCsv(`Name\n${"x".repeat(MAX_IMPORT_FILE_BYTES)}`)).toThrow("4 MiB");
    });

    it("rejects compact CSV and pasted tables as soon as they exceed 2,000 data rows", () => {
        const csvRows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => `Student ${index + 1}`).join("\n");
        const tabRows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => `Student ${index + 1}\t9876543210`).join("\n");
        const alignedRows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => `Student ${index + 1}  9876543210`).join("\n");

        expect(Buffer.byteLength(csvRows, "utf8")).toBeLessThan(MAX_IMPORT_FILE_BYTES);
        expect(() => parseCsv(`Name\n${csvRows}`)).toThrow("2,000 rows");
        expect(() => parsePastedTable(`Name\tPhone\n${tabRows}`)).toThrow("2,000 rows");
        expect(() => parsePastedTable(`Name  Phone\n${alignedRows}`)).toThrow("2,000 rows");
    });

    it("checks original decoded cells before trimming whitespace", async () => {
        const whitespacePadded = `${" ".repeat(9_000)}A`;
        expect(() => parseCsv(`Name\n${whitespacePadded}`)).toThrow("8 KiB");
        expect(() => parsePastedTable(`Name,Notes\nAsha,${whitespacePadded}`)).toThrow("8 KiB");

        const XLSX = await import("xlsx");
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ["Name"],
            [whitespacePadded],
        ]), "Students");
        const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
        await expect(parseXlsx(buffer)).rejects.toThrow("8 KiB");
    });

    it("preserves physical CSV and paste row positions across blank and multiline rows", () => {
        const csv = parseCsv("\nName,Notes\nAsha,\"line one\nline two\"\n\nRavi,ok");
        expect(csv.rowNumbers).toEqual([3, 6]);

        const pasted = parsePastedTable("\nName\tPhone\n\nAsha\t1\n\nRavi\t2");
        expect(pasted.rowNumbers).toEqual([4, 6]);
    });

    it("validates UTF-8 text and rejects binary signatures", () => {
        expect(() => parseCsv(Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0xc3, 0x28]))).toThrow("UTF-8");
        expect(() => parseCsv(Buffer.from("%PDF-1.7\nName,Phone\nAsha,1"))).toThrow("plain UTF-8");
    });

    it("detects pasted delimiters from the header deterministically", () => {
        const input = "Name\tNotes\nAsha\tuses commas, safely";
        expect(detectPastedTableFormat(input)).toBe("tab");
        const parsed = parsePastedTable(input);
        expect(parsed.parserMetadata.delimiter).toBe("tab");
        expect(parsed.rows[0]).toEqual({ Name: "Asha", Notes: "uses commas, safely" });
    });

    it("exposes workbook sheets and requires an explicit choice for multi-sheet files", async () => {
        const XLSX = await import("xlsx");
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ["Name", "Phone"],
            ["Asha", "9876543210"],
        ]), "Students");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ["Instructions"],
            ["Name", "", "Name"],
            [],
            ["Ravi", "middle", "Alias"],
        ]), "Legacy");
        const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

        const inspection = await inspectXlsxWorkbook(buffer);
        expect(inspection.requiresSheetSelection).toBe(true);
        expect(inspection.sheets.map(sheet => sheet.name)).toEqual(["Students", "Legacy"]);
        expect(inspection.sheets[1].headerCandidates.map(candidate => candidate.rowNumber)).toContain(2);
        await expect(parseXlsx(buffer)).rejects.toThrow("multiple sheets");

        const parsed = await parseXlsx(buffer, { sheetName: "Legacy", headerRow: 2 });
        expect(parsed.columns).toEqual(["Name", "Column 2", "Name (2)"]);
        expect(parsed.rows[0]).toEqual({ Name: "Ravi", "Column 2": "middle", "Name (2)": "Alias" });
        expect(parsed.rowNumbers).toEqual([4]);
        expect(parsed.parserMetadata).toMatchObject({ format: "XLSX", sheetName: "Legacy", headerRow: 2 });
    });

    it("rejects compact XLS and XLSX workbooks after the 2,001st selected data row", async () => {
        const XLSX = await import("xlsx");
        const dataRows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => [`Student ${index + 1}`]);
        for (const bookType of ["xlsx", "biff8"] as const) {
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
                ["Instructions"],
                [],
                ["Name"],
                ...dataRows,
            ]), "Students");
            const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType }));

            expect(buffer.byteLength).toBeLessThan(MAX_IMPORT_FILE_BYTES);
            await expect(parseXlsx(buffer, {
                headerRow: 3,
                expectedFormat: bookType === "xlsx" ? "XLSX" : "XLS",
            })).rejects.toThrow("2,000 rows");
        }
    });

    it("rejects a workbook with a mismatched signature", async () => {
        await expect(parseXlsx(Buffer.from("Name,Phone\nAsha,1"))).rejects.toThrow("valid XLSX or XLS");
    });

    it("rejects XLS/XLSX extension and workbook-format mismatches in both directions", async () => {
        const XLSX = await import("xlsx");
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ["Name"],
            ["Asha"],
        ]), "Students");
        const xlsxBuffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
        const xlsBuffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "biff8" }));

        await expect(parseXlsx(xlsxBuffer, { expectedFormat: "XLS" })).rejects.toThrow("contents are XLSX");
        await expect(parseXlsx(xlsBuffer, { expectedFormat: "XLSX" })).rejects.toThrow("contents are XLS");
        await expect(parseXlsx(xlsxBuffer, { expectedFormat: "XLSX" })).resolves.toMatchObject({
            parserMetadata: { format: "XLSX" },
        });
        await expect(parseXlsx(xlsBuffer, { expectedFormat: "XLS" })).resolves.toMatchObject({
            parserMetadata: { format: "XLS" },
        });
    });

    it("rejects ZIP workbook metadata declaring more than 32 MiB expanded", () => {
        const buffer = Buffer.alloc(68);
        buffer.writeUInt32LE(0x02014b50, 0);
        buffer.writeUInt32LE(MAX_IMPORT_WORKBOOK_UNCOMPRESSED_BYTES + 1, 24);
        buffer.writeUInt32LE(0x06054b50, 46);
        buffer.writeUInt16LE(1, 54);
        buffer.writeUInt16LE(1, 56);
        buffer.writeUInt32LE(46, 58);
        buffer.writeUInt32LE(0, 62);

        expect(() => assertZipWorkbookDeclaredSize(buffer)).toThrow("32 MiB");
    });

    it("rejects undercounted or partially parsed ZIP central directories", () => {
        expect(() => assertZipWorkbookDeclaredSize(zipDirectory({
            entries: [centralDirectoryEntry(), centralDirectoryEntry()],
            reportedEntries: 1,
        }))).toThrow("directory is malformed");

        expect(() => assertZipWorkbookDeclaredSize(zipDirectory({
            entries: [centralDirectoryEntry()],
            centralSuffix: Buffer.from([0x00, 0x01]),
        }))).toThrow("directory is malformed");
    });

    it("rejects trailing ZIP bytes and inconsistent disk entry counts", () => {
        expect(() => assertZipWorkbookDeclaredSize(zipDirectory({
            entries: [centralDirectoryEntry()],
            archiveSuffix: Buffer.from([0x00]),
        }))).toThrow("metadata is missing or malformed");

        expect(() => assertZipWorkbookDeclaredSize(zipDirectory({
            entries: [centralDirectoryEntry()],
            entriesOnDisk: 0,
        }))).toThrow("Multi-disk");
    });
});
