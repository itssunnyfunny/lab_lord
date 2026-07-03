import { prisma } from "@/lib/prisma";
import { sortSeatsByLabel } from "@/lib/seatNumbering";
import { StaffService } from "@/services/staff.service";
import { SeatService } from "@/services/seat.service";
import type {
    ImportIssue,
    ImportMappingState,
    ImportNormalizedRow,
} from "@/importing/contracts/import-session.contract";
import type {
    ImportAvailabilityPreview,
    ImportPaymentPreview,
    ImportRowDraftPreview,
} from "@/importing/contracts/import-preview.contract";
import { detectDuplicateImportRows, detectExistingStudentDuplicates } from "@/importing/utils/duplicate-detector";
import { applyImportDefaults } from "@/importing/utils/row-normalizer";
import { promoteKnownMultiShiftAllocation } from "@/importing/utils/shift-alias-resolver";
import { mergeValidatorResults, validateRequiredImportFields } from "@/importing/validators/import-required-fields.validator";
import { validateImportAllocation } from "@/importing/validators/import-allocation.validator";
import { validateImportPayment } from "@/importing/validators/import-payment.validator";
import { validateImportSeat } from "@/importing/validators/import-seat.validator";
import { validateImportShift } from "@/importing/validators/import-shift.validator";
import { validateImportStudent } from "@/importing/validators/import-student.validator";
import { normalizeMapping, statusForValidation } from "./import-session.service";
import {
    findStagedAllocationConflicts,
    stagedAllocationConflictWarnings,
    stagedRowsForRequestedShifts,
} from "@/importing/utils/staged-allocation-conflicts";
import { buildImportPaymentPlan } from "@/importing/utils/import-payment-plan";

type SessionRow = {
    id: string;
    rowNumber: number;
    status: string;
    skipped: boolean;
    rawData: unknown;
    normalizedData: unknown;
};

type ValidationContext = Awaited<ReturnType<typeof getValidationContext>>;

function key(value: string | undefined | null) {
    return (value ?? "").trim().toLowerCase();
}

function cloneNormalized(value: ImportNormalizedRow): ImportNormalizedRow {
    return JSON.parse(JSON.stringify(value)) as ImportNormalizedRow;
}

function columnsFromFileMeta(meta: unknown, firstRow: unknown) {
    if (meta && typeof meta === "object" && !Array.isArray(meta) && "columns" in meta) {
        const columns = (meta as { columns?: unknown }).columns;
        if (Array.isArray(columns) && columns.every(column => typeof column === "string")) return columns;
    }
    return Object.keys((firstRow ?? {}) as Record<string, unknown>);
}

function normalizedFromRow(row: SessionRow): ImportNormalizedRow {
    return row.normalizedData && typeof row.normalizedData === "object" && !Array.isArray(row.normalizedData)
        ? row.normalizedData as ImportNormalizedRow
        : {};
}

