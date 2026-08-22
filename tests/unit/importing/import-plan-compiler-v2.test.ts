import { describe, expect, it } from "vitest";
import type { ImportMappingState } from "@/importing/contracts/import-session.contract";
import {
    compileImportPlanSnapshot,
    createImportMutationRequestHash,
    createImportRequestHash,
    readinessPolicyFromLegacyCommitMode,
} from "@/importing/utils/import-plan-compiler";

const mapping: ImportMappingState = {
    entityTypesDetected: ["STUDENT", "ALLOCATION", "PAYMENT"],
    columnMappings: [{
        sourceColumn: "Name",
        targetField: "student.name",
        confidence: 100,
    }],
    importOptions: {
        paymentAction: "GENERATE_DUE",
        paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
        paymentHistoryMode: "FROM_JOINED_MARK_DUE",
    },
};

function evaluations() {
    return [
        {
            id: "evaluation_1",
            rowId: "row_1",
            rowNumber: 2,
            status: "READY" as const,
            skipped: false,
            normalizedData: {
                student: {
                    name: "Asha",
                    joinedAt: "2026-01-01T00:00:00.000Z",
                    monthlyFee: 1200,
                },
                allocation: { seatLabel: "A1", shiftName: "Morning" },
            },
            warnings: [],
        },
        {
            id: "evaluation_2",
            rowId: "row_2",
            rowNumber: 3,
            status: "BLOCKED" as const,
            skipped: false,
            normalizedData: { student: {} },
            warnings: [],
        },
        {
            id: "evaluation_3",
            rowId: "row_3",
            rowNumber: 4,
            status: "SKIPPED" as const,
            skipped: true,
            normalizedData: { student: { name: "Skipped" } },
            warnings: [],
        },
    ];
}

