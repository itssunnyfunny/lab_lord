import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_REQUEST_BYTES } from "@/importing/http/import-request";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    createSession: vi.fn(),
    listSessions: vi.fn(),
    createOrGetRun: vi.fn(),
    setAnalysisStatus: vi.fn(),
    startRun: vi.fn(),
    tryStartRun: vi.fn(),
    inspectXlsxWorkbook: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
    getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/importing/parsers/xlsx.parser", () => ({
    inspectXlsxWorkbook: mocks.inspectXlsxWorkbook,
}));

vi.mock("@/importing/services/import-session.service", () => ({
    ImportSessionService: {
        createSession: mocks.createSession,
        listSessions: mocks.listSessions,
    },
}));

vi.mock("@/importing/services/import-run.service", () => ({
    ImportRunService: {
        createOrGetRun: mocks.createOrGetRun,
    },
}));

vi.mock("@/importing/services/import-runner.service", () => ({
    ImportRunRunner: {
        setAnalysisStatus: mocks.setAnalysisStatus,
    },
}));

vi.mock("@/importing/services/import-workflow", () => ({
    ImportWorkflowService: {
        startRun: mocks.startRun,
        tryStartRun: mocks.tryStartRun,
    },
}));

function routeContext() {
    return { params: Promise.resolve({ branchId: "branch_1" }) };
}

function uploadRequest(file: File, fields: Record<string, string> = {}) {
    const form = new FormData();
    form.set("file", file);
    form.set("goal", fields.goal ?? "STUDENTS");
    for (const [key, value] of Object.entries(fields)) {
        if (key !== "goal") form.set(key, value);
    }
    return new Request("http://test.local/api/branches/branch_1/import-sessions", {
        method: "POST",
        body: form,
    });
}

