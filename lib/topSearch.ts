import type { StaffAction } from "@/types";

export type TopSearchResultType =
    | "action"
    | "student"
    | "payment"
    | "seat"
    | "shift"
    | "staff";

export type TopSearchGroupId =
    | "actions"
    | "students"
    | "payments"
    | "seats"
    | "shifts"
    | "staff";

export type TopSearchResult = {
    id: string;
    type: TopSearchResultType;
    group: TopSearchGroupId;
    title: string;
    subtitle: string;
    href: string;
    keywords: string[];
    score: number;
};

export type TopSearchGroup = {
    id: TopSearchGroupId;
    label: string;
    results: TopSearchResult[];
};

export type TopSearchAccess = {
    permissions: Partial<Record<StaffAction, boolean>>;
};

export type StudentSearchRecord = {
    id: string;
    name?: string | null;
    phone?: string | null;
    status?: string | null;
};

export type PaymentSearchRecord = {
    id: string;
    studentId?: string | null;
    amount?: number | null;
    status?: string | null;
    type?: string | null;
    dueDate?: Date | string | null;
    student?: {
        name?: string | null;
        phone?: string | null;
    } | null;
};

export type SeatSearchRecord = {
    id: string;
    label?: string | null;
    seatAllocations?: {
        student?: {
            name?: string | null;
        } | null;
    }[];
};

export type ShiftSearchRecord = {
    id: string;
    name?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    price?: number | null;
};

export type StaffSearchRecord = {
    id: string;
    role?: string | null;
    user?: {
        name?: string | null;
        email?: string | null;
    } | null;
};

export type BuildTopSearchResultsInput = {
    branchId: string;
    query: string;
    access: TopSearchAccess | null | undefined;
    students?: StudentSearchRecord[];
    payments?: PaymentSearchRecord[];
    seats?: SeatSearchRecord[];
    shifts?: ShiftSearchRecord[];
    staff?: StaffSearchRecord[];
    limitPerGroup?: number;
};

const GROUP_LABELS: Record<TopSearchGroupId, string> = {
    actions: "Quick actions",
    students: "Students",
    payments: "Payments",
    seats: "Seats",
    shifts: "Shifts",
    staff: "Staff",
};

const GROUP_ORDER: TopSearchGroupId[] = [
    "actions",
    "students",
    "payments",
    "seats",
    "shifts",
    "staff",
];

type ActionDefinition = {
    id: string;
    title: string;
    subtitle: string;
    path: string;
    permissions: StaffAction[];
    keywords: string[];
};

const ACTIONS: ActionDefinition[] = [
    {
        id: "add-student",
        title: "Add Student",
        subtitle: "Create a new student record",
        path: "students",
        permissions: ["students"],
        keywords: ["student", "add", "admit", "new", "register"],
    },
    {
        id: "assign-seat",
        title: "Assign Seat",
        subtitle: "Open seat allocation workflow",
        path: "allocations",
        permissions: ["seat_allocation"],
        keywords: ["seat", "assign", "allocation", "book"],
    },
    {
        id: "seats-map",
        title: "Seats & Maps",
        subtitle: "View branch seating and occupancy",
        path: "seats",
        permissions: ["seat_allocation"],
        keywords: ["seat", "map", "occupancy", "available"],
    },
    {
        id: "payments",
        title: "Payments",
        subtitle: "Review dues, paid payments, and history",
        path: "payments",
        permissions: ["view_payments"],
        keywords: ["payment", "payments", "due", "paid", "fees"],
    },
    {
        id: "generate-payments",
        title: "Generate Payments",
        subtitle: "Create due payments for active students",
        path: "payments?generate=1",
        permissions: ["view_payments", "generate_payments"],
        keywords: ["generate", "billing", "due", "fees", "payments"],
    },
    {
        id: "staff",
        title: "Staff",
        subtitle: "Manage branch team and permissions",
        path: "staff",
        permissions: ["manage_branch"],
        keywords: ["staff", "team", "manager", "permissions"],
    },
    {
        id: "analytics",
        title: "Analytics",
        subtitle: "Open branch performance dashboards",
        path: "analytics",
        permissions: ["analytics"],
        keywords: ["analytics", "dashboard", "trends", "reports"],
    },
    {
        id: "ai-reports",
        title: "AI Reports",
        subtitle: "Review generated branch reports",
        path: "ai/reports",
        permissions: ["analytics", "view_payments"],
        keywords: ["ai", "reports", "insights", "analysis"],
    },
    {
        id: "ai-messages",
        title: "AI Messages",
        subtitle: "Draft overdue payment messages",
        path: "ai/messages",
        permissions: ["analytics", "view_payments"],
        keywords: ["ai", "messages", "reminders", "overdue"],
    },
];

