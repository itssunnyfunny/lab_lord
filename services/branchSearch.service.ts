import { prisma } from "@/lib/prisma";
import {
    getBranchCapabilityDecision,
    type BranchCapabilityKey,
} from "@/lib/branchCapabilities";
import {
    buildTopSearchResults,
    type TopSearchGroup,
    type TopSearchGroupId,
} from "@/lib/topSearch";
import { StaffService } from "@/services/staff.service";
import { BillingExperienceService } from "@/services/billingExperience.service";

export const BRANCH_SEARCH_TYPES = [
    "actions",
    "students",
    "payments",
    "seats",
    "shifts",
    "staff",
] as const satisfies readonly TopSearchGroupId[];

export type BranchSearchType = typeof BRANCH_SEARCH_TYPES[number];

const ACTION_CAPABILITIES: Record<string, BranchCapabilityKey> = {
    "action:add-student": "studentsManage",
    "action:assign-seat": "allocationsManage",
    "action:seats-map": "seatsView",
    "action:payments": "paymentsView",
    "action:generate-payments": "paymentsGenerate",
    "action:staff": "staffView",
    "action:analytics": "analyticsView",
    "action:ai-reports": "aiUse",
    "action:ai-messages": "aiUse",
};

function normalizeQuery(value: string) {
    return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

export class BranchSearchService {
    static async search(
        userId: string,
        branchId: string,
        query: string,
        options: { types?: BranchSearchType[]; limitPerGroup?: number } = {}
    ): Promise<TopSearchGroup[]> {
        const [baseAccess, billingExperience] = await Promise.all([
            StaffService.getBranchAccess(userId, branchId),
            BillingExperienceService.getForBranch(branchId, userId),
        ]);
        const access = { ...baseAccess, billingExperience };
        const normalizedQuery = normalizeQuery(query);
        const types = new Set(options.types?.length ? options.types : BRANCH_SEARCH_TYPES);
        const limitPerGroup = Math.max(1, Math.min(options.limitPerGroup ?? 5, 10));
        const take = limitPerGroup * 3;

        const shouldSearchRecords = normalizedQuery.length >= 2;
        const upperQuery = normalizedQuery.toUpperCase();
        const numericQuery = /^\d+$/.test(normalizedQuery) ? Number(normalizedQuery) : null;
        const paymentStatus = ["DUE", "PAID", "WAIVED"].includes(upperQuery)
            ? upperQuery as "DUE" | "PAID" | "WAIVED"
            : null;
        const studentStatus = ["ACTIVE", "INACTIVE"].includes(upperQuery)
            ? upperQuery as "ACTIVE" | "INACTIVE"
            : null;
        const searchable = {
            students: getBranchCapabilityDecision(access, "studentsView").allowed,
            payments: getBranchCapabilityDecision(access, "paymentsView").allowed,
            seats: getBranchCapabilityDecision(access, "seatsView").allowed,
            shifts: getBranchCapabilityDecision(access, "shiftsView").allowed,
            staff: getBranchCapabilityDecision(access, "staffView").allowed,
        };

        const [students, payments, seats, shifts, staff] = await Promise.all([
            shouldSearchRecords && types.has("students") && searchable.students
                ? prisma.student.findMany({
                    where: {
                        branchId,
                        OR: [
                            { name: { contains: normalizedQuery, mode: "insensitive" } },
                            { phone: { contains: normalizedQuery, mode: "insensitive" } },
                            ...(studentStatus ? [{ status: studentStatus }] : []),
                        ],
                    },
                    select: { id: true, name: true, phone: true, status: true },
                    orderBy: { name: "asc" },
                    take,
                })
                : Promise.resolve([]),
            shouldSearchRecords && types.has("payments") && searchable.payments
                ? prisma.payment.findMany({
                    where: {
                        branchId,
                        OR: [
                            { student: { name: { contains: normalizedQuery, mode: "insensitive" } } },
                            { student: { phone: { contains: normalizedQuery, mode: "insensitive" } } },
                            ...(paymentStatus ? [{ status: paymentStatus }] : []),
                            ...(numericQuery != null ? [{ amount: numericQuery }] : []),
                        ],
                    },
                    select: {
                        id: true,
                        studentId: true,
                        amount: true,
                        status: true,
                        type: true,
                        dueDate: true,
                        student: { select: { name: true, phone: true } },
                    },
                    orderBy: { dueDate: "desc" },
                    take,
                })
                : Promise.resolve([]),
            shouldSearchRecords && types.has("seats") && searchable.seats
                ? prisma.seat.findMany({
                    where: {
                        branchId,
                        OR: [
                            { label: { contains: normalizedQuery, mode: "insensitive" } },
                            {
                                seatAllocations: {
                                    some: {
                                        endDate: null,
                                        student: { name: { contains: normalizedQuery, mode: "insensitive" } },
                                    },
                                },
                            },
                        ],
                    },
                    select: {
                        id: true,
                        label: true,
                        seatAllocations: {
                            where: { endDate: null },
                            select: { student: { select: { name: true } } },
                            take: 1,
                        },
                    },
                    orderBy: { label: "asc" },
                    take,
                })
                : Promise.resolve([]),
            shouldSearchRecords && types.has("shifts") && searchable.shifts
                ? prisma.shift.findMany({
                    where: {
                        branchId,
                        deletedAt: null,
                        OR: [
                            { name: { contains: normalizedQuery, mode: "insensitive" } },
                            { startTime: { contains: normalizedQuery, mode: "insensitive" } },
                            { endTime: { contains: normalizedQuery, mode: "insensitive" } },
                        ],
                    },
                    select: { id: true, name: true, startTime: true, endTime: true, price: true },
                    orderBy: { name: "asc" },
                    take,
                })
                : Promise.resolve([]),
            shouldSearchRecords && types.has("staff") && searchable.staff
                ? prisma.staff.findMany({
                    where: {
                        branchId,
                        OR: [
                            { user: { name: { contains: normalizedQuery, mode: "insensitive" } } },
                            { user: { email: { contains: normalizedQuery, mode: "insensitive" } } },
                        ],
                    },
                    select: {
                        id: true,
                        role: true,
                        user: { select: { name: true, email: true } },
                    },
                    orderBy: { createdAt: "desc" },
                    take,
                })
                : Promise.resolve([]),
        ]);

        const groups = buildTopSearchResults({
            branchId,
            query: normalizedQuery,
            access,
            students,
            payments,
            seats,
            shifts,
            staff,
            limitPerGroup,
        }).filter(group => types.has(group.id));

        return groups.flatMap(group => {
            if (group.id !== "actions") return [group];
            const results = group.results.filter(result => {
                const capability = ACTION_CAPABILITIES[result.id];
                return capability
                    ? getBranchCapabilityDecision(access, capability).allowed
                    : false;
            });
            return results.length > 0 ? [{ ...group, results }] : [];
        });
    }
}
