import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importSession: {
            findFirst: vi.fn(),
            update: vi.fn(),
        },
    };
    return {
        authorize: vi.fn(),
        assertBranchWritable: vi.fn(),
        mapImportColumns: vi.fn(),
        sessionFindFirst: vi.fn(),
        sessionUpdateMany: vi.fn(),
        tx,
        transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
});

vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));

vi.mock("@/importing/ai/import-column-mapper.ai", () => ({
    mapImportColumns: mocks.mapImportColumns,
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        $transaction: mocks.transaction,
        importSession: {
            findFirst: mocks.sessionFindFirst,
            updateMany: mocks.sessionUpdateMany,
        },
    },
}));

const initialSession = {
    id: "session_1",
    branchId: "branch_1",
    engineVersion: 2,
    goal: "STUDENTS",
    status: "UPLOADED",
    mapping: null,
    fileMeta: { columns: ["Name"] },
    summary: null,
    draftRevision: 0,
    activeEvaluationRevision: null,
    archivedAt: null,
    rows: [{ id: "row_1", rowNumber: 2, rawData: { Name: "Asha" } }],
};

describe("import analysis replay", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.assertBranchWritable.mockResolvedValue({});
        mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "session_1" }]);
        mocks.tx.importSession.findFirst.mockImplementation(async () => ({
            draftRevision: 0,
            archivedAt: null,
            status: "ANALYZING",
            analysisLeaseToken: mocks.sessionUpdateMany.mock.calls[0]?.[0]?.data?.analysisLeaseToken,
        }));
        mocks.tx.importSession.update.mockResolvedValue({});
        mocks.mapImportColumns.mockResolvedValue({
            entityTypesDetected: ["STUDENT"],
            columnMappings: [{ sourceColumn: "Name", targetField: "student.name", confidence: 100 }],
            questions: [],
            warnings: [],
            suggestedImportOptions: {},
        });
    });

    it("advances the analysis base revision exactly once under a session lock", async () => {
        mocks.sessionFindFirst.mockResolvedValueOnce(initialSession);
        const { ImportSessionService } = await import("@/importing/services/import-session.service");
        const internals = ImportSessionService as unknown as {
            getValidationContext: (branchId: string) => Promise<{ aiBranchContext: Record<string, never> }>;
            revalidateAuthorizedSession: (
                userId: string,
                branchId: string,
                sessionId: string
            ) => Promise<{ id: string; activeEvaluationRevision: number }>;
        };
        vi.spyOn(internals, "getValidationContext").mockResolvedValue({
            aiBranchContext: {},
        });
        vi.spyOn(internals, "revalidateAuthorizedSession").mockResolvedValue({
            id: "session_1",
            activeEvaluationRevision: 1,
        });

        const detail = await ImportSessionService.analyzeSession("user_1", "branch_1", "session_1", 0);

        expect(detail).toMatchObject({ activeEvaluationRevision: 1 });
        expect(mocks.tx.importSession.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "session_1" },
            data: expect.objectContaining({ draftRevision: { increment: 1 } }),
        }));
    });

    it("returns an already published newer revision without rerunning AI", async () => {
        mocks.sessionFindFirst.mockResolvedValueOnce({
            ...initialSession,
            status: "READY_TO_COMMIT",
            mapping: { entityTypesDetected: ["STUDENT"], columnMappings: [] },
            draftRevision: 1,
            activeEvaluationRevision: 1,
        });
        const { ImportSessionService } = await import("@/importing/services/import-session.service");
        vi.spyOn(ImportSessionService, "getSessionDetail").mockResolvedValue({
            id: "session_1",
            activeEvaluationRevision: 1,
        } as never);

        const detail = await ImportSessionService.analyzeSession("user_1", "branch_1", "session_1", 0);

        expect(detail).toMatchObject({ activeEvaluationRevision: 1 });
        expect(mocks.mapImportColumns).not.toHaveBeenCalled();
        expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
    });
});

vi.mock("@/services/accessPolicy.service", async importOriginal => {
    const actual = await importOriginal<typeof import("@/services/accessPolicy.service")>();
    const { callerPolicyMock } = await import("@/tests/helpers/accessPolicyCallerMock");
    const { StaffService } = await import("@/services/staff.service");
    const { EntitlementService } = await import("@/services/entitlement.service");
    return { ...actual, AccessPolicy: callerPolicyMock(actual.AccessPolicy, StaffService, EntitlementService) };
});
