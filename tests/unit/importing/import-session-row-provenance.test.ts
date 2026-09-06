import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    assertBranchWritable: vi.fn(),
    transaction: vi.fn(),
    importSessionCreate: vi.fn(),
    importRowCreateMany: vi.fn(),
    importRunCreate: vi.fn(),
    tx: {
        importSession: { create: vi.fn() },
        importRow: { createMany: vi.fn() },
        importRun: { create: vi.fn() },
    },
}));

vi.mock("@/lib/prisma", () => ({
    prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));

vi.mock("@/importing/ai/import-column-mapper.ai", () => ({
    mapImportColumns: vi.fn(),
}));

import { ImportSessionService } from "@/importing/services/import-session.service";

describe("ImportSessionService source row provenance", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(undefined);
        mocks.assertBranchWritable.mockResolvedValue(undefined);
        mocks.tx.importSession.create = mocks.importSessionCreate;
        mocks.tx.importRow.createMany = mocks.importRowCreateMany;
        mocks.tx.importRun.create = mocks.importRunCreate;
        mocks.importSessionCreate.mockResolvedValue({
            id: "session_1",
            status: "UPLOADED",
            sourceConfiguration: {},
        });
        mocks.importRowCreateMany.mockResolvedValue({ count: 2 });
        mocks.importRunCreate.mockResolvedValue({ id: "run_1", status: "QUEUED" });
        mocks.transaction.mockImplementation(async callback => callback(mocks.tx));
    });

    it("persists physical CSV row numbers across blank source rows", async () => {
        await ImportSessionService.createSession("user_1", "branch_1", {
            sourceType: "CSV",
            fileName: "students.csv",
            fileBuffer: Buffer.from("Name\nAsha\n\nRavi"),
            goal: "STUDENTS",
        });

        expect(mocks.importRowCreateMany).toHaveBeenCalledOnce();
        expect(mocks.importRowCreateMany.mock.calls[0][0].data.map(
            (row: { rowNumber: number }) => row.rowNumber
        )).toEqual([2, 4]);
        expect(mocks.importRunCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                branchId: "branch_1",
                importSessionId: "session_1",
                targetRevision: 0,
                idempotencyKey: "analysis:session_1:0",
                requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                kind: "ANALYSIS",
                status: "QUEUED",
                totalItems: 0,
            }),
        });
    });

    it("persists selected workbook positions after its header and blank rows", async () => {
        const XLSX = await import("xlsx");
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ["Instructions"],
            [],
            ["Name"],
            [],
            ["Asha"],
            [],
            ["Ravi"],
        ]), "Students");
        const fileBuffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

        await ImportSessionService.createSession("user_1", "branch_1", {
            sourceType: "XLSX",
            fileName: "students.xlsx",
            fileBuffer,
            goal: "STUDENTS",
            sourceConfiguration: { sheetName: "Students", headerRow: 3 },
        });

        expect(mocks.importRowCreateMany).toHaveBeenCalledOnce();
        expect(mocks.importRowCreateMany.mock.calls[0][0].data.map(
            (row: { rowNumber: number }) => row.rowNumber
        )).toEqual([5, 7]);
    });
});

vi.mock("@/services/accessPolicy.service", async importOriginal => {
    const actual = await importOriginal<typeof import("@/services/accessPolicy.service")>();
    const { callerPolicyMock } = await import("@/tests/helpers/accessPolicyCallerMock");
    const { StaffService } = await import("@/services/staff.service");
    const { EntitlementService } = await import("@/services/entitlement.service");
    return { ...actual, AccessPolicy: callerPolicyMock(actual.AccessPolicy, StaffService, EntitlementService) };
});