describe("/api/branches/[branchId]/import-sessions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("IMPORT_V2_ENABLED", "true");
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
        mocks.createSession.mockResolvedValue({
            id: "session_1",
            extractionPreview: null,
            analysisRun: { id: "run_1", status: "QUEUED" },
        });
        mocks.createOrGetRun.mockResolvedValue({
            id: "run_1",
            kind: "ANALYSIS",
            status: "QUEUED",
            workflowRunId: null,
        });
        mocks.startRun.mockResolvedValue({ id: "run_1", status: "RUNNING" });
        mocks.tryStartRun.mockResolvedValue({
            run: { id: "run_1", status: "RUNNING" },
            dispatchPending: false,
            workflowAttached: true,
            dispatchRequired: false,
        });
        mocks.setAnalysisStatus.mockResolvedValue({ id: "run_1", status: "WAITING_FOR_USER" });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("returns 401 for unauthenticated POST", async () => {
        mocks.getSessionUser.mockResolvedValueOnce(null);
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");

        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-sessions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ pastedTable: "Name\nAsha", goal: "STUDENTS" }),
            }),
            routeContext()
        );

        expect(response.status).toBe(401);
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it("returns 401 for unauthenticated GET", async () => {
        mocks.getSessionUser.mockResolvedValueOnce(null);
        const { GET } = await import("@/app/api/branches/[branchId]/import-sessions/route");

        const response = await GET(
            new Request("http://test.local/api/branches/branch_1/import-sessions"),
            routeContext()
        );

        expect(response.status).toBe(401);
        expect(mocks.listSessions).not.toHaveBeenCalled();
    });

    it.each([
        ["no source", { pastedTable: "", goal: "STUDENTS" }],
        ["both sources", { pastedTable: "Name\nAsha", file: { name: "students.csv" }, goal: "STUDENTS" }],
    ])("rejects %s with the shared source-discrimination error", async (_label, body) => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-sessions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
            routeContext()
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            error: "Choose exactly one import source: a file or a pasted table.",
            code: "IMPORT_SOURCE_REQUIRED",
        });
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it("rejects an oversized request from Content-Length before reading the body", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-sessions", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": String(MAX_IMPORT_REQUEST_BYTES + 1),
                },
                body: "{}",
            }),
            routeContext()
        );

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toEqual({
            error: "Import request is larger than the 4.25 MiB request limit.",
            code: "IMPORT_REQUEST_TOO_LARGE",
        });
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it("rejects unknown multipart string parts that push the raw request over the cap", async () => {
        const form = new FormData();
        form.set("file", new File(["Name\nAsha"], "students.csv", { type: "text/csv" }));
        form.set("goal", "STUDENTS");
        form.set("unrecognized", "x".repeat(MAX_IMPORT_REQUEST_BYTES));
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const response = await POST(new Request(
            "http://test.local/api/branches/branch_1/import-sessions",
            { method: "POST", body: form }
        ), routeContext());

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({ code: "IMPORT_REQUEST_TOO_LARGE" });
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it("rejects unknown multipart file parts that push the raw request over the cap", async () => {
        const form = new FormData();
        form.set("file", new File(["Name\nAsha"], "students.csv", { type: "text/csv" }));
        form.set("goal", "STUDENTS");
        form.set("unrecognizedFile", new File([
            new Uint8Array(MAX_IMPORT_REQUEST_BYTES),
        ], "payload.bin", { type: "application/octet-stream" }));
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const response = await POST(new Request(
            "http://test.local/api/branches/branch_1/import-sessions",
            { method: "POST", body: form }
        ), routeContext());

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toMatchObject({ code: "IMPORT_REQUEST_TOO_LARGE" });
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it("creates a pasted-table session and starts its analysis Workflow", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const response = await POST(
            new Request("http://test.local/api/branches/branch_1/import-sessions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ pastedTable: "Name\nAsha", goal: "STUDENTS" }),
            }),
            routeContext()
        );

        expect(response.status).toBe(202);
        expect(mocks.createSession).toHaveBeenCalledWith("user_1", "branch_1", {
            sourceType: "PASTED_TABLE",
            fileName: "Pasted table",
            fileMeta: { pasted: true },
            pastedTable: "Name\nAsha",
            goal: "STUDENTS",
        });
        expect(mocks.tryStartRun).toHaveBeenCalledWith({ id: "run_1", status: "QUEUED" });
        await expect(response.json()).resolves.toEqual({
            sessionId: "session_1",
            runId: "run_1",
            status: "RUNNING",
            dispatchPending: false,
            workflowAttached: true,
            dispatchRequired: false,
        });
    });

    it("returns durable session/run identifiers when initial Workflow dispatch is unavailable", async () => {
        mocks.tryStartRun.mockResolvedValueOnce({
            run: { id: "run_1", status: "QUEUED" },
            dispatchPending: true,
            workflowAttached: false,
            dispatchRequired: true,
        });
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const response = await POST(new Request(
            "http://test.local/api/branches/branch_1/import-sessions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ pastedTable: "Name\nAsha", goal: "STUDENTS" }),
            }
        ), routeContext());

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            sessionId: "session_1",
            runId: "run_1",
            status: "QUEUED",
            dispatchPending: true,
            dispatchRequired: true,
        });
        expect(mocks.createSession).toHaveBeenCalledTimes(1);
    });

    it("accepts an authorized CSV upload and starts analysis", async () => {
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const file = new File(["Name,Phone\nAsha,9999999999"], "students.csv", { type: "text/csv" });
        const response = await POST(uploadRequest(file), routeContext());

        expect(response.status).toBe(202);
        expect(mocks.createSession).toHaveBeenCalledWith("user_1", "branch_1", expect.objectContaining({
            sourceType: "CSV",
            fileName: "students.csv",
            fileMeta: { size: file.size, type: "text/csv" },
            fileBuffer: expect.any(Buffer),
            goal: "STUDENTS",
        }));
        expect(mocks.tryStartRun).toHaveBeenCalledTimes(1);
    });

    it("returns workbook choices instead of silently selecting a sheet", async () => {
        const workbook = {
            format: "XLSX" as const,
            sheets: [
                { name: "January", headerCandidates: [{ row: 2, values: ["Name", "Phone"] }] },
                { name: "February", headerCandidates: [{ row: 1, values: ["Name", "Phone"] }] },
            ],
        };
        mocks.inspectXlsxWorkbook.mockResolvedValueOnce(workbook);
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const response = await POST(
            uploadRequest(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "students.xlsx", {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            })),
            routeContext()
        );

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({
            error: "Select the worksheet and header row before importing.",
            code: "IMPORT_WORKBOOK_SELECTION_REQUIRED",
            workbook,
        });
        expect(mocks.inspectXlsxWorkbook).toHaveBeenCalledWith(expect.any(Buffer));
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it("rejects XLS content uploaded with an XLSX extension before workbook selection", async () => {
        mocks.inspectXlsxWorkbook.mockResolvedValueOnce({
            format: "XLS",
            sheets: [{ name: "Students", headerCandidates: [{ rowNumber: 1, values: ["Name"] }] }],
        });
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");

        const response = await POST(
            uploadRequest(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], "students.xlsx", {
                type: "application/octet-stream",
            })),
            routeContext()
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code: "INVALID_IMPORT_SOURCE" });
        expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it("stages PDF text extraction in WAITING_FOR_USER without starting Workflow", async () => {
        const extractionPreview = {
            mode: "PDF_TEXT_BETA",
            warnings: ["Review extracted text before analysis."],
            rows: [["Asha", "9999999999"]],
        };
        mocks.createSession.mockResolvedValueOnce({
            id: "session_pdf",
            extractionPreview,
            analysisRun: { id: "run_pdf", status: "WAITING_FOR_USER" },
        });
        mocks.createOrGetRun.mockResolvedValueOnce({
            id: "run_pdf",
            kind: "ANALYSIS",
            status: "QUEUED",
            workflowRunId: null,
        });
        mocks.setAnalysisStatus.mockResolvedValueOnce({ id: "run_pdf", status: "WAITING_FOR_USER" });
        const { POST } = await import("@/app/api/branches/[branchId]/import-sessions/route");
        const file = new File(["%PDF-1.7\n"], "students.pdf", { type: "application/pdf" });
        const response = await POST(uploadRequest(file, { goal: "FULL" }), routeContext());

        expect(response.status).toBe(202);
        expect(mocks.createSession).toHaveBeenCalledWith("user_1", "branch_1", expect.objectContaining({
            sourceType: "PDF",
            goal: "FULL",
            sourceConfiguration: { sheetName: undefined, headerRow: undefined, pdfConfirmed: false },
        }));
        expect(mocks.tryStartRun).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({
            sessionId: "session_pdf",
            runId: "run_pdf",
            status: "WAITING_FOR_USER",
            dispatchPending: false,
            workflowAttached: false,
            dispatchRequired: false,
            requiresPdfConfirmation: true,
            extractionPreview,
        });
    });
});
