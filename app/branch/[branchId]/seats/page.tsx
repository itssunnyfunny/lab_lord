"use client";

import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { Badge } from "@/components/ui/Badge";
import { AppButton, AppPanel, Drawer, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formSurfaceClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import {
    pageDescriptionClass,
    pageEmptyStateClass,
    pageEyebrowClass,
    pageErrorIconClass,
    pageErrorStateClass,
    pageFilterShellClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetHoverClass,
    pageInsetMetricClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
    pageTableBodyDividerClass,
    pageTableHeadClass,
    pageTableRowClass,
    pageTableShellClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";
import { ViewToggle } from "@/components/tables/ViewToggle";
import type { DataViewMode } from "@/components/tables/DataTable";
import { cn } from "@/lib/utils";
import {
    AlertCircle,
    Armchair,
    ArrowLeft,
    CalendarClock,
    Clock,
    Loader2,
    LogOut,
    RefreshCw,
    Search,
    SearchX,
    User,
    UserPlus,
    X,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, use } from "react";
import { branches } from "@/lib/api/branches";
import type { Shift } from "@/app/generated/prisma/browser";
import { useRouter, useSearchParams } from "next/navigation";
import { AddSeatDialog } from "./AddSeatDialog";
import { AllocateSeatDialog } from "@/components/allocations/AllocateSeatDialog";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { getPermissionHelpText } from "@/lib/permissionMessages";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import type { CapabilityDecision } from "@/types";
import { useMediaQuery } from "@/hooks/useMediaQuery";

type SeatStatus = "Allocated" | "Available";
type StatusFilter = "ALL" | "ALLOCATED" | "AVAILABLE";
type SerializableDate = string | Date;

interface SeatAllocationSummary {
    id: string;
    studentId: string;
    shiftId: string;
    multiShiftId?: string | null;
    startDate: SerializableDate;
    student?: {
        id: string;
        name: string;
        phone?: string | null;
        status?: string;
        monthlyFee?: number | null;
    } | null;
    shift?: {
        id: string;
        name: string;
        startTime: string | null;
        endTime: string | null;
        isReserved?: boolean;
    } | null;
    multiShift?: {
        id: string;
        name: string;
    } | null;
}

interface SeatApi {
    id: string;
    branchId: string;
    label: string;
    createdAt: SerializableDate;
    seatAllocations?: SeatAllocationSummary[];
}

interface SeatWithStatus {
    id: string;
    branchId: string;
    label: string;
    createdAt: SerializableDate;
    status: SeatStatus;
    studentName?: string;
    allocations: SeatAllocationSummary[];
}

interface ReleaseTarget {
    id: string;
    seatLabel: string;
    studentName: string;
    shiftName: string;
}

interface AllocationSeed {
    seatId: string;
    seatLabel: string;
    shiftIds?: string[];
    shiftNames?: string[];
}

type ShiftSummary = {
    id: string;
    name: string;
    timeLabel: string;
    allocated: number;
    available: number;
    capacity: number;
    percent: number;
    tone: "success" | "warning" | "danger" | "info";
};

function getErrorMessage(err: unknown) {
    return err instanceof Error ? err.message : "Failed to load seats.";
}

function formatTime(value: string | null | undefined) {
    if (!value) return "";
    const [hourText, minuteText = "0"] = value.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);

    if (Number.isNaN(hour) || Number.isNaN(minute)) return value;

    const suffix = hour < 12 ? "AM" : "PM";
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatTimeRange(startTime: string | null | undefined, endTime: string | null | undefined) {
    if (!startTime && !endTime) return "Full day";
    if (startTime && endTime) return `${formatTime(startTime)} - ${formatTime(endTime)}`;
    if (startTime) return `From ${formatTime(startTime)}`;
    return `Until ${formatTime(endTime)}`;
}

function getAllocationShiftLabel(allocation: SeatAllocationSummary) {
    const shiftName = allocation.shift?.name ?? "Shift";
    return allocation.multiShift?.name ? `${allocation.multiShift.name} - ${shiftName}` : shiftName;
}

function getUniqueStudentNames(allocations: SeatAllocationSummary[]) {
    return Array.from(
        new Set(
            allocations
                .map(allocation => allocation.student?.name)
                .filter((name): name is string => Boolean(name))
        )
    );
}

function buildSeatWithStatus(seat: SeatApi | SeatWithStatus, allocations: SeatAllocationSummary[]): SeatWithStatus {
    return {
        id: seat.id,
        branchId: seat.branchId,
        label: seat.label,
        createdAt: seat.createdAt,
        allocations,
        status: allocations.length > 0 ? "Allocated" : "Available",
        studentName: allocations[0]?.student?.name,
    };
}

function getShiftTone(percent: number): "success" | "warning" | "danger" | "info" {
    if (percent >= 100) return "danger";
    if (percent >= 80) return "warning";
    if (percent > 0) return "success";
    return "info";
}

export default function SeatsPage({ params }: { params: Promise<{ branchId: string }> }) {
    const { branchId } = use(params);

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.seats}>
            {access => (
                <Suspense fallback={<PageLoadingSkeleton label="Loading seats" variant="cards" rows={6} />}>
                    <SeatsContent
                        branchId={branchId}
                        seatManageDecision={getBranchCapabilityDecision(access, "seatsManage")}
                        allocationDecision={getBranchCapabilityDecision(access, "allocationsManage")}
                    />
                </Suspense>
            )}
        </BranchAccessGuard>
    );
}

