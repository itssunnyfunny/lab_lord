import { AccessPolicy } from "@/services/accessPolicy.service";
import { Prisma, type PaymentMethod, type PaymentStatus } from "@/app/generated/prisma/client";
import { FORM_LIMITS } from "@/lib/formValidation";
import { prisma } from "@/lib/prisma";
import { MultiShiftService } from "@/services/multiShift.service";
import { PaymentService } from "@/services/payment.service";
import { SeatService } from "@/services/seat.service";
import { SeatAllocationService } from "@/services/seatAllocation.service";
import { ShiftService } from "@/services/shift.service";
import { StudentService } from "@/services/student.service";
import { PaymentResolutionEventSource } from "@/types";
import type { ClaimedImportRunItem, ImportRunItemResult } from "../contracts/import-v2.contract";
import { ImportRunRunner } from "./import-runner.service";

const PAYMENT_METHODS = new Set<PaymentMethod>(["CASH", "UPI", "BANK_TRANSFER"]);
const PAYMENT_STATUSES = new Set<PaymentStatus>(["DUE", "PAID", "WAIVED"]);

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} is required`);
    }
    return value.trim();
}

function optionalString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown, label: string) {
    if (value == null || value === "") return undefined;
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > FORM_LIMITS.moneyMax) {
        throw new Error(`${label} must be a non-negative whole number no greater than ${FORM_LIMITS.moneyMax}`);
    }
    return Number(value);
}

function requiredDate(value: unknown, label: string) {
    const parsed = typeof value === "string" ? new Date(value) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
    return parsed;
}

function optionalDate(value: unknown, label: string) {
    return value == null || value === "" ? undefined : requiredDate(value, label);
}

function resultEntityId(result: unknown, label: string) {
    const entityIds = asRecord(result).entityIds;
    const id = Array.isArray(entityIds) ? entityIds[0] : undefined;
    return requiredString(id, label);
}

async function predecessorEntityId(
    tx: Prisma.TransactionClient,
    importRunId: string,
    itemKey: unknown,
    label: string
) {
    const dependencyKey = requiredString(itemKey, `${label} dependency`);
    const dependency = await tx.importRunItem.findFirst({
        where: {
            importRunId,
            itemKey: dependencyKey,
            status: "SUCCEEDED",
        },
        select: { result: true },
    });
    if (!dependency) throw new Error(`${label} dependency has not completed`);
    return resultEntityId(dependency.result, label);
}

async function resolvedStudentId(
    tx: Prisma.TransactionClient,
    importRunId: string,
    payload: Record<string, unknown>
) {
    const retainedStudentId = optionalString(payload.studentId);
    if (retainedStudentId) return retainedStudentId;
    return predecessorEntityId(tx, importRunId, payload.studentItemKey, "Student");
}

async function applyConfigurationItem(
    tx: Prisma.TransactionClient,
    userId: string,
    branchId: string,
    payload: Record<string, unknown>
): Promise<ImportRunItemResult> {
    await AccessPolicy.authorizeAction(userId, branchId, "manage_branch", tx, true);
    const type = requiredString(payload.type, "Configuration type");
    const name = optionalString(payload.name);
    const label = optionalString(payload.label);

    if (type === "seat") {
        const seatLabel = requiredString(label, "Seat label");
        const existing = await tx.seat.findFirst({
            where: { branchId, label: { equals: seatLabel, mode: "insensitive" } },
            select: { id: true },
        });
        const seat = existing ?? await SeatService.createSeatInTransaction(userId, branchId, seatLabel, tx);
        return { entityIds: [seat.id], counts: { seats: existing ? 0 : 1 } };
    }

    if (type === "shift") {
        const shiftName = requiredString(name, "Shift name");
        const expectedStartTime = optionalString(payload.startTime) ?? null;
        const expectedEndTime = optionalString(payload.endTime) ?? null;
        const expectedPrice = optionalInteger(payload.price, "Shift price") ?? 0;
        const existing = await tx.shift.findFirst({
            where: { branchId, name: { equals: shiftName, mode: "insensitive" }, status: "ACTIVE" },
            select: { id: true, startTime: true, endTime: true, price: true, isReserved: true },
        });
        if (
            existing
            && (
                existing.startTime !== expectedStartTime
                || existing.endTime !== expectedEndTime
                || existing.price !== expectedPrice
                || existing.isReserved
            )
        ) {
            throw new Error("Import plan is stale because the reviewed shift configuration changed");
        }
        const shift = existing ?? await ShiftService.createShiftInTransaction(userId, branchId, {
            name: shiftName,
            startTime: expectedStartTime ?? undefined,
            endTime: expectedEndTime ?? undefined,
            price: expectedPrice,
        }, tx);
        return { entityIds: [shift.id], counts: { shifts: existing ? 0 : 1 } };
    }

    if (type === "multi-shift") {
        const multiShiftName = requiredString(name, "Multi-shift name");
        const expectedPrice = optionalInteger(payload.price, "Multi-shift price") ?? 0;
        const componentNames = Array.isArray(payload.componentShiftNames)
            ? payload.componentShiftNames.map(value => requiredString(value, "Component shift"))
            : [];
        if (componentNames.length === 0) throw new Error("Multi-shift component shifts are required");
        const existing = await tx.multiShift.findFirst({
            where: { branchId, name: { equals: multiShiftName, mode: "insensitive" } },
            select: {
                id: true,
                price: true,
                components: {
                    orderBy: { order: "asc" },
                    select: { shift: { select: { name: true } } },
                },
            },
        });
        if (existing) {
            const existingNames = existing.components.map(component => component.shift.name.toLocaleLowerCase("en-IN"));
            const expectedNames = componentNames.map(component => component.toLocaleLowerCase("en-IN"));
            if (
                existing.price !== expectedPrice
                || existingNames.length !== expectedNames.length
                || existingNames.some((component, index) => component !== expectedNames[index])
            ) {
                throw new Error("Import plan is stale because the reviewed multi-shift configuration changed");
            }
        }
        if (existing) return { entityIds: [existing.id], counts: { multiShifts: 0 } };
        const shiftIds: string[] = [];
        for (const componentName of componentNames) {
            const shift = await tx.shift.findFirst({
                where: {
                    branchId,
                    name: { equals: componentName, mode: "insensitive" },
                    status: "ACTIVE",
                },
                select: { id: true },
            });
            if (!shift) throw new Error("A multi-shift component is no longer available");
            shiftIds.push(shift.id);
        }
        const multiShift = await MultiShiftService.createMultiShiftInTransaction(userId, branchId, {
            name: multiShiftName,
            price: expectedPrice,
            shiftIds,
        }, tx);
        return { entityIds: [multiShift.id], counts: { multiShifts: 1 } };
    }

    throw new Error("Configuration type is not supported");
}

async function applyStudentItem(
    tx: Prisma.TransactionClient,
    userId: string,
    branchId: string,
    payload: Record<string, unknown>
): Promise<ImportRunItemResult> {
    const student = asRecord(payload.student);
    const feeLinkedShiftName = optionalString(student.feeLinkedShiftName);
    const feeLinkedMultiShiftName = optionalString(student.feeLinkedMultiShiftName);
    const reviewedMonthlyFee = optionalInteger(student.monthlyFee, "Monthly fee");
    if ((feeLinkedShiftName || feeLinkedMultiShiftName) && reviewedMonthlyFee === undefined) {
        throw new Error("Import plan is stale because the reviewed linked fee is missing");
    }
    const linkedShift = feeLinkedShiftName
        ? await tx.shift.findFirst({
            where: { branchId, name: { equals: feeLinkedShiftName, mode: "insensitive" }, status: "ACTIVE" },
            select: { id: true, branchId: true, price: true, status: true },
        })
        : null;
    const linkedMultiShift = feeLinkedMultiShiftName
        ? await tx.multiShift.findFirst({
            where: { branchId, name: { equals: feeLinkedMultiShiftName, mode: "insensitive" } },
            select: {
                id: true,
                branchId: true,
                price: true,
                components: {
                    select: { shift: { select: { branchId: true, status: true } } },
                },
            },
        })
        : null;
    if (
        feeLinkedShiftName
        && (
            !linkedShift
            || linkedShift.branchId !== branchId
            || linkedShift.status !== "ACTIVE"
        )
    ) {
        throw new Error("The linked shift is no longer available");
    }
    if (
        feeLinkedMultiShiftName
        && (
            !linkedMultiShift
            || linkedMultiShift.branchId !== branchId
            || linkedMultiShift.components.length === 0
            || linkedMultiShift.components.some(component =>
                component.shift.branchId !== branchId || component.shift.status !== "ACTIVE"
            )
        )
    ) {
        throw new Error("The linked multi-shift is no longer available");
    }
    if (linkedShift && linkedShift.price !== reviewedMonthlyFee) {
        throw new Error("Import plan is stale because the reviewed linked shift price changed");
    }
    if (linkedMultiShift && linkedMultiShift.price !== reviewedMonthlyFee) {
        throw new Error("Import plan is stale because the reviewed linked multi-shift price changed");
    }

    const created = await StudentService.createImportedStudentInTransaction(userId, branchId, {
        name: requiredString(student.name, "Student name"),
        phone: optionalString(student.phone) ?? null,
        monthlyFee: reviewedMonthlyFee,
        // Import plans currently model monthly cycles only. Preserve the
        // existing import contract by preventing an implicit branch-default
        // admission charge that was not present in the reviewed plan.
        admissionFee: 0,
        joinedAt: optionalDate(student.joinedAt, "Joined date"),
        billingStartAt: optionalDate(payload.billingStartAt, "Billing start date") ?? null,
        feeLinkedShiftId: linkedShift?.id,
        feeLinkedMultiShiftId: linkedMultiShift?.id,
    }, tx);
    return { entityIds: [created.id], counts: { students: 1 } };
}

async function applyAllocationItem(
    tx: Prisma.TransactionClient,
    item: ClaimedImportRunItem,
    userId: string,
    branchId: string,
    payload: Record<string, unknown>
): Promise<ImportRunItemResult> {
    const studentId = await resolvedStudentId(tx, item.importRunId, payload);
    const allocation = asRecord(payload.allocation);
    const seatLabel = requiredString(allocation.seatLabel, "Seat label");
    const seat = await tx.seat.findFirst({
        where: { branchId, label: { equals: seatLabel, mode: "insensitive" } },
        select: { id: true },
    });
    if (!seat) throw new Error("The selected seat is no longer available");

    const multiShiftName = optionalString(allocation.multiShiftName);
    let multiShiftId: string | undefined;
    let shiftIds: string[] = [];
    if (multiShiftName) {
        const reviewedComponentNames = Array.isArray(allocation.componentShiftNames)
            ? allocation.componentShiftNames.map(value => requiredString(value, "Multi-shift component"))
            : [];
        if (reviewedComponentNames.length === 0) {
            throw new Error("Import plan is stale because reviewed multi-shift components are missing");
        }
        const multiShift = await tx.multiShift.findFirst({
            where: { branchId, name: { equals: multiShiftName, mode: "insensitive" } },
            select: {
                id: true,
                branchId: true,
                components: {
                    orderBy: { order: "asc" },
                    select: {
                        shift: { select: { id: true, branchId: true, name: true, status: true } },
                    },
                },
            },
        });
        if (
            !multiShift
            || multiShift.branchId !== branchId
            || multiShift.components.length === 0
            || multiShift.components.some(component =>
                component.shift.branchId !== branchId || component.shift.status !== "ACTIVE"
            )
        ) {
            throw new Error("The selected multi-shift is no longer available");
        }
        const currentComponentNames = multiShift.components.map(component =>
            component.shift.name.toLocaleLowerCase("en-IN")
        );
        const expectedComponentNames = reviewedComponentNames.map(component =>
            component.toLocaleLowerCase("en-IN")
        );
        if (
            currentComponentNames.length !== expectedComponentNames.length
            || currentComponentNames.some((component, index) => component !== expectedComponentNames[index])
        ) {
            throw new Error("Import plan is stale because the reviewed multi-shift components changed");
        }
        multiShiftId = multiShift.id;
        shiftIds = multiShift.components.map(component => component.shift.id);
    } else {
        const shiftName = requiredString(allocation.shiftName, "Shift name");
        const shift = await tx.shift.findFirst({
            where: { branchId, name: { equals: shiftName, mode: "insensitive" }, status: "ACTIVE" },
            select: { id: true },
        });
        if (!shift) throw new Error("The selected shift is no longer available");
        shiftIds = [shift.id];
    }

    const allocations = await SeatAllocationService.assignSeatToShiftsInTransaction(
        userId,
        seat.id,
        studentId,
        shiftIds,
        multiShiftId,
        tx
    );
    return { entityIds: allocations.map(allocationRecord => allocationRecord.id), counts: { allocations: allocations.length } };
}

async function applyPaymentItem(
    tx: Prisma.TransactionClient,
    item: ClaimedImportRunItem,
    userId: string,
    branchId: string,
    payload: Record<string, unknown>
): Promise<ImportRunItemResult> {
    const studentId = await resolvedStudentId(tx, item.importRunId, payload);
    const cycle = asRecord(payload.cycle);
    const statusValue = requiredString(payload.status, "Payment status") as PaymentStatus;
    if (!PAYMENT_STATUSES.has(statusValue)) throw new Error("Payment status is not supported");
    const methodValue = optionalString(payload.method) as PaymentMethod | undefined;
    if (methodValue && !PAYMENT_METHODS.has(methodValue)) throw new Error("Payment method is not supported");
    const referenceId = optionalString(payload.referenceId);

    const payment = await PaymentService.ensureMonthlyPaymentForStudentInTransaction(userId, branchId, {
        studentId,
        periodStart: requiredDate(cycle.periodStart, "Payment period start"),
        periodEnd: requiredDate(cycle.periodEnd, "Payment period end"),
        dueDate: requiredDate(cycle.dueDate, "Payment due date"),
        amount: optionalInteger(payload.amount, "Payment amount"),
        strictExisting: {
            targetStatus: statusValue,
            paymentMethod: methodValue,
            referenceId,
        },
    }, tx);
    if (statusValue === "PAID") {
        await PaymentService.markPaymentAsPaidInTransaction(
            userId,
            payment.id,
            methodValue,
            referenceId,
            tx,
            { source: PaymentResolutionEventSource.IMPORT_EXECUTION }
        );
    } else if (statusValue === "WAIVED") {
        await PaymentService.markPaymentAsWaivedInTransaction(
            userId,
            payment.id,
            tx,
            { source: PaymentResolutionEventSource.IMPORT_EXECUTION }
        );
    }
    return {
        entityIds: [payment.id],
        counts: {
            payments: 1,
            [statusValue.toLowerCase()]: 1,
            [requiredString(payload.bucket, "Payment bucket").toLowerCase()]: 1,
        },
    };
}

export class ImportRunExecutor {
    /**
     * Applies one persisted item and its success marker in the same short
     * transaction. Workflow passes only ledger identifiers to this boundary.
     */
    static async executeClaimedItem(item: ClaimedImportRunItem) {
        return prisma.$transaction(async tx => {
            // Keep the same lock order as cancellation/failure/finalization:
            // run first, then item. This avoids a run/item lock inversion.
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRun" WHERE "id" = ${item.importRunId} FOR UPDATE
            `;
            await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "ImportRunItem" WHERE "id" = ${item.id} FOR UPDATE
            `;
            const stored = await tx.importRunItem.findFirst({
                where: { id: item.id, importRunId: item.importRunId },
                include: {
                    run: {
                        include: {
                            session: { select: { id: true, branchId: true, engineVersion: true, draftRevision: true, activeEvaluationRevision: true, archivedAt: true } },
                            plan: { select: { id: true, revision: true, canRun: true } },
                        },
                    },
                },
            });
            if (!stored) throw new Error("Import item not found");
            if (stored.status === "SUCCEEDED") return { alreadyCompleted: true };
            if (stored.status !== "RUNNING" || stored.leaseToken !== item.leaseToken) {
                throw new Error("Import item lease was lost");
            }
            const run = stored.run;
            const session = run.session;
            if (!session || session.branchId !== run.branchId || session.archivedAt) {
                throw new Error("Import session is no longer available");
            }
            if (
                session.engineVersion !== 2
                || session.draftRevision !== run.targetRevision
                || session.activeEvaluationRevision !== run.targetRevision
                || !run.plan
                || run.plan.revision !== run.targetRevision
                || !run.plan.canRun
            ) {
                throw new Error("Import plan is stale");
            }
            if (run.status === "CANCEL_REQUESTED" || run.status === "CANCELLED") {
                throw new Error("Import run was cancelled");
            }

            const payload = asRecord(stored.payload);
            const result = stored.kind === "CONFIG"
                ? await applyConfigurationItem(tx, run.requestedByUserId, run.branchId, payload)
                : stored.kind === "STUDENT"
                    ? await applyStudentItem(tx, run.requestedByUserId, run.branchId, payload)
                    : stored.kind === "ALLOCATION"
                        ? await applyAllocationItem(tx, item, run.requestedByUserId, run.branchId, payload)
                        : await applyPaymentItem(tx, item, run.requestedByUserId, run.branchId, payload);

            await ImportRunRunner.completeItemInTransaction(tx, {
                importRunId: run.id,
                itemId: stored.id,
                leaseToken: item.leaseToken,
                result,
            });
            return { alreadyCompleted: false };
        }, { isolationLevel: "Serializable" });
    }
}

export function classifyImportRunError(error: unknown) {
    const rawMessage = error instanceof Error ? error.message : "Import mutation failed";
    const code = error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    const retryable = ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"].includes(code)
        || /timeout|temporar|connection|deadlock|serialization/i.test(rawMessage);
    const authorization = /unauthori|permission|access denied|subscription|read.only|read-only/i.test(rawMessage);
    const stale = /stale|revision|no longer available|archived/i.test(rawMessage);
    return {
        code: authorization
            ? "IMPORT_AUTHORIZATION_REVOKED"
            : stale
                ? "IMPORT_PLAN_STALE"
                : retryable
                    ? "IMPORT_TRANSIENT_FAILURE"
                    : "IMPORT_DOMAIN_CONFLICT",
        message: authorization
            ? "Authorization or branch writability changed before this item could be applied."
            : stale
                ? "The reviewed import plan no longer matches current branch data."
                : retryable
                    ? "A temporary database failure interrupted this item."
                    : "This item conflicts with current domain data and was not applied.",
        retryable,
    };
}
