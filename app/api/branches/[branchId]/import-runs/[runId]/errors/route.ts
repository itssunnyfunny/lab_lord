import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportRunService } from "@/importing/services/import-run.service";

type Params = { params: Promise<{ branchId: string; runId: string }> };

function errorRecord(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { code: "", message: "" };
    const record = value as Record<string, unknown>;
    return {
        code: typeof record.code === "string" ? record.code : "",
        message: typeof record.message === "string" ? record.message : "",
    };
}

function safeSpreadsheetText(value: unknown) {
    const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown) {
    return `"${safeSpreadsheetText(value).replace(/"/g, '""')}"`;
}

export async function GET(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, runId } = await params;
        const format = new URL(req.url).searchParams.get("format")?.toLowerCase() ?? "csv";
        if (format !== "csv" && format !== "xlsx") throw new Error("Error export format must be CSV or XLSX.");
        const items = await ImportRunService.getRunErrors(user.id, branchId, runId);
        const rows = items.map(item => {
            const error = errorRecord(item.error);
            return {
                "Row number": safeSpreadsheetText(item.row?.rowNumber ?? ""),
                "Mutation": safeSpreadsheetText(item.kind),
                "Status": safeSpreadsheetText(item.status),
                "Attempts": safeSpreadsheetText(item.attemptCount),
                "Error code": safeSpreadsheetText(error.code),
                "What happened": safeSpreadsheetText(error.message),
            };
        });
        const safeRunId = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "run";

        if (format === "xlsx") {
            const XLSX = await import("xlsx");
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Import issues");
            const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
            const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            return new NextResponse(body, {
                headers: {
                    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "Content-Disposition": `attachment; filename="import-${safeRunId}-issues.xlsx"`,
                    "Cache-Control": "private, no-store",
                },
            });
        }

        const headers = ["Row number", "Mutation", "Status", "Attempts", "Error code", "What happened"];
        const csv = [
            headers.map(csvCell).join(","),
            ...rows.map(row => headers.map(header => csvCell(row[header as keyof typeof row])).join(",")),
        ].join("\r\n");
        return new NextResponse(`\uFEFF${csv}`, {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="import-${safeRunId}-issues.csv"`,
                "Cache-Control": "private, no-store",
            },
        });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to export import issues.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