function SeatsContent({
    branchId,
    seatManageDecision,
    allocationDecision,
}: {
    branchId: string;
    seatManageDecision: CapabilityDecision;
    allocationDecision: CapabilityDecision;
}) {
    const canManageBranch = seatManageDecision.allowed;
    const showSeatManageActions = seatManageDecision.blocker !== "permission";
    const canAllocateSeats = allocationDecision.allowed;
    const showAllocationActions = allocationDecision.blocker !== "permission";
    const router = useRouter();
    const searchParams = useSearchParams();
    const linkedSeatId = searchParams.get("seatId");
    const hasLoadedSeats = useRef(false);
    const loadSequence = useRef(0);
    const [allSeats, setAllSeats] = useState<SeatWithStatus[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [totalSeatCount, setTotalSeatCount] = useState(0);
    const [shifts, setShifts] = useState<Shift[]>([]);
    const [selectedShift, setSelectedShift] = useState<string>("");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
    const [searchQuery, setSearchQuery] = useState("");
    const [viewMode, setViewMode] = useState<DataViewMode>("grid");
    const compactLayout = useMediaQuery("(max-width: 1023px)", true);
    const effectiveViewMode: DataViewMode = compactLayout ? "grid" : viewMode;
    const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [releaseLoading, setReleaseLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [allocationSeed, setAllocationSeed] = useState<AllocationSeed | null>(null);
    const [releaseTarget, setReleaseTarget] = useState<ReleaseTarget | null>(null);

    useEffect(() => {
        const loadShifts = async () => {
            try {
                const shiftsData = await branches.getShifts(branchId);
                setShifts(shiftsData);
            } catch (err) {
                console.error("Failed to load shifts", err);
            }
        };

        loadShifts();
    }, [branchId]);

    const loadSeats = useCallback(async ({
        cursor,
        append = false,
        revealSeatId,
    }: {
        cursor?: string;
        append?: boolean;
        revealSeatId?: string | null;
    } = {}) => {
        const sequence = ++loadSequence.current;
        if (append) {
            setLoadingMore(true);
            setLoadMoreError(null);
        } else if (hasLoadedSeats.current) {
            setRefreshing(true);
        } else {
            setLoading(true);
        }

        try {
            if (!append) setError(null);

            let requestCursor = cursor;
            let resultCursor: string | null = null;
            let resultTotal = 0;
            const loaded: SeatWithStatus[] = [];

            do {
                const page = await branches.getSeats(branchId, { cursor: requestCursor });
                const mapped = (page.items as SeatApi[])
                    .map(seat => buildSeatWithStatus(seat, seat.seatAllocations ?? []));
                loaded.push(...mapped);
                resultCursor = page.nextCursor;
                resultTotal = page.total;
                requestCursor = page.nextCursor ?? undefined;
            } while (
                revealSeatId
                && !loaded.some(seat => seat.id === revealSeatId)
                && requestCursor
            );

            if (sequence !== loadSequence.current) return;

            setAllSeats(current => {
                if (!append) return loaded;
                const byId = new Map(current.map(seat => [seat.id, seat]));
                loaded.forEach(seat => byId.set(seat.id, seat));
                return Array.from(byId.values());
            });
            setNextCursor(resultCursor);
            setTotalSeatCount(resultTotal);

            if (revealSeatId && !loaded.some(seat => seat.id === revealSeatId) && !resultCursor) {
                setActionError("The linked seat could not be found in this branch.");
            }
        } catch (err: unknown) {
            if (sequence !== loadSequence.current) return;
            const message = getErrorMessage(err);
            console.error("Failed to load seats", err);
            if (append) {
                setLoadMoreError(message || "Failed to load more seats.");
            } else if (message.includes("Branch not found")) {
                setError("Branch not found. Matches no existing records.");
            } else {
                setError(message || "Failed to load seats.");
            }
        } finally {
            if (sequence === loadSequence.current) {
                hasLoadedSeats.current = true;
                setLoading(false);
                setRefreshing(false);
                setLoadingMore(false);
            }
        }
    }, [branchId]);

    useEffect(() => {
        hasLoadedSeats.current = false;
        setAllSeats([]);
        setNextCursor(null);
        setTotalSeatCount(0);
        setActionError(null);
        void loadSeats({ revealSeatId: linkedSeatId });
    }, [linkedSeatId, loadSeats]);

    useEffect(() => {
        if (!linkedSeatId || !allSeats.some(seat => seat.id === linkedSeatId)) return;

        const frame = window.requestAnimationFrame(() => {
            const target = document.getElementById(`seat-record-${linkedSeatId}`);
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({
                block: "center",
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [allSeats, effectiveViewMode, linkedSeatId]);

    const seats = useMemo(() => {
        if (!selectedShift) return allSeats;

        return allSeats.map((seat) => {
            const shiftAllocations = seat.allocations.filter(allocation => allocation.shiftId === selectedShift);
            return buildSeatWithStatus(seat, shiftAllocations);
        });
    }, [allSeats, selectedShift]);

    useEffect(() => {
        if (!selectedSeatId) return;
        if (!seats.some(seat => seat.id === selectedSeatId)) {
            setSelectedSeatId(null);
        }
    }, [seats, selectedSeatId]);

    const activeShift = useMemo(
        () => shifts.find(shift => shift.id === selectedShift) ?? null,
        [selectedShift, shifts]
    );

    const stats = useMemo(() => {
        const total = seats.length;
        const allocated = seats.filter(seat => seat.status === "Allocated").length;
        const available = total - allocated;
        const allocations = seats.reduce((sum, seat) => sum + seat.allocations.length, 0);
        const totalSlots = selectedShift ? total : total * shifts.length;
        const utilization = totalSlots === 0 ? 0 : Math.round((allocations / totalSlots) * 100);

        return { total, allocated, available, allocations, totalSlots, utilization };
    }, [seats, selectedShift, shifts.length]);

    const shiftSummaries = useMemo(() => {
        return shifts.map((shift) => {
            const allocated = allSeats.filter(seat =>
                seat.allocations.some(allocation => allocation.shiftId === shift.id)
            ).length;
            const capacity = allSeats.length;
            const available = Math.max(0, capacity - allocated);
            const percent = capacity === 0 ? 0 : Math.round((allocated / capacity) * 100);

            return {
                id: shift.id,
                name: shift.name,
                timeLabel: formatTimeRange(shift.startTime, shift.endTime),
                allocated,
                available,
                capacity,
                percent,
                tone: getShiftTone(percent),
            };
        });
    }, [allSeats, shifts]);

    const filteredSeats = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();

        return seats
            .filter((seat) => {
                if (statusFilter === "ALLOCATED" && seat.status !== "Allocated") return false;
                if (statusFilter === "AVAILABLE" && seat.status !== "Available") return false;
                if (!query) return true;

                const studentNames = getUniqueStudentNames(seat.allocations).join(" ").toLowerCase();
                const shiftNames = seat.allocations.map(getAllocationShiftLabel).join(" ").toLowerCase();
                return (
                    seat.label.toLowerCase().includes(query) ||
                    studentNames.includes(query) ||
                    shiftNames.includes(query)
                );
            })
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
    }, [searchQuery, seats, statusFilter]);

    const selectedSeat = useMemo(
        () => seats.find(seat => seat.id === selectedSeatId) ?? null,
        [seats, selectedSeatId]
    );

    const statusFilters: { value: StatusFilter; label: string; count: number }[] = [
        { value: "ALL", label: "All", count: stats.total },
        { value: "ALLOCATED", label: "Allocated", count: stats.allocated },
        { value: "AVAILABLE", label: "Available", count: stats.available },
    ];

    const openAllocation = (seat: SeatWithStatus) => {
        if (!allocationDecision.allowed) {
            setActionError(allocationDecision.reason ?? "Seat allocation changes are unavailable.");
            return;
        }
        setActionError(null);
        setSelectedSeatId(null);
        setAllocationSeed({
            seatId: seat.id,
            seatLabel: seat.label,
            shiftIds: selectedShift ? [selectedShift] : undefined,
            shiftNames: activeShift ? [activeShift.name] : undefined,
        });
    };

    const handleReleaseAllocation = async () => {
        if (!releaseTarget) return;
        if (!allocationDecision.allowed) {
            setActionError(allocationDecision.reason ?? "Seat allocation changes are unavailable.");
            return;
        }

        setReleaseLoading(true);
        setActionError(null);

        try {
            const response = await fetch(`/api/seat-allocations/${releaseTarget.id}`, {
                method: "PUT",
            });

            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(typeof payload.error === "string" ? payload.error : "Failed to release seat.");
            }

            await loadSeats({ revealSeatId: linkedSeatId });
            setReleaseTarget(null);
        } catch (err: unknown) {
            setActionError(err instanceof Error ? err.message : "Failed to release seat.");
        } finally {
            setReleaseLoading(false);
        }
    };

    if (loading) {
        return <PageLoadingSkeleton label="Loading seats" variant="cards" rows={6} />;
    }

    if (error) {
        return (
            <div className={pageErrorStateClass}>
                <AlertCircle className={pageErrorIconClass} />
                <h2 className="text-xl font-semibold">Something went wrong</h2>
                <p className={pageMutedTextClass}>{error}</p>
                <AppButton variant="quiet" icon={ArrowLeft} onClick={() => router.push("/org")}>
                    Back to Workspace
                </AppButton>
            </div>
        );
    }

    return (
        <PageShell>
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className={pageEyebrowClass}>Seat map</p>
                    <h1 className={cn(pageTitleClass, "mt-2 truncate")}>Seats</h1>
                    <p className={pageDescriptionClass}>
                        Review availability by shift and move straight into allocation work.
                    </p>
                </div>

                <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                    <div className="relative min-w-0 sm:w-72">
                        <Search className={cn("absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2", pageSubtleTextClass)} />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="Search seat, student, shift..."
                            aria-label="Search loaded seats"
                            className={cn(formControlClass, "h-11 pl-9 pr-3 text-sm lg:h-10")}
                        />
                    </div>
                    {showSeatManageActions && (
                        <AppButton
                            variant="primary"
                            icon={UserPlus}
                            onClick={() => setIsAddModalOpen(true)}
                            disabled={!canManageBranch}
                            title={canManageBranch ? undefined : seatManageDecision.reason ?? undefined}
                            className="sm:w-auto"
                        >
                            Add seat
                        </AppButton>
                    )}
                </div>
            </header>

            {!canManageBranch && (
                <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)}>
                    Adding seats is disabled. {seatManageDecision.reason ?? getPermissionHelpText("manage_branch")}
                    {seatManageDecision.recoveryHref ? (
                        <a href={seatManageDecision.recoveryHref} className="ml-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                            Review billing
                        </a>
                    ) : null}
                </div>
            )}

            {!canAllocateSeats && allocationDecision.blocker !== "permission" ? (
                <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)}>
                    Allocation changes are disabled. {allocationDecision.reason}
                    {allocationDecision.recoveryHref ? (
                        <a href={allocationDecision.recoveryHref} className="ml-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                            Review billing
                        </a>
                    ) : null}
                </div>
            ) : null}

            {actionError && (
                <div className={cn("flex items-start justify-between gap-3 px-4 py-3 text-sm", formErrorBannerClass)}>
                    <span>{actionError}</span>
                    <button
                        type="button"
                        onClick={() => setActionError(null)}
                        className="transition-colors hover:text-[color:var(--text-primary)]"
                        aria-label="Dismiss error"
                    >
                        <X size={16} />
                    </button>
                </div>
            )}

            <AppPanel contentClassName="space-y-4">
                <ShiftFilterPanel
                    selectedShift={selectedShift}
                    summaries={shiftSummaries}
                    totalSeats={allSeats.length}
                    branchTotalSeats={totalSeatCount}
                    totalSlots={allSeats.length * shifts.length}
                    totalAllocatedSlots={allSeats.reduce((sum, seat) => sum + seat.allocations.length, 0)}
                    onSelect={setSelectedShift}
                />

                <div className={cn("border-t pt-4", pageSectionDividerClass)}>
                    <SeatSummaryBar
                        stats={stats}
                        activeShiftName={activeShift?.name}
                        branchTotalSeats={totalSeatCount}
                    />
                </div>

                <div className={cn("flex flex-col gap-3 border-t pt-4 xl:flex-row xl:items-center xl:justify-between", pageSectionDividerClass)}>
                    <div className="flex flex-wrap items-center gap-2">
                        {statusFilters.map(filter => (
                            <StatusFilterChip
                                key={filter.value}
                                filter={filter}
                                active={statusFilter === filter.value}
                                onClick={() => setStatusFilter(filter.value)}
                            />
                        ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className={cn("inline-flex min-h-11 max-w-full items-center gap-2 px-2.5 text-xs lg:min-h-8", pageFilterShellClass, pageSubtleTextClass)}>
                            <Clock size={13} className="shrink-0" />
                            <span className="truncate">
                                {activeShift ? formatTimeRange(activeShift.startTime, activeShift.endTime) : "All active allocations"}
                            </span>
                        </div>
                        <ViewToggle value={viewMode} onChange={setViewMode} className="hidden lg:inline-flex" />
                        <AppButton
                            type="button"
                            variant="quiet"
                            size="sm"
                            icon={refreshing ? Loader2 : RefreshCw}
                            onClick={() => loadSeats({ revealSeatId: linkedSeatId })}
                            disabled={refreshing}
                            className={refreshing ? "[&_svg]:animate-spin" : undefined}
                        >
                            Refresh
                        </AppButton>
                    </div>
                </div>
            </AppPanel>

            <div className={cn("relative transition-opacity", refreshing && "opacity-60")}>
                {filteredSeats.length === 0 ? (
                    <SeatEmptyState
                        hasSeats={seats.length > 0}
                        canManageBranch={canManageBranch}
                        showManageAction={showSeatManageActions}
                        disabledReason={seatManageDecision.reason ?? undefined}
                        onAddSeat={() => setIsAddModalOpen(true)}
                    />
                ) : effectiveViewMode === "grid" ? (
                    <SeatGrid
                        seats={filteredSeats}
                        selectedSeatId={selectedSeatId}
                        focusedSeatId={linkedSeatId}
                        selectedShiftId={selectedShift}
                        canAllocateSeats={canAllocateSeats}
                        showAllocationActions={showAllocationActions}
                        allocationDisabledReason={allocationDecision.reason ?? undefined}
                        onInspect={setSelectedSeatId}
                        onAllocate={openAllocation}
                    />
                ) : (
                    <SeatList
                        seats={filteredSeats}
                        focusedSeatId={linkedSeatId}
                        selectedShiftId={selectedShift}
                        canAllocateSeats={canAllocateSeats}
                        showAllocationActions={showAllocationActions}
                        allocationDisabledReason={allocationDecision.reason ?? undefined}
                        onInspect={setSelectedSeatId}
                        onAllocate={openAllocation}
                    />
                )}
            </div>

            <div className="flex flex-col items-center gap-2" aria-busy={loadingMore}>
                <p id="seat-page-progress" className={cn("text-sm", pageMutedTextClass)} aria-live="polite">
                    Showing {allSeats.length} of {totalSeatCount} seats
                </p>
                {nextCursor && (
                    <AppButton
                        type="button"
                        variant="secondary"
                        onClick={() => loadSeats({ cursor: nextCursor, append: true })}
                        isLoading={loadingMore}
                        disabled={loadingMore}
                        aria-describedby="seat-page-progress"
                    >
                        Load more seats
                    </AppButton>
                )}
                {loadMoreError && (
                    <p role="alert" className="text-sm text-[color:var(--ui-tone-danger-text)]">
                        {loadMoreError}
                    </p>
                )}
            </div>

            <SeatDetailsDrawer
                seat={selectedSeat}
                activeShiftName={activeShift?.name}
                selectedShiftId={selectedShift}
                canAllocateSeats={canAllocateSeats}
                showAllocationActions={showAllocationActions}
                allocationDisabledReason={allocationDecision.reason ?? undefined}
                onClose={() => setSelectedSeatId(null)}
                onAllocate={openAllocation}
                onRelease={setReleaseTarget}
            />

            {canManageBranch && (
                <AddSeatDialog
                    isOpen={isAddModalOpen}
                    onClose={() => setIsAddModalOpen(false)}
                    branchId={branchId}
                    onSuccess={() => loadSeats({ revealSeatId: linkedSeatId })}
                />
            )}

            <AllocateSeatDialog
                isOpen={!!allocationSeed}
                branchId={branchId}
                preselectedSeatId={allocationSeed?.seatId}
                preselectedShiftIds={allocationSeed?.shiftIds}
                preselectedShiftNames={allocationSeed?.shiftNames}
                onClose={() => setAllocationSeed(null)}
                onSuccess={() => {
                    void loadSeats({ revealSeatId: linkedSeatId });
                }}
            />

            <ConfirmDialog
                isOpen={!!releaseTarget}
                onClose={() => setReleaseTarget(null)}
                onConfirm={handleReleaseAllocation}
                title="Release allocation?"
                description={
                    releaseTarget ? (
                        <span>
                            End {releaseTarget.studentName}&apos;s allocation for {releaseTarget.shiftName} on seat {releaseTarget.seatLabel}.
                        </span>
                    ) : null
                }
                confirmText="Release seat"
                loading={releaseLoading}
                variant="warning"
            />
        </PageShell>
    );
}

function ShiftFilterPanel({
    selectedShift,
    summaries,
    totalSeats,
    branchTotalSeats,
    totalSlots,
    totalAllocatedSlots,
    onSelect,
}: {
    selectedShift: string;
    summaries: ShiftSummary[];
    totalSeats: number;
    branchTotalSeats: number;
    totalSlots: number;
    totalAllocatedSlots: number;
    onSelect: (shiftId: string) => void;
}) {
    const allPercent = totalSlots === 0 ? 0 : Math.round((totalAllocatedSlots / totalSlots) * 100);
    const selectedSummary = summaries.find((shift) => shift.id === selectedShift);
    const selectedLabel = selectedSummary
        ? `${selectedSummary.allocated}/${selectedSummary.capacity} loaded seats allocated`
        : `${totalAllocatedSlots}/${totalSlots} loaded shift slots used`;

    return (
        <div className="space-y-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Shift scope</h2>
                    <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>Seat status is calculated across the records loaded so far.</p>
                </div>
                <p className={cn("text-xs font-medium", pageMutedTextClass)}>{selectedLabel}</p>
            </div>
            <div className={cn("p-1.5", pageFilterShellClass)}>
                <div className="flex gap-1.5 overflow-x-auto">
                <ShiftFilterChip
                    active={selectedShift === ""}
                    label="All shifts"
                    sublabel={`${totalSeats}/${branchTotalSeats} loaded`}
                    count={`${allPercent}% used`}
                    percent={allPercent}
                    tone="info"
                    onClick={() => onSelect("")}
                />
                {summaries.map((shift) => (
                    <ShiftFilterChip
                        key={shift.id}
                        active={selectedShift === shift.id}
                        label={shift.name}
                        sublabel={shift.timeLabel}
                        count={`${shift.available} free`}
                        percent={shift.percent}
                        tone={shift.tone}
                        onClick={() => onSelect(shift.id)}
                    />
                ))}
                </div>
            </div>
        </div>
    );
}

function ShiftFilterChip({
    active,
    label,
    sublabel,
    count,
    percent,
    tone,
    onClick,
}: {
    active: boolean;
    label: string;
    sublabel: string;
    count: string;
    percent: number;
    tone: "success" | "warning" | "danger" | "info";
    onClick: () => void;
}) {
    const toneClasses = {
        info: {
            active: "border-cyan-300/35 bg-cyan-300/10 text-cyan-100",
            dot: "bg-cyan-300",
            text: "text-cyan-200",
        },
        success: {
            active: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
            dot: "bg-emerald-300",
            text: "text-emerald-200",
        },
        warning: {
            active: "border-amber-300/30 bg-amber-300/10 text-amber-100",
            dot: "bg-amber-300",
            text: "text-amber-200",
        },
        danger: {
            active: "border-rose-300/30 bg-rose-300/10 text-rose-100",
            dot: "bg-rose-300",
            text: "text-rose-200",
        },
    }[tone];

    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "group min-w-[156px] cursor-pointer rounded-[var(--ui-radius-control)] border px-3 py-2 text-left transition-colors",
                active
                    ? cn(toneClasses.active, "shadow-sm shadow-black/20")
                    : "border-transparent bg-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
            )}
        >
            <div className="flex items-center gap-2">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", toneClasses.dot)} />
                <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-sm font-semibold", active ? "text-[color:var(--text-primary)]" : pageMutedTextClass)}>{label}</p>
                    <p className={cn("mt-0.5 truncate text-[11px]", pageSubtleTextClass)}>{sublabel}</p>
                </div>
            </div>
            <p className={cn("mt-2 text-[11px] font-medium", active ? toneClasses.text : pageSubtleTextClass)}>
                {count}
                <span className="ml-1 text-[color:var(--text-muted)]">/ {percent}%</span>
            </p>
        </button>
    );
}