function normalize(value: unknown) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function compact(values: Array<string | number | null | undefined>) {
    return values
        .map(value => String(value ?? "").trim())
        .filter(Boolean);
}

function scoreFields(query: string, fields: Array<string | number | null | undefined>) {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return 0;

    let best = 0;

    for (const raw of fields) {
        const field = normalize(raw);
        if (!field) continue;

        if (field === normalizedQuery) best = Math.max(best, 120);
        if (field.startsWith(normalizedQuery)) best = Math.max(best, 100);
        if (field.split(" ").some(part => part.startsWith(normalizedQuery))) best = Math.max(best, 90);
        if (field.includes(normalizedQuery)) best = Math.max(best, 60);
    }

    return best;
}

function formatDate(value: Date | string | null | undefined) {
    if (!value) return "No due date";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "No due date";

    return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    }).format(date);
}

function formatMoney(value: number | null | undefined) {
    if (typeof value !== "number") return "INR 0";

    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(value);
}

function formatShiftTime(startTime: string | null | undefined, endTime: string | null | undefined) {
    if (!startTime && !endTime) return "Full day";
    if (startTime && endTime) return `${startTime} - ${endTime}`;
    return startTime ?? endTime ?? "Full day";
}

function can(access: TopSearchAccess | null | undefined, permission: StaffAction) {
    return access?.permissions[permission] ?? false;
}

function href(branchId: string, path: string) {
    return `/branch/${branchId}/${path}`;
}

function paymentCalendarMonth(value: Date | string | null | undefined) {
    if (!value) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
    }).formatToParts(date);
    const year = parts.find(part => part.type === "year")?.value;
    const month = parts.find(part => part.type === "month")?.value;

    return year && month ? `${year}-${month}` : undefined;
}

function hrefWithQuery(branchId: string, path: string, params: Record<string, string | null | undefined>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value) query.set(key, value);
    }
    const suffix = query.toString();
    return `${href(branchId, path)}${suffix ? `?${suffix}` : ""}`;
}

function sortAndLimit(results: TopSearchResult[], limit: number) {
    return [...results]
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        .slice(0, limit);
}

function actionsFor(input: BuildTopSearchResultsInput, normalizedQuery: string): TopSearchResult[] {
    if (!input.access) return [];

    return ACTIONS.flatMap((action, actionIndex) => {
        if (!action.permissions.every(permission => can(input.access, permission))) return [];

        const fields = [action.title, action.subtitle, ...action.keywords];
        const score = normalizedQuery ? scoreFields(normalizedQuery, fields) : 100 - actionIndex;
        if (normalizedQuery && score === 0) return [];

        return [{
            id: `action:${action.id}`,
            type: "action" as const,
            group: "actions" as const,
            title: action.title,
            subtitle: action.subtitle,
            href: href(input.branchId, action.path),
            keywords: compact(fields),
            score,
        }];
    });
}

