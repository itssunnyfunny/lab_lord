import { prisma } from "@/lib/prisma";
import { MultiShiftService } from "@/services/multiShift.service";
import { PaymentService } from "@/services/payment.service";
import { SeatAllocationService } from "@/services/seatAllocation.service";
import { SeatService } from "@/services/seat.service";
import { ShiftService } from "@/services/shift.service";
import { StaffService } from "@/services/staff.service";
import { StudentService } from "@/services/student.service";
import { EntitlementService } from "@/services/entitlement.service";
import type { CommitMode, ImportCommitResult, ImportMappingState, ImportNormalizedRow } from "@/importing/contracts/import-session.contract";
import { promoteKnownMultiShiftAllocation } from "@/importing/utils/shift-alias-resolver";
import { buildImportPlanChecks, createImportPlanVersion, getBlockingImportPlanChecks } from "@/importing/utils/import-plan-checks";
import { buildImportPaymentPlan, importPaymentHistoryMode } from "@/importing/utils/import-payment-plan";
import { ImportSessionService } from "./import-session.service";
import type { PaymentMethod } from "@/app/generated/prisma/enums";
import type { Prisma } from "@/app/generated/prisma/client";
import { PaymentResolutionEventSource } from "@/types";

const STALE_COMMITTING_AFTER_MS = 30 * 60 * 1000;

function asJson(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
}

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : "Something went wrong";
}

function key(value: string | undefined | null) {
    return (value ?? "").trim().toLowerCase();
}

function defersAllocation(row: { warnings: unknown }) {
    return Array.isArray(row.warnings) && row.warnings.some((warning: { code?: string }) =>
        (warning.code ?? "").startsWith("ALLOCATION_SKIPPED_")
    );
}

function createCommitSummary(skippedRows = 0): Record<string, number> {
    return {
        createdStudents: 0,
        createdSeats: 0,
        createdShifts: 0,
        createdMultiShifts: 0,
        createdAllocations: 0,
        generatedPayments: 0,
        markedPaid: 0,
        markedWaived: 0,
        historicalPaid: 0,
        historicalDue: 0,
        currentCyclePayments: 0,
        skippedHistoricalPayments: 0,
        skippedRows,
        failedRows: 0,
    };
}

function addCommitSummary(target: Record<string, number>, source: Record<string, number>) {
    for (const [key, value] of Object.entries(source)) {
        target[key] = (target[key] ?? 0) + value;
    }
}

function stringId(value: unknown) {
    return typeof value === "string" && value.trim() ? value : null;
}

function stringIds(value: unknown) {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : [];
}

async function cleanupCreatedEntities(createdEntityIds: Record<string, unknown>) {
    const paymentIds = [
        ...stringIds(createdEntityIds.paymentIds),
        stringId(createdEntityIds.paymentId),
    ].filter((id): id is string => Boolean(id));
    const allocationIds = stringIds(createdEntityIds.allocationIds);
    const studentId = stringId(createdEntityIds.studentId);
    const multiShiftId = stringId(createdEntityIds.multiShiftId);
    const shiftId = stringId(createdEntityIds.shiftId);
    const seatId = stringId(createdEntityIds.seatId);

    if (paymentIds.length === 0 && allocationIds.length === 0 && !studentId && !multiShiftId && !shiftId && !seatId) {
        return;
    }

    await prisma.$transaction(async tx => {
        if (paymentIds.length > 0) {
            await tx.auditLog.deleteMany({ where: { paymentId: { in: paymentIds } } });
            await tx.payment.deleteMany({ where: { id: { in: paymentIds } } });
        }
        if (allocationIds.length > 0) {
            await tx.seatAllocation.deleteMany({ where: { id: { in: allocationIds } } });
        }
        if (studentId) {
            await tx.student.deleteMany({ where: { id: studentId } });
        }
        if (multiShiftId) {
            await tx.multiShift.deleteMany({ where: { id: multiShiftId } });
        }
        if (shiftId) {
            await tx.shift.deleteMany({ where: { id: shiftId } });
        }
        if (seatId) {
            await tx.seat.deleteMany({ where: { id: seatId } });
        }
    });
}

