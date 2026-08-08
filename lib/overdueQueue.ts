export type OverdueQueuePayment = {
    paymentId: string;
    studentId: string;
    dueDate: string;
};

function paymentMonth(dueDate: string) {
    const parsed = new Date(dueDate);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 7);
}

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
        month: paymentMonth(payment.dueDate),
        status: "DUE",
    });
}

export function getOverdueStudentHref(branchId: string, studentId: string) {
    const search = new URLSearchParams({ studentId });
    return `/branch/${encodeURIComponent(branchId)}/students?${search.toString()}`;
}

export function getOverdueBulkReviewHref(branchId: string, payments: OverdueQueuePayment[]) {
    if (payments.length === 1) return getOverduePaymentHref(branchId, payments[0]);

    const months = new Set(payments.map(payment => paymentMonth(payment.dueDate)).filter(Boolean));
    return paymentsPath(branchId, {
        month: months.size === 1 ? [...months][0] ?? null : null,
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
