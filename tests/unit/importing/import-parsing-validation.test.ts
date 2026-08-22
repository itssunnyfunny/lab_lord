import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsv } from "@/importing/parsers/csv.parser";
import { parsePastedTable } from "@/importing/parsers/pasted-table.parser";
import { parsePdf } from "@/importing/parsers/pdf.parser";
import { parseXlsx } from "@/importing/parsers/xlsx.parser";
import { buildFallbackMappings, normalizeColumnName } from "@/importing/utils/column-normalizer";
import { detectDuplicateImportRows, detectExistingStudentDuplicates } from "@/importing/utils/duplicate-detector";
import {
    buildImportAttention,
    buildImportSourceProfile,
    hasManualNormalizedData,
    markManualNormalizedData,
} from "@/importing/pipeline/import-extraction.pipeline";
import {
    applyImportDefaults,
    classifyPaymentStatus,
    normalizeImportRow,
    parseImportDate,
    parseImportMoney,
    parsePaymentMethod,
} from "@/importing/utils/row-normalizer";
import { promoteKnownMultiShiftAllocation } from "@/importing/utils/shift-alias-resolver";
import {
    draftFromImportRow,
    feeFromSelection,
    feeLooksAutoFilled,
    importRowFieldValue,
    normalizedFromImportDraft,
    numberFromDraft,
} from "@/importing/utils/manual-row-draft";
import { buildImportPlanChecks, createImportPlanVersion, getBlockingImportPlanChecks } from "@/importing/utils/import-plan-checks";
import { inferConfirmedPaymentMapping } from "@/importing/utils/payment-mapping-inference";
import { assertImportRowLimit, MAX_IMPORT_ROWS, statusForValidation } from "@/importing/services/import-session.service";
import { validateRequiredImportFields } from "@/importing/validators/import-required-fields.validator";
import { validateImportPayment } from "@/importing/validators/import-payment.validator";
import { IMPORT_TARGET_FIELDS, type ImportMappingState } from "@/importing/contracts/import-session.contract";
import { validateImportAllocation } from "@/importing/validators/import-allocation.validator";
import { validateImportSeat } from "@/importing/validators/import-seat.validator";
import { validateImportShift } from "@/importing/validators/import-shift.validator";
import { validateImportStudent } from "@/importing/validators/import-student.validator";
import type { ImportColumnMapping, ImportNormalizedRow } from "@/importing/contracts/import-session.contract";

const mocks = vi.hoisted(() => ({
    callGemini: vi.fn(),
    callGeminiJson: vi.fn(),
}));

vi.mock("@/ai/llm/gemini.client", () => ({
    callGemini: mocks.callGemini,
    callGeminiJson: mocks.callGeminiJson,
    resolveGeminiProModel: () => "gemini-3.5-flash",
}));

beforeEach(() => {
    vi.clearAllMocks();
});

describe("import parsers", () => {
    it("parses CSV headers and rows", () => {
        const parsed = parseCsv("Name,Mobile,Seat\nAsha,9876543210,A1\nRavi,9876543211,A2");

        expect(parsed.columns).toEqual(["Name", "Mobile", "Seat"]);
        expect(parsed.rows).toEqual([
            { Name: "Asha", Mobile: "9876543210", Seat: "A1" },
            { Name: "Ravi", Mobile: "9876543211", Seat: "A2" },
        ]);
    });

    it("parses pasted tabular data", () => {
        const parsed = parsePastedTable("Student Name\tPhone\nAsha\t9876543210");

        expect(parsed.columns).toEqual(["Student Name", "Phone"]);
        expect(parsed.rows[0]["Student Name"]).toBe("Asha");
    });

    it("parses the first XLSX sheet", async () => {
        const XLSX = await import("xlsx");
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.json_to_sheet([{ Name: "Asha", Paid: "yes" }]);
        XLSX.utils.book_append_sheet(workbook, sheet, "Students");
        const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

        const parsed = await parseXlsx(buffer);

        expect(parsed.columns).toEqual(["Name", "Paid"]);
        expect(parsed.rows[0]).toEqual({ Name: "Asha", Paid: "yes" });
    });

    it("profiles extracted source columns for downstream AI analysis", () => {
        const profile = buildImportSourceProfile({
            columns: ["Name", "Mobile", "Fee"],
            rows: [
                { Name: "Asha", Mobile: "9876543210", Fee: "Rs 1,200" },
                { Name: "Ravi", Mobile: "", Fee: "1500" },
            ],
            rowNumbers: [2, 3],
        });

        expect(profile.rowCount).toBe(2);
        expect(profile.columns.find(column => column.column === "Mobile")?.detectedKind).toBe("phone");
        expect(profile.columns.find(column => column.column === "Fee")?.fillRate).toBe(100);
    });

    it("guards the current wizard row limit", () => {
        expect(() => assertImportRowLimit(MAX_IMPORT_ROWS)).not.toThrow();
        expect(() => assertImportRowLimit(MAX_IMPORT_ROWS + 1)).toThrow("supports up to");
    });

    it("rejects a file without a PDF signature", async () => {
        await expect(parsePdf(Buffer.from("not a pdf"))).rejects.toThrow("PDF file signature");
    }, 10000);
});

