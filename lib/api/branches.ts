import { apiClient } from "./core";
import type { Student, Seat, Payment, Staff, Shift, Branch } from "@/app/generated/prisma/browser";
import type { SeatNumberingConfig } from "@/lib/seatNumbering";
import type { BranchAccess } from "@/types";
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

    getStudents: async (branchId: string, shiftId?: string): Promise<Student[]> => {
        const query = shiftId ? `?shiftId=${shiftId}` : "";
        return apiClient.get(`/branches/${branchId}/students${query}`);
    },

    createStudent: async (branchId: string, data: { name: string; phone: string }): Promise<Student> => {
        return apiClient.post(`/branches/${branchId}/students`, data);
    },

    getSeats: async (branchId: string, shiftId?: string): Promise<Seat[]> => {
        const query = shiftId ? `?shiftId=${shiftId}` : "";
        return apiClient.get(`/branches/${branchId}/seats${query}`);
    },

    createSeat: async (branchId: string, label: string): Promise<Seat> => {
        return apiClient.post(`/branches/${branchId}/seats`, { label });
    },

    generateSeats: async (branchId: string, seatNumbering: SeatNumberingConfig): Promise<{ created: number; seats: Seat[] }> => {
        return apiClient.post(`/branches/${branchId}/seats/generate`, { seatNumbering });
    },

    getPayments: async (branchId: string, status?: string): Promise<Payment[]> => {
        const params = new URLSearchParams();
        if (status) params.append("status", status);
        return apiClient.get(`/branches/${branchId}/payments?${params.toString()}`);
    },

    getStaff: async (branchId: string): Promise<Staff[]> => {
        return apiClient.get(`/branches/${branchId}/staff`);
    },

    addStaff: async (branchId: string, data: { email: string; role: string }): Promise<Staff> => {
        return apiClient.post(`/branches/${branchId}/staff`, data);
    },

    getShifts: async (branchId: string): Promise<Shift[]> => {
        return apiClient.get(`/branches/${branchId}/shifts`);
    },

    createShift: async (branchId: string, data: { name: string; startTime?: string; endTime?: string }): Promise<Shift> => {
        return apiClient.post(`/branches/${branchId}/shifts`, data);
    }
};
