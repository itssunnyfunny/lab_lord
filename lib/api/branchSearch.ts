import { apiClient } from "@/lib/api/core";
import type { TopSearchGroup } from "@/lib/topSearch";

export const branchSearch = {
    search(branchId: string, query: string, limit = 5) {
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        return apiClient.get<unknown, TopSearchGroup[]>(
            `/branches/${branchId}/search?${params.toString()}`
        );
    },
};
