import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        importSession: { findFirst: vi.fn(), updateMany: vi.fn() },
        importRow: { update: vi.fn(), findMany: vi.fn() },
        importQuestion: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
        importRowEvaluation: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    return {
        authorize: vi.fn(),
        assertBranchWritable: vi.fn(),
        sessionFindFirst: vi.fn(),
        runItemFindMany: vi.fn(),
        validateAllocation: vi.fn(),
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
vi.mock("@/importing/validators/import-allocation.validator", () => ({
    validateImportAllocation: mocks.validateAllocation,
}));
vi.mock("@/lib/prisma", () => ({
    prisma: {
        $transaction: mocks.transaction,
        importSession: { findFirst: mocks.sessionFindFirst },
        importRunItem: { findMany: mocks.runItemFindMany },
    },
}));

describe("PARTIAL import retry revalidation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.validateAllocation.mockReturnValue({
            issues: [{ code: "SHOULD_NOT_RUN", message: "allocation already exists", severity: "error" }],
            warnings: [],
            questions: [],
        });
        mocks.sessionFindFirst.mockResolvedValue({
            id: "session_1",
            branchId: "branch_1",
            sourceType: "CSV",
            engineVersion: 2,
            goal: "FULL",
            status: "PARTIAL",
            mapping: {
                entityTypesDetected: ["STUDENT", "ALLOCATION", "PAYMENT"],
                columnMappings: [{ sourceColumn: "Name", targetField: "student.name", confidence: 100 }],
                importOptions: { paymentAction: "SKIP_PAYMENTS", paymentCycle: "SKIP_PAYMENTS" },
            },
            fileMeta: { columns: ["Name"] },
            draftRevision: 4,
            activeEvaluationRevision: 3,
            archivedAt: null,
            rows: [{
                id: "row_1",
                importSessionId: "session_1",
                rowNumber: 2,
                rawData: { Name: "Asha" },
                mappedData: { __manualNormalizedData: true },
                normalizedData: {
                    student: {
                        name: "Asha",
                        phone: "9876543210",
                        joinedAt: "2026-01-01T00:00:00.000Z",
                        monthlyFee: 1200,
                    },
                    allocation: { seatLabel: "A1", shiftName: "Morning" },
                },
                status: "NEEDS_REVIEW",
                issues: [],
                warnings: [],
                confidence: 100,
                skipped: false,
                createdEntityIds: { studentId: "student_1", allocationIds: ["allocation_1"] },
            }],
        });
        mocks.runItemFindMany.mockResolvedValue([
            { importRowId: "row_1", kind: "STUDENT", result: { entityIds: ["student_1"] } },
            { importRowId: "row_1", kind: "ALLOCATION", result: { entityIds: ["allocation_1"] } },
        ]);
        mocks.tx.$queryRaw.mockResolvedValue([{ id: "session_1" }]);
        mocks.tx.importSession.findFirst.mockResolvedValue({ draftRevision: 4, archivedAt: null });
        mocks.tx.importSession.updateMany.mockResolvedValue({ count: 1 });
        mocks.tx.importRow.update.mockResolvedValue({});
        mocks.tx.importRow.findMany.mockResolvedValue([
            {
                id: "row_1",
                rowNumber: 2,
                status: "READY",
                skipped: false,
                mappedData: { __manualNormalizedData: true },
                normalizedData: {
                    student: { name: "Asha" },
                    allocation: { seatLabel: "A1", shiftName: "Morning" },
                },
                issues: [],
                warnings: [],
                confidence: 100,
            },
            {
                id: "row_imported",
                rowNumber: 3,
                status: "IMPORTED",
                skipped: false,
                mappedData: {},
                normalizedData: { student: { name: "Already imported" } },
                issues: [{ code: "OLD_IMPORTED_ISSUE", message: "Retained audit detail", severity: "error" }],
                warnings: [{ code: "OLD_IMPORTED_WARNING", message: "Retained audit detail", severity: "warning" }],
                confidence: 100,
            },
        ]);
        mocks.tx.importQuestion.deleteMany.mockResolvedValue({ count: 0 });
        mocks.tx.importQuestion.findMany.mockResolvedValue([]);
        mocks.tx.importRowEvaluation.deleteMany.mockResolvedValue({ count: 1 });
        mocks.tx.importRowEvaluation.createMany.mockResolvedValue({ count: 1 });
    });

    it("ignores its own created student and does not revalidate an already-succeeded allocation", async () => {
        const { ImportSessionService } = await import("@/importing/services/import-session.service");
        const internals = ImportSessionService as unknown as {
            getValidationContext: (branchId: string) => Promise<{
                branchDefaultFee: number;
                defaultAdmissionFee: number;
                seatsByLabel: Map<string, { id: string; label: string }>;
                shiftsByName: Map<string, { id: string; name: string; price: number }>;
                multiShiftsByName: Map<string, {
                    id: string;
                    name: string;
                    price: number;
                    components: Array<{ shiftId: string; shiftName: string }>;
                }>;
                existingStudents: Array<{
                    id: string;
                    name: string;
                    phone: string;
                    joinedAt: Date;
                    seatAllocations: Array<{ seat: { label: string }; shift: { name: string } }>;
                }>;
                activeAllocations: unknown[];
                aiBranchContext: Record<string, never>;
            }>;
            revalidateAuthorizedSession: (
                userId: string,
                branchId: string,
                sessionId: string
            ) => Promise<{ id: string }>;
        };
        vi.spyOn(internals, "getValidationContext").mockResolvedValue({
            branchDefaultFee: 1000,
            defaultAdmissionFee: 0,
            seatsByLabel: new Map([["a1", { id: "seat_1", label: "A1" }]]),
            shiftsByName: new Map([["morning", { id: "shift_1", name: "Morning", price: 1200 }]]),
            multiShiftsByName: new Map(),
            existingStudents: [{
                id: "student_1",
                name: "Asha",
                phone: "9876543210",
                joinedAt: new Date("2026-01-01T00:00:00.000Z"),
                seatAllocations: [{ seat: { label: "A1" }, shift: { name: "Morning" } }],
            }],
            activeAllocations: [],
            aiBranchContext: {},
        });
        vi.spyOn(ImportSessionService, "getSessionDetail").mockResolvedValue({ id: "session_1" } as never);

        await internals.revalidateAuthorizedSession("user_1", "branch_1", "session_1");

        expect(mocks.validateAllocation).not.toHaveBeenCalled();
        expect(mocks.tx.importRow.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "row_1" },
            data: expect.objectContaining({
                status: "READY",
                issues: [],
                warnings: [],
            }),
        }));
        expect(mocks.tx.importSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                summary: expect.objectContaining({ attention: [] }),
                mapping: expect.objectContaining({
                    analysis: expect.objectContaining({ attention: [] }),
                }),
            }),
        }));
    });
});

vi.mock("@/services/accessPolicy.service", async importOriginal => {
    const actual = await importOriginal<typeof import("@/services/accessPolicy.service")>();
    const { callerPolicyMock } = await import("@/tests/helpers/accessPolicyCallerMock");
    const { StaffService } = await import("@/services/staff.service");
    const { EntitlementService } = await import("@/services/entitlement.service");
    return { ...actual, AccessPolicy: callerPolicyMock(actual.AccessPolicy, StaffService, EntitlementService) };
});