function SeatSummaryBar({
    stats,
    activeShiftName,
    branchTotalSeats,
}: {
    stats: {
        total: number;
        allocated: number;
        available: number;
        allocations: number;
        totalSlots: number;
        utilization: number;
    };
    activeShiftName?: string;
    branchTotalSeats: number;
}) {
    const utilizationLabel = activeShiftName ? "Shift use" : "Slot use";
    const utilizationDetail = activeShiftName
        ? `${stats.allocations}/${stats.total} loaded seats`
        : `${stats.allocations}/${stats.totalSlots} loaded slots`;

    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryMetric label="Loaded seats" value={stats.total} detail={`${branchTotalSeats} total`} tone="neutral" />
            <SummaryMetric label="Allocated" value={stats.allocated} detail={`${stats.allocations} loaded active slot${stats.allocations === 1 ? "" : "s"}`} tone="success" />
            <SummaryMetric label="Available" value={stats.available} detail={activeShiftName ? `Loaded in ${activeShiftName}` : "Loaded unallocated seats"} tone="warning" />
            <SummaryMetric label={utilizationLabel} value={`${stats.utilization}%`} detail={utilizationDetail} tone={getShiftTone(stats.utilization)} />
        </div>
    );
}

function SummaryMetric({
    label,
    value,
    detail,
    tone,
}: {
    label: string;
    value: string | number;
    detail: string;
    tone: "neutral" | "success" | "warning" | "danger" | "info";
}) {
    const valueClass = {
        neutral: "text-[color:var(--text-primary)]",
        success: "text-emerald-200",
        warning: "text-amber-200",
        danger: "text-rose-200",
        info: "text-cyan-200",
    }[tone];

    return (
        <div className={pageInsetMetricClass}>
            <p className={cn("text-[11px] font-medium uppercase tracking-wide", pageSubtleTextClass)}>{label}</p>
            <div className="mt-1 flex items-baseline justify-between gap-3">
                <p className={cn("text-xl font-semibold tracking-tight", valueClass)}>{value}</p>
                <p className={cn("truncate text-xs", pageSubtleTextClass)}>{detail}</p>
            </div>
        </div>
    );
}

