"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    AlertCircle,
    Bell,
    CheckCircle2,
    CreditCard,
    Grid,
    Loader2,
    RefreshCw,
    UserPlus,
    Users,
} from "lucide-react";
import { branches } from "@/lib/api/branches";
import { seats } from "@/lib/api/seats";
import { staff } from "@/lib/api/staff";
import { useBranchAccess } from "@/hooks/useBranchAccess";
import {
    buildBranchNotifications,
    type AllocationNotificationRecord,
    type BranchNotification,
    type BranchNotificationKind,
    type BranchNotificationSeverity,
    type OverduePaymentNotificationData,
    type ShiftCapacityNotificationRecord,
    type StaffInviteNotificationRecord,
    type StudentNotificationRecord,
} from "@/lib/branchNotifications";
import { cn } from "@/lib/utils";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import { SkeletonBlock } from "@/components/ui";
import {
    chromeCompactIconButtonClass,
    chromeEmptyStateClass,
    chromeIconButtonClass,
    chromeListItemClass,
    chromePopoverClass,
    chromePopoverHeaderClass,
    chromePopoverScrollClass,
    chromeSubtleTextClass,
} from "@/components/ui/chromeSurface";

type NotificationData = {
    overdue: OverduePaymentNotificationData | null;
    students: StudentNotificationRecord[];
    allocations: AllocationNotificationRecord[];
    shiftCapacities: ShiftCapacityNotificationRecord[];
    staffInvites: StaffInviteNotificationRecord[];
};

type NotificationLoadState = {
    branchId?: string;
    data: NotificationData;
    loaded: boolean;
    loadErrors: string[];
};

const EMPTY_DATA: NotificationData = {
    overdue: null,
    students: [],
    allocations: [],
    shiftCapacities: [],
    staffInvites: [],
};

const KIND_ICONS: Record<BranchNotificationKind, typeof AlertCircle> = {
    overdue_payments: CreditCard,
    students_without_seats: Users,
    shift_full: Grid,
    shift_near_full: Grid,
    active_invites: UserPlus,
};

const SEVERITY_STYLES: Record<BranchNotificationSeverity, string> = {
    critical: "border-rose-500/25 bg-rose-500/10 text-rose-300",
    warning: "border-amber-500/25 bg-amber-500/10 text-amber-300",
    info: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300",
};

function NotificationSkeleton() {
    return (
        <div role="status" aria-live="polite" className="space-y-2 px-3 py-3">
            <span className="sr-only">Loading notifications</span>
            {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex items-start gap-3 rounded-[var(--ui-radius-control)] px-1 py-2">
                    <SkeletonBlock className="h-9 w-9" />
                    <div className="min-w-0 flex-1 space-y-2">
                        <SkeletonBlock className="h-4 w-40 max-w-full" />
                        <SkeletonBlock className="h-3 w-56 max-w-full" />
                    </div>
                </div>
            ))}
        </div>
    );
}

const READ_EVENT = "lab-lords-branch-notifications-read";
const MAX_READ_KEYS = 100;

function getBranchId(pathname: string | null) {
    const segments = pathname?.split("/").filter(Boolean) ?? [];
    if (segments[0] !== "branch" || !segments[1]) return undefined;
    return segments[1];
}

function readStorageKey(branchId: string) {
    return `lab_lords.branchNotifications.sessionRead.${branchId}`;
}

function subscribeReadStore(callback: () => void) {
    if (typeof window === "undefined") return () => { };

    window.addEventListener("storage", callback);
    window.addEventListener(READ_EVENT, callback);
    return () => {
        window.removeEventListener("storage", callback);
        window.removeEventListener(READ_EVENT, callback);
    };
}

function getReadKeysSnapshot(branchId: string | undefined) {
    if (!branchId || typeof window === "undefined") return "";

    return window.sessionStorage.getItem(readStorageKey(branchId)) ?? "";
}

function parseReadKeys(value: string) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function writeReadKeys(branchId: string, keys: string[]) {
    if (typeof window === "undefined") return;

    const uniqueKeys = Array.from(new Set(keys)).slice(-MAX_READ_KEYS);
    window.sessionStorage.setItem(readStorageKey(branchId), JSON.stringify(uniqueKeys));
    window.dispatchEvent(new Event(READ_EVENT));
}

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Request failed");
    }

    return response.json();
}

function DisabledBell() {
    return (
        <span
            title="Open a branch to view notifications"
            className={cn("relative", chromeIconButtonClass, "pointer-events-none opacity-50")}
            aria-label="Notifications unavailable outside a branch"
        >
            <Bell size={20} />
        </span>
    );
}

