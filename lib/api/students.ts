import { apiClient } from "./core";
import type { Student } from "@/app/generated/prisma/browser";
import { CreateStudentDto, StudentStatus } from "@/types";
import type { PagedResult } from "@/types/ui";

export type StudentSeatAllocation = {
    id: string;
    seatId: string;
    shiftId: string;
    multiShiftId: string | null;
    endDate: string | null;
    seat: { id: string; label: string };
    shift: { id: string; name: string; startTime: string | null; endTime: string | null };
    multiShift: { id: string; name: string } | null;
};

export type StudentListItem = Student & {
    seatAllocations?: StudentSeatAllocation[];
};

export type StudentListParams = {
    status?: StudentStatus;
    shiftId?: string;
    multiShiftId?: string;
    query?: string;
    cursor?: string;
    limit?: number;
};

export const students = {
    // List students for a branch
    list: async (
        branchId: string,
        params: StudentListParams = {}
    ): Promise<PagedResult<StudentListItem>> => {
        return apiClient.get(`/branches/${branchId}/students`, {
            params: {
                status: params.status,
                shiftId: params.shiftId,
                multiShiftId: params.multiShiftId,
                q: params.query,
                cursor: params.cursor,
                limit: params.limit,
                _t: new Date().getTime() // Prevent caching
            }
        });
    },

    listAll: async (
        branchId: string,
        params: Omit<StudentListParams, "cursor" | "limit"> = {}
    ): Promise<StudentListItem[]> => {
        const items: StudentListItem[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;

        do {
            const page = await students.list(branchId, { ...params, cursor, limit: 100 });
            items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
            if (cursor && seenCursors.has(cursor)) {
                throw new Error("Student pagination returned a repeated cursor");
            }
            if (cursor) seenCursors.add(cursor);
        } while (cursor);

        return items;
    },

    // Create a new student in a branch
    create: async (branchId: string, data: CreateStudentDto): Promise<Student> => {
        return apiClient.post(`/branches/${branchId}/students`, data);
    },

    // Get a single student (if endpoint exists, otherwise we might rely on list)
    // Looking at routes, we have `students/[studentId]/status/route.ts` but maybe not get by ID yet.

    // Update student status
    updateStatus: async (studentId: string, status: StudentStatus): Promise<Student> => {
        return apiClient.patch(`/students/${studentId}/status`, { status });
    }
};
