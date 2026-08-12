"use client";

import { Suspense, type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { AllocationsTable } from "@/components/allocations/AllocationsTable";
import { AllocateSeatDialog } from "@/components/allocations/AllocateSeatDialog";
import { UpdateAllocationDialog } from "@/components/allocations/UpdateAllocationDialog";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { ViewToggle } from "@/components/tables/ViewToggle";
import { useDataViewMode } from "@/hooks/useDataViewMode";
import { AppButton, AppSelect, PageLoadingSkeleton, PageShell } from "@/components/ui";
import {
    pageCountBadgeClass,
    pageDescriptionClass,
    pageEmptyStateClass,
    pageEyebrowClass,
    pageErrorIconClass,
    pageErrorStateClass,
    pageInsetMetricClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";
import { AlertCircle, ArrowRightLeft, CalendarCheck, UserPlus, Users } from "lucide-react";
import { seats } from "@/lib/api/seats";
import { branches } from "@/lib/api/branches";
import type { Shift } from "@/app/generated/prisma/browser";
import type { MultiShiftSummary, ShiftScope } from "@/types";
import type { CapabilityDecision, PagedResult } from "@/types/ui";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import { getAtomicReleaseAllocationId } from "@/lib/seatViewState";

interface AllocationRow {
    id: string;
    studentId: string;
    student: { name: string; status: string; monthlyFee?: number | null };
    seat: { id: string; label: string };
    shiftId: string;
    shift: { name: string; isReserved: boolean };
    startDate: string;
    endDate: string | null;
    multiShiftId: string | null;
    multiShift?: { id: string; name: string } | null;
}

type AllocationTab = "ACTIVE" | "ENDED";

const EMPTY_TOTALS: Record<AllocationTab, number> = { ACTIVE: 0, ENDED: 0 };
const EMPTY_CURSORS: Record<AllocationTab, string | null> = { ACTIVE: null, ENDED: null };

function shiftScopeValue(scope: ShiftScope) {
    return scope.kind === "all" ? "all" : `${scope.kind}:${scope.id}`;
}

function shiftScopeFromValue(value: string): ShiftScope {
    if (value === "all") return { kind: "all" };
    const [kind, id] = value.split(":", 2);
    return kind === "multi" ? { kind: "multi", id } : { kind: "primary", id };
}

function mergeAllocationRows(current: AllocationRow[], incoming: AllocationRow[]) {
    const byId = new Map(current.map(allocation => [allocation.id, allocation]));
    incoming.forEach(allocation => byId.set(allocation.id, allocation));
    return Array.from(byId.values());
}

export default function AllocationsPage() {
    const params = useParams();
    const branchId = params?.branchId as string;

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.allocations}>
            {access => (
                <Suspense fallback={<PageLoadingSkeleton label="Loading allocations" variant="table" rows={6} />}>
                    <AllocationsContent
                        branchId={branchId}
                        manageDecision={getBranchCapabilityDecision(access, "allocationsManage")}
                    />
                </Suspense>
            )}
        </BranchAccessGuard>
    );
}