function StatusFilterChip({
    filter,
    active,
    onClick,
}: {
    filter: { value: StatusFilter; label: string; count: number };
    active: boolean;
    onClick: () => void;
}) {
    const tone = filter.value === "ALLOCATED"
        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
        : filter.value === "AVAILABLE"
            ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
            : "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";

    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "inline-flex h-11 cursor-pointer items-center gap-2 rounded-[var(--ui-radius-control)] border px-2.5 text-xs font-semibold transition-colors lg:h-8",
                active ? tone : cn(pageInsetSurfaceClass, pageInsetHoverClass, "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]")
            )}
        >
            {filter.label}
            <span className="rounded-full bg-[color:var(--ui-table-action-bg)] px-1.5 py-0.5 text-[10px] text-[color:var(--text-primary)]">
                {filter.count}
            </span>
        </button>
    );
}

function SeatGrid({
    seats,
    selectedSeatId,
    focusedSeatId,
    selectedShiftId,
    canAllocateSeats,
    showAllocationActions,
    allocationDisabledReason,
    onInspect,
    onAllocate,
}: {
    seats: SeatWithStatus[];
    selectedSeatId: string | null;
    focusedSeatId: string | null;
    selectedShiftId: string;
    canAllocateSeats: boolean;
    showAllocationActions: boolean;
    allocationDisabledReason?: string;
    onInspect: (seatId: string) => void;
    onAllocate: (seat: SeatWithStatus) => void;
}) {
    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {seats.map(seat => {
                const allocated = seat.status === "Allocated";
                const allocationEligible = !selectedShiftId || !allocated;
                const studentNames = getUniqueStudentNames(seat.allocations);
                const shiftText = allocated
                    ? seat.allocations.map(getAllocationShiftLabel).join(", ")
                    : selectedShiftId ? "Open in selected shift" : "No active allocation";

                return (
                    <article
                        key={seat.id}
                        id={`seat-record-${seat.id}`}
                        tabIndex={-1}
                        aria-label={`Seat ${seat.label}`}
                        aria-current={focusedSeatId === seat.id ? "true" : undefined}
                        className={cn(
                            "flex min-h-[150px] flex-col p-3.5",
                            pageGridCardClass,
                            pageGridCardHoverClass,
                            selectedSeatId === seat.id || focusedSeatId === seat.id ? "border-cyan-400/40 bg-cyan-400/[0.05]" : "border-[color:var(--ui-card-border)] hover:border-[color:var(--ui-card-hover-border)]",
                            allocated ? "shadow-[inset_2px_0_0_rgba(52,211,153,0.6)]" : "border-dashed shadow-[inset_2px_0_0_rgba(251,191,36,0.45)]"
                        )}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="truncate text-base font-semibold text-[color:var(--text-primary)]">{seat.label}</p>
                                <p className={cn("mt-1 truncate text-xs", pageSubtleTextClass)}>{shiftText}</p>
                            </div>
                            <SeatStatusBadge status={seat.status} />
                        </div>

                        <div className="mt-3 min-h-[42px] flex-1">
                            <p className={cn("truncate text-sm font-medium", allocated ? "text-[color:var(--text-primary)]" : "text-[color:var(--ui-tone-warning-text)]")}>
                                {allocated ? studentNames.join(", ") || "Student" : "Available"}
                            </p>
                            <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>
                                {allocated
                                    ? `${seat.allocations.length} allocation${seat.allocations.length === 1 ? "" : "s"}`
                                    : "Ready to assign"}
                            </p>
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-2">
                            <AppButton type="button" variant="quiet" size="sm" onClick={() => onInspect(seat.id)}>
                                Details
                            </AppButton>
                            {showAllocationActions && allocationEligible && (
                                <AppButton
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    icon={UserPlus}
                                    onClick={() => onAllocate(seat)}
                                    disabled={!canAllocateSeats}
                                    title={canAllocateSeats ? undefined : allocationDisabledReason}
                                >
                                    {allocated ? "Add shift" : "Assign"}
                                </AppButton>
                            )}
                        </div>
                    </article>
                );
            })}
        </div>
    );
}