async function getValidationContext(branchId: string) {
    const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: {
            defaultFee: true,
            defaultAdmissionFee: true,
            seats: { select: { id: true, label: true }, orderBy: { label: "asc" } },
            shifts: {
                where: { status: "ACTIVE" },
                select: { id: true, name: true, startTime: true, endTime: true, price: true },
                orderBy: { name: "asc" },
            },
            multiShifts: {
                select: {
                    id: true,
                    name: true,
                    price: true,
                    components: {
                        include: { shift: { select: { id: true, name: true, startTime: true, endTime: true } } },
                        orderBy: { order: "asc" },
                    },
                },
                orderBy: { name: "asc" },
            },
            students: {
                select: {
                    id: true,
                    name: true,
                    phone: true,
                    joinedAt: true,
                    seatAllocations: {
                        where: { endDate: null },
                        include: { seat: { select: { label: true } }, shift: { select: { name: true } } },
                    },
                },
            },
        },
    });

    if (!branch) throw new Error("Branch not found");
    const sortedSeats = sortSeatsByLabel(branch.seats);

    const activeAllocations = await prisma.seatAllocation.findMany({
        where: { endDate: null, seat: { branchId } },
        include: { seat: { select: { label: true } }, shift: { select: { name: true, startTime: true, endTime: true } } },
    });

    const shiftsByName = new Map(branch.shifts.map(shift => [key(shift.name), shift]));
    const shiftsById = new Map(branch.shifts.map(shift => [shift.id, shift]));

    return {
        branchDefaultFee: branch.defaultFee ?? 0,
        defaultAdmissionFee: branch.defaultAdmissionFee ?? 0,
        seatsByLabel: new Map(sortedSeats.map(seat => [key(seat.label), seat])),
        shiftsByName,
        shiftsById,
        multiShiftsByName: new Map(branch.multiShifts.map(multiShift => [
            key(multiShift.name),
            {
                id: multiShift.id,
                name: multiShift.name,
                price: multiShift.price,
                components: multiShift.components.map(component => ({
                    shiftId: component.shift.id,
                    shiftName: component.shift.name,
                    startTime: component.shift.startTime,
                    endTime: component.shift.endTime,
                })),
            },
        ])),
        multiShiftsById: new Map(branch.multiShifts.map(multiShift => [
            multiShift.id,
            {
                id: multiShift.id,
                name: multiShift.name,
                price: multiShift.price,
                components: multiShift.components.map(component => ({
                    shiftId: component.shift.id,
                    shiftName: component.shift.name,
                    startTime: component.shift.startTime,
                    endTime: component.shift.endTime,
                })),
            },
        ])),
        existingStudents: branch.students,
        activeAllocations,
    };
}

function paymentAmountSource(normalized: ImportNormalizedRow): ImportPaymentPreview["amountSource"] {
    if (normalized.payment?.amount !== undefined) return "UPLOADED";
    if (normalized.student?.monthlyFee === undefined) return "NONE";
    if (normalized.student.feeSource === "SHIFT_PRICE") return "SHIFT_PRICE";
    if (normalized.student.feeSource === "MULTI_SHIFT_PRICE") return "MULTI_SHIFT_PRICE";
    if (normalized.student.feeSource === "BRANCH_DEFAULT") return "BRANCH_DEFAULT";
    return "MONTHLY_FEE";
}

function buildPaymentPreview(
    normalized: ImportNormalizedRow,
    mapping: ImportMappingState,
    issues: ImportIssue[],
    warnings: ImportIssue[]
): ImportPaymentPreview {
    const action = mapping.importOptions?.paymentAction;
    const cycle = mapping.importOptions?.paymentCycle;
    const enabled = Boolean(action && action !== "SKIP_PAYMENTS" && cycle && cycle !== "SKIP_PAYMENTS");
    const source = paymentAmountSource(normalized);
    const amount = normalized.payment?.amount ?? normalized.student?.monthlyFee ?? null;
    const blockers = [...issues, ...warnings].filter(issue => issue.code.startsWith("PAYMENT"));
    const plan = buildImportPaymentPlan(normalized, mapping);

    return {
        enabled,
        action,
        cycle,
        historyMode: plan.historyMode,
        generatedCount: plan.items.length,
        skippedHistoricalPayments: plan.skippedHistoricalPayments,
        amount,
        amountSource: source,
        status: normalized.payment?.status,
        method: normalized.payment?.method,
        referenceId: normalized.payment?.referenceId,
        blockers,
        message: enabled
            ? `${plan.items.length} joined-date cycle${plan.items.length === 1 ? "" : "s"} will be created${plan.skippedHistoricalPayments > 0 ? `; ${plan.skippedHistoricalPayments} old cycle${plan.skippedHistoricalPayments === 1 ? "" : "s"} skipped` : ""}. Amount uses ${source.toLowerCase().replace(/_/g, " ")}${amount !== null ? ` (${amount})` : ""}.`
            : "Payments are not enabled for this row yet.",
    };
}

function suggestedFixes(issues: ImportIssue[], warnings: ImportIssue[]) {
    return [...issues, ...warnings]
        .map(issue => {
            if (issue.code === "MISSING_STUDENT_NAME") return "Add a student name.";
            if (issue.code.includes("UNKNOWN_SEAT")) return "Review the missing seat decision.";
            if (issue.code.includes("UNKNOWN_SHIFT")) return "Review the missing shift decision.";
            if (issue.code.includes("PAYMENT")) return "Confirm the payment setup.";
            if (issue.code.includes("ALLOCATION_CONFLICT")) return "Choose a different seat or shift.";
            return issue.message;
        })
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 5);
}

