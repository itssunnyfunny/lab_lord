import { describe, expect, it } from "vitest";
import {
    aiAssistanceState,
    buildImportWizardSteps,
    deferAllocationOptions,
    isImportPlanFresh,
    paymentActionChangeOptions,
    paymentSkipOptions,
    splitImportValues,
    studentsOnlyImportOptions,
    studentOnlyNormalizedData,
} from "@/importing/utils/import-wizard-view-model";
import {
    allocationSelectionFromDraft,
    draftFromImportRowWithFallback,
    hasDirtyImportDraft,
    importRowDraftSourceKey,
    nextImportRowDraft,
    normalizedFromImportDraft,
} from "@/importing/utils/manual-row-draft";

describe("import wizard view model", () => {
    it("keeps import usable when AI falls back", () => {
        const state = aiAssistanceState({
            usedFallback: true,
            ai: {
                status: "unavailable",
                attemptedAt: "2026-06-30T00:00:00.000Z",
                durationMs: 12,
                fallbackReason: "Missing API key.",
            },
        });

        expect(state.tone).toBe("warning");
        expect(state.title).toContain("import can continue");
        expect(state.message).toContain("Deterministic matching");
        expect(state.needsMappingReview).toBe(true);
    });

    it("marks a reviewed plan stale when policy or revision changes", () => {
        expect(isImportPlanFresh({ readinessPolicy: "READY_ROWS_ONLY", planVersion: "abc123", revision: 3 }, "READY_ROWS_ONLY", 3)).toBe(true);
        expect(isImportPlanFresh({ readinessPolicy: "READY_ROWS_ONLY", planVersion: "abc123", revision: 3 }, "REQUIRE_ALL_ROWS_READY", 3)).toBe(false);
        expect(isImportPlanFresh({ readinessPolicy: "READY_ROWS_ONLY", planVersion: "abc123", revision: 3 }, "READY_ROWS_ONLY", 4)).toBe(false);
        expect(isImportPlanFresh(null, "READY_ROWS_ONLY", 3)).toBe(false);
    });

    it("provides explicit student-only and defer-allocation defaults", () => {
        expect(paymentSkipOptions()).toEqual({
            paymentCycle: "SKIP_PAYMENTS",
            paymentAction: "SKIP_PAYMENTS",
        });
        expect(deferAllocationOptions()).toEqual({
            skipUnknownSeatAllocations: true,
            skipUnknownShiftAllocations: true,
            skipUnknownMultiShiftAllocations: true,
            skipMissingShiftAllocations: true,
            skipConflictingAllocations: true,
        });
        expect(studentOnlyNormalizedData({
            student: { name: "Asha", phone: "9876543210" },
            allocation: { seatLabel: "A1", shiftName: "Morning" },
            payment: { amount: 1200, status: "PAID" },
        })).toEqual({
            student: { name: "Asha", phone: "9876543210" },
        });
        expect(studentsOnlyImportOptions()).toMatchObject({
            paymentCycle: "SKIP_PAYMENTS",
            paymentAction: "SKIP_PAYMENTS",
            skipUnknownSeatAllocations: true,
            skipUnknownShiftAllocations: true,
        });
    });

    it("keeps payment action changes internally consistent", () => {
        expect(paymentActionChangeOptions({}, "SKIP_PAYMENTS")).toEqual(paymentSkipOptions());
        expect(paymentActionChangeOptions({ paymentCycle: "SKIP_PAYMENTS" }, "IMPORT_PAID_UNPAID")).toEqual({
            paymentAction: "IMPORT_PAID_UNPAID",
            paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
            paymentHistoryMode: "START_CURRENT_JOINED_CYCLE",
        });
    });

    it("hydrates row drafts from raw mapped data when normalized data is not ready", () => {
        const draft = draftFromImportRowWithFallback({
            rawData: {
                Name: "Asha",
                Mobile: "9876543210",
                Fee: "1200",
                Paid: "yes",
            },
            normalizedData: null,
        }, [
            { sourceColumn: "Name", targetField: "student.name", confidence: 90 },
            { sourceColumn: "Mobile", targetField: "student.phone", confidence: 90 },
            { sourceColumn: "Fee", targetField: "student.monthlyFee", confidence: 90 },
            { sourceColumn: "Paid", targetField: "payment.status", confidence: 90 },
        ]);

        expect(draft).toMatchObject({
            studentName: "Asha",
            phone: "9876543210",
            fee: "1200",
            paymentAmount: "1200",
            paymentStatus: "yes",
        });
    });

    it("can identify source changes without overwriting dirty drafts", () => {
        const before = importRowDraftSourceKey({ normalizedData: null, rawData: { Name: "" } });
        const after = importRowDraftSourceKey({ normalizedData: { student: { name: "Asha" } }, rawData: { Name: "Asha" } });

        expect(before).not.toBe(after);
        expect(hasDirtyImportDraft({ studentName: true })).toBe(true);
        expect(hasDirtyImportDraft({})).toBe(false);
    });

    it("syncs fee and payment amount until payment amount is manually edited", () => {
        const context = {
            defaultFee: 900,
            defaultAdmissionFee: 0,
            seats: [],
            shifts: [{ id: "shift_1", name: "Morning", startTime: null, endTime: null, price: 1200 }],
            multiShifts: [{ id: "multi_1", name: "Full day", price: 2400, componentShiftNames: ["Morning", "Evening"] }],
        };

        const selectedShift = nextImportRowDraft({
            draft: {
                studentName: "Asha",
                phone: "",
                joinedAt: "",
                fee: "",
                seat: "",
                shift: "",
                multiShift: "",
                paymentAmount: "",
                paymentStatus: "",
                paymentMethod: "",
                referenceId: "",
            },
            field: "shift",
            value: "Morning",
            context,
            linkFeeToSelection: true,
        });

        expect(selectedShift.draft.fee).toBe("1200");
        expect(selectedShift.draft.paymentAmount).toBe("1200");

        const manualPayment = nextImportRowDraft({
            draft: selectedShift.draft,
            dirty: selectedShift.dirty,
            field: "paymentAmount",
            value: "1000",
            context,
        });
        const changedFee = nextImportRowDraft({
            draft: manualPayment.draft,
            dirty: manualPayment.dirty,
            field: "fee",
            value: "1500",
            context,
        });

        expect(changedFee.draft.fee).toBe("1500");
        expect(changedFee.draft.paymentAmount).toBe("1000");
    });

    it("treats the row payment amount as an override, not hidden payment data", () => {
        const baseRow = { normalizedData: null };
        const baseDraft = {
            studentName: "Asha",
            phone: "",
            joinedAt: "",
            fee: "1200",
            seat: "",
            shift: "",
            multiShift: "",
            paymentAmount: "1200",
            paymentStatus: "",
            paymentMethod: "",
            referenceId: "",
        };

        expect(normalizedFromImportDraft(baseRow, baseDraft).payment).toBeUndefined();
        expect(normalizedFromImportDraft(baseRow, { ...baseDraft, paymentAmount: "1000" }).payment).toEqual({
            amount: 1000,
        });
        expect(normalizedFromImportDraft(baseRow, { ...baseDraft, paymentStatus: "PAID" }).payment).toMatchObject({
            amount: 1200,
            status: "PAID",
        });
    });

    it("builds student-only data from the current edited draft", () => {
        const normalized = normalizedFromImportDraft(
            {
                normalizedData: {
                    student: { name: "Old name", phone: "111" },
                    allocation: { seatLabel: "A1", shiftName: "Morning" },
                    payment: { amount: 1200, status: "PAID" },
                },
            },
            {
                studentName: "Edited name",
                phone: "9999999999",
                joinedAt: "2026-06-30",
                fee: "1400",
                seat: "B2",
                shift: "Evening",
                multiShift: "",
                paymentAmount: "1000",
                paymentStatus: "PAID",
                paymentMethod: "UPI",
                referenceId: "TXN9",
            }
        );

        const studentOnly = studentOnlyNormalizedData(normalized);
        expect(studentOnly.student).toMatchObject({
            name: "Edited name",
            phone: "9999999999",
            joinedAt: "2026-06-30T00:00:00.000Z",
            joinedAtSource: "UPLOADED",
            monthlyFee: 1400,
            feeSource: "UPLOADED",
        });
        expect(studentOnly.allocation).toBeUndefined();
        expect(studentOnly.payment).toBeUndefined();
    });

    it("maps compact allocation picker draft selections to shift and bundle ids", () => {
        const context = {
            defaultFee: 900,
            defaultAdmissionFee: 0,
            seats: [],
            shifts: [{ id: "shift_1", name: "Morning", startTime: null, endTime: null, price: 1200 }],
            multiShifts: [{ id: "multi_1", name: "Full day", price: 2400, componentShiftNames: ["Morning", "Evening"] }],
        };
        const baseDraft = {
            studentName: "",
            phone: "",
            joinedAt: "",
            fee: "",
            seat: "",
            shift: "",
            multiShift: "",
            paymentAmount: "",
            paymentStatus: "",
            paymentMethod: "",
            referenceId: "",
        };

        expect(allocationSelectionFromDraft({ ...baseDraft, shift: "Morning" }, context)).toEqual({
            shiftIds: ["shift_1"],
            multiShiftId: null,
        });
        expect(allocationSelectionFromDraft({ ...baseDraft, shift: "Morning", multiShift: "Full day" }, context)).toEqual({
            shiftIds: [],
            multiShiftId: "multi_1",
        });
    });

    it("builds step states for manual-first imports", () => {
        const steps = buildImportWizardSteps({
            readinessPolicy: "READY_ROWS_ONLY",
            plan: { readinessPolicy: "READY_ROWS_ONLY", planVersion: "plan_1", canRun: true },
            detail: {
                status: "READY_TO_COMMIT",
                mapping: {
                    usedFallback: true,
                    columnMappings: [
                        { sourceColumn: "Name", targetField: "student.name", confidence: 90 },
                        { sourceColumn: "Paid", targetField: "payment.status", confidence: 90 },
                    ],
                    importOptions: paymentSkipOptions(),
                    analysis: {
                        ai: {
                            status: "unavailable",
                            attemptedAt: "2026-06-30T00:00:00.000Z",
                            durationMs: 2,
                        },
                        detectedPaymentValues: ["yes", "no"],
                    },
                },
                summary: {
                    readyRows: 4,
                    warningRows: 1,
                    needsReviewRows: 0,
                    blockedRows: 0,
                    duplicateRows: 0,
                    conflictRows: 0,
                    skippedRows: 2,
                    detectedEntityCounts: {
                        STUDENT: 5,
                        SEAT: 0,
                        SHIFT: 0,
                        ALLOCATION: 0,
                        PAYMENT: 2,
                    },
                },
                questions: [],
            },
        });

        expect(steps.map(step => step.id)).toEqual(["columns", "decisions", "rows", "payments", "preview", "result"]);
        expect(steps.find(step => step.id === "columns")?.state).toBe("completed");
        expect(steps.find(step => step.id === "payments")?.detail).toBe("Skipped for now");
        expect(steps.find(step => step.id === "preview")?.state).toBe("completed");
    });

    it("treats an intentionally ignored reviewed column as resolved", () => {
        const steps = buildImportWizardSteps({
            readinessPolicy: "READY_ROWS_ONLY",
            detail: {
                status: "VALIDATED",
                mapping: {
                    usedFallback: true,
                    columnMappings: [
                        { sourceColumn: "Name", targetField: "student.name", confidence: 100, needsReview: false },
                        { sourceColumn: "Notes", targetField: "ignore", confidence: 100, needsReview: false },
                    ],
                    importOptions: paymentSkipOptions(),
                },
                summary: {
                    readyRows: 1,
                    warningRows: 0,
                    needsReviewRows: 0,
                    blockedRows: 0,
                    duplicateRows: 0,
                    conflictRows: 0,
                    skippedRows: 0,
                    detectedEntityCounts: {
                        STUDENT: 1,
                        SEAT: 0,
                        SHIFT: 0,
                        ALLOCATION: 0,
                        PAYMENT: 0,
                    },
                },
                questions: [],
            },
        });

        expect(steps.find(step => step.id === "columns")?.state).toBe("completed");
    });

    it("splits payment mapping words consistently", () => {
        expect(splitImportValues("paid, yes,  done ,,")).toEqual(["paid", "yes", "done"]);
    });
});