function SeatList({
    seats,
    focusedSeatId,
    selectedShiftId,
    canAllocateSeats,
    showAllocationActions,
    allocationDisabledReason,
    onInspect,
    onAllocate,
}: {
    seats: SeatWithStatus[];
    focusedSeatId: string | null;
    selectedShiftId: string;
    canAllocateSeats: boolean;
    showAllocationActions: boolean;
    allocationDisabledReason?: string;
    onInspect: (seatId: string) => void;
    onAllocate: (seat: SeatWithStatus) => void;
}) {
    return (
        <div className={pageTableShellClass}>
            <div className="overflow-x-auto" role="region" aria-label="Loaded seat inventory" tabIndex={0}>
                <table className="w-full min-w-[760px] text-left text-sm">
                    <caption className="sr-only">Loaded seat inventory and active allocations</caption>
                    <thead className={pageTableHeadClass}>
                        <tr>
                            <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-textSecondary">Seat</th>
                            <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-textSecondary">Status</th>
                            <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-textSecondary">Students</th>
                            <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-textSecondary">Shift coverage</th>
                            <th scope="col" className="px-5 py-4 text-right text-xs font-medium uppercase tracking-wider text-textSecondary">Actions</th>
                        </tr>
                    </thead>
                    <tbody className={pageTableBodyDividerClass}>
                        {seats.map(seat => {
                            const allocated = seat.status === "Allocated";
                            const allocationEligible = !selectedShiftId || !allocated;
                            const studentNames = getUniqueStudentNames(seat.allocations);

                            return (
                                <tr
                                    key={seat.id}
                                    id={`seat-record-${seat.id}`}
                                    tabIndex={-1}
                                    aria-current={focusedSeatId === seat.id ? "true" : undefined}
                                    className={cn(pageTableRowClass, focusedSeatId === seat.id && "bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60")}
                                >
                                    <th scope="row" className="px-5 py-4 text-left font-normal">
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]">
                                                <Armchair size={16} />
                                            </div>
                                            <div>
                                                <p className="font-medium text-[color:var(--text-primary)]">{seat.label}</p>
                                                <p className="text-xs text-textMuted">{seat.allocations.length} allocation{seat.allocations.length === 1 ? "" : "s"}</p>
                                            </div>
                                        </div>
                                    </th>
                                    <td className="px-5 py-4">
                                        <SeatStatusBadge status={seat.status} />
                                    </td>
                                    <td className="px-5 py-4 text-textSecondary">
                                        {studentNames.length > 0 ? studentNames.join(", ") : "No student"}
                                    </td>
                                    <td className="px-5 py-4 text-textSecondary">
                                        {allocated ? seat.allocations.map(getAllocationShiftLabel).join(", ") : "Open"}
                                    </td>
                                    <td className="px-5 py-4">
                                        <div className="flex justify-end gap-2">
                                            <AppButton type="button" variant="quiet" size="sm" onClick={() => onInspect(seat.id)}>
                                                Details
                                            </AppButton>
                                            {showAllocationActions && allocationEligible && (
                                                <AppButton
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    icon={UserPlus}
                                                    onClick={() => onAllocate(seat)}
                                                    disabled={!canAllocateSeats}
                                                    title={canAllocateSeats ? undefined : allocationDisabledReason}
                                                >
                                                    Assign
                                                </AppButton>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function SeatStatusBadge({ status }: { status: SeatStatus }) {
    return (
        <Badge variant={status === "Allocated" ? "success" : "warning"}>
            {status}
        </Badge>
    );
}

function SeatEmptyState({
    hasSeats,
    canManageBranch,
    showManageAction,
    disabledReason,
    onAddSeat,
}: {
    hasSeats: boolean;
    canManageBranch: boolean;
    showManageAction: boolean;
    disabledReason?: string;
    onAddSeat: () => void;
}) {
    return (
        <div className={pageEmptyStateClass}>
            <div className={cn("flex h-14 w-14 items-center justify-center", pageInsetSurfaceClass, pageMutedTextClass)}>
                {hasSeats ? <SearchX size={24} /> : <Armchair size={24} />}
            </div>
            <h3 className="mt-4 text-lg font-semibold text-[color:var(--text-primary)]">
                {hasSeats ? "No seats match this view" : "No seats yet"}
            </h3>
            <p className="mt-2 max-w-md text-sm text-textSecondary">
                {hasSeats
                    ? "Try a different search, status, or shift filter."
                    : "Create the physical seats first, then assign active students into the right shifts."}
            </p>
            {!hasSeats && showManageAction && (
                <AppButton
                    type="button"
                    variant="primary"
                    icon={UserPlus}
                    className="mt-5"
                    onClick={onAddSeat}
                    disabled={!canManageBranch}
                    title={canManageBranch ? undefined : disabledReason}
                >
                    Add first seat
                </AppButton>
            )}
        </div>
    );
}

function SeatDetailsDrawer({
    seat,
    activeShiftName,
    selectedShiftId,
    canAllocateSeats,
    showAllocationActions,
    allocationDisabledReason,
    onClose,
    onAllocate,
    onRelease,
}: {
    seat: SeatWithStatus | null;
    activeShiftName?: string;
    selectedShiftId: string;
    canAllocateSeats: boolean;
    showAllocationActions: boolean;
    allocationDisabledReason?: string;
    onClose: () => void;
    onAllocate: (seat: SeatWithStatus) => void;
    onRelease: (target: ReleaseTarget) => void;
}) {
    if (!seat) return null;

    const allocated = seat.status === "Allocated";
    const studentNames = getUniqueStudentNames(seat.allocations);
    const allocationEligible = !selectedShiftId || !allocated;

    return (
        <Drawer
            open
            onClose={onClose}
            title={`Seat ${seat.label}`}
            description={allocated ? studentNames.join(", ") || "Allocated" : "Available for assignment"}
            closeLabel="Close seat details"
            className="max-w-lg"
            footer={
                showAllocationActions && allocationEligible ? (
                    <AppButton
                        type="button"
                        variant="primary"
                        icon={UserPlus}
                        className="w-full"
                        onClick={() => onAllocate(seat)}
                        disabled={!canAllocateSeats}
                        title={canAllocateSeats ? undefined : allocationDisabledReason}
                    >
                        {allocated ? "Add another shift allocation" : "Assign this seat"}
                    </AppButton>
                ) : allocationEligible ? null : (
                    <div className={cn("w-full px-4 py-3 text-sm", formWarningBannerClass)}>
                        This seat is already allocated in the selected shift.
                    </div>
                )
            }
        >
            <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                    <SeatStatusBadge status={seat.status} />
                    {activeShiftName ? (
                        <span className="rounded-full border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-textSecondary">
                            {activeShiftName}
                        </span>
                    ) : null}
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div className={cn("p-3", formSurfaceClass)}>
                        <p className="text-xs uppercase tracking-wide text-textMuted">Allocations</p>
                        <p className="mt-2 text-xl font-semibold text-[color:var(--text-primary)]">{seat.allocations.length}</p>
                    </div>
                    <div className={cn("p-3", formSurfaceClass)}>
                        <p className="text-xs uppercase tracking-wide text-textMuted">Scope</p>
                        <p className="mt-2 truncate text-sm font-medium text-[color:var(--text-primary)]">{activeShiftName ?? "All shifts"}</p>
                    </div>
                </div>

                <div>
                    <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Active allocations</h3>
                        {allocated ? <Badge variant="purple">{seat.allocations.length}</Badge> : null}
                    </div>

                    {seat.allocations.length === 0 ? (
                        <div className={cn("rounded-[var(--ui-radius-control)] border border-dashed border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-4 text-sm", formHelpTextClass)}>
                            No active allocation in this view.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {seat.allocations.map(allocation => (
                                <div key={allocation.id} className={cn("p-4", formSurfaceClass)}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                                                    <User size={15} />
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="truncate font-medium text-[color:var(--text-primary)]">{allocation.student?.name ?? "Student"}</p>
                                                    <p className="truncate text-xs text-textMuted">{allocation.student?.phone ?? "No phone"}</p>
                                                </div>
                                            </div>
                                            <div className="mt-3 space-y-1.5 text-xs text-textSecondary">
                                                <div className="flex items-center gap-2">
                                                    <CalendarClock size={13} className="text-cyan-300" />
                                                    <span>{getAllocationShiftLabel(allocation)}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Clock size={13} className="text-amber-300" />
                                                    <span>{formatTimeRange(allocation.shift?.startTime, allocation.shift?.endTime)}</span>
                                                </div>
                                            </div>
                                        </div>
                                        {showAllocationActions ? (
                                            <AppButton
                                                type="button"
                                                variant="danger"
                                                size="sm"
                                                icon={LogOut}
                                                disabled={!canAllocateSeats}
                                                title={canAllocateSeats ? undefined : allocationDisabledReason}
                                                onClick={() => onRelease({
                                                    id: allocation.id,
                                                    seatLabel: seat.label,
                                                    studentName: allocation.student?.name ?? "Student",
                                                    shiftName: getAllocationShiftLabel(allocation),
                                                })}
                                            >
                                                Release
                                            </AppButton>
                                        ) : null}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </Drawer>
    );
}
