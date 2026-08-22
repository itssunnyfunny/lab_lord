import type { Prisma } from "@/app/generated/prisma/client";
import {
    PaymentMethod,
    PaymentResolutionEventSource,
    PaymentStatus,
    PaymentType,
} from "@/types";

export type PaymentResolutionSnapshot = {
    id: string;
    branchId: string;
    status: PaymentStatus;
    amount: number;
    type: PaymentType;
    periodStart: Date;
    dueDate: Date;
    paidAt: Date | null;
    paymentMethod: PaymentMethod | null;
    referenceId: string | null;
};

export type PaymentResolutionContext = {
    source: PaymentResolutionEventSource;
    details?: Prisma.InputJsonValue;
};

type RecordPaymentResolutionEventInput = PaymentResolutionContext & {
    before: PaymentResolutionSnapshot;
    after: PaymentResolutionSnapshot;
    actorUserId?: string | null;
    occurredAt: Date;
};

const SUPPORTED_TRANSITIONS = new Set([
    `${PaymentStatus.DUE}:${PaymentStatus.PAID}`,
    `${PaymentStatus.DUE}:${PaymentStatus.WAIVED}`,
    `${PaymentStatus.PAID}:${PaymentStatus.WAIVED}`,
    `${PaymentStatus.WAIVED}:${PaymentStatus.PAID}`,
]);

function eventData({
    before,
    after,
    actorUserId,
    source,
    details,
    occurredAt,
}: RecordPaymentResolutionEventInput): Prisma.PaymentResolutionEventCreateManyInput {
    if (before.id !== after.id) {
        throw new Error("Payment resolution snapshots must refer to the same payment");
    }
    if (before.branchId !== after.branchId) {
        throw new Error("Payment resolution cannot change branch ownership");
    }
    if (before.status === after.status) {
        throw new Error("Payment resolution requires a real status transition");
    }

    const transition = `${before.status}:${after.status}`;
    if (!SUPPORTED_TRANSITIONS.has(transition)) {
        throw new Error(`Unsupported payment resolution transition: ${transition}`);
    }

    return {
        paymentId: after.id,
        branchId: after.branchId,
        actorUserId: actorUserId ?? null,
        source,
        fromStatus: before.status,
        toStatus: after.status,
        amount: after.amount,
        paymentType: after.type,
        periodStart: after.periodStart,
        dueDate: after.dueDate,
        paidAt: after.paidAt,
        paymentMethod: after.paymentMethod,
        referenceId: after.referenceId,
        ...(details === undefined ? {} : { details }),
        occurredAt,
    };
}

export async function recordPaymentResolutionEvent(
    tx: Prisma.TransactionClient,
    input: RecordPaymentResolutionEventInput
) {
    return tx.paymentResolutionEvent.create({
        data: eventData(input),
    });
}

export async function recordPaymentResolutionEvents(
    tx: Prisma.TransactionClient,
    inputs: RecordPaymentResolutionEventInput[]
) {
    if (inputs.length === 0) {
        return { count: 0 };
    }

    return tx.paymentResolutionEvent.createMany({
        data: inputs.map(eventData),
    });
}