describe("Import Assistance V2 plan compiler", () => {
    it("keeps readiness policy separate from transaction atomicity", () => {
        const partial = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 4,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: evaluations(),
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });
        const allReady = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 4,
            goal: "FULL",
            readinessPolicy: "REQUIRE_ALL_ROWS_READY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: evaluations(),
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });

        expect(partial.canRun).toBe(true);
        expect(partial).toMatchObject({ readyRows: 1, blockedRows: 1, skippedRows: 1 });
        expect(allReady.canRun).toBe(false);
        expect(allReady.checks.find(check => check.code === "ALL_ROWS_READY")?.status).toBe("block");
        expect(readinessPolicyFromLegacyCommitMode("STRICT_ALL_OR_NOTHING")).toBe("REQUIRE_ALL_ROWS_READY");
    });

    it("compiles one ledger item per deterministic mutation and payment cycle", () => {
        const januaryStart = new Date(2026, 0, 1).toISOString();
        const februaryStart = new Date(2026, 1, 1).toISOString();
        const marchStart = new Date(2026, 2, 1).toISOString();
        const plan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 4,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: evaluations(),
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });

        expect(plan.snapshot.items.filter(item => item.kind === "STUDENT")).toHaveLength(1);
        expect(plan.snapshot.items.filter(item => item.kind === "ALLOCATION")).toHaveLength(1);
        expect(plan.snapshot.items.filter(item => item.kind === "PAYMENT_CYCLE")).toHaveLength(2);
        expect(plan.snapshot.items.filter(item => item.kind === "PAYMENT_CYCLE").map(item => item.payload)).toEqual([
            expect.objectContaining({
                bucket: "historical",
                status: "DUE",
                amount: 1200,
                cycle: {
                    periodStart: januaryStart,
                    periodEnd: februaryStart,
                    dueDate: februaryStart,
                },
            }),
            expect.objectContaining({
                bucket: "current",
                status: "DUE",
                amount: 1200,
                cycle: {
                    periodStart: februaryStart,
                    periodEnd: marchStart,
                    dueDate: marchStart,
                },
            }),
        ]);
        expect(new Set(plan.snapshot.items.map(item => item.itemKey)).size).toBe(plan.snapshot.items.length);
        expect(plan.snapshot.evaluations).toHaveLength(3);
        expect(plan.snapshot.mutationSummary.paymentBreakdown).toEqual([{
            rowId: "row_1",
            rowNumber: 2,
            studentName: "Asha",
            historical: { DUE: 1, PAID: 0, WAIVED: 0 },
            current: { DUE: 1, PAID: 0, WAIVED: 0 },
            total: 2,
        }]);
    });

    it("stops high-fanout payment expansion at the configured cap plus one sentinel item", () => {
        const maxPlannedMutations = 25;
        const highFanoutEvaluations = Array.from({ length: 2_000 }, (_, index) => ({
            id: `evaluation_${index + 1}`,
            rowId: `row_${index + 1}`,
            rowNumber: index + 2,
            status: "READY" as const,
            skipped: false,
            normalizedData: {
                student: {
                    name: `Student ${index + 1}`,
                    joinedAt: "1970-01-01T00:00:00.000Z",
                    monthlyFee: 1200,
                },
            },
            warnings: [],
        }));

        const plan = compileImportPlanSnapshot({
            sessionId: "session_high_fanout",
            targetRevision: 1,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: highFanoutEvaluations.length,
            evaluations: highFanoutEvaluations,
            asOf: new Date("2026-08-18T00:00:00.000Z"),
            maxPlannedMutations,
        });

        expect(plan.canRun).toBe(false);
        expect(plan.snapshot.items).toHaveLength(maxPlannedMutations + 1);
        expect(plan.snapshot.mutationSummary.total).toBe(maxPlannedMutations + 1);
        expect(new Set(plan.snapshot.items.map(item => item.rowId))).toEqual(new Set(["row_1"]));
        expect(plan.checks).toContainEqual(expect.objectContaining({
            code: "MUTATION_LIMIT",
            status: "block",
            count: maxPlannedMutations + 1,
        }));
    });

    it("pins the reviewed multi-shift component structure in the allocation item", () => {
        const plan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 4,
            goal: "STUDENTS_ALLOCATIONS",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 1,
            evaluations: [{
                id: "evaluation_1",
                rowId: "row_1",
                rowNumber: 2,
                status: "READY",
                skipped: false,
                normalizedData: {
                    student: { name: "Asha", monthlyFee: 2400 },
                    allocation: { seatLabel: "A1", multiShiftName: "Full day" },
                    multiShift: { name: "Full day", componentShiftNames: ["Morning", "Evening"] },
                },
                warnings: [],
            }],
        });

        expect(plan.snapshot.items.find(item => item.kind === "ALLOCATION")?.payload).toMatchObject({
            allocation: {
                seatLabel: "A1",
                multiShiftName: "Full day",
                componentShiftNames: ["Morning", "Evening"],
            },
        });
    });

    it("omits stable successes and carries the retained student id into remaining retry items", () => {
        const firstPlan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 4,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: evaluations(),
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });
        const paymentKeys = firstPlan.snapshot.items
            .filter(item => item.kind === "PAYMENT_CYCLE")
            .map(item => item.itemKey);
        const succeeded = (itemKey: string, entityId: string) => {
            const item = firstPlan.snapshot.items.find(candidate => candidate.itemKey === itemKey)!;
            return {
                itemKey,
                kind: item.kind,
                rowId: item.rowId,
                entityIds: [entityId],
                requestHash: createImportMutationRequestHash(item),
            };
        };

        const retryPlan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 5,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: evaluations(),
            previouslySucceededItems: [
                succeeded("row:row_1:student", "student_1"),
                succeeded("row:row_1:allocation", "allocation_1"),
                succeeded(paymentKeys[0], "payment_1"),
            ],
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });

        expect(retryPlan.canRun).toBe(true);
        expect(retryPlan.snapshot.items).toHaveLength(1);
        expect(retryPlan.snapshot.items[0]).toMatchObject({
            itemKey: paymentKeys[1],
            kind: "PAYMENT_CYCLE",
            payload: { studentId: "student_1" },
        });
        expect(retryPlan.snapshot.items[0].payload).not.toHaveProperty("studentItemKey");
        expect(retryPlan.snapshot.mutationSummary.paymentBreakdown[0]).toMatchObject({ total: 1 });
    });

    it("blocks a repair plan when edited data no longer matches a completed mutation", () => {
        const firstPlan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 4,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: evaluations(),
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });
        const student = firstPlan.snapshot.items.find(item => item.kind === "STUDENT")!;
        const editedEvaluations: Parameters<typeof compileImportPlanSnapshot>[0]["evaluations"] = evaluations();
        editedEvaluations[0] = {
            id: "evaluation_1",
            rowId: "row_1",
            rowNumber: 2,
            status: "READY",
            skipped: false,
            normalizedData: {
                student: {
                    name: "Edited Asha",
                    joinedAt: "2026-01-01T00:00:00.000Z",
                    monthlyFee: 1200,
                },
                allocation: { seatLabel: "A1", shiftName: "Morning" },
            },
            warnings: [],
        };

        const repairPlan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 5,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: editedEvaluations,
            previouslySucceededItems: [{
                itemKey: student.itemKey,
                kind: student.kind,
                rowId: student.rowId,
                entityIds: ["student_1"],
                requestHash: createImportMutationRequestHash(student),
            }],
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });

        expect(repairPlan.canRun).toBe(false);
        expect(repairPlan.checks).toContainEqual(expect.objectContaining({
            code: "RETRY_MUTATION_CONFLICT",
            status: "block",
            count: 1,
        }));
        expect(repairPlan.snapshot.items.some(item => item.rowId === "row_1")).toBe(false);
    });

    it("blocks edited allocation and payment mutations that already succeeded", () => {
        const firstPlan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 4,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: evaluations(),
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });
        const completed = firstPlan.snapshot.items.map((item, index) => ({
            itemKey: item.itemKey,
            kind: item.kind,
            rowId: item.rowId,
            entityIds: [`entity_${index}`],
            requestHash: createImportMutationRequestHash(item),
        }));
        const editedEvaluations: Parameters<typeof compileImportPlanSnapshot>[0]["evaluations"] = evaluations();
        editedEvaluations[0] = {
            id: "evaluation_1",
            rowId: "row_1",
            rowNumber: 2,
            status: "READY",
            skipped: false,
            normalizedData: {
                student: {
                    name: "Asha",
                    joinedAt: "2026-01-01T00:00:00.000Z",
                    monthlyFee: 1200,
                },
                allocation: { seatLabel: "A2", shiftName: "Morning" },
                payment: { amount: 500 },
            },
            warnings: [],
        };

        const repairPlan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 5,
            goal: "FULL",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: editedEvaluations,
            previouslySucceededItems: completed,
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });

        expect(repairPlan.canRun).toBe(false);
        expect(repairPlan.checks).toContainEqual(expect.objectContaining({
            code: "RETRY_MUTATION_CONFLICT",
            status: "block",
            count: 3,
        }));
        expect(repairPlan.snapshot.items).toHaveLength(0);
    });

    it("orders prerequisite configuration and counts every row sharing a deduplicated config", () => {
        const configMapping: ImportMappingState = {
            ...mapping,
            importOptions: {
                ...mapping.importOptions,
                createUnknownSeats: true,
                createUnknownShifts: true,
                createUnknownMultiShifts: true,
                configurationBatchApproved: true,
            },
        };
        const configEvaluations = [1, 2].map(index => ({
            id: `evaluation_${index}`,
            rowId: `row_${index}`,
            rowNumber: index + 1,
            status: "READY" as const,
            skipped: false,
            normalizedData: {
                student: { name: `Student ${index}`, joinedAt: "2026-01-01T00:00:00.000Z", monthlyFee: 1200 },
                seat: { label: "A1" },
                shift: { name: "Morning" },
                multiShift: { name: "Full day", componentShiftNames: ["Morning"] },
            },
            warnings: [],
        }));

        const plan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 1,
            goal: "STUDENTS",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping: configMapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 2,
            evaluations: configEvaluations,
        });
        const configItems = plan.snapshot.items.filter(item => item.kind === "CONFIG");

        expect(configItems.map(item => item.payload?.type)).toEqual(["seat", "shift", "multi-shift"]);
        expect(configItems.find(item => item.payload?.type === "shift")?.payload).toMatchObject({ price: 1200 });
        expect(configItems.find(item => item.payload?.type === "multi-shift")?.payload).toMatchObject({ price: 1200 });
        expect(plan.snapshot.mutationSummary.configuration).toBe(3);
        expect(plan.snapshot.mutationSummary.affectedRows.configuration).toBe(2);
        expect(plan.snapshot.configurationApproval.affectedRows).toBe(2);
    });

    it("blocks conflicting definitions for one normalized configuration identity", () => {
        const conflictMapping: ImportMappingState = {
            ...mapping,
            importOptions: {
                ...mapping.importOptions,
                createUnknownShifts: true,
                configurationBatchApproved: true,
            },
        };
        const plan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 1,
            goal: "STUDENTS",
            readinessPolicy: "READY_ROWS_ONLY",
            mapping: conflictMapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 2,
            evaluations: [1200, 1500].map((monthlyFee, index) => ({
                id: `evaluation_${index}`,
                rowId: `row_${index}`,
                rowNumber: index + 2,
                status: "READY" as const,
                skipped: false,
                normalizedData: {
                    student: { name: `Student ${index}`, monthlyFee },
                    shift: { name: index === 0 ? "Morning" : " morning " },
                },
                warnings: [],
            })),
        });

        expect(plan.canRun).toBe(false);
        expect(plan.snapshot.items.filter(item => item.kind === "CONFIG")).toHaveLength(1);
        expect(plan.checks).toContainEqual(expect.objectContaining({
            code: "CONFIGURATION_CONFLICT",
            status: "block",
            count: 1,
        }));
    });

    it("excludes already imported rows from a PARTIAL repair plan", () => {
        const repairEvaluations = evaluations().map(evaluation =>
            evaluation.rowId === "row_2"
                ? { ...evaluation, status: "IMPORTED" as const }
                : evaluation
        );
        const plan = compileImportPlanSnapshot({
            sessionId: "session_1",
            targetRevision: 5,
            goal: "FULL",
            readinessPolicy: "REQUIRE_ALL_ROWS_READY",
            mapping,
            summary: null,
            hasOpenQuestions: false,
            expectedRowCount: 3,
            evaluations: repairEvaluations,
            asOf: new Date("2026-03-15T00:00:00.000Z"),
        });

        expect(plan.canRun).toBe(true);
        expect(plan).toMatchObject({ readyRows: 1, blockedRows: 0, skippedRows: 2 });
        expect(plan.snapshot.items.every(item => item.rowId !== "row_2")).toBe(true);
    });

    it("uses canonical request hashes for idempotency comparisons", () => {
        expect(createImportRequestHash({ a: 1, nested: { x: true, y: "yes" } }))
            .toBe(createImportRequestHash({ nested: { y: "yes", x: true }, a: 1 }));
        expect(createImportRequestHash({ a: 1 })).not.toBe(createImportRequestHash({ a: 2 }));
    });
});