export class ImportCommitService {
    private static async loadBusinessContext(branchId: string) {
        const [seats, shifts, multiShifts] = await Promise.all([
            prisma.seat.findMany({ where: { branchId } }),
            prisma.shift.findMany({ where: { branchId, status: "ACTIVE" } }),
            prisma.multiShift.findMany({
                where: { branchId },
                include: { components: { include: { shift: true }, orderBy: { order: "asc" } } },
            }),
        ]);

        return {
            seatsByLabel: new Map(seats.map(seat => [key(seat.label), seat])),
            shiftsByName: new Map(shifts.map(shift => [key(shift.name), shift])),
            multiShiftsByName: new Map(multiShifts.map(multiShift => [key(multiShift.name), multiShift])),
        };
    }

    private static async ensureCommitPermissions(
        userId: string,
        branchId: string,
        rows: { normalizedData: ImportNormalizedRow | null; warnings: unknown }[],
        mapping: ImportMappingState
    ) {
        await StaffService.authorize(userId, branchId, "students");
        const needsManageBranch = rows.some(row =>
            Array.isArray(row.warnings) && row.warnings.some((warning: { code?: string }) =>
                ["WILL_CREATE_SEAT", "WILL_CREATE_SHIFT", "WILL_CREATE_MULTI_SHIFT"].includes(warning.code ?? "")
            )
        );
        const needsAllocation = rows.some(row =>
            !defersAllocation(row) &&
            row.normalizedData?.allocation?.seatLabel &&
            (row.normalizedData.allocation.shiftName || row.normalizedData.allocation.multiShiftName)
        );
        const needsPayments = mapping.importOptions?.paymentAction && mapping.importOptions.paymentAction !== "SKIP_PAYMENTS";
        const importsPaymentStatuses = mapping.importOptions?.paymentAction === "IMPORT_PAID_UNPAID";
        const historyMode = importPaymentHistoryMode(mapping.importOptions);
        const historyMarksPaid = historyMode === "FROM_JOINED_MARK_PAID" || historyMode === "FROM_JOINED_PAID_THROUGH_PREVIOUS";
        const needsPaid = Boolean(needsPayments && (
            historyMarksPaid ||
            importsPaymentStatuses && rows.some(row => row.normalizedData?.payment?.status === "PAID")
        ));
        const needsWaived = importsPaymentStatuses && rows.some(row => row.normalizedData?.payment?.status === "WAIVED");

        if (needsManageBranch) await StaffService.authorize(userId, branchId, "manage_branch");
        if (needsAllocation) await StaffService.authorize(userId, branchId, "seat_allocation");
        if (needsPayments) await StaffService.authorize(userId, branchId, "generate_payments");
        if (needsPaid) await StaffService.authorize(userId, branchId, "mark_payment_paid");
        if (needsWaived) await StaffService.authorize(userId, branchId, "waive_payments");
    }