function requestedShiftsFromInput(input: { shiftIds?: string[]; multiShiftId?: string | null }, context: ValidationContext) {
    if (input.multiShiftId) {
        const multiShift = context.multiShiftsById.get(input.multiShiftId);
        return (multiShift?.components ?? []).map(component => ({
            id: component.shiftId,
            name: component.shiftName,
            startTime: component.startTime,
            endTime: component.endTime,
        }));
    }

    return (input.shiftIds ?? [])
        .map(shiftId => context.shiftsById.get(shiftId))
        .filter((shift): shift is NonNullable<typeof shift> => Boolean(shift));
}

export class ImportWiringService {
    private static async loadSession(branchId: string, sessionId: string) {
        const session = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            include: { rows: { orderBy: { rowNumber: "asc" } } },
        });
        if (!session) throw new Error("Import session not found");
        return session;
    }

    static async previewRowDraft(
        userId: string,
        branchId: string,
        sessionId: string,
        input: { rowId: string; normalizedData: ImportNormalizedRow }
    ): Promise<ImportRowDraftPreview> {
        await StaffService.authorize(userId, branchId, "students");
        const session = await this.loadSession(branchId, sessionId);
        const row = session.rows.find(item => item.id === input.rowId);
        if (!row) throw new Error("Import row not found");

        const columns = columnsFromFileMeta(session.fileMeta, session.rows[0]?.rawData);
        const mapping = normalizeMapping(session.mapping, columns);
        const context = await getValidationContext(branchId);
        const normalizedData = applyImportDefaults(
            promoteKnownMultiShiftAllocation(cloneNormalized(input.normalizedData), context),
            mapping.importOptions,
            context
        );

        const result = mergeValidatorResults(
            validateRequiredImportFields(normalizedData),
            validateImportStudent(normalizedData, context),
            validateImportSeat(normalizedData, {
                seatsByLabel: context.seatsByLabel,
                createUnknownSeats: mapping.importOptions?.createUnknownSeats,
                skipUnknownSeatAllocations: mapping.importOptions?.skipUnknownSeatAllocations,
            }),
            validateImportShift(normalizedData, {
                shiftsByName: context.shiftsByName,
                multiShiftsByName: context.multiShiftsByName,
                createUnknownShifts: mapping.importOptions?.createUnknownShifts,
                createUnknownMultiShifts: mapping.importOptions?.createUnknownMultiShifts,
                skipUnknownShiftAllocations: mapping.importOptions?.skipUnknownShiftAllocations,
                skipUnknownMultiShiftAllocations: mapping.importOptions?.skipUnknownMultiShiftAllocations,
                skipMissingShiftAllocations: mapping.importOptions?.skipMissingShiftAllocations,
            }),
            validateImportAllocation(normalizedData, {
                ...context,
                skipConflictingAllocations: mapping.importOptions?.skipConflictingAllocations,
            }),
            validateImportPayment(normalizedData, mapping)
        );

        const sessionRows = session.rows.map(item => ({
            id: item.id,
            rowNumber: item.rowNumber,
            status: item.status,
            skipped: item.skipped,
            rawData: item.rawData,
            normalizedData: item.id === input.rowId ? normalizedData : normalizedFromRow(item),
        }));
        const stagedConflicts = findStagedAllocationConflicts({
            rowId: input.rowId,
            normalizedData,
            rows: sessionRows,
            context,
        });
        const skippedStagedConflicts = mapping.importOptions?.skipConflictingAllocations
            ? stagedAllocationConflictWarnings(stagedConflicts)
            : [];
        const duplicateWarnings = [
            ...(detectDuplicateImportRows(sessionRows
                .filter(item => !item.skipped)
                .map(item => ({
                    id: item.id,
                    rowNumber: item.rowNumber,
                    normalizedData: normalizedFromRow(item),
                }))).get(input.rowId) ?? []),
            ...detectExistingStudentDuplicates(normalizedData, context.existingStudents),
        ];
        const issues = [
            ...result.issues,
            ...(mapping.importOptions?.skipConflictingAllocations ? [] : stagedConflicts),
        ];
        const warnings = [...result.warnings, ...skippedStagedConflicts, ...duplicateWarnings];

        return {
            rowId: input.rowId,
            rowNumber: row.rowNumber,
            status: statusForValidation({ skipped: row.skipped, issues, warnings }),
            normalizedData,
            issues,
            warnings,
            paymentPreview: buildPaymentPreview(normalizedData, mapping, issues, warnings),
            suggestedFixes: suggestedFixes(issues, warnings),
        };
    }

    static async getAvailability(
        userId: string,
        branchId: string,
        sessionId: string,
        input: { rowId: string; shiftIds?: string[]; multiShiftId?: string | null }
    ): Promise<ImportAvailabilityPreview> {
        await StaffService.authorize(userId, branchId, "students");
        const [session, context, baseShifts] = await Promise.all([
            this.loadSession(branchId, sessionId),
            getValidationContext(branchId),
            SeatService.getShiftsCapacityWithMulti(userId, branchId),
        ]);

        const requestedShifts = requestedShiftsFromInput(input, context);
        const sessionRows = session.rows.map(row => ({
            id: row.id,
            rowNumber: row.rowNumber,
            status: row.status,
            skipped: row.skipped,
            rawData: row.rawData,
            normalizedData: normalizedFromRow(row),
        }));

        const shifts = baseShifts.map(shift => {
            const shiftCandidates = shift.type === "MULTISHIFT"
                ? (shift.componentShiftIds ?? []).map(id => context.shiftsById.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
                : [context.shiftsById.get(shift.shiftId)].filter((item): item is NonNullable<typeof item> => Boolean(item));
            const stagedLabels = new Set(stagedRowsForRequestedShifts({
                rowId: input.rowId,
                rows: sessionRows,
                requestedShifts: shiftCandidates,
                context,
            }).map(row => key(row.seatLabel)));
            const stagedUsed = stagedLabels.size;
            const stagedAvailable = Math.max(0, shift.available - stagedUsed);

            return {
                ...shift,
                stagedUsed,
                stagedAvailable,
                available: stagedAvailable,
                isFull: stagedAvailable === 0,
                occupancyPercent: shift.totalSeats === 0
                    ? 0
                    : Math.round(((shift.used + stagedUsed) / shift.totalSeats) * 100),
            };
        });

        const primaryShiftId = input.multiShiftId
            ? requestedShifts[0]?.id
            : input.shiftIds?.[0];

        if (!primaryShiftId || requestedShifts.length === 0) {
            return { shifts, seatMap: null, conflicts: [] };
        }

        const baseSeatMap = await SeatService.getSeatMap(userId, branchId, primaryShiftId, input.multiShiftId ?? undefined);
        const stagedRows = stagedRowsForRequestedShifts({
            rowId: input.rowId,
            rows: sessionRows,
            requestedShifts,
            context,
        });
        const stagedBySeat = new Map(stagedRows.map(row => [key(row.seatLabel), row]));
        let occupiedCount = 0;
        const seats = baseSeatMap.seats.map(seat => {
            const staged = stagedBySeat.get(key(seat.label));
            const occupied = seat.occupied || Boolean(staged);
            if (occupied) occupiedCount++;

            return {
                ...seat,
                occupied,
                occupiedBy: seat.occupied
                    ? seat.occupiedBy
                    : staged
                        ? `Row ${staged.rowNumber}${staged.studentName ? `: ${staged.studentName}` : ""}`
                        : null,
                source: seat.occupied ? "existing" as const : staged ? "staged" as const : "available" as const,
                stagedRowId: staged?.rowId,
                stagedRowNumber: staged?.rowNumber,
            };
        });

        return {
            shifts,
            seatMap: {
                ...baseSeatMap,
                occupiedCount,
                availableCount: Math.max(0, baseSeatMap.totalSeats - occupiedCount),
                seats,
            },
            conflicts: [],
        };
    }
}
