import type { BranchSnapshot } from "@/lib/api/analytics";
import { analytics } from "@/lib/api/analytics";
import { branches } from "@/lib/api/branches";
import type { BranchAccess } from "@/types";

export type DashboardResourceStatus = "success" | "restricted" | "error";

export type DashboardResourceStatuses = {
    analytics: DashboardResourceStatus;
    students: DashboardResourceStatus;
    allocations: DashboardResourceStatus;
    payments: DashboardResourceStatus;
    overdue: DashboardResourceStatus;
};

export interface DashboardStudent {
    id: string;
    name: string;
    status: string;
    joinedAt?: Date | string | null;
    createdAt?: Date | string;
}

export interface DashboardPayment {
    id: string;
    status: "DUE" | "PAID" | string;
    dueDate: string | Date;
    amount: number;
    paidAt?: string | Date | null;
    updatedAt?: string | Date | null;
    student?: {
        id?: string;
        name?: string | null;
        phone?: string | null;
    } | null;
}

export interface DashboardAllocation {
    seat?: { label?: string | null } | null;
    student?: { name?: string | null } | null;
    startDate?: string | Date | null;
}

export interface DashboardOverduePayment {
    paymentId: string;
    studentId: string;
    studentName: string;
    phone: string | null;
    dueDate: string;
    amount: number;
}

export interface BranchDashboardSources {
    snapshot: BranchSnapshot | null;
    students: DashboardStudent[];
    allocations: DashboardAllocation[];
    monthPayments: DashboardPayment[];
    overduePayments: DashboardOverduePayment[];
    resources: DashboardResourceStatuses;
    updatedAt: string;
}

type DashboardPermissions = Pick<
    BranchAccess["permissions"],
    "analytics" | "students" | "seat_allocation" | "view_payments"
>;

async function fetchDashboardJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Dashboard request failed with status ${response.status}`);
    }
    return response.json() as Promise<T>;
}

function dashboardItems<T>(value: unknown, legacyKey?: string): T[] {
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.items)) return record.items as T[];
        if (legacyKey && Array.isArray(record[legacyKey])) {
            return record[legacyKey] as T[];
        }
    }
    throw new Error("Dashboard response did not contain a list");
}

async function fetchDashboardItems<T>(url: string, legacyKey?: string): Promise<T[]> {
    return dashboardItems<T>(await fetchDashboardJson<unknown>(url), legacyKey);
}

function resourceStatus(
    allowed: boolean,
    result: PromiseSettledResult<unknown>
): DashboardResourceStatus {
    if (!allowed) return "restricted";
    return result.status === "fulfilled" ? "success" : "error";
}

function fulfilledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
    return result.status === "fulfilled" ? result.value : fallback;
}

function formatMonth(date: Date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${date.getFullYear()}-${month}`;
}

export async function loadBranchDashboardSources(
    branchId: string,
    permissions: DashboardPermissions,
    now = new Date()
): Promise<BranchDashboardSources> {
    const month = formatMonth(now);
    const [snapshotResult, studentsResult, allocationsResult, paymentsResult, overdueResult] =
        await Promise.allSettled([
            permissions.analytics
                ? analytics.getSnapshot(branchId, { period: "month" })
                : Promise.resolve(null),
            permissions.students
                ? branches.getStudents(branchId) as Promise<DashboardStudent[]>
                : Promise.resolve([] as DashboardStudent[]),
            permissions.seat_allocation
                ? fetchDashboardItems<DashboardAllocation>(
                    `/api/branches/${branchId}/seat-allocations?activeOnly=true&all=true`
                )
                : Promise.resolve([] as DashboardAllocation[]),
            permissions.view_payments
                ? fetchDashboardItems<DashboardPayment>(
                    `/api/branches/${branchId}/payments?month=${month}&all=true`
                )
                : Promise.resolve([] as DashboardPayment[]),
            permissions.view_payments
                ? fetchDashboardItems<DashboardOverduePayment>(
                    `/api/branches/${branchId}/payments/overdue?all=true`,
                    "payments"
                )
                : Promise.resolve([] as DashboardOverduePayment[]),
        ] as const);

    return {
        snapshot: fulfilledValue(snapshotResult, null),
        students: fulfilledValue(studentsResult, []),
        allocations: fulfilledValue(allocationsResult, []),
        monthPayments: fulfilledValue(paymentsResult, []),
        overduePayments: fulfilledValue(overdueResult, []),
        resources: {
            analytics: resourceStatus(permissions.analytics, snapshotResult),
            students: resourceStatus(permissions.students, studentsResult),
            allocations: resourceStatus(permissions.seat_allocation, allocationsResult),
            payments: resourceStatus(permissions.view_payments, paymentsResult),
            overdue: resourceStatus(permissions.view_payments, overdueResult),
        },
        updatedAt: now.toISOString(),
    };
}
