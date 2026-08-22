import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    getRunErrors: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
    getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/importing/services/import-run.service", () => ({
    ImportRunService: {
        getRunErrors: mocks.getRunErrors,
    },
}));

function routeContext() {
    return { params: Promise.resolve({ branchId: "branch_1", runId: "run_1" }) };
}

describe("/api/branches/[branchId]/import-runs/[runId]/errors", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.getRunErrors.mockResolvedValue([
            {
                kind: "PAYMENT_CYCLE",
                status: "FAILED",
                attemptCount: 3,
                error: { code: "IMPORT_DOMAIN_CONFLICT", message: "=2+2" },
                row: { rowNumber: 7 },
            },
        ]);
    });

    it("returns 401 without loading error rows", async () => {
        mocks.getSessionUser.mockResolvedValueOnce(null);
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/errors/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1/errors"),
            routeContext()
        );

        expect(response.status).toBe(401);
        expect(mocks.getRunErrors).not.toHaveBeenCalled();
    });

    it("exports authorized errors as private UTF-8 CSV with spreadsheet text escaped", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/errors/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1/errors?format=csv"),
            routeContext()
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        const csv = new TextDecoder().decode(bytes.slice(3));

        expect(mocks.getRunErrors).toHaveBeenCalledWith("user_1", "branch_1", "run_1");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
        expect(response.headers.get("content-disposition")).toBe('attachment; filename="import-run_1-issues.csv"');
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(csv).toContain('"Row number","Mutation","Status","Attempts","Error code","What happened"');
        expect(csv).toContain('"7","PAYMENT_CYCLE","FAILED","3","IMPORT_DOMAIN_CONFLICT","\'=2+2"');
    });

    it("exports authorized errors as a readable private XLSX workbook", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/errors/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1/errors?format=xlsx"),
            routeContext()
        );
        const workbook = XLSX.read(await response.arrayBuffer(), { type: "array" });
        const sheet = workbook.Sheets["Import issues"];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        expect(response.headers.get("content-disposition")).toBe('attachment; filename="import-run_1-issues.xlsx"');
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(rows).toEqual([{
            "Row number": "7",
            Mutation: "PAYMENT_CYCLE",
            Status: "FAILED",
            Attempts: "3",
            "Error code": "IMPORT_DOMAIN_CONFLICT",
            "What happened": "'=2+2",
        }]);
    });

    it("rejects an unsupported export format before loading errors", async () => {
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/errors/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_1/errors?format=pdf"),
            routeContext()
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Failed to export import issues." });
        expect(mocks.getRunErrors).not.toHaveBeenCalled();
    });

    it.each([
        "Import run not found",
        "Unauthorized: run belongs to another organization",
    ])("returns the same tenant-safe response for %s", async message => {
        mocks.getRunErrors.mockRejectedValueOnce(new Error(message));
        const { GET } = await import("@/app/api/branches/[branchId]/import-runs/[runId]/errors/route");
        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-runs/run_foreign/errors"),
            routeContext()
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
            error: "Import resource not found.",
            code: "IMPORT_NOT_FOUND",
        });
    });
});