    static async commitSession(
        userId: string,
        branchId: string,
        sessionId: string,
        mode: CommitMode = "SAFE_PARTIAL",
        expectedPlanVersion?: string
    ): Promise<ImportCommitResult> {
        if (!expectedPlanVersion) {
            throw new Error("Reviewed import plan version is required before commit.");
        }

        await StaffService.authorize(userId, branchId, "students");
        await EntitlementService.assertBranchWritable(branchId);
        const currentSession = await prisma.importSession.findFirst({
            where: { id: sessionId, branchId },
            select: { status: true, updatedAt: true },
        });
        if (!currentSession) throw new Error("Import session not found.");
        if (["COMMITTED", "PARTIAL"].includes(currentSession.status)) {
            throw new Error("Import session has already been committed.");
        }
        if (currentSession.status === "COMMITTING") {
            const stale = Date.now() - currentSession.updatedAt.getTime() > STALE_COMMITTING_AFTER_MS;
            if (!stale) {
                throw new Error("Import is already running. Wait for it to finish before retrying.");
            }
        }

        const detail = await ImportSessionService.revalidateSession(userId, branchId, sessionId);
        const rows = detail.rows.map(row => ({
            id: row.id,
            rowNumber: row.rowNumber,
            status: row.status,
            skipped: row.skipped,
            normalizedData: row.normalizedData as ImportNormalizedRow | null,
            issues: row.issues,
            warnings: row.warnings,
        }));
        const importableRows = rows.filter(row => !row.skipped && ["READY", "WARNING"].includes(row.status));
        const hasOpenQuestions = detail.questions?.some((question: { status?: string }) => question.status === "OPEN") ?? false;
        const canSafePartial = mode === "SAFE_PARTIAL" && !hasOpenQuestions && importableRows.length > 0;
        if (detail.status !== "READY_TO_COMMIT" && !canSafePartial) {
            throw new Error("Import session is not ready to commit.");
        }

        const blockedRows = rows.filter(row => ["BLOCKED", "CONFLICT", "NEEDS_REVIEW", "DUPLICATE"].includes(row.status));
        if (mode === "STRICT_ALL_OR_NOTHING" && blockedRows.length > 0) {
            throw new Error("Strict import refused because blocked or review rows remain.");
        }

        const mapping = detail.mapping as ImportMappingState;
        const checks = buildImportPlanChecks({
            mapping,
            rows,
            hasOpenQuestions,
            mode,
        });
        const blockers = getBlockingImportPlanChecks(checks);
        if (blockers.length > 0) {
            throw new Error(`Resolve import checks before committing: ${blockers.map(check => check.label).join(", ")}.`);
        }

        const actualPlanVersion = createImportPlanVersion({
            sessionId,
            status: detail.status,
            mapping,
            rows,
        });
        if (actualPlanVersion !== expectedPlanVersion) {
            throw new Error("Import plan changed after preview. Refresh the final check before committing.");
        }

        await this.ensureCommitPermissions(userId, branchId, importableRows, mapping);

        await prisma.importSession.update({
            where: { id: sessionId },
            data: { status: "COMMITTING" },
        });

        const summary = createCommitSummary(rows.length - importableRows.length);
        const errors: { rowId?: string; rowNumber?: number; message: string }[] = [];

        try {
            let context = await this.loadBusinessContext(branchId);

            for (const row of importableRows) {
                const normalized = row.normalizedData
                    ? promoteKnownMultiShiftAllocation(row.normalizedData, context)
                    : null;
                if (!normalized?.student?.name) {
                    summary.failedRows++;
                    errors.push({ rowId: row.id, rowNumber: row.rowNumber, message: "Student name is missing on an importable row." });
                    await prisma.importRow.update({
                        where: { id: row.id },
                        data: {
                            status: "FAILED",
                            issues: asJson([{ code: "COMMIT_FAILED", message: "Student name is missing on an importable row.", severity: "error" }]),
                        },
                    });
                    continue;
                }
                const createdEntityIds: Record<string, unknown> = {};
                const rowSummary = createCommitSummary();

                try {
                    const seatLabel = normalized.allocation?.seatLabel ?? normalized.seat?.label;
                    const shiftName = normalized.allocation?.shiftName ?? normalized.shift?.name;
                    const multiShiftName = normalized.allocation?.multiShiftName ?? normalized.multiShift?.name;

                    const allocationDeferred = defersAllocation(row);

                    if (!allocationDeferred && seatLabel && !context.seatsByLabel.has(key(seatLabel)) && mapping.importOptions?.createUnknownSeats) {
                        const seat = await SeatService.createSeat(userId, branchId, seatLabel);
                        context.seatsByLabel.set(key(seat.label), seat);
                        createdEntityIds.seatId = seat.id;
                        rowSummary.createdSeats++;
                    }

                    if (!allocationDeferred && shiftName && !context.shiftsByName.has(key(shiftName)) && mapping.importOptions?.createUnknownShifts) {
                        const shift = await ShiftService.createShift(userId, branchId, {
                            name: shiftName,
                            startTime: normalized.shift?.startTime,
                            endTime: normalized.shift?.endTime,
                            price: normalized.student.monthlyFee ?? 0,
                        });
                        context.shiftsByName.set(key(shift.name), shift);
                        createdEntityIds.shiftId = shift.id;
                        rowSummary.createdShifts++;
                    }

                    if (!allocationDeferred && multiShiftName && !context.multiShiftsByName.has(key(multiShiftName)) && mapping.importOptions?.createUnknownMultiShifts) {
                        const componentShiftIds = (normalized.multiShift?.componentShiftNames ?? [])
                            .map(name => context.shiftsByName.get(key(name))?.id)
                            .filter((id): id is string => Boolean(id));

                        if (componentShiftIds.length >= 2) {
                            const multiShift = await MultiShiftService.createMultiShift(userId, branchId, {
                                name: multiShiftName,
                                price: normalized.student.monthlyFee ?? 0,
                                shiftIds: componentShiftIds,
                            });
                            context = await this.loadBusinessContext(branchId);
                            createdEntityIds.multiShiftId = multiShift.id;
                            rowSummary.createdMultiShifts++;
                        }
                    }

                    const seat = seatLabel ? context.seatsByLabel.get(key(seatLabel)) : undefined;
                    const shift = shiftName ? context.shiftsByName.get(key(shiftName)) : undefined;
                    const multiShift = multiShiftName ? context.multiShiftsByName.get(key(multiShiftName)) : undefined;
                    const feeLinkedShift = normalized.student.feeLinkedShiftName
                        ? context.shiftsByName.get(key(normalized.student.feeLinkedShiftName))
                        : shift;
                    const feeLinkedMultiShift = normalized.student.feeLinkedMultiShiftName
                        ? context.multiShiftsByName.get(key(normalized.student.feeLinkedMultiShiftName))
                        : multiShift;
                    const feeLinkedShiftId = normalized.student.feeSource === "UPLOADED"
                        ? undefined
                        : feeLinkedMultiShift
                            ? undefined
                            : feeLinkedShift?.id;
                    const feeLinkedMultiShiftId = normalized.student.feeSource === "UPLOADED"
                        ? undefined
                        : feeLinkedMultiShift?.id;
                    const joinedAt = normalized.student.joinedAt ? new Date(normalized.student.joinedAt) : new Date();
                    const paymentPlan = buildImportPaymentPlan({
                        ...normalized,
                        student: {
                            ...normalized.student,
                            joinedAt: joinedAt.toISOString(),
                        },
                    }, mapping);
                    const student = await StudentService.createImportedStudent(userId, branchId, {
                        name: normalized.student.name,
                        phone: normalized.student.phone,
                        joinedAt,
                        billingStartAt: paymentPlan.billingStartAt,
                        monthlyFee: normalized.student.monthlyFee,
                        admissionFee: 0,
                        feeLinkedShiftId,
                        feeLinkedMultiShiftId,
                    });
                    createdEntityIds.studentId = student.id;
                    rowSummary.createdStudents++;

                    if (!allocationDeferred && seat && multiShift) {
                        const shiftIds = multiShift.components.map(component => component.shiftId);
                        const allocations = await SeatAllocationService.assignSeatToShifts(userId, seat.id, student.id, shiftIds, multiShift.id);
                        createdEntityIds.allocationIds = allocations.map(allocation => allocation.id);
                        rowSummary.createdAllocations += allocations.length;
                    } else if (!allocationDeferred && seat && shift) {
                        const allocations = await SeatAllocationService.assignSeatToShifts(userId, seat.id, student.id, [shift.id]);
                        createdEntityIds.allocationIds = allocations.map(allocation => allocation.id);
                        rowSummary.createdAllocations += allocations.length;
                    }

                    rowSummary.skippedHistoricalPayments += paymentPlan.skippedHistoricalPayments;

                    if (paymentPlan.enabled && paymentPlan.items.length > 0) {
                        const paymentAmount = normalized.payment?.amount ?? normalized.student.monthlyFee;
                        await prisma.$transaction(async tx => {
                            const paymentIds: string[] = [];
                            for (const item of paymentPlan.items) {
                                const payment = await PaymentService.ensureMonthlyPaymentForStudentInTransaction(
                                    userId,
                                    branchId,
                                    {
                                        studentId: student.id,
                                        periodStart: item.cycle.periodStart,
                                        periodEnd: item.cycle.periodEnd,
                                        dueDate: item.cycle.dueDate,
                                        amount: paymentAmount,
                                    },
                                    tx
                                );
                                paymentIds.push(payment.id);
                                createdEntityIds.paymentIds = paymentIds;
                                rowSummary.generatedPayments++;
                                if (item.bucket === "historical" && item.status === "PAID") rowSummary.historicalPaid++;
                                if (item.bucket === "historical" && item.status === "DUE") rowSummary.historicalDue++;
                                if (item.bucket === "current") rowSummary.currentCyclePayments++;

                                if (item.status === "PAID") {
                                    const method = normalized.payment?.method
                                        ?? mapping.importOptions?.paymentMapping?.defaultMethod as PaymentMethod | undefined;
                                    await PaymentService.markPaymentAsPaidInTransaction(
                                        userId,
                                        payment.id,
                                        method,
                                        normalized.payment?.referenceId,
                                        tx,
                                        { source: PaymentResolutionEventSource.IMPORT_EXECUTION }
                                    );
                                    rowSummary.markedPaid++;
                                }
                                if (item.status === "WAIVED") {
                                    await PaymentService.markPaymentAsWaivedInTransaction(
                                        userId,
                                        payment.id,
                                        tx,
                                        { source: PaymentResolutionEventSource.IMPORT_EXECUTION }
                                    );
                                    rowSummary.markedWaived++;
                                }
                            }

                            await tx.importRow.update({
                                where: { id: row.id },
                                data: {
                                    status: "IMPORTED",
                                    createdEntityIds: asJson(createdEntityIds),
                                },
                            });
                        });
                    } else {
                        await prisma.importRow.update({
                            where: { id: row.id },
                            data: {
                                status: "IMPORTED",
                                createdEntityIds: asJson(createdEntityIds),
                            },
                        });
                    }
                    addCommitSummary(summary, rowSummary);
                } catch (error) {
                    let cleanupMessage: string | null = null;
                    try {
                        await cleanupCreatedEntities(createdEntityIds);
                        context = await this.loadBusinessContext(branchId);
                    } catch (cleanupError) {
                        cleanupMessage = ` Cleanup failed: ${messageOf(cleanupError)}`;
                    }
                    summary.failedRows++;
                    errors.push({ rowId: row.id, rowNumber: row.rowNumber, message: `${messageOf(error)}${cleanupMessage ?? ""}` });
                    await prisma.importRow.update({
                        where: { id: row.id },
                        data: {
                            status: "FAILED",
                            issues: asJson([{ code: "COMMIT_FAILED", message: `${messageOf(error)}${cleanupMessage ?? ""}`, severity: "error" }]),
                        },
                    });
                }
            }

            const isPartial = errors.length > 0 || summary.skippedRows > 0;
            const hasCreatedStudents = summary.createdStudents > 0;
            const status = errors.length > 0 && !hasCreatedStudents ? "FAILED" : isPartial ? "PARTIAL" : "COMMITTED";
            const commitStatus = errors.length > 0 && !hasCreatedStudents ? "FAILED" : isPartial ? "PARTIAL" : "SUCCESS";

            await prisma.importCommit.create({
                data: {
                    importSessionId: sessionId,
                    committedByUserId: userId,
                    status: commitStatus,
                    summary: asJson(summary),
                    errors: asJson(errors),
                },
            });
            await prisma.importSession.update({
                where: { id: sessionId },
                data: { status, summary: asJson(summary) },
            });

            return { status: commitStatus, summary, errors };
        } catch (error) {
            errors.push({ message: messageOf(error) });
            await prisma.importCommit.create({
                data: {
                    importSessionId: sessionId,
                    committedByUserId: userId,
                    status: "FAILED",
                    summary: asJson(summary),
                    errors: asJson(errors),
                },
            });
            await prisma.importSession.update({
                where: { id: sessionId },
                data: { status: "FAILED", summary: asJson(summary) },
            });
            return { status: "FAILED", summary, errors };
        }
    }
}
