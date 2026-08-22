import { Prisma } from "@/app/generated/prisma/client";
import type { ImportRunKind, ImportRunStatus, ImportSessionStatus } from "@/app/generated/prisma/enums";
import { importStagingPurgeAfter } from "../utils/import-retention";

type ImportRunLifecycleState = {
    id: string;
    branchId: string;
    importSessionId: string | null;
    kind: ImportRunKind;
    status: ImportRunStatus;
};

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function resultEntityIds(value: Prisma.JsonValue | null) {
    const ids = asRecord(value).entityIds;
    return Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
}

function stringIds(value: unknown) {
    return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
}

async function projectCommitResultOntoRows(
    tx: Prisma.TransactionClient,
    run: ImportRunLifecycleState
) {
    const items = await tx.importRunItem.findMany({
        where: { importRunId: run.id, importRowId: { not: null } },
        orderBy: { ordinal: "asc" },
        select: {
            importRowId: true,
            kind: true,
            status: true,
            result: true,
        },
    });
    const itemsByRow = new Map<string, typeof items>();
    for (const item of items) {
        if (!item.importRowId) continue;
        const rowItems = itemsByRow.get(item.importRowId) ?? [];
        rowItems.push(item);
        itemsByRow.set(item.importRowId, rowItems);
    }
    if (itemsByRow.size === 0) return;

    const rows = await tx.importRow.findMany({
        where: {
            id: { in: [...itemsByRow.keys()] },
            importSessionId: run.importSessionId!,
        },
        select: { id: true, createdEntityIds: true },
    });
    const updates = rows.flatMap(row => {
        const rowItems = itemsByRow.get(row.id) ?? [];
        if (rowItems.length === 0) return [];
        const status = rowItems.some(item => item.status === "FAILED")
            ? "FAILED" as const
            : rowItems.every(item => item.status === "SUCCEEDED")
                ? "IMPORTED" as const
                : null;

        const createdEntityIds = { ...asRecord(row.createdEntityIds) };
        const studentIds = rowItems
            .filter(item => item.kind === "STUDENT" && item.status === "SUCCEEDED")
            .flatMap(item => resultEntityIds(item.result));
        const allocationIds = rowItems
            .filter(item => item.kind === "ALLOCATION" && item.status === "SUCCEEDED")
            .flatMap(item => resultEntityIds(item.result));
        const paymentIds = rowItems
            .filter(item => item.kind === "PAYMENT_CYCLE" && item.status === "SUCCEEDED")
            .flatMap(item => resultEntityIds(item.result));
        if (studentIds[0]) createdEntityIds.studentId = studentIds[0];
        if (allocationIds.length > 0) {
            createdEntityIds.allocationIds = [
                ...new Set([...stringIds(createdEntityIds.allocationIds), ...allocationIds]),
            ];
        }
        if (paymentIds.length > 0) {
            createdEntityIds.paymentIds = [
                ...new Set([...stringIds(createdEntityIds.paymentIds), ...paymentIds]),
            ];
        }

        if (!status && Object.keys(createdEntityIds).length === 0) return [];
        return [{
            id: row.id,
            status,
            createdEntityIds,
        }];
    });

    const chunkSize = 100;
    for (let index = 0; index < updates.length; index += chunkSize) {
        await Promise.all(updates.slice(index, index + chunkSize).map(update =>
            tx.importRow.update({
                where: { id: update.id },
                data: {
                    ...(update.status ? { status: update.status } : {}),
                    createdEntityIds: update.createdEntityIds as Prisma.InputJsonValue,
                },
            })
        ));
    }
}

function terminalSessionStatus(run: ImportRunLifecycleState): ImportSessionStatus | null {
    if (run.status === "CANCELLED") return "CANCELLED";
    if (run.status === "PERMANENT_FAILURE") return "FAILED";
    if (run.kind !== "COMMIT") return null;
    if (run.status === "COMPLETED") return "COMMITTED";
    if (run.status === "COMPLETED_WITH_ISSUES") return "PARTIAL";
    return null;
}

/**
 * Keeps staging lifecycle state tied to the PostgreSQL run ledger instead of
 * to a particular scheduler. Retained run history survives the later purge.
 */
export async function syncImportSessionRunLifecycle(
    tx: Prisma.TransactionClient,
    run: ImportRunLifecycleState,
    now: Date
) {
    if (!run.importSessionId) return;
    const status = terminalSessionStatus(run);
    if (!status) return;

    await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ImportSession"
        WHERE "id" = ${run.importSessionId} AND "branchId" = ${run.branchId}
        FOR UPDATE
    `;
    const session = await tx.importSession.findFirst({
        where: {
            id: run.importSessionId,
            branchId: run.branchId,
            engineVersion: 2,
            archivedAt: null,
        },
        select: { status: true },
    });
    if (!session) return;

    if (run.kind === "COMMIT") {
        await projectCommitResultOntoRows(tx, run);
    }

    if (session.status === status) return;

    await tx.importSession.updateMany({
        where: {
            id: run.importSessionId,
            branchId: run.branchId,
            engineVersion: 2,
            archivedAt: null,
        },
        data: {
            status,
            purgeAfter: importStagingPurgeAfter(now),
        },
    });
}