export function buildTopSearchResults(input: BuildTopSearchResultsInput): TopSearchGroup[] {
    const normalizedQuery = normalize(input.query);
    const limit = input.limitPerGroup ?? 5;
    const groups: Partial<Record<TopSearchGroupId, TopSearchResult[]>> = {
        actions: actionsFor(input, normalizedQuery),
    };

    if (normalizedQuery && can(input.access, "students")) {
        groups.students = (input.students ?? []).flatMap(student => {
            const title = student.name?.trim() || "Unnamed student";
            const fields = [title, student.phone, student.status];
            const score = scoreFields(normalizedQuery, fields);
            if (score === 0) return [];

            return [{
                id: `student:${student.id}`,
                type: "student" as const,
                group: "students" as const,
                title,
                subtitle: compact([student.status, student.phone]).join(" - ") || "Student record",
                href: hrefWithQuery(input.branchId, "students", {
                    studentId: student.id,
                    status: student.status ?? undefined,
                }),
                keywords: compact(fields),
                score,
            }];
        });
    }

    if (normalizedQuery && can(input.access, "view_payments")) {
        groups.payments = (input.payments ?? []).flatMap(payment => {
            const studentName = payment.student?.name?.trim() || "Unknown student";
            const paymentStatus = payment.status?.toUpperCase();
            const fields = [
                studentName,
                payment.student?.phone,
                payment.amount,
                payment.status,
                payment.type,
                formatDate(payment.dueDate),
            ];
            const score = scoreFields(normalizedQuery, fields);
            if (score === 0) return [];

            return [{
                id: `payment:${payment.id}`,
                type: "payment" as const,
                group: "payments" as const,
                title: studentName,
                subtitle: compact([
                    payment.status,
                    payment.type,
                    formatMoney(payment.amount),
                    `Due ${formatDate(payment.dueDate)}`,
                ]).join(" - "),
                href: hrefWithQuery(input.branchId, "payments", {
                    paymentId: payment.id,
                    studentId: payment.studentId ?? undefined,
                    month: paymentStatus === "PAID" || paymentStatus === "WAIVED"
                        ? paymentCalendarMonth(payment.dueDate)
                        : undefined,
                    status: paymentStatus,
                }),
                keywords: compact(fields),
                score,
            }];
        });
    }

    if (normalizedQuery && can(input.access, "seat_allocation")) {
        groups.seats = (input.seats ?? []).flatMap(seat => {
            const label = seat.label?.trim() || "Unnamed seat";
            const occupiedBy = seat.seatAllocations
                ?.map(allocation => allocation.student?.name)
                .find(Boolean);
            const status = occupiedBy ? `Occupied by ${occupiedBy}` : "Available";
            const fields = [label, status, occupiedBy];
            const score = scoreFields(normalizedQuery, fields);
            if (score === 0) return [];

            return [{
                id: `seat:${seat.id}`,
                type: "seat" as const,
                group: "seats" as const,
                title: `Seat ${label}`,
                subtitle: status,
                href: hrefWithQuery(input.branchId, "seats", { seatId: seat.id }),
                keywords: compact(fields),
                score,
            }];
        });

        groups.shifts = (input.shifts ?? []).flatMap(shift => {
            const title = shift.name?.trim() || "Unnamed shift";
            const time = formatShiftTime(shift.startTime, shift.endTime);
            const fields = [title, time, shift.price];
            const score = scoreFields(normalizedQuery, fields);
            if (score === 0) return [];

            return [{
                id: `shift:${shift.id}`,
                type: "shift" as const,
                group: "shifts" as const,
                title,
                subtitle: compact([time, formatMoney(shift.price)]).join(" - "),
                href: hrefWithQuery(input.branchId, "shifts", { shiftId: shift.id }),
                keywords: compact(fields),
                score,
            }];
        });
    }

    if (normalizedQuery && can(input.access, "manage_branch")) {
        groups.staff = (input.staff ?? []).flatMap(member => {
            const name = member.user?.name?.trim();
            const email = member.user?.email?.trim();
            const title = name || email || "Staff member";
            const fields = [title, email, member.role];
            const score = scoreFields(normalizedQuery, fields);
            if (score === 0) return [];

            return [{
                id: `staff:${member.id}`,
                type: "staff" as const,
                group: "staff" as const,
                title,
                subtitle: compact([member.role, email && name ? email : null]).join(" - ") || "Staff member",
                href: hrefWithQuery(input.branchId, "staff", { staffId: member.id }),
                keywords: compact(fields),
                score,
            }];
        });
    }

    return GROUP_ORDER.flatMap(groupId => {
        const results = sortAndLimit(groups[groupId] ?? [], limit);
        if (results.length === 0) return [];

        return [{
            id: groupId,
            label: GROUP_LABELS[groupId],
            results,
        }];
    });
}
