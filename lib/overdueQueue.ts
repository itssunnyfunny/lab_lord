export type OverdueQueuePayment = {
    paymentId: string;
    studentId: string;
    dueDate: string;
};

function paymentsPath(branchId: string, parameters: Record<string, string | null>) {
    const search = new URLSearchParams();
    Object.entries(parameters).forEach(([key, value]) => {
        if (value) search.set(key, value);
    });
    return `/branch/${encodeURIComponent(branchId)}/payments?${search.toString()}`;
}

export function getOverduePaymentHref(branchId: string, payment: OverdueQueuePayment) {
    return paymentsPath(branchId, {
        paymentId: payment.paymentId,
        studentId: payment.studentId,
        status: "DUE",
    });
}

export function getOverdueStudentHref(branchId: string, studentId: string) {
    const search = new URLSearchParams({ studentId });
    return `/branch/${encodeURIComponent(branchId)}/students?${search.toString()}`;
}

export function getOverdueBulkReviewHref(branchId: string, payments: OverdueQueuePayment[]) {
    if (payments.length === 1) return getOverduePaymentHref(branchId, payments[0]);

    return paymentsPath(branchId, {
        status: "DUE",
    });
}

export function updateQueueSelection(
    selected: ReadonlySet<string>,
    paymentIds: readonly string[],
    checked: boolean
) {
    const next = new Set(selected);
    paymentIds.forEach(paymentId => {
        if (checked) next.add(paymentId);
        else next.delete(paymentId);
    });
    return next;
}
