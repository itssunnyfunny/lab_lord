import { NextResponse } from "next/server";
import type { ImportGoal, ImportSourceType } from "@/app/generated/prisma/enums";
import { getSessionUser } from "@/lib/auth";
import { assertImportV2Enabled } from "@/lib/importFeature";
import { toImportApiError } from "@/importing/http/import-api-error";
import {
    assertDecodedImportRequestSize,
    assertExactlyOneImportSource,
    assertImportContentLength,
    readImportFormData,
    readImportJson,
} from "@/importing/http/import-request";
import { inspectXlsxWorkbook } from "@/importing/parsers/xlsx.parser";
import { ImportParserError } from "@/importing/utils/import-errors";
import { ImportSessionService } from "@/importing/services/import-session.service";
import { ImportWorkflowService } from "@/importing/services/import-workflow";

type Params = { params: Promise<{ branchId: string }> };
type FileImportSourceType = Exclude<ImportSourceType, "PASTED_TABLE">;

const IMPORT_GOALS = new Set<ImportGoal>(["STUDENTS", "STUDENTS_ALLOCATIONS", "FULL"]);
const MIME_TYPES: Record<FileImportSourceType, Set<string>> = {
    CSV: new Set(["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel", "application/octet-stream"]),
    XLSX: new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"]),
    XLS: new Set(["application/vnd.ms-excel", "application/octet-stream"]),
    PDF: new Set(["application/pdf", "application/octet-stream"]),
    OTHER: new Set(),
};

function sourceTypeForFile(fileName: string): FileImportSourceType {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".csv")) return "CSV";
    if (lower.endsWith(".xlsx")) return "XLSX";
    if (lower.endsWith(".xls")) return "XLS";
    if (lower.endsWith(".pdf")) return "PDF";
    throw new Error("Choose a CSV, XLSX, XLS, or PDF file.");
}

function parseGoal(value: FormDataEntryValue | unknown): ImportGoal {
    if (typeof value === "string" && IMPORT_GOALS.has(value as ImportGoal)) return value as ImportGoal;
    throw new Error("Choose what you want to import before uploading.");
}

function optionalHeaderRow(value: FormDataEntryValue | null) {
    if (value == null || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Header row must be a one-based row number.");
    return parsed;
}

function assertFileMime(sourceType: FileImportSourceType, mimeType: string) {
    const normalized = mimeType.trim().toLowerCase();
    if (normalized && !MIME_TYPES[sourceType].has(normalized)) {
        throw new Error("The file type does not match its extension.");
    }
}

export async function POST(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        assertImportV2Enabled();
        assertImportContentLength(req);
        const { branchId } = await params;
        const contentType = req.headers.get("content-type") ?? "";

        if (contentType.includes("multipart/form-data")) {
            const form = await readImportFormData(req);
            const file = form.get("file");
            const pastedTable = form.get("pastedTable");
            assertExactlyOneImportSource({
                hasFile: file instanceof File,
                hasPaste: typeof pastedTable === "string" && Boolean(pastedTable.trim()),
            });
            if (!(file instanceof File)) throw new Error("File is required.");

            const goal = parseGoal(form.get("goal"));
            const sourceType = sourceTypeForFile(file.name);
            assertFileMime(sourceType, file.type);
            const sheetNameEntry = form.get("sheetName");
            const sheetName = typeof sheetNameEntry === "string" ? sheetNameEntry.trim() || undefined : undefined;
            const headerRow = optionalHeaderRow(form.get("headerRow"));
            const buffer = Buffer.from(await file.arrayBuffer());

            if (sourceType === "XLS" || sourceType === "XLSX") {
                const workbook = await inspectXlsxWorkbook(buffer);
                if (workbook.format !== sourceType) {
                    throw new ImportParserError(
                        `Workbook contents are ${workbook.format}, but the uploaded file extension is ${sourceType}.`
                    );
                }
                if (!sheetName || !headerRow) {
                    return NextResponse.json({
                        error: "Select the worksheet and header row before importing.",
                        code: "IMPORT_WORKBOOK_SELECTION_REQUIRED",
                        workbook,
                    }, { status: 422 });
                }
            }

            const session = await ImportSessionService.createSession(user.id, branchId, {
                sourceType,
                fileName: file.name,
                fileMeta: { size: file.size, type: file.type },
                fileBuffer: buffer,
                goal,
                sourceConfiguration: {
                    sheetName,
                    headerRow,
                    ...(sourceType === "PDF" ? { pdfConfirmed: false } : {}),
                },
            });
            const dispatch = sourceType === "PDF"
                ? {
                    run: session.analysisRun,
                    dispatchPending: false,
                    workflowAttached: false,
                    dispatchRequired: false,
                }
                : await ImportWorkflowService.tryStartRun(session.analysisRun);
            return NextResponse.json({
                sessionId: session.id,
                runId: dispatch.run.id,
                status: dispatch.run.status,
                dispatchPending: dispatch.dispatchPending,
                workflowAttached: dispatch.workflowAttached,
                dispatchRequired: dispatch.dispatchRequired,
                ...(sourceType === "PDF" ? {
                    requiresPdfConfirmation: true,
                    extractionPreview: session.extractionPreview,
                } : {}),
            }, { status: 202 });
        }

        const body = await readImportJson<{
            pastedTable?: unknown;
            fileName?: unknown;
            goal?: unknown;
            file?: unknown;
        }>(req);
        const pastedTable = typeof body.pastedTable === "string" ? body.pastedTable : "";
        assertExactlyOneImportSource({
            hasFile: body.file != null,
            hasPaste: Boolean(pastedTable.trim()),
        });
        const goal = parseGoal(body.goal);
        assertDecodedImportRequestSize({ fields: [pastedTable, typeof body.fileName === "string" ? body.fileName : "", goal] });
        const session = await ImportSessionService.createSession(user.id, branchId, {
            sourceType: "PASTED_TABLE",
            fileName: typeof body.fileName === "string" ? body.fileName : "Pasted table",
            fileMeta: { pasted: true },
            pastedTable,
            goal,
        });
        const dispatch = await ImportWorkflowService.tryStartRun(session.analysisRun);
        return NextResponse.json({
            sessionId: session.id,
            runId: dispatch.run.id,
            status: dispatch.run.status,
            dispatchPending: dispatch.dispatchPending,
            workflowAttached: dispatch.workflowAttached,
            dispatchRequired: dispatch.dispatchRequired,
        }, { status: 202 });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to create import session.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}

export async function GET(_req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId } = await params;
        const sessions = await ImportSessionService.listSessions(user.id, branchId);
        return NextResponse.json(sessions);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to list import sessions.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