function AllocationsContent({
    branchId,
    manageDecision,
}: {
    branchId: string;
    manageDecision: CapabilityDecision;
}) {
    const canManageAllocations = manageDecision.allowed;
    const showManageActions = manageDecision.blocker !== "permission";
    const searchParams = useSearchParams();
    const router = useRouter();
    const loadSequence = useRef(0);

    const [allocations, setAllocations] = useState<AllocationRow[]>([]);
    const [nextCursors, setNextCursors] = useState<Record<AllocationTab, string | null>>(EMPTY_CURSORS);
    const [allocationTotals, setAllocationTotals] = useState<Record<AllocationTab, number>>(EMPTY_TOTALS);
    const [loading, setLoading] = useState(true);
    const [loadingMoreTab, setLoadingMoreTab] = useState<AllocationTab | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [linkedRecordError, setLinkedRecordError] = useState<string | null>(null);
    const [scopeFeedback, setScopeFeedback] = useState<string | null>(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<AllocationTab>("ACTIVE");
    const [shiftScope, setShiftScope] = useState<ShiftScope>({ kind: "all" });
    const [shifts, setShifts] = useState<Shift[]>([]);
    const [multiShifts, setMultiShifts] = useState<MultiShiftSummary[]>([]);
    const [shiftOptionsLoaded, setShiftOptionsLoaded] = useState(false);
    const [viewMode, setViewMode] = useDataViewMode();

    // Optional: pre-selected student passed via query param from students page
    const preselectedStudentId = searchParams.get("studentId") ?? undefined;
    const preselectedStudentName = searchParams.get("studentName") ?? undefined;
    // Change seat: navigated from students page with existing allocation
    const changeStudentId = searchParams.get("changeStudentId") ?? undefined;
    const changeStudentName = searchParams.get("studentName") ?? undefined;
    const linkedAllocationId = searchParams.get("allocationId") ?? undefined;
    const linkedStatus = searchParams.get("status");

    const [updateTarget, setUpdateTarget] = useState<{
        ids: string[];
        studentId: string;
        studentName: string;
        currentSeatId: string;
        currentFee: number | null;
        currentShiftIds: string[];
        currentMultiShiftId: string | null;
    } | null>(null);

    // Auto-open dialog when navigated from students page with ?studentId=...
    useEffect(() => {
        if (preselectedStudentId && canManageAllocations) {
            setIsDialogOpen(true);
        }
    }, [canManageAllocations, preselectedStudentId]);

    useEffect(() => {
        if (linkedStatus === "ACTIVE" || linkedStatus === "ENDED") {
            setActiveTab(linkedStatus);
        }
    }, [linkedStatus]);

    useEffect(() => {
        let cancelled = false;
        Promise.all([branches.getShifts(branchId), branches.getMultiShifts(branchId)])
            .then(([primaryShifts, bundleShifts]) => {
                if (cancelled) return;
                setShifts(primaryShifts);
                setMultiShifts(bundleShifts);
                setShiftOptionsLoaded(true);
            })
            .catch(() => {
                if (!cancelled) setScopeFeedback("Shift filters could not be loaded.");
            });
        return () => { cancelled = true; };
    }, [branchId]);

    useEffect(() => {
        if (!shiftOptionsLoaded || shiftScope.kind !== "multi") return;
        if (multiShifts.some(multiShift => multiShift.id === shiftScope.id)) return;
        setShiftScope({ kind: "all" });
        setScopeFeedback("That multi-shift is no longer available. Showing all shifts.");
    }, [multiShifts, shiftOptionsLoaded, shiftScope]);

    const shiftFilterOptions = useMemo(() => [
        { value: "all", label: "All Shifts" },
        ...shifts.map(shift => ({ value: `primary:${shift.id}`, label: shift.name })),
        ...multiShifts.map(multiShift => ({ value: `multi:${multiShift.id}`, label: multiShift.name })),
    ], [multiShifts, shifts]);

    // Auto-open update dialog when navigated with ?changeStudentId=...
    useEffect(() => {
        if (!canManageAllocations || !changeStudentId || allocations.length === 0) return;
        // Find the active allocation(s) for this student
        const studentAllocs = allocations.filter(
            (a) => a.studentId === changeStudentId && !a.endDate
        );
        if (studentAllocs.length === 0) return;
        // Group by multiShiftId
        const ids = studentAllocs.map((a) => a.id);
        setUpdateTarget({
            ids,
            studentId: changeStudentId,
            studentName: changeStudentName || studentAllocs[0]?.student?.name || "",
            currentSeatId: studentAllocs[0]?.seat?.id || "",
            currentFee: studentAllocs[0]?.student?.monthlyFee ?? null,
            currentShiftIds: studentAllocs.map((a) => a.shiftId),
            currentMultiShiftId: studentAllocs[0]?.multiShiftId ?? null,
        });
        // Clear query param
        router.replace(`/branch/${branchId}/allocations`);
    }, [allocations, branchId, canManageAllocations, changeStudentId, changeStudentName, router]);

    const fetchAllocations = useCallback(async () => {
        const sequence = ++loadSequence.current;
        setLoading(true);
        try {
            setError(null);
            setLinkedRecordError(null);

            const scopeFilters = {
                shiftId: shiftScope.kind === "primary" ? shiftScope.id : undefined,
                multiShiftId: shiftScope.kind === "multi" ? shiftScope.id : undefined,
            };

            let [activePage, endedPage] = await Promise.all([
                seats.listAllocations<AllocationRow>(branchId, { status: "ACTIVE", ...scopeFilters }),
                seats.listAllocations<AllocationRow>(branchId, { status: "ENDED", ...scopeFilters }),
            ]);

            const loadUntil = async (
                status: AllocationTab,
                initialPage: PagedResult<AllocationRow>,
                predicate: (allocation: AllocationRow) => boolean
            ) => {
                let page = initialPage;
                let items = [...page.items];
                while (!items.some(predicate) && page.nextCursor) {
                    page = await seats.listAllocations<AllocationRow>(branchId, {
                        status,
                        cursor: page.nextCursor,
                        ...scopeFilters,
                    });
                    items = mergeAllocationRows(items, page.items);
                }
                return { ...page, items };
            };

            if (changeStudentId) {
                const studentAllocations = await seats.listAllocations<AllocationRow>(branchId, {
                    status: "ACTIVE",
                    studentId: changeStudentId,
                    all: true,
                });
                activePage = {
                    ...activePage,
                    items: mergeAllocationRows(activePage.items, studentAllocations.items),
                };
            }

            if (linkedAllocationId) {
                activePage = await loadUntil(
                    "ACTIVE",
                    activePage,
                    allocation => allocation.id === linkedAllocationId
                );
                if (!activePage.items.some(allocation => allocation.id === linkedAllocationId)) {
                    endedPage = await loadUntil(
                        "ENDED",
                        endedPage,
                        allocation => allocation.id === linkedAllocationId
                    );
                }
            }

            if (sequence !== loadSequence.current) return;

            setAllocations([...activePage.items, ...endedPage.items]);
            setNextCursors({ ACTIVE: activePage.nextCursor, ENDED: endedPage.nextCursor });
            setAllocationTotals({ ACTIVE: activePage.total, ENDED: endedPage.total });

            if (linkedAllocationId) {
                const target = [...activePage.items, ...endedPage.items]
                    .find(allocation => allocation.id === linkedAllocationId);
                if (target) {
                    setActiveTab(target.endDate ? "ENDED" : "ACTIVE");
                } else {
                    setLinkedRecordError("The linked allocation could not be found in this branch.");
                }
            }
        } catch (err: unknown) {
            if (sequence === loadSequence.current) {
                if (
                    shiftScope.kind === "multi"
                    && err instanceof Error
                    && err.message.toLowerCase().includes("not found")
                ) {
                    setShiftScope({ kind: "all" });
                    setScopeFeedback("That multi-shift is no longer available. Showing all shifts.");
                } else {
                    setError(err instanceof Error ? err.message : "Failed to load allocations");
                }
            }
        } finally {
            if (sequence === loadSequence.current) setLoading(false);
        }
    }, [branchId, changeStudentId, linkedAllocationId, shiftScope]);

    const loadMoreAllocations = useCallback(async (status: AllocationTab) => {
        const cursor = nextCursors[status];
        if (!cursor || loadingMoreTab) return;

        setLoadingMoreTab(status);
        setLoadMoreError(null);
        try {
            const page = await seats.listAllocations<AllocationRow>(branchId, {
                status,
                cursor,
                shiftId: shiftScope.kind === "primary" ? shiftScope.id : undefined,
                multiShiftId: shiftScope.kind === "multi" ? shiftScope.id : undefined,
            });
            setAllocations(current => mergeAllocationRows(current, page.items));
            setNextCursors(current => ({ ...current, [status]: page.nextCursor }));
            setAllocationTotals(current => ({ ...current, [status]: page.total }));
        } catch (loadError) {
            setLoadMoreError(loadError instanceof Error ? loadError.message : "Failed to load more allocations.");
        } finally {
            setLoadingMoreTab(null);
        }
    }, [branchId, loadingMoreTab, nextCursors, shiftScope]);

    useEffect(() => {
        if (!branchId) return;
        void fetchAllocations();
    }, [branchId, fetchAllocations]);

    useEffect(() => {
        if (!linkedAllocationId || !allocations.some(allocation => allocation.id === linkedAllocationId)) return;
        const frame = window.requestAnimationFrame(() => {
            const candidates = [
                document.getElementById(`allocation-record-${linkedAllocationId}-card`),
                document.getElementById(`allocation-record-${linkedAllocationId}-row`),
            ];
            const target = candidates.find(candidate => candidate && candidate.getClientRects().length > 0);
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({
                block: "center",
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [activeTab, allocations, linkedAllocationId, viewMode]);

    const handleEndAllocation = async (ids: string | string[]) => {
        if (!manageDecision.allowed) {
            throw new Error(manageDecision.reason ?? "Allocation changes are unavailable.");
        }
        // A grouped multi-shift is released atomically by the server when any
        // one component allocation is ended. Sending every component would
        // turn the successful first release into a false "already ended" error.
        const allocationId = getAtomicReleaseAllocationId(ids);
        const res = await fetch(`/api/seat-allocations/${allocationId}/end`, {
            method: "POST",
        });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || "Failed to end allocation");
        }
        await fetchAllocations();
    };

    const handleClose = () => {
        setIsDialogOpen(false);
        // Clear studentId query param if present
        if (preselectedStudentId) {
            router.replace(`/branch/${branchId}/allocations`);
        }
    };

    const openAllocateDialog = () => {
        if (!manageDecision.allowed) return;
        setIsDialogOpen(true);
    };

    const allocationCounts = useMemo(() => {
        const multiShift = allocations.filter(alloc => alloc.multiShiftId || alloc.multiShift).length;
        return { active: allocationTotals.ACTIVE, ended: allocationTotals.ENDED, multiShift };
    }, [allocationTotals, allocations]);

    if (loading) return <PageLoadingSkeleton label="Loading allocations" variant="table" rows={6} />;

    if (error) return (
        <div className={pageErrorStateClass}>
            <AlertCircle className={pageErrorIconClass} />
            <h2 className="text-xl font-semibold">Allocations did not load</h2>
            <p className={pageMutedTextClass}>{error}</p>
            <AppButton variant="secondary" onClick={() => fetchAllocations()}>
                Try again
            </AppButton>
        </div>
    );

    const filteredAllocations = allocations.filter(alloc => 
        activeTab === "ACTIVE" ? !alloc.endDate : !!alloc.endDate
    );

    return (
        <PageShell>
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className={pageEyebrowClass}>Seat workflow</p>
                    <h1 className={cn(pageTitleClass, "mt-2 truncate")}>Allocations</h1>
                    <p className={pageDescriptionClass}>
                        Keep current seat assignments visible, then move quickly into changes, releases, or allocation history.
                    </p>
                </div>

                {showManageActions ? (
                    <AppButton
                        variant="primary"
                        icon={UserPlus}
                        onClick={openAllocateDialog}
                        disabled={!canManageAllocations}
                        title={canManageAllocations ? undefined : manageDecision.reason ?? undefined}
                    >
                        Allocate seat
                    </AppButton>
                ) : null}
            </header>

            {!canManageAllocations ? (
                <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)}>
                    Allocation changes are disabled. {manageDecision.reason}
                    {manageDecision.recoveryHref ? (
                        <a href={manageDecision.recoveryHref} className="ml-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                            Review billing
                        </a>
                    ) : null}
                </div>
            ) : null}

            <section className="grid gap-3 sm:grid-cols-3">
                <AllocationMetric icon={Users} label="Active" value={allocationCounts.active} detail="Current seat assignments" tone="success" />
                <AllocationMetric icon={CalendarCheck} label="Ended" value={allocationCounts.ended} detail="Historical allocations" tone="neutral" />
                <AllocationMetric icon={ArrowRightLeft} label="Loaded multi-shift" value={allocationCounts.multiShift} detail="Loaded linked assignments" tone="info" />
            </section>

            {linkedRecordError && (
                <p role="alert" className="text-sm text-[color:var(--ui-tone-danger-text)]">
                    {linkedRecordError}
                </p>
            )}

            {scopeFeedback && (
                <p role="status" className="text-sm text-[color:var(--ui-tone-warning-text)]">
                    {scopeFeedback}
                </p>
            )}

            <div className={cn("flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between", pageSectionDividerClass)}>
                <div role="group" className="flex max-w-full items-center gap-2 overflow-x-auto" aria-label="Allocation status filter">
                    {(["ACTIVE", "ENDED"] as const).map(tab => {
                        const active = activeTab === tab;
                        const count = tab === "ACTIVE" ? allocationCounts.active : allocationCounts.ended;
                        const selectedClassName = tab === "ACTIVE"
                            ? "border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] text-[color:var(--ui-badge-success-text)]"
                            : "border-[color:var(--ui-badge-default-border)] bg-[color:var(--ui-badge-default-bg)] text-[color:var(--ui-badge-default-text)]";
                        const dotClassName = tab === "ACTIVE"
                            ? "bg-[color:var(--ui-badge-success-text)]"
                            : "bg-[color:var(--ui-badge-default-text)]";

                        return (
                            <button
                                type="button"
                                key={tab}
                                onClick={() => setActiveTab(tab)}
                                aria-pressed={active}
                                className={cn(
                                    "inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-[var(--ui-radius-control)] border px-3 text-sm font-medium transition-colors",
                                    active ? selectedClassName : "border-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
                                )}
                            >
                                {active && <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dotClassName)} />}
                                {tab === "ACTIVE" ? "Active" : "Ended"}
                                <span className={pageCountBadgeClass}>{count}</span>
                            </button>
                        );
                    })}
                </div>

                <div className="flex items-center gap-2">
                    <AppSelect
                        aria-label="Filter allocations by shift"
                        containerClassName="min-w-48"
                        value={shiftScopeValue(shiftScope)}
                        options={shiftFilterOptions}
                        onValueChange={value => {
                            setScopeFeedback(null);
                            setShiftScope(shiftScopeFromValue(value));
                        }}
                    />
                    <ViewToggle value={viewMode} onChange={setViewMode} className="hidden md:inline-flex" />
                </div>
            </div>

            {filteredAllocations.length === 0 ? (
                <div className={pageEmptyStateClass}>
                    <Users size={34} className="mb-4 opacity-60" />
                    <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
                        No {activeTab === "ACTIVE" ? "active" : "ended"} allocations
                    </h2>
                    <p className={cn("mt-2 max-w-md text-sm", pageMutedTextClass)}>
                        {activeTab === "ACTIVE"
                            ? "No seats are currently allocated. Assign a student to a seat when they are ready to start."
                            : "Ended allocations will appear here after seats are released."}
                    </p>
                    {activeTab === "ACTIVE" && showManageActions && (
                        <AppButton
                            className="mt-5"
                            variant="primary"
                            icon={UserPlus}
                            onClick={openAllocateDialog}
                            disabled={!canManageAllocations}
                            title={canManageAllocations ? undefined : manageDecision.reason ?? undefined}
                        >
                            Allocate seat
                        </AppButton>
                    )}
                </div>
            ) : (
                <AllocationsTable
                    allocations={filteredAllocations}
                    viewMode={viewMode}
                    highlightedAllocationId={linkedAllocationId}
                    onEndAllocation={handleEndAllocation}
                    showActions={showManageActions}
                    actionsEnabled={canManageAllocations}
                    actionsDisabledReason={manageDecision.reason ?? undefined}
                    onUpdateAllocation={(ids, studentId, studentName, currentSeatId, currentFee, currentShiftIds, currentMultiShiftId) =>
                        canManageAllocations
                            ? setUpdateTarget({ ids, studentId, studentName, currentSeatId, currentFee, currentShiftIds, currentMultiShiftId })
                            : undefined
                    }
                    isEndedTab={activeTab === "ENDED"}
                />
            )}

            <div className="flex flex-col items-center gap-2" aria-busy={loadingMoreTab === activeTab}>
                <p id="allocation-page-progress" className={cn("text-sm", pageMutedTextClass)} aria-live="polite">
                    Showing {filteredAllocations.length} of {allocationTotals[activeTab]} {activeTab.toLowerCase()} allocations
                </p>
                {nextCursors[activeTab] && (
                    <AppButton
                        type="button"
                        variant="secondary"
                        onClick={() => void loadMoreAllocations(activeTab)}
                        isLoading={loadingMoreTab === activeTab}
                        disabled={loadingMoreTab !== null}
                        aria-describedby="allocation-page-progress"
                    >
                        Load more {activeTab.toLowerCase()} allocations
                    </AppButton>
                )}
                {loadMoreError && (
                    <p role="alert" className="text-sm text-[color:var(--ui-tone-danger-text)]">
                        {loadMoreError}
                    </p>
                )}
            </div>

            {canManageAllocations ? (
                <AllocateSeatDialog
                    branchId={branchId}
                    isOpen={isDialogOpen}
                    preselectedStudentId={preselectedStudentId}
                    preselectedStudentName={preselectedStudentName}
                    onClose={handleClose}
                    onSuccess={() => {
                        fetchAllocations();
                        handleClose();
                    }}
                />
            ) : null}

            {/* Update (change seat/shift) dialog */}
            {canManageAllocations && updateTarget && (
                <UpdateAllocationDialog
                    isOpen={!!updateTarget}
                    branchId={branchId}
                    allocationId={updateTarget.ids[0]}
                    allocationIds={updateTarget.ids}
                    studentId={updateTarget.studentId}
                    studentName={updateTarget.studentName}
                    currentSeatId={updateTarget.currentSeatId}
                    currentFee={updateTarget.currentFee}
                    currentShiftIds={updateTarget.currentShiftIds}
                    currentMultiShiftId={updateTarget.currentMultiShiftId}
                    onClose={() => setUpdateTarget(null)}
                    onSuccess={() => {
                        fetchAllocations();
                        setUpdateTarget(null);
                    }}
                />
            )}
        </PageShell>
    );
}

function AllocationMetric({
    icon: Icon,
    label,
    value,
    detail,
    tone,
}: {
    icon: ComponentType<{ size?: number; className?: string }>;
    label: string;
    value: number;
    detail: string;
    tone: "success" | "neutral" | "info";
}) {
    const toneClass = tone === "success"
        ? "text-[color:var(--ui-tone-success-text)]"
        : tone === "info"
            ? "text-[color:var(--ui-tone-info-text)]"
            : "text-[color:var(--text-primary)]";

    return (
        <div className={cn("flex items-start gap-3", pageInsetMetricClass)}>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[color:var(--ui-form-muted-surface-bg)]">
                <Icon size={17} className={toneClass} />
            </div>
            <div className="min-w-0">
                <p className={cn("text-xs font-medium uppercase tracking-wide", pageSubtleTextClass)}>{label}</p>
                <p className={cn("mt-1 text-2xl font-semibold tracking-tight", toneClass)}>{value}</p>
                <p className={cn("mt-1 text-xs", pageMutedTextClass)}>{detail}</p>
            </div>
        </div>
    );
}
