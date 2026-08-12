import { apiClient } from "./core";
import type { Payment } from "@/app/generated/prisma/browser";
import type { PagedResult } from "@/types/ui";

export type PaymentListItem = Payment & {
    student?: {
        id?: string;
        name?: string | null;
        phone?: string | null;
        joinedAt?: string | Date;
    } | null;
};

export type PaymentListParams = {
    status?: "DUE" | "PAID" | "WAIVED";
    month?: string;
    cursor?: string;
    limit?: number;
};

export type AuditLogEntry = {
    id: string;
    action: "PAYMENT_MARKED_PAID" | "PAYMENT_WAIVED";
    paymentId: string;
    details: {
        from: string;
        to: string;
        amount: number;
        method?: "CASH" | "UPI" | "BANK_TRANSFER" | null;
        referenceId?: string | null;
    };
    createdAt: string;
    user: { id: string; name: string | null; email: string };
};

export type PaymentGenerationSummary = {
    generatedCount: number;
    skippedCount: number;
    totalStudents: number;
    updatedBranchIds: string[];
};

export type OverduePaymentRecord = {
    paymentId: string;
    studentId: string;
    studentName: string;
    phone: string | null;
    dueDate: string;
    amount: number;
    daysOverdue: number;
};

export type OverdueListOptions = {
    cursor?: string | null;
    limit?: number;
    all?: boolean;
};

export const payments = {
    // List payments for a branch
    list: async (
        branchId: string,
        options: PaymentListParams = {}
    ): Promise<PagedResult<PaymentListItem>> => {
        const params = new URLSearchParams();
        if (options.status) params.set("status", options.status);
        if (options.month) params.set("month", options.month);
        if (options.cursor) params.set("cursor", options.cursor);
        if (options.limit) params.set("limit", String(options.limit));
        return apiClient.get(`/branches/${branchId}/payments?${params.toString()}`);
    },

    listAll: async (
        branchId: string,
        options: Omit<PaymentListParams, "cursor" | "limit"> = {}
    ): Promise<PaymentListItem[]> => {
        const items: PaymentListItem[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;

        do {
            const page = await payments.list(branchId, { ...options, cursor, limit: 100 });
            items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
            if (cursor && seenCursors.has(cursor)) {
                throw new Error("Payment pagination returned a repeated cursor");
            }
            if (cursor) seenCursors.add(cursor);
        } while (cursor);

        return items;
    },

    listOverdue: async (
        branchId: string,
        options: OverdueListOptions = {}
    ): Promise<PagedResult<OverduePaymentRecord>> => {
        const params = new URLSearchParams();
        if (options.all) {
            params.set("all", "true");
        } else {
            if (options.cursor) params.set("cursor", options.cursor);
            if (options.limit != null) params.set("limit", String(options.limit));
        }
        const query = params.size > 0 ? `?${params.toString()}` : "";
        return apiClient.get(`/branches/${branchId}/payments/overdue${query}`);
    },

    // Generate payments (if logic exists in frontend to trigger this)
    generate: async (branchId: string): Promise<PaymentGenerationSummary> => {
        return apiClient.post(`/branches/${branchId}/payments/generate`, {});
    },

    // Mark payment as paid — method and referenceId are optional but recommended
    markAsPaid: async (
        paymentId: string,
        method?: "CASH" | "UPI" | "BANK_TRANSFER",
        referenceId?: string,
    ): Promise<Payment> => {
        return apiClient.patch(`/payments/${paymentId}/pay`, { method, referenceId });
    },

    // Mark payment as waived
    markAsWaived: async (paymentId: string): Promise<Payment> => {
        return apiClient.patch(`/payments/${paymentId}/waive`, {});
    },

    // Fetch audit log for a specific payment
    getAuditLog: async (paymentId: string): Promise<AuditLogEntry[]> => {
        return apiClient.get(`/payments/${paymentId}/audit-log`);
    },
};