export function BranchNotifications() {
    const pathname = usePathname();
    const router = useRouter();
    const branchId = getBranchId(pathname);
    const { access, loading: accessLoading, error: accessError } = useBranchAccess(branchId);

    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const popoverId = useId();
    const popoverTitleId = useId();
    const loadSeq = useRef(0);
    const [openBranchId, setOpenBranchId] = useState<string | null>(null);
    const [loadingBranchId, setLoadingBranchId] = useState<string | null>(null);
    const [loadState, setLoadState] = useState<NotificationLoadState>({
        data: EMPTY_DATA,
        loaded: false,
        loadErrors: [],
    });

    const branchState = loadState.branchId === branchId
        ? loadState
        : { data: EMPTY_DATA, loaded: false, loadErrors: [] };
    const open = openBranchId === branchId;
    const loading = loadingBranchId === branchId;
    const data = branchState.data;
    const loaded = branchState.loaded;
    const loadErrors = branchState.loadErrors;

    const notifications = useMemo(() => {
        if (!branchId) return [];

        return buildBranchNotifications({
            branchId,
            access,
            overdue: data.overdue,
            students: data.students,
            allocations: data.allocations,
            shiftCapacities: data.shiftCapacities,
            staffInvites: data.staffInvites,
        });
    }, [access, branchId, data]);
    const readKeysSnapshot = useSyncExternalStore(
        subscribeReadStore,
        () => getReadKeysSnapshot(branchId),
        () => ""
    );
    const readKeys = useMemo(() => new Set(parseReadKeys(readKeysSnapshot)), [readKeysSnapshot]);
    const unreadNotifications = useMemo(
        () => notifications.filter(notification => !readKeys.has(notification.readKey)),
        [notifications, readKeys]
    );

    const loadNotifications = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
        if (!branchId || !access || loading || (loaded && !force)) return;

        const seq = ++loadSeq.current;
        const failures: string[] = [];

        async function read<T>(
            label: string,
            enabled: boolean,
            loader: () => Promise<T>
        ): Promise<T | null> {
            if (!enabled) return null;
            try {
                return await loader();
            } catch {
                failures.push(label);
                return null;
            }
        }

        setLoadingBranchId(branchId);

        const [
            overdue,
            students,
            allocations,
            shiftCapacities,
            staffInvites,
        ] = await Promise.all([
            read("overdue payments", Boolean(access.permissions.view_payments), () =>
                fetchJson<OverduePaymentNotificationData>(`/api/branches/${branchId}/payments/overdue?all=true`)
            ),
            read("students", Boolean(access.permissions.students && access.permissions.seat_allocation), () =>
                branches.getStudents(branchId) as Promise<StudentNotificationRecord[]>
            ),
            read("allocations", Boolean(access.permissions.students && access.permissions.seat_allocation), () =>
                seats.listAllAllocations<AllocationNotificationRecord>(branchId, { activeOnly: true })
            ),
            read("shift capacity", Boolean(access.permissions.seat_allocation), () =>
                fetchJson<ShiftCapacityNotificationRecord[]>(`/api/branches/${branchId}/shifts/capacity`)
            ),
            read("staff invites", Boolean(access.permissions.staff_management), () =>
                staff.listInvites(branchId) as Promise<StaffInviteNotificationRecord[]>
            ),
        ]);

        if (seq !== loadSeq.current) return;

        setLoadState({
            branchId,
            loaded: true,
            loadErrors: failures,
            data: {
                overdue,
                students: students ?? [],
                allocations: allocations ?? [],
                shiftCapacities: shiftCapacities ?? [],
                staffInvites: staffInvites ?? [],
            },
        });
        setLoadingBranchId(current => current === branchId ? null : current);
    }, [access, branchId, loaded, loading]);

    useEffect(() => {
        if (!branchId || !access) return;
        const timer = window.setTimeout(() => {
            void loadNotifications();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [access, branchId, loadNotifications]);

    useEffect(() => {
        if (!open) return;

        const handleMouseDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpenBranchId(null);
            }
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpenBranchId(null);
            triggerRef.current?.focus();
        };

        document.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("keydown", handleKeyDown);
        const frame = window.requestAnimationFrame(() => {
            popoverRef.current?.querySelector<HTMLElement>("button:not([disabled]), a[href]")?.focus();
        });
        return () => {
            window.cancelAnimationFrame(frame);
            document.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [open]);

    if (!branchId) return <DisabledBell />;

    const disabled = accessLoading || Boolean(accessError) || !access;
    const alertCount = unreadNotifications.length;

    const markRead = (items: BranchNotification[]) => {
        if (!branchId || items.length === 0) return;

        writeReadKeys(branchId, [
            ...parseReadKeys(getReadKeysSnapshot(branchId)),
            ...items.map(item => item.readKey),
        ]);
    };

    const openNotification = (notification: BranchNotification) => {
        markRead([notification]);
        setOpenBranchId(null);
        router.push(notification.href);
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                ref={triggerRef}
                type="button"
                disabled={disabled}
                onClick={() => {
                    setOpenBranchId(value => value === branchId ? null : branchId ?? null);
                    void loadNotifications();
                }}
                className={cn(
                    "relative rounded-full",
                    chromeIconButtonClass,
                    open && "bg-[color:var(--ui-form-surface-hover-bg)] text-[color:var(--text-primary)]",
                    disabled && "cursor-not-allowed opacity-60"
                )}
                aria-label={alertCount > 0 ? `${alertCount} branch notifications` : "Branch notifications"}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-controls={open ? popoverId : undefined}
            >
                <Bell size={20} />
                {loading && !loaded && (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[color:var(--ui-form-accent)] shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                )}
                {alertCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-[color:var(--bg-app)] bg-[color:var(--accent-danger)] px-1 text-[10px] font-bold leading-none text-white shadow-[0_0_10px_rgba(244,63,94,0.55)]">
                        {alertCount > 9 ? "9+" : alertCount}
                    </span>
                )}
            </button>

            {open && !disabled && (
                <div
                    ref={popoverRef}
                    id={popoverId}
                    role="dialog"
                    aria-modal="false"
                    aria-labelledby={popoverTitleId}
                    className={cn(chromePopoverClass, "sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:w-[22rem]")}
                >
                    <div className={chromePopoverHeaderClass}>
                        <div>
                            <h2 id={popoverTitleId} className="text-sm font-bold text-[color:var(--text-primary)]">Notifications</h2>
                            <p className={cn("text-xs", chromeSubtleTextClass)}>Current branch alerts</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void loadNotifications({ force: true })}
                            disabled={loading}
                            className={cn("h-8 w-8", chromeCompactIconButtonClass)}
                            aria-label="Refresh notifications"
                        >
                            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                        </button>
                    </div>

                    <div className={chromePopoverScrollClass}>
                        {loadErrors.length > 0 && (
                            <div className={cn("mx-3 mb-2 flex items-start gap-2 px-3 py-2 text-xs leading-5", formWarningBannerClass)}>
                                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                                <span>Some alerts could not load: {loadErrors.join(", ")}.</span>
                            </div>
                        )}

                        {loading && !loaded && (
                            <NotificationSkeleton />
                        )}

                        {!loading && loaded && notifications.length === 0 && loadErrors.length > 0 && (
                            <div className={chromeEmptyStateClass} role="status">
                                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-300">
                                    <AlertCircle size={20} aria-hidden="true" />
                                </div>
                                <p className="text-sm font-semibold text-[color:var(--text-primary)]">Alert status incomplete</p>
                                <p className={cn("mt-1 text-xs leading-5", chromeSubtleTextClass)}>
                                    No loaded alerts are visible, but some sources failed. Refresh before treating this branch as clear.
                                </p>
                            </div>
                        )}

                        {!loading && loaded && notifications.length === 0 && loadErrors.length === 0 && (
                            <div className={chromeEmptyStateClass}>
                                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                                    <CheckCircle2 size={20} />
                                </div>
                                <p className="text-sm font-semibold text-[color:var(--text-primary)]">All clear</p>
                                <p className={cn("mt-1 text-xs leading-5", chromeSubtleTextClass)}>
                                    No overdue payments, seating gaps, capacity alerts, or active invites need attention.
                                </p>
                            </div>
                        )}

                        {!loading && loaded && notifications.length > 0 && (
                            <div className="space-y-1.5 px-2">
                                <div className="flex min-h-11 items-center justify-between gap-3 px-1 pb-1">
                                    <span className={cn("text-xs", chromeSubtleTextClass)}>
                                        {unreadNotifications.length > 0
                                            ? `${unreadNotifications.length} unread`
                                            : "All current alerts read"}
                                    </span>
                                    {unreadNotifications.length > 0 ? (
                                        <button
                                            type="button"
                                            onClick={() => markRead(unreadNotifications)}
                                            className="min-h-11 rounded-[var(--ui-radius-control)] px-2 py-1 text-xs font-medium text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
                                        >
                                            Mark all read
                                        </button>
                                    ) : null}
                                </div>
                                {notifications.map(notification => {
                                    const Icon = KIND_ICONS[notification.kind];
                                    const read = readKeys.has(notification.readKey);

                                    return (
                                        <button
                                            key={notification.id}
                                            type="button"
                                            onClick={() => openNotification(notification)}
                                            className={cn(
                                                chromeListItemClass,
                                                "min-h-11 items-start py-3",
                                                read && "opacity-65"
                                            )}
                                            aria-label={`${notification.title}${read ? ", read" : ", unread"}`}
                                        >
                                            <span className={cn(
                                                "mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border",
                                                SEVERITY_STYLES[notification.severity]
                                            )}>
                                                <Icon size={16} />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-center gap-2 text-sm font-semibold text-[color:var(--text-primary)]">
                                                    <span className="min-w-0 flex-1">{notification.title}</span>
                                                    {!read ? <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-300" aria-hidden="true" /> : null}
                                                </span>
                                                <span className={cn("mt-0.5 block text-xs leading-5", chromeSubtleTextClass)}>
                                                    {notification.message}
                                                </span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
