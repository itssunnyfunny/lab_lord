import { apiClient } from "./core";
import type { Staff, StaffPermissionOverride, StaffRole } from "@/app/generated/prisma/browser";
import type { PagedResult, StaffPermissionUpdate } from "@/types";

export type StaffWithUser = Staff & {
    user: { id: string; name: string | null; email: string };
    permissionOverrides?: StaffPermissionOverride[];
};

export type StaffInviteResponse = {
    id: string;
    role: StaffRole;
    token: string;
    expiresAt: string;
    createdAt: string;
    inviteUrl: string;
};

export type StaffListOptions = {
    cursor?: string | null;
    limit?: number;
};

export const staff = {
    list: async (
        branchId: string,
        options: StaffListOptions = {}
    ): Promise<PagedResult<StaffWithUser>> => {
        const params = new URLSearchParams();
        if (options.cursor) params.set("cursor", options.cursor);
        if (options.limit != null) params.set("limit", String(options.limit));
        const query = params.size > 0 ? `?${params.toString()}` : "";
        return apiClient.get(`/branches/${branchId}/staff${query}`);
    },

    add: async (branchId: string, data: { email: string; role: StaffRole }): Promise<StaffWithUser> => {
        return apiClient.post(`/branches/${branchId}/staff`, data);
    },

    update: async (
        branchId: string,
        staffId: string,
        data: { role?: StaffRole; permissions?: StaffPermissionUpdate }
    ): Promise<StaffWithUser> => {
        return apiClient.patch(`/branches/${branchId}/staff/${staffId}`, data);
    },

    createInvite: async (
        branchId: string,
        data: { role: StaffRole; email: string; ttlDays?: number }
    ): Promise<StaffInviteResponse> => {
        return apiClient.post(`/branches/${branchId}/staff-invites`, data);
    },

    listInvites: async (branchId: string): Promise<StaffInviteResponse[]> => {
        return apiClient.get(`/branches/${branchId}/staff-invites`);
    },

    revokeInvite: async (branchId: string, inviteId: string): Promise<{ success: boolean }> => {
        return apiClient.delete(`/branches/${branchId}/staff-invites/${inviteId}`);
    },
};