describe("import mapping and validation", () => {
    it("normalizes common column variants", () => {
        const mappings = buildFallbackMappings(["student name", "mobile", "seat no", "batch", "fee", "paid"]);

        expect(normalizeColumnName("Seat No.")).toBe("seat no");
        expect(mappings.map(mapping => mapping.targetField)).toEqual([
            "student.name",
            "student.phone",
            "seat.label",
            "shift.name",
            "student.monthlyFee",
            "payment.status",
        ]);
    });

    it("does not expose or deterministically select unsupported legacy fields", () => {
        expect(IMPORT_TARGET_FIELDS).not.toEqual(expect.arrayContaining([
            "student.status",
            "allocation.startDate",
            "payment.period",
        ]));
        expect(buildFallbackMappings([
            "Student Status",
            "Allocation Start Date",
            "Payment Period",
        ]).map(mapping => mapping.targetField)).toEqual(["ignore", "ignore", "ignore"]);
    });

    it("falls back when AI mapping fails", async () => {
        mocks.callGeminiJson.mockResolvedValueOnce({ ok: false, rawText: null, error: "Missing API key" });
        const { mapImportColumns } = await import("@/importing/ai/import-column-mapper.ai");

        const mapped = await mapImportColumns({
            branchContext: {},
            columns: ["Name", "Legacy Code"],
            sampleRows: [{ Name: "Asha", "Legacy Code": "private-value" }],
        });

        expect(mapped.usedFallback).toBe(true);
        expect(mapped.columnMappings[0].targetField).toBe("student.name");
        expect(mapped.aiTrace?.status).toBe("unavailable");
        expect(mapped.warnings[0]).toBe("Missing API key");
    });

    it("falls back when AI returns invalid JSON", async () => {
        mocks.callGeminiJson.mockResolvedValueOnce({ ok: false, rawText: "not-json", error: "Unexpected token" });
        const { mapImportColumns } = await import("@/importing/ai/import-column-mapper.ai");

        const mapped = await mapImportColumns({
            branchContext: {},
            columns: ["Name", "Ledger Signal"],
            sampleRows: [{ Name: "Asha", "Ledger Signal": "private-value" }],
        });

        expect(mapped.usedFallback).toBe(true);
        expect(mapped.aiTrace?.status).toBe("invalid_response");
        expect(mapped.columnMappings.map(mapping => mapping.targetField)).toEqual(["student.name", "ignore"]);
    });

    it("rejects AI mappings to fields the V2 import does not support", async () => {
        mocks.callGeminiJson.mockResolvedValueOnce({
            ok: true,
            rawText: "{}",
            data: {
                entityTypesDetected: ["STUDENT", "ALLOCATION", "PAYMENT"],
                columnMappings: [
                    { sourceColumn: "column_2: Student Status", targetField: "student.status", confidence: 99 },
                    { sourceColumn: "column_3: Allocation Start Date", targetField: "allocation.startDate", confidence: 99 },
                    { sourceColumn: "column_4: Payment Period", targetField: "payment.period", confidence: 99 },
                ],
                questions: [],
                warnings: [],
            },
        });
        const { mapImportColumns } = await import("@/importing/ai/import-column-mapper.ai");

        const mapped = await mapImportColumns({
            branchContext: {},
            columns: ["Name", "Student Status", "Allocation Start Date", "Payment Period"],
            sampleRows: [{
                Name: "Asha",
                "Student Status": "Inactive",
                "Allocation Start Date": "2026-01-01",
                "Payment Period": "January",
            }],
        });

        expect(mapped.usedFallback).toBe(true);
        expect(mapped.columnMappings.map(mapping => mapping.targetField)).toEqual([
            "student.name",
            "ignore",
            "ignore",
            "ignore",
        ]);
    });

    it("keeps AI payment value guesses unconfirmed", async () => {
        mocks.callGeminiJson.mockResolvedValueOnce({
            ok: true,
            rawText: "{}",
            data: {
            entityTypesDetected: ["STUDENT", "PAYMENT"],
            columnMappings: [
                { sourceColumn: "column_2: Ledger Flag", targetField: "payment.status", confidence: 88 },
            ],
            questions: [],
            warnings: [],
            suggestedImportOptions: {
                paymentMapping: {
                    paidValues: ["yes"],
                    unpaidValues: ["no"],
                    waivedValues: [],
                    unclearValues: ["maybe"],
                    confirmed: true,
                },
            },
        }});
        const { mapImportColumns } = await import("@/importing/ai/import-column-mapper.ai");

        const mapped = await mapImportColumns({
            branchContext: {},
            columns: ["Name", "Ledger Flag"],
            sampleRows: [{ Name: "Asha", "Ledger Flag": "yes" }],
        });

        expect(mapped.suggestedImportOptions?.paymentMapping?.paidValues).toEqual(["yes"]);
        expect(mapped.suggestedImportOptions?.paymentMapping?.confirmed).toBe(false);
    });

    it("auto-confirms only deterministic payment status words", () => {
        const columnMappings: ImportColumnMapping[] = [
            { sourceColumn: "Payment Status", targetField: "payment.status", confidence: 95 },
        ];

        expect(inferConfirmedPaymentMapping({
            columnMappings,
            rows: [
                { rawData: { "Payment Status": "PAID" } },
                { rawData: { "Payment Status": "DUE" } },
                { rawData: { "Payment Status": "WAIVED" } },
            ],
        })).toMatchObject({
            paidValues: ["PAID"],
            unpaidValues: ["DUE"],
            waivedValues: ["WAIVED"],
            unclearValues: [],
            confirmed: true,
        });
        expect(inferConfirmedPaymentMapping({
            columnMappings,
            rows: [
                { rawData: { "Payment Status": "PAID" } },
                { rawData: { "Payment Status": "PARTIAL" } },
            ],
        })).toBeUndefined();
    });

    it("flags duplicate AI target mappings and keeps all source columns covered", async () => {
        mocks.callGeminiJson.mockResolvedValueOnce({
            ok: true,
            rawText: "{}",
            data: {
                entityTypesDetected: ["STUDENT"],
                columnMappings: [
                    { sourceColumn: "column_2: Full Name", targetField: "student.name", confidence: 91 },
                    { sourceColumn: "column_3: Notes", targetField: "student.notes", confidence: 80 },
                ],
                questions: [],
                warnings: [],
            },
        });
        const { mapImportColumns } = await import("@/importing/ai/import-column-mapper.ai");

        const mapped = await mapImportColumns({
            branchContext: {},
            columns: ["Name", "Full Name", "Notes"],
            sampleRows: [{ Name: "Asha", "Full Name": "Asha Sharma", Notes: "prefers morning" }],
        });

        expect(mapped.aiTrace?.status).toBe("success");
        expect(mapped.columnMappings).toHaveLength(3);
        expect(mapped.columnMappings.find(mapping => mapping.sourceColumn === "Full Name")?.targetField).toBe("ignore");
        expect(mapped.columnMappings.find(mapping => mapping.sourceColumn === "Notes")?.targetField).toBe("ignore");
        expect(mapped.warnings.some(warning => warning.includes("more than one column"))).toBe(true);
    });

    it("keeps low-confidence AI mappings for review instead of auto-applying them", async () => {
        mocks.callGeminiJson.mockResolvedValueOnce({
            ok: true,
            rawText: "{}",
            data: {
                entityTypesDetected: ["STUDENT", "ALLOCATION"],
                columnMappings: [
                    { sourceColumn: "column_2: Allocation Hint", targetField: "allocation.seatLabel", confidence: 62 },
                ],
                questions: [],
                warnings: [],
            },
        });
        const { mapImportColumns } = await import("@/importing/ai/import-column-mapper.ai");

        const mapped = await mapImportColumns({
            branchContext: {},
            columns: ["Name", "Allocation Hint"],
            sampleRows: [{ Name: "Asha", "Allocation Hint": "Morning maybe" }],
        });

        expect(mapped.columnMappings.find(mapping => mapping.sourceColumn === "Name")).toMatchObject({
            targetField: "student.name",
            source: "DETERMINISTIC",
            autoApplied: true,
            needsReview: false,
        });
        expect(mapped.columnMappings.find(mapping => mapping.sourceColumn === "Allocation Hint")).toMatchObject({
            targetField: "ignore",
            source: "AI",
            autoApplied: false,
            needsReview: true,
        });
        expect(mapped.warnings.some(warning => warning.includes("unsure"))).toBe(true);
    });

    it("blocks rows missing student name", () => {
        const result = validateRequiredImportFields({ student: { phone: "9876543210" } });

        expect(result.issues[0].code).toBe("MISSING_STUDENT_NAME");
    });

    it("warns for missing phone", () => {
        const result = validateImportStudent(
            { student: { name: "Asha" } },
            { branchDefaultFee: 1200, shiftsByName: new Map(), multiShiftsByName: new Map() }
        );

        expect(result.warnings.some(warning => warning.code === "MISSING_PHONE")).toBe(true);
    });

    it("blocks an invalid nonblank phone", () => {
        const result = validateImportStudent(
            { student: { name: "Asha", phone: "12345", monthlyFee: 1200 } },
            { branchDefaultFee: 1200, shiftsByName: new Map(), multiShiftsByName: new Map() }
        );

        expect(result.issues).toContainEqual(expect.objectContaining({
            code: "INVALID_PHONE",
            severity: "error",
        }));
    });

    it("blocks non-integer and out-of-range imported money", () => {
        const student = validateImportStudent(
            { student: { name: "Asha", monthlyFee: 10_000_001 } },
            { branchDefaultFee: 1200, shiftsByName: new Map(), multiShiftsByName: new Map() }
        );
        const payment = validateImportPayment(
            { payment: { amount: 10.5 } },
            { entityTypesDetected: ["PAYMENT"], columnMappings: [], importOptions: {} }
        );

        expect(student.issues).toContainEqual(expect.objectContaining({ code: "INVALID_MONTHLY_FEE" }));
        expect(payment.issues).toContainEqual(expect.objectContaining({ code: "INVALID_PAYMENT_AMOUNT" }));
    });

    it("blocks malformed or incomplete imported shift times", () => {
        const malformed = validateImportShift(
            { shift: { name: "Morning", startTime: "25:00", endTime: "10:00" } },
            { shiftsByName: new Map(), multiShiftsByName: new Map(), createUnknownShifts: true }
        );
        const incomplete = validateImportShift(
            { shift: { name: "Morning", startTime: "06:00" } },
            { shiftsByName: new Map(), multiShiftsByName: new Map(), createUnknownShifts: true }
        );

        expect(malformed.issues).toContainEqual(expect.objectContaining({ code: "INVALID_SHIFT_START_TIME" }));
        expect(incomplete.issues).toContainEqual(expect.objectContaining({ code: "INCOMPLETE_SHIFT_TIME_RANGE" }));
    });

    it("asks a question for unknown shift", () => {
        const result = validateImportShift(
            { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Night" } },
            { shiftsByName: new Map(), multiShiftsByName: new Map() }
        );

        expect(result.questions[0].field).toBe("allocation.shiftName");
    });

    it("asks for payment cycle when payment columns exist", () => {
        const result = validateImportPayment(
            { student: { name: "Asha" }, payment: { amount: 1200, rawStatus: "paid", status: "PAID" } },
            { entityTypesDetected: ["PAYMENT"], columnMappings: [], importOptions: {} }
        );

        expect(result.questions.some(question => question.field === "payment.cycle")).toBe(true);
    });

    it("marks ambiguous paid/unpaid values as review warnings", () => {
        const result = validateImportPayment(
            { payment: { rawStatus: "maybe", status: "UNCLEAR" } },
            {
                entityTypesDetected: ["PAYMENT"],
                columnMappings: [],
                importOptions: {
                    paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
                    paymentAction: "IMPORT_PAID_UNPAID",
                    paymentMapping: { paidValues: ["yes"], unpaidValues: ["no"], waivedValues: [], unclearValues: [], confirmed: true },
                },
            }
        );

        expect(result.warnings.some(warning => warning.code === "AMBIGUOUS_PAYMENT_STATUS")).toBe(true);
    });

    it("allows unknown seats to be skipped while importing the student", () => {
        const result = validateImportSeat(
            { student: { name: "Asha" }, allocation: { seatLabel: "A404", shiftName: "Morning" } },
            { seatsByLabel: new Map(), skipUnknownSeatAllocations: true }
        );

        expect(result.questions).toEqual([]);
        expect(result.warnings[0]).toMatchObject({ code: "ALLOCATION_SKIPPED_UNKNOWN_SEAT", severity: "info" });
    });

    it("allows unknown shifts to be skipped while importing the student", () => {
        const result = validateImportShift(
            { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Night" } },
            { shiftsByName: new Map(), multiShiftsByName: new Map(), skipUnknownShiftAllocations: true }
        );

        expect(result.questions).toEqual([]);
        expect(result.warnings[0]).toMatchObject({ code: "ALLOCATION_SKIPPED_UNKNOWN_SHIFT", severity: "info" });
    });

    it("does not keep rows in review for info-only skipped allocation warnings", () => {
        const status = statusForValidation({
            skipped: false,
            issues: [],
            warnings: [{
                code: "ALLOCATION_SKIPPED_UNKNOWN_SEAT",
                field: "allocation.seatLabel",
                message: "Student will import without allocation because the seat is unknown.",
                severity: "info",
            }],
        });

        expect(status).toBe("WARNING");
    });

    it("blocks import allocation conflicts for overlapping shift times", () => {
        const result = validateImportAllocation(
            { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Late Morning" } },
            {
                seatsByLabel: new Map([["a1", { id: "seat_1", label: "A1" }]]),
                shiftsByName: new Map([["late morning", { id: "shift_late", name: "Late Morning", startTime: "10:00", endTime: "13:00" }]]),
                multiShiftsByName: new Map(),
                activeAllocations: [{
                    seatId: "seat_1",
                    shiftId: "shift_morning",
                    seat: { label: "A1" },
                    shift: { name: "Morning", startTime: "09:00", endTime: "12:00" },
                }],
            }
        );

        expect(result.issues[0]).toMatchObject({ code: "ALLOCATION_CONFLICT", severity: "error" });
    });

    it("allows allocation conflicts to become manual follow-up warnings", () => {
        const result = validateImportAllocation(
            { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Late Morning" } },
            {
                seatsByLabel: new Map([["a1", { id: "seat_1", label: "A1" }]]),
                shiftsByName: new Map([["late morning", { id: "shift_late", name: "Late Morning", startTime: "10:00", endTime: "13:00" }]]),
                multiShiftsByName: new Map(),
                activeAllocations: [{
                    seatId: "seat_1",
                    shiftId: "shift_morning",
                    seat: { label: "A1" },
                    shift: { name: "Morning", startTime: "09:00", endTime: "12:00" },
                }],
                skipConflictingAllocations: true,
            }
        );
        const status = statusForValidation({
            skipped: false,
            issues: result.issues,
            warnings: result.warnings,
        });

        expect(result.issues).toEqual([]);
        expect(result.warnings[0]).toMatchObject({ code: "ALLOCATION_SKIPPED_CONFLICT", severity: "info" });
        expect(status).toBe("WARNING");
    });

    it("applies operator defaults before validation", () => {
        const normalized = applyImportDefaults(
            { student: { name: "Asha" }, allocation: { seatLabel: "A1" } },
            { defaultShiftName: "Morning", defaultJoinedAt: "2026-01-01" }
        );

        expect(normalized.allocation?.shiftName).toBe("Morning");
        expect(normalized.student?.joinedAt).toContain("2026-01-01");
    });

    it("clears stale shift and payment values when a manual row edit blanks them", () => {
        const normalized = normalizedFromImportDraft(
            {
                normalizedData: {
                    student: { name: "Asha", monthlyFee: 1200 },
                    seat: { label: "A1" },
                    shift: { name: "Morning" },
                    allocation: { seatLabel: "A1", shiftName: "Morning" },
                    payment: { amount: 1200, status: "PAID", rawStatus: "PAID", method: "UPI", referenceId: "TXN1" },
                },
            },
            {
                studentName: "Asha",
                phone: "",
                joinedAt: "",
                fee: "",
                seat: "A2",
                shift: "",
                multiShift: "",
                paymentAmount: "",
                paymentStatus: "",
                paymentMethod: "",
                referenceId: "",
            }
        );

        expect(normalized.allocation?.seatLabel).toBe("A2");
        expect(normalized.allocation?.shiftName).toBeUndefined();
        expect(normalized.shift).toBeUndefined();
        expect(normalized.payment).toBeUndefined();
        expect(normalized.student?.monthlyFee).toBeUndefined();
    });

    it("keeps manual seat and bundle edits scoped to the edited row", () => {
        const normalized = normalizedFromImportDraft(
            { normalizedData: { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Morning" } } },
            {
                studentName: "Asha",
                phone: "",
                joinedAt: "",
                fee: "2500",
                seat: "B7",
                shift: "",
                multiShift: "Full Time",
                paymentAmount: "",
                paymentStatus: "",
                paymentMethod: "",
                referenceId: "",
            },
            {
                defaultFee: 1200,
                defaultAdmissionFee: 0,
                seats: [{ id: "seat_b7", label: "B7" }],
                shifts: [{ id: "shift_morning", name: "Morning", startTime: null, endTime: null, price: 1200 }],
                multiShifts: [{ id: "multi_full", name: "Full Time", price: 2500, componentShiftNames: ["Morning", "Evening"] }],
            }
        );

        expect(normalized.allocation).toMatchObject({ seatLabel: "B7", multiShiftName: "Full Time" });
        expect(normalized.allocation?.shiftName).toBeUndefined();
        expect(normalized.multiShift?.componentShiftNames).toEqual(["Morning", "Evening"]);
        expect(normalized.student?.feeSource).toBe("MULTI_SHIFT_PRICE");
    });

    it("fills missing row fees from selected branch shift prices", () => {
        const normalized = applyImportDefaults(
            { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Evening" } },
            {},
            {
                defaultFee: 900,
                shiftsByName: new Map([["evening", { name: "Evening", price: 1500 }]]),
                multiShiftsByName: new Map(),
            }
        );

        expect(normalized.student?.monthlyFee).toBe(1500);
        expect(normalized.student?.feeSource).toBe("SHIFT_PRICE");
        expect(normalized.student?.feeLinkedShiftName).toBe("Evening");
    });

    it("flags anniversary payment cycles when joined dates were defaulted", () => {
        const result = validateImportPayment(
            { student: { name: "Asha", joinedAt: "2026-06-21T00:00:00.000Z", joinedAtSource: "TODAY_DEFAULT" } },
            {
                entityTypesDetected: ["STUDENT"],
                columnMappings: [],
                importOptions: {
                    paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
                    paymentAction: "GENERATE_DUE",
                },
            }
        );

        expect(result.warnings.some(warning => warning.code === "PAYMENT_JOINED_AT_REQUIRED")).toBe(true);
    });

    it("blocks import plans where payment action and cycle disagree", () => {
        const checks = buildImportPlanChecks({
            hasOpenQuestions: false,
            mapping: {
                entityTypesDetected: ["STUDENT", "PAYMENT"],
                columnMappings: [],
                importOptions: {
                    paymentAction: "GENERATE_DUE",
                    paymentCycle: "SKIP_PAYMENTS",
                },
            },
            rows: [{
                id: "row_1",
                status: "READY",
                skipped: false,
                normalizedData: { student: { name: "Asha" }, payment: { amount: 1200 } },
            }],
        });

        expect(getBlockingImportPlanChecks(checks).map(check => check.code)).toContain("PAYMENT_PLAN");
    });

    it("builds the same plan version from preview rowId and commit row id", () => {
        const base = {
            sessionId: "session_1",
            status: "READY_TO_COMMIT",
            mapping: {
                entityTypesDetected: ["STUDENT"],
                columnMappings: [],
                importOptions: { paymentCycle: "SKIP_PAYMENTS", paymentAction: "SKIP_PAYMENTS" },
            } as ImportMappingState,
        };
        const row = {
            status: "READY",
            normalizedData: { student: { name: "Asha" } },
            issues: [],
            warnings: [],
        };

        expect(createImportPlanVersion({
            ...base,
            rows: [{ ...row, rowId: "row_1" }],
        })).toBe(createImportPlanVersion({
            ...base,
            rows: [{ ...row, id: "row_1", skipped: false }],
        }));
    });

    it("does not count deferred allocation rows as seat links in the import plan", () => {
        const checks = buildImportPlanChecks({
            hasOpenQuestions: false,
            mapping: {
                entityTypesDetected: ["STUDENT", "ALLOCATION"],
                columnMappings: [],
                importOptions: { skipConflictingAllocations: true },
            },
            rows: [{
                id: "row_1",
                status: "WARNING",
                skipped: false,
                normalizedData: { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Morning" } },
                warnings: [{
                    code: "ALLOCATION_SKIPPED_CONFLICT",
                    field: "allocation.seatLabel",
                    message: "Student will import without allocation.",
                    severity: "info",
                }],
            }],
        });

        expect(checks.find(check => check.code === "SEAT_SHIFT_LINKS")).toMatchObject({
            status: "warning",
            count: 0,
        });
        expect(getBlockingImportPlanChecks(checks)).toEqual([]);
    });

    it("promotes known multi-shift names from plain shift columns", () => {
        const normalized = promoteKnownMultiShiftAllocation(
            { student: { name: "Asha" }, allocation: { seatLabel: "A1", shiftName: "Full Time" } },
            {
                shiftsByName: new Map([["morning", { name: "Morning" }]]),
                multiShiftsByName: new Map([[
                    "full time",
                    {
                        name: "Full Time",
                        components: [
                            { shiftName: "Morning" },
                            { shiftName: "Afternoon" },
                            { shiftName: "Evening" },
                        ],
                    },
                ]]),
            }
        );

        expect(normalized.allocation?.shiftName).toBeUndefined();
        expect(normalized.allocation?.multiShiftName).toBe("Full Time");
        expect(normalized.multiShift?.componentShiftNames).toEqual(["Morning", "Afternoon", "Evening"]);
    });

    it("parses formatted money values", () => {
        expect(parseImportMoney("Rs 1,500")).toBe(1500);
        expect(parseImportMoney("₹1,500.00")).toBe(1500);
        expect(parseImportMoney("1500.50")).toBeUndefined();
        expect(parseImportMoney("-1500")).toBeUndefined();
    });

    it("normalizes all supported mapped import fields", () => {
        const mappings: ImportColumnMapping[] = [
            { sourceColumn: "Name", targetField: "student.name", confidence: 90 },
            { sourceColumn: "Phone", targetField: "student.phone", confidence: 90 },
            { sourceColumn: "Joined", targetField: "student.joinedAt", confidence: 90 },
            { sourceColumn: "Fee", targetField: "student.monthlyFee", confidence: 90 },
            { sourceColumn: "Fee Source", targetField: "student.feeSource", confidence: 90 },
            { sourceColumn: "Fee Shift", targetField: "student.feeLinkedShiftName", confidence: 90 },
            { sourceColumn: "Fee Bundle", targetField: "student.feeLinkedMultiShiftName", confidence: 90 },
            { sourceColumn: "Seat", targetField: "allocation.seatLabel", confidence: 90 },
            { sourceColumn: "Shift", targetField: "shift.name", confidence: 90 },
            { sourceColumn: "Start", targetField: "shift.startTime", confidence: 90 },
            { sourceColumn: "End", targetField: "shift.endTime", confidence: 90 },
            { sourceColumn: "Bundle", targetField: "multiShift.name", confidence: 90 },
            { sourceColumn: "Components", targetField: "multiShift.componentShiftNames", confidence: 90 },
            { sourceColumn: "Paid Amount", targetField: "payment.amount", confidence: 90 },
            { sourceColumn: "Paid", targetField: "payment.status", confidence: 90 },
            { sourceColumn: "Method", targetField: "payment.method", confidence: 90 },
            { sourceColumn: "Reference", targetField: "payment.referenceId", confidence: 90 },
        ];

        const result = normalizeImportRow(
            {
                Name: "Asha",
                Phone: "9876543210",
                Joined: "02/03/26",
                Fee: "Rs 1,500",
                "Fee Source": "uploaded",
                "Fee Shift": "Morning",
                "Fee Bundle": "Full Time",
                Seat: "A1",
                Shift: "Morning",
                Start: "09:00",
                End: "12:00",
                Bundle: "Full Time",
                Components: "Morning + Evening",
                "Paid Amount": "1500",
                Paid: "yes",
                Method: "PhonePe",
                Reference: "TXN1",
            },
            mappings,
            { paidValues: ["yes"], unpaidValues: ["no"], waivedValues: ["free"], confirmed: true }
        );

        expect(result.confidence).toBe(90);
        expect(result.issues).toEqual([]);
        expect(result.normalizedData.student).toMatchObject({
            name: "Asha",
            phone: "9876543210",
            monthlyFee: 1500,
            feeSource: "UPLOADED",
            feeLinkedShiftName: "Morning",
            feeLinkedMultiShiftName: "Full Time",
        });
        expect(result.normalizedData.allocation).toMatchObject({
            seatLabel: "A1",
            shiftName: "Morning",
            multiShiftName: "Full Time",
        });
        expect(result.normalizedData.multiShift?.componentShiftNames).toEqual(["Morning", "Evening"]);
        expect(result.normalizedData.payment).toMatchObject({
            amount: 1500,
            status: "PAID",
            method: "UPI",
            referenceId: "TXN1",
        });
    });

    it("reports invalid mapped fee and payment amounts", () => {
        const result = normalizeImportRow(
            { Fee: "many rupees", Paid: "not sure" },
            [
                { sourceColumn: "Fee", targetField: "student.monthlyFee", confidence: 90 },
                { sourceColumn: "Paid", targetField: "payment.amount", confidence: 90 },
            ]
        );

        expect(result.issues.map(issue => issue.code)).toEqual(["INVALID_MONTHLY_FEE", "INVALID_PAYMENT_AMOUNT"]);
        expect(result.normalizedData.student?.monthlyFee).toBeUndefined();
        expect(result.normalizedData.payment?.amount).toBeUndefined();
    });

    it("covers import value parser edge cases", () => {
        expect(parseImportDate("31/03/26")).toContain("2026-03-31");
        expect(parseImportDate("02/03/26")).toContain("2026-03-02");
        expect(parseImportDate("2026-03-02")).toContain("2026-03-02");
        expect(parseImportDate("31/02/2026")).toBeUndefined();
        expect(parseImportDate("2026-02-31")).toBeUndefined();
        expect(parseImportDate("not a date")).toBeUndefined();
        expect(parsePaymentMethod("cash")).toBe("CASH");
        expect(parsePaymentMethod("bank transfer")).toBe("BANK_TRANSFER");
        expect(parsePaymentMethod("Paytm")).toBe("UPI");
        expect(parsePaymentMethod("cheque")).toBeUndefined();
        expect(classifyPaymentStatus("free")).toBe("WAIVED");
        expect(classifyPaymentStatus("maybe", { paidValues: ["yes"], unpaidValues: ["no"], waivedValues: [], confirmed: true })).toBe("UNCLEAR");
        expect(classifyPaymentStatus("")).toBeUndefined();
    });

    it("turns an invalid joined date into a blocking normalization issue", () => {
        const result = normalizeImportRow(
            { Joined: "31/02/2026" },
            [{ sourceColumn: "Joined", targetField: "student.joinedAt", confidence: 100 }]
        );

        expect(result.normalizedData.student?.joinedAt).toBeUndefined();
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "INVALID_JOINED_DATE", severity: "error" }),
        ]));
    });

    it("applies default seat, multi-shift, and branch fee fallbacks", () => {
        const normalized = applyImportDefaults(
            { student: { name: "Asha" } },
            { defaultSeatLabel: "B2", defaultMultiShiftName: "Full Time" },
            { branchDefaultFee: 1100, multiShiftsByName: new Map(), shiftsByName: new Map() }
        );

        expect(normalized.allocation).toMatchObject({ seatLabel: "B2", multiShiftName: "Full Time" });
        expect(normalized.student?.monthlyFee).toBe(1100);
        expect(normalized.student?.feeSource).toBe("BRANCH_DEFAULT");
    });

    it("handles manual row draft field extraction and fee helpers", () => {
        const branchContext = {
            defaultFee: 900,
            defaultAdmissionFee: 0,
            seats: [{ id: "seat_1", label: "A1" }],
            shifts: [{ id: "shift_1", name: "Morning", startTime: null, endTime: null, price: 1200 }],
            multiShifts: [{ id: "multi_1", name: "Full Time", price: 2500, componentShiftNames: ["Morning", "Evening"] }],
        };
        const row: { normalizedData: ImportNormalizedRow } = {
            normalizedData: {
                student: { name: "Asha", phone: "9876543210", joinedAt: "2026-01-01T00:00:00.000Z", monthlyFee: 1200 },
                seat: { label: "A1" },
                shift: { name: "Morning" },
                payment: { amount: 1200, status: "PAID", method: "CASH", referenceId: "R1" },
            },
        };

        expect(draftFromImportRow(row)).toMatchObject({
            studentName: "Asha",
            phone: "9876543210",
            joinedAt: "2026-01-01",
            fee: "1200",
            seat: "A1",
            shift: "Morning",
            paymentAmount: "1200",
            paymentStatus: "PAID",
            paymentMethod: "CASH",
            referenceId: "R1",
        });
        expect(importRowFieldValue({ normalizedData: null }, "studentName")).toBe("");
        expect(numberFromDraft("Rs 1,299.60")).toBe(1300);
        expect(numberFromDraft("abc")).toBeUndefined();
        expect(feeLooksAutoFilled({ ...draftFromImportRow(row), fee: "" }, branchContext)).toBe(true);
        expect(feeLooksAutoFilled({ ...draftFromImportRow(row), fee: "777" }, branchContext)).toBe(false);
        expect(feeFromSelection({ ...draftFromImportRow(row), shift: "", multiShift: "Full Time" }, branchContext)).toBe("2500");
        expect(feeFromSelection({ ...draftFromImportRow(row), shift: "Morning", multiShift: "" }, branchContext)).toBe("1200");
    });

    it("treats phone-only matches as hints and name-plus-phone as the canonical duplicate", () => {
        const result = detectDuplicateImportRows([
            { id: "row_1", rowNumber: 2, normalizedData: { student: { name: "A", phone: "9876543210" } } },
            { id: "row_2", rowNumber: 3, normalizedData: { student: { name: "B", phone: "9876543210" } } },
            { id: "row_3", rowNumber: 4, normalizedData: { student: { name: "A", phone: "9876543210" } } },
            { id: "row_4", rowNumber: 5, normalizedData: { student: { name: "A" } } },
            { id: "row_5", rowNumber: 6, normalizedData: { student: { name: "A" } } },
        ]);

        expect(result.get("row_2")?.[0]).toMatchObject({ code: "SIMILAR_PHONE_IN_FILE", severity: "info" });
        expect(result.get("row_3")?.some(issue => issue.code === "DUPLICATE_IDENTITY_IN_FILE")).toBe(true);
        expect(result.has("row_5")).toBe(false);
    });

    it("canonicalizes supported Indian phone prefixes for duplicate review", () => {
        const result = detectDuplicateImportRows([
            { id: "row_1", rowNumber: 2, normalizedData: { student: { name: "Asha", phone: "9876543210" } } },
            { id: "row_2", rowNumber: 3, normalizedData: { student: { name: " Asha ", phone: "09876543210" } } },
            { id: "row_3", rowNumber: 4, normalizedData: { student: { name: "ASHA", phone: "+91 98765 43210" } } },
            { id: "row_4", rowNumber: 5, normalizedData: { student: { name: "Asha", phone: "919876543210" } } },
            { id: "row_5", rowNumber: 6, normalizedData: { student: { name: "Asha", phone: "" } } },
            { id: "row_6", rowNumber: 7, normalizedData: { student: { name: "Asha" } } },
        ]);

        for (const rowId of ["row_2", "row_3", "row_4"]) {
            expect(result.get(rowId)).toContainEqual(expect.objectContaining({
                code: "DUPLICATE_IDENTITY_IN_FILE",
            }));
        }
        expect(result.has("row_5")).toBe(false);
        expect(result.has("row_6")).toBe(false);
    });

    it("uses the same Indian phone canonical form for existing-student matches", () => {
        const issues = detectExistingStudentDuplicates(
            { student: { name: "Asha", phone: "09876543210" } },
            [{
                id: "student_1",
                name: "Asha",
                phone: "+91 98765 43210",
                joinedAt: new Date("2026-01-01T00:00:00.000Z"),
            }]
        );

        expect(issues).toContainEqual(expect.objectContaining({
            code: "DUPLICATE_EXISTING_IDENTITY",
        }));
    });

    it("builds attention buckets and manual edit markers", () => {
        const marked = markManualNormalizedData({ "student.name": "Asha" });
        const attention = buildImportAttention({
            mapping: { entityTypesDetected: ["STUDENT"], columnMappings: [], importOptions: {} },
            questions: [{ status: "OPEN", field: "payment.cycle" }],
            rows: [{
                rowNumber: 2,
                status: "BLOCKED",
                issues: [{ code: "MISSING_STUDENT_NAME", message: "Student name is required.", severity: "error" }],
                warnings: [],
            }],
        });

        expect(hasManualNormalizedData(marked)).toBe(true);
        expect(attention[0].code).toBe("MISSING_STUDENT_NAME");
        expect(attention.some(item => item.code === "OPEN_QUESTIONS")).toBe(true);
    });
});
