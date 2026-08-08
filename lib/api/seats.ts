import { apiClient } from "./core";
import type { SeatAllocation } from "@/app/generated/prisma/browser";
import type { PagedResult } from "@/types/ui";

export const seats = {
    // Re-export branch-level seat calls via convenience methods if needed, 
    // or keep them strictly in branches.ts. 
    // Here we focus on allocations which might be under `seat-allocations` or `branches/:id/seat-allocations`

    listAllocations: async <T = SeatAllocation>(
        branchId: string,
        params?: {
            studentId?: string;
            shiftId?: string;
            activeOnly?: boolean;
            status?: "ACTIVE" | "ENDED";
            cursor?: string;
            limit?: number;
            all?: boolean;
        }
    ): Promise<PagedResult<T>> => {
        const query = new URLSearchParams();
        if (params?.studentId) query.append("studentId", params.studentId);
        if (params?.shiftId) query.append("shiftId", params.shiftId);
        if (params?.activeOnly) query.append("activeOnly", "true");
        if (params?.status) query.append("status", params.status);
        if (params?.cursor) query.append("cursor", params.cursor);
        if (params?.limit) query.append("limit", String(params.limit));
        if (params?.all) query.append("all", "true");

        return apiClient.get(`/branches/${branchId}/seat-allocations?${query.toString()}`);
    },

    listAllAllocations: async <T = SeatAllocation>(
        branchId: string,
        params?: { studentId?: string; shiftId?: string; activeOnly?: boolean; status?: "ACTIVE" | "ENDED" }
    ): Promise<T[]> => {
        const page = await seats.listAllocations<T>(branchId, { ...params, all: true });
        return page.items;
    },

    allocate: async (branchId: string, data: { seatId: string; studentId: string; shiftId: string }): Promise<SeatAllocation> => {
        return apiClient.post(`/branches/${branchId}/seat-allocations`, data);
    }
};
