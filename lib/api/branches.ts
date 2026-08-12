import { apiClient } from "./core";
import type { Student, Seat, Payment, Staff, Shift, Branch } from "@/app/generated/prisma/browser";
import type { SeatNumberingConfig } from "@/lib/seatNumbering";
import type { BranchAccess, MultiShiftSeatMap, MultiShiftSummary } from "@/types";
import type { PagedResult } from "@/types/ui";
import type { BillingCheckoutPayload } from "@/lib/api/billing";

export type BranchBillingAction = "NONE" | "PROCESSING" | "CHECKOUT_REQUIRED";

export type BranchBillingMutationResponse = {
    action?: BranchBillingAction;
    billingChangeId?: string;
    processingUrl?: string | null;
    checkout?: BillingCheckoutPayload | null;
};

export type BranchCreationResponse = Branch & BranchBillingMutationResponse;

const BRANCH_BILLING_ACTIONS = new Set<BranchBillingAction>([
    "NONE",
    "PROCESSING",
    "CHECKOUT_REQUIRED",
]);

/** Normalizes the additive action field while older API responses are still deployable. */
export function resolveBranchBillingAction(
    response: BranchBillingMutationResponse
): BranchBillingAction {
    if (response.action && BRANCH_BILLING_ACTIONS.has(response.action)) return response.action;
    if (response.checkout) return "CHECKOUT_REQUIRED";
    if (response.processingUrl) return "PROCESSING";
    return "NONE";
}

export const branches = {
    getDetails: async (branchId: string): Promise<Branch> => {
        return apiClient.get(`/branches/${branchId}`);
    },

    getAccess: async (branchId: string): Promise<BranchAccess> => {
        return apiClient.get(`/branches/${branchId}/access`);
    },

    retryPendingActivation: (branchId: string): Promise<BranchBillingMutationResponse> =>
        apiClient.post(`/branches/${branchId}/billing/pending`),

    discardPendingActivation: (branchId: string) => apiClient.delete(`/branches/${branchId}/billing/pending`),

    reactivate: (branchId: string): Promise<BranchBillingMutationResponse> => apiClient.post(`/branches/${branchId}/billing/reactivate`, null, {
        headers: { "Idempotency-Key": crypto.randomUUID() },
    }),

    getStudents: async (branchId: string, shiftId?: string, multiShiftId?: string): Promise<Student[]> => {
        const query = new URLSearchParams({ all: "true" });
        if (shiftId) query.set("shiftId", shiftId);
        if (multiShiftId) query.set("multiShiftId", multiShiftId);
        const page = await apiClient.get(`/branches/${branchId}/students?${query.toString()}`) as unknown as PagedResult<Student>;
        return page.items;
    },

    createStudent: async (branchId: string, data: { name: string; phone: string }): Promise<Student> => {
        return apiClient.post(`/branches/${branchId}/students`, data);
    },

    getSeats: async (
        branchId: string,
        params?: string | { shiftId?: string; cursor?: string; limit?: number; all?: boolean }
    ): Promise<PagedResult<Seat>> => {
        const resolved = typeof params === "string" ? { shiftId: params } : params;
        const query = new URLSearchParams();
        if (resolved?.shiftId) query.set("shiftId", resolved.shiftId);
        if (resolved?.cursor) query.set("cursor", resolved.cursor);
        if (resolved?.limit) query.set("limit", String(resolved.limit));
        if (resolved?.all) query.set("all", "true");
        const suffix = query.toString();
        return apiClient.get(`/branches/${branchId}/seats${suffix ? `?${suffix}` : ""}`);
    },

    createSeat: async (branchId: string, label: string): Promise<Seat> => {
        return apiClient.post(`/branches/${branchId}/seats`, { label });
    },

    generateSeats: async (branchId: string, seatNumbering: SeatNumberingConfig): Promise<{ created: number; seats: Seat[] }> => {
        return apiClient.post(`/branches/${branchId}/seats/generate`, { seatNumbering });
    },

    getPayments: async (branchId: string, status?: string, month?: string): Promise<Payment[]> => {
        const params = new URLSearchParams();
        if (status) params.append("status", status);
        if (month) params.append("month", month);
        params.set("all", "true");
        const page = await apiClient.get(`/branches/${branchId}/payments?${params.toString()}`) as unknown as PagedResult<Payment>;
        return page.items;
    },

    getStaff: async (branchId: string): Promise<PagedResult<Staff>> => {
        return apiClient.get(`/branches/${branchId}/staff`);
    },

    addStaff: async (branchId: string, data: { email: string; role: string }): Promise<Staff> => {
        return apiClient.post(`/branches/${branchId}/staff`, data);
    },

    getShifts: async (branchId: string): Promise<Shift[]> => {
        return apiClient.get(`/branches/${branchId}/shifts`);
    },

    getMultiShifts: async (branchId: string): Promise<MultiShiftSummary[]> => {
        return apiClient.get(`/branches/${branchId}/multi-shifts`);
    },

    getMultiShiftSeatMap: async (branchId: string, multiShiftId: string): Promise<MultiShiftSeatMap> => {
        return apiClient.get(`/branches/${branchId}/multi-shifts/${multiShiftId}/seat-map`);
    },

    createShift: async (branchId: string, data: { name: string; startTime?: string; endTime?: string }): Promise<Shift> => {
        return apiClient.post(`/branches/${branchId}/shifts`, data);
    }
};
