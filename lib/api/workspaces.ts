import { apiClient } from "@/lib/api/core";
import type { WorkspaceDirectory } from "@/types";

export const workspaces = {
    getDirectory: () => apiClient.get<unknown, WorkspaceDirectory>("/workspaces"),
};
