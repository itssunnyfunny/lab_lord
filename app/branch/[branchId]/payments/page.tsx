"use client";

import { DataTable } from "@/components/tables/DataTable";
import { ViewToggle } from "@/components/tables/ViewToggle";
import { Badge } from "@/components/ui/Badge";
import { AppButton, Dialog, LoadingTableSkeleton, PageShell, useToast } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RowActionsMenu } from "@/components/ui/RowActionsMenu";
import {
    formControlClass,
    formHelpTextClass,
    formIconClass,
    formSurfaceClass,
    formSurfaceHoverClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import {
    pageCountBadgeClass,
    pageDescriptionClass,
    pageEyebrowClass,
    pageErrorIconClass,
    pageErrorStateClass,
    pageFilterShellClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetMetricClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
    pageTitleClass,
} from "@/components/ui/pageSurface";
import { PaymentAuditLog } from "@/components/payments/PaymentAuditLog";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { AlertCircle, ArrowLeft, Check, ChevronLeft, ChevronRight, History, Ban, MoreHorizontal, Banknote, Smartphone, Building2 } from "lucide-react";
import { useCallback, useEffect, useState, use } from "react";
import { payments, type PaymentListItem } from "@/lib/api/payments";
import { format, addMonths, subMonths } from "date-fns";
import { isOverdue } from "@/lib/utils/paymentStatus";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { getAnyPermissionHelpText } from "@/lib/permissionMessages";
import { useDataViewMode } from "@/hooks/useDataViewMode";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import type { CapabilityDecision } from "@/types";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";

type PaymentRow = PaymentListItem;

type PaymentTab = "DUE" | "PAID" | "WAIVED";

export default function PaymentsPage({ params }: { params: Promise<{ branchId: string }> }) {
    const { branchId } = use(params);

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.payments}>
            {access => {
                const recordDecision = getBranchCapabilityDecision(access, "paymentsRecord");
                const waiveDecision = getBranchCapabilityDecision(access, "paymentsWaive");
                const generateDecision = getBranchCapabilityDecision(access, "paymentsGenerate");
                return (
                    <PaymentsContent
                        branchId={branchId}
                        recordDecision={recordDecision}
                        waiveDecision={waiveDecision}
                        generateDecision={generateDecision}
                    />
                );
            }}
        </BranchAccessGuard>
    );
}

function PaymentsContent({
    branchId,
    recordDecision,
    waiveDecision,
    generateDecision,
}: {
    branchId: string;
    recordDecision: CapabilityDecision;
    waiveDecision: CapabilityDecision;
    generateDecision: CapabilityDecision;
}) {
    const router = useRouter();
    const toast = useToast();
    const { formatDate, formatNumber } = useUserPreferences();
    const searchParams = useSearchParams();
    const targetPaymentId = searchParams.get("paymentId");
    const targetStatus = searchParams.get("status");
    const targetMonth = searchParams.get("month");
    const generationRequested = searchParams.get("generate") === "1";
    const paymentActionHelpText = getAnyPermissionHelpText(["mark_payment_paid", "waive_payments"]);
    const canMarkPaid = recordDecision.allowed;
    const canWaivePayments = waiveDecision.allowed;
    const canGeneratePayments = generateDecision.allowed;
    const generateBlockedReason = generateDecision.allowed ? null : generateDecision.reason;
    const showRecordAction = recordDecision.allowed || recordDecision.blocker !== "permission";
    const showWaiveAction = waiveDecision.allowed || waiveDecision.blocker !== "permission";
    const showGenerateAction = generateDecision.allowed || generateDecision.blocker !== "permission";

    const [currentDate, setCurrentDate] = useState(() => (
        targetMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)
            ? new Date(`${targetMonth}-01T12:00:00`)
            : new Date()
    ));
    const [activeTab, setActiveTab] = useState<PaymentTab>(() => (
        targetStatus === "PAID" || targetStatus === "WAIVED" ? targetStatus : "DUE"
    ));
    const [viewMode, setViewMode] = useDataViewMode();

    const [data, setData] = useState<PaymentRow[]>([]);
    const [paymentTotals, setPaymentTotals] = useState<Record<PaymentTab, number>>({
        DUE: 0,
        PAID: 0,
        WAIVED: 0,
    });
    const [nextPaymentCursor, setNextPaymentCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [paymentToMark, setPaymentToMark] = useState<string | null>(null);
    const [marking, setMarking] = useState(false);
    const [markMethod, setMarkMethod] = useState<"CASH" | "UPI" | "BANK_TRANSFER">("CASH");
    const [markReferenceId, setMarkReferenceId] = useState("");

    const [paymentToWaive, setPaymentToWaive] = useState<string | null>(null);
    const [waiving, setWaiving] = useState(false);

    const [auditLog, setAuditLog] = useState<{ paymentId: string; studentName: string } | null>(null);
    const [generating, setGenerating] = useState(false);
    const [generationMessage, setGenerationMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

    const loadPayments = useCallback(async (cursor?: string, append = false) => {
        if (append) setLoadingMore(true);
        else setLoading(true);

        try {
            const monthStr = format(currentDate, "yyyy-MM");
            const options = { status: activeTab, month: monthStr };

            if (append) {
                const page = await payments.list(branchId, { ...options, cursor, limit: 50 });
                setData(previous => [...previous, ...page.items]);
                setNextPaymentCursor(page.nextCursor);
                setPaymentTotals(previous => ({ ...previous, [activeTab]: page.total }));
            } else {
                const shouldResolveDeepLink = Boolean(
                    targetPaymentId && (!targetStatus || targetStatus === activeTab)
                );
                const currentPagePromise = shouldResolveDeepLink
                    ? payments.listAll(branchId, options).then(items => ({
                        items,
                        nextCursor: null,
                        total: items.length,
                    }))
                    : payments.list(branchId, { ...options, limit: 50 });
                const countPromises = (["DUE", "PAID", "WAIVED"] as const)
                    .filter(status => status !== activeTab)
                    .map(status => payments.list(branchId, { status, month: monthStr, limit: 1 })
                        .then(page => [status, page.total] as const));
                const [page, otherCounts] = await Promise.all([
                    currentPagePromise,
                    Promise.all(countPromises),
                ]);
                const totals: Record<PaymentTab, number> = {
                    DUE: 0,
                    PAID: 0,
                    WAIVED: 0,
                    ...Object.fromEntries(otherCounts),
                    [activeTab]: page.total,
                };

                setData(page.items);
                setNextPaymentCursor(page.nextCursor);
                setPaymentTotals(totals);
            }
            setError(null);
        } catch (loadError: unknown) {
            console.error("Failed to load payments", loadError);
            if (append) {
                toast.show({
                    title: "More payments could not be loaded",
                    description: loadError instanceof Error ? loadError.message : "Try again.",
                    tone: "error",
                });
            } else {
                setError("Failed to load payments.");
            }
        } finally {
            if (append) setLoadingMore(false);
            else setLoading(false);
        }
    }, [activeTab, branchId, currentDate, targetPaymentId, targetStatus, toast]);

    useEffect(() => {
        void loadPayments();
    }, [loadPayments]);

    useEffect(() => {
        if (targetMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
            setCurrentDate(new Date(`${targetMonth}-01T12:00:00`));
        }
        if (targetStatus === "DUE" || targetStatus === "PAID" || targetStatus === "WAIVED") {
            setActiveTab(targetStatus);
        }
    }, [targetMonth, targetStatus]);

    useEffect(() => {
        if (loading || !targetPaymentId) return;
        const target = document.getElementById(`payment-table-${targetPaymentId}`)
            ?? document.getElementById(`payment-grid-${targetPaymentId}`);
        if (!target) return;
        const focusFrame = window.requestAnimationFrame(() => {
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
            target.focus({ preventScroll: true });
        });
        return () => window.cancelAnimationFrame(focusFrame);
    }, [activeTab, data, loading, targetPaymentId]);

    const generateMissingPayments = async () => {
        setGenerating(true);
        setGenerationMessage(null);
        try {
            const response = await fetch(`/api/branches/${branchId}/payments/generate`, {
                method: "POST",
                cache: "no-store",
            });
            const result = await response.json() as { generatedCount?: number; error?: string };
            if (!response.ok) throw new Error(result.error || "Payment generation failed");
            const generatedCount = result.generatedCount ?? 0;
            setGenerationMessage({
                tone: "success",
                text: generatedCount > 0
                    ? `Generated ${generatedCount} missing payment${generatedCount === 1 ? "" : "s"}.`
                    : "Payment schedule is already up to date.",
            });
            await loadPayments();
        } catch (error) {
            setGenerationMessage({
                tone: "error",
                text: error instanceof Error ? error.message : "Payment generation failed.",
            });
        } finally {
            setGenerating(false);
        }
    };

    const handleMonthChange = (direction: "prev" | "next") => {
        setCurrentDate(prev => direction === "prev" ? subMonths(prev, 1) : addMonths(prev, 1));
    };

    const handleMarkPaid = (id: string) => {
        setMarkMethod("CASH");
        setMarkReferenceId("");
        setPaymentToMark(id);
    };

    const confirmMarkPaid = async () => {
        if (!paymentToMark) return;
        setMarking(true);
        try {
            await payments.markAsPaid(
                paymentToMark,
                markMethod,
                markReferenceId.trim() || undefined,
            );
            await loadPayments();
            setPaymentToMark(null);
            toast.show({ title: "Payment recorded", tone: "success" });
        } catch (error) {
            toast.show({
                title: "Payment was not recorded",
                description: error instanceof Error ? error.message : "Try again. No payment state was changed.",
                tone: "error",
                persistent: true,
            });
        } finally {
            setMarking(false);
        }
    };

    const confirmWaive = async () => {
        if (!paymentToWaive) return;
        setWaiving(true);
        try {
            await payments.markAsWaived(paymentToWaive);
            await loadPayments();
            setPaymentToWaive(null);
            toast.show({ title: "Payment waived", tone: "success" });
        } catch (error) {
            toast.show({
                title: "Payment was not waived",
                description: error instanceof Error ? error.message : "Try again. The due remains active.",
                tone: "error",
                persistent: true,
            });
        } finally {
            setWaiving(false);
        }
    };

    // Filter data based on active tab
    const filteredData = data;
    const dueCount = paymentTotals.DUE;
    const paidCount = paymentTotals.PAID;
    const waivedCount = paymentTotals.WAIVED;

    const isCurrentMonth = (date: Date) => formatDate(date, { year: "numeric", month: "2-digit" })
        === formatDate(new Date(), { year: "numeric", month: "2-digit" });

    const formatPaymentAmount = (amount: number) =>
        formatNumber(amount, {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 0,
        });

    const renderDueDate = (item: PaymentRow) => {
        const overdue = isOverdue(item.dueDate);

        return (
            <div className="flex flex-wrap items-center gap-2">
                <span className={cn(overdue ? "text-red-400 font-medium" : "text-textSecondary")}>
                    {formatDate(item.dueDate)}
                </span>
                {overdue && (
                    <Badge variant="danger" className="h-5 px-1 py-0 text-[10px]">OVERDUE</Badge>
                )}
            </div>
        );
    };

    const renderPaymentStatus = (item: PaymentRow) => (
        <Badge
            variant={
                item.status === "PAID" ? "success" :
                    item.status === "DUE" ? "warning" :
                        "purple"
            }
        >
            {item.status}
        </Badge>
    );

    const renderPaymentMethod = (item: PaymentRow) => {
        const m = item.paymentMethod ?? null;
        if (!m) return <span className="text-xs text-textSecondary">-</span>;

        const map = {
            CASH: { label: "Cash", cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
            UPI: { label: "UPI", cls: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
            BANK_TRANSFER: { label: "Bank", cls: "text-purple-400 bg-purple-500/10 border-purple-500/20" },
        };
        const { label, cls } = map[m];

        return (
            <span className={cn("rounded border px-2 py-0.5 text-[11px] font-medium", cls)}>
                {label}
            </span>
        );
    };

    const renderPaymentActions = (item: PaymentRow) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
            {(item.status === "PAID" || item.status === "WAIVED") && (
                <AppButton
                    variant="quiet"
                    size="sm"
                    icon={History}
                    className={cn("text-xs", pageSubtleTextClass)}
                    onClick={() =>
                        setAuditLog({
                            paymentId: item.id,
                            studentName: item.student?.name || "Unknown",
                        })
                    }
                >
                    History
                </AppButton>
            )}

            {item.status === "DUE" && (showRecordAction || showWaiveAction) && (
                <>
                    {showRecordAction && (
                        <AppButton
                            variant="secondary"
                            size="sm"
                            icon={Check}
                            className="text-xs"
                            disabled={!canMarkPaid}
                            title={recordDecision.allowed ? undefined : recordDecision.reason}
                            onClick={() => handleMarkPaid(item.id)}
                        >
                            Mark paid
                        </AppButton>
                    )}

                    {showWaiveAction && (
                        <RowDropdown
                            onWaive={() => setPaymentToWaive(item.id)}
                            disabled={!canWaivePayments}
                            reason={waiveDecision.allowed ? undefined : waiveDecision.reason}
                        />
                    )}
                </>
            )}

            {item.status === "DUE" && !showRecordAction && !showWaiveAction && (
                <span className={cn("max-w-[180px] text-right text-xs leading-5", pageSubtleTextClass)} title={paymentActionHelpText}>
                    {paymentActionHelpText}
                </span>
            )}
        </div>
    );

    if (error) {
        return (
            <div className={pageErrorStateClass}>
                <AlertCircle className={pageErrorIconClass} />
                <h2 className="text-xl font-semibold">Something went wrong</h2>
                <p className={pageMutedTextClass}>{error}</p>
                <AppButton variant="secondary" icon={ArrowLeft} onClick={() => router.push("/org")}>
                    Back to workspace
                </AppButton>
            </div>
        );
    }

    return (
        <PageShell>
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className={pageEyebrowClass}>Branch payments</p>
                    <h1 className={cn(pageTitleClass, "mt-2")}>Payment history</h1>
                    <p className={pageDescriptionClass}>
                        Review dues, record collections, and keep waived payments separate from active follow-up.
                    </p>
                </div>

                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                {showGenerateAction && (
                    <AppButton
                        variant="secondary"
                        isLoading={generating}
                        autoFocus={generationRequested}
                        disabled={!canGeneratePayments}
                        title={generateDecision.allowed ? undefined : generateDecision.reason}
                        onClick={() => void generateMissingPayments()}
                    >
                        Generate missing dues
                    </AppButton>
                )}
                <div className={cn("flex items-center justify-between gap-2 p-2 sm:gap-4", pageFilterShellClass)}>
                    <AppButton variant="quiet" size="icon" onClick={() => handleMonthChange("prev")} aria-label="Previous month">
                        <ChevronLeft className="h-4 w-4" />
                    </AppButton>
                    <div className="min-w-[132px] text-center">
                        <div className="font-semibold text-[color:var(--text-primary)]">{formatDate(currentDate, { month: "long", year: "numeric" })}</div>
                        {isCurrentMonth(currentDate) && (
                            <div className="text-xs font-medium text-[color:var(--ui-form-accent)]">Current month</div>
                        )}
                    </div>
                    <AppButton variant="quiet" size="icon" onClick={() => handleMonthChange("next")} aria-label="Next month">
                        <ChevronRight className="h-4 w-4" />
                    </AppButton>
                </div>
                </div>
            </header>

            {generationRequested && !canGeneratePayments && generateBlockedReason && (
                <div role="alert" className={cn("px-4 py-3 text-sm", formWarningBannerClass)}>
                    {generateBlockedReason}
                </div>
            )}
            {generationMessage && (
                <div
                    role={generationMessage.tone === "error" ? "alert" : "status"}
                    className={cn(
                        "rounded-[var(--ui-radius-control)] border px-4 py-3 text-sm",
                        generationMessage.tone === "error"
                            ? "border-red-400/30 bg-red-400/10 text-red-200"
                            : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                    )}
                >
                    {generationMessage.text}
                </div>
            )}

            <div className={cn("flex flex-col gap-3 border-b pb-2 sm:flex-row sm:items-center sm:justify-between", pageSectionDividerClass)}>
                <div className="flex max-w-full items-center gap-2 overflow-x-auto">
                    <PaymentTabButton
                        label="Due"
                        count={dueCount}
                        active={activeTab === "DUE"}
                        tone="warning"
                        onClick={() => setActiveTab("DUE")}
                    />
                    <PaymentTabButton
                        label="Paid"
                        count={paidCount}
                        active={activeTab === "PAID"}
                        tone="success"
                        onClick={() => setActiveTab("PAID")}
                    />
                    <PaymentTabButton
                        label="Waived"
                        count={waivedCount}
                        active={activeTab === "WAIVED"}
                        tone="neutral"
                        onClick={() => setActiveTab("WAIVED")}
                    />
                </div>

                <ViewToggle value={viewMode} onChange={setViewMode} className="hidden md:inline-flex" />
            </div>

            {loading ? (
                <LoadingTableSkeleton rows={7} />
            ) : (
                <DataTable
                    caption="Payments"
                    data={filteredData}
                    getRowAttributes={(item, view) => ({
                        id: `payment-${view}-${item.id}`,
                        tabIndex: -1,
                        "aria-label": item.id === targetPaymentId
                            ? `${item.student?.name || "Payment"}, selected search result`
                            : undefined,
                        className: item.id === targetPaymentId
                            ? "rounded-[var(--ui-radius-control)] bg-cyan-400/10 ring-2 ring-cyan-300/70"
                            : undefined,
                    })}
                    viewMode={viewMode}
                    emptyMessage="No payments found for this view."
                    renderGridCard={(item, actions) => (
                        <div className={cn("relative flex min-h-[245px] flex-col", pageGridCardClass, pageGridCardHoverClass)}>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className={cn("font-mono text-xs", pageSubtleTextClass)}>#{item.id.slice(-6)}</div>
                                    <div className="mt-1 truncate font-medium text-[color:var(--text-primary)]">{item.student?.name || "Unknown"}</div>
                                    <div className={cn("truncate text-xs", pageMutedTextClass)}>{item.student?.phone || "No phone"}</div>
                                </div>
                                <div className="flex-shrink-0">{renderPaymentStatus(item)}</div>
                            </div>

                            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                                <div className={pageInsetMetricClass}>
                                    <div className={cn("text-xs", pageSubtleTextClass)}>Amount</div>
                                    <div className="mt-1 truncate font-semibold text-[color:var(--text-primary)]">{formatPaymentAmount(item.amount)}</div>
                                </div>
                                <div className={pageInsetMetricClass}>
                                    <div className={cn("text-xs", pageSubtleTextClass)}>Method</div>
                                    <div className="mt-1">{renderPaymentMethod(item)}</div>
                                </div>
                            </div>

                            <div className={cn("mt-3 p-3 text-sm", pageInsetSurfaceClass)}>
                                <div className={cn("mb-1 text-xs", pageSubtleTextClass)}>Due date</div>
                                {renderDueDate(item)}
                            </div>

                            <div className={cn("mt-auto border-t pt-4", pageSectionDividerClass)}>
                                {actions?.(item)}
                            </div>
                        </div>
                    )}
                    columns={[
                        { header: "Transaction ID", accessor: (item) => <span className="font-mono text-xs text-textSecondary">#{item.id.slice(-6)}</span> },
                        {
                            header: "Student",
                            accessor: (item) => (
                                <div>
                                    <div className="font-medium text-[color:var(--text-primary)]">{item.student?.name || "Unknown"}</div>
                                    <div className={cn("text-xs", pageMutedTextClass)}>{item.student?.phone}</div>
                                </div>
                            )
                        },
                        {
                            header: "Due Date",
                            accessor: renderDueDate
                        },
                        {
                            header: "Amount",
                            accessor: (item) => (
                                <span className="font-semibold text-[color:var(--text-primary)]">
                                    {formatPaymentAmount(item.amount)}
                                </span>
                            )
                        },
                        {
                            header: "Status",
                            accessor: renderPaymentStatus
                        },
                        {
                            header: "Method",
                            accessor: (item) => {
                                const m = item.paymentMethod ?? null;
                                if (!m) return <span className={cn("text-xs", pageMutedTextClass)}>-</span>;
                                const map = {
                                    CASH: { label: "Cash", cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
                                    UPI:  { label: "UPI",  cls: "text-blue-400  bg-blue-500/10  border-blue-500/20"  },
                                    BANK_TRANSFER: { label: "Bank", cls: "text-purple-400 bg-purple-500/10 border-purple-500/20" },
                                };
                                const { label, cls } = map[m];
                                return (
                                    <span className={cn("text-[11px] font-medium px-2 py-0.5 rounded border", cls)}>
                                        {label}
                                    </span>
                                );
                            }
                        },
                    ]}
                    actions={renderPaymentActions}
                />
            )}

            {!loading ? (
                <div className="flex flex-col items-center gap-2" aria-live="polite">
                    <p className={cn("text-sm", pageMutedTextClass)}>
                        Showing {data.length} of {paymentTotals[activeTab]} {activeTab.toLowerCase()} payments
                    </p>
                    {nextPaymentCursor ? (
                        <AppButton
                            variant="secondary"
                            isLoading={loadingMore}
                            aria-label={`Load more ${activeTab.toLowerCase()} payments; ${data.length} of ${paymentTotals[activeTab]} shown`}
                            onClick={() => void loadPayments(nextPaymentCursor, true)}
                        >
                            Load more payments
                        </AppButton>
                    ) : null}
                </div>
            ) : null}

            <MarkPaidDialog
                isOpen={!!paymentToMark}
                onClose={() => setPaymentToMark(null)}
                onConfirm={confirmMarkPaid}
                loading={marking}
                method={markMethod}
                onMethodChange={setMarkMethod}
                referenceId={markReferenceId}
                onReferenceIdChange={setMarkReferenceId}
            />

            <ConfirmDialog
                isOpen={!!paymentToWaive}
                onClose={() => setPaymentToWaive(null)}
                onConfirm={confirmWaive}
                title="Waive Payment"
                description="This will mark the payment as WAIVED. The debt will be written off and excluded from analytics. This cannot be undone."
                confirmText="Yes, Waive"
                loading={waiving}
                variant="warning"
            />

            <PaymentAuditLog
                isOpen={!!auditLog}
                onClose={() => setAuditLog(null)}
                paymentId={auditLog?.paymentId ?? ""}
                studentName={auditLog?.studentName ?? ""}
            />
        </PageShell>
    );
}

function RowDropdown({ onWaive, disabled, reason }: { onWaive: () => void; disabled?: boolean; reason?: string }) {
    return (
        <RowActionsMenu
            buttonIcon={MoreHorizontal}
            buttonClassName="hover:bg-[color:var(--ui-form-surface-hover-bg)]"
            menuWidthClassName="w-40"
            actions={[
                {
                    label: "Waive Payment",
                    icon: Ban,
                    variant: "warning",
                    onClick: onWaive,
                    disabled,
                    description: reason,
                },
            ]}
        />
    );
}

// ─── Mark Paid Dialog ─────────────────────────────────────────────────────────

function PaymentTabButton({
    label,
    count,
    active,
    tone,
    onClick,
}: {
    label: string;
    count: number;
    active: boolean;
    tone: "warning" | "success" | "neutral";
    onClick: () => void;
}) {
    const activeClass = {
        warning: "border-[color:var(--ui-badge-warning-border)] bg-[color:var(--ui-badge-warning-bg)] text-[color:var(--ui-badge-warning-text)]",
        success: "border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] text-[color:var(--ui-badge-success-text)]",
        neutral: "border-[color:var(--ui-badge-purple-border)] bg-[color:var(--ui-badge-purple-bg)] text-[color:var(--ui-badge-purple-text)]",
    }[tone];

    const dotClass = {
        warning: "bg-[color:var(--ui-tone-warning-progress)]",
        success: "bg-[color:var(--ui-tone-success-progress)]",
        neutral: "bg-[color:var(--ui-badge-purple-text)]",
    }[tone];

    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? "page" : undefined}
            className={cn(
                "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-[var(--ui-radius-control)] border px-3 py-2 text-sm font-medium transition-colors",
                active
                    ? activeClass
                    : "border-transparent text-[color:var(--text-secondary)] hover:border-[color:var(--ui-form-surface-border)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
            )}
        >
            {active && <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />}
            {label}
            {count > 0 && <span className={pageCountBadgeClass}>{count}</span>}
        </button>
    );
}

type PayMethod = "CASH" | "UPI" | "BANK_TRANSFER";

interface MarkPaidDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    loading: boolean;
    method: PayMethod;
    onMethodChange: (m: PayMethod) => void;
    referenceId: string;
    onReferenceIdChange: (v: string) => void;
}

const METHOD_OPTIONS: { value: PayMethod; label: string; sublabel: string; icon: React.ReactNode }[] = [
    { value: "CASH",          label: "Cash",          sublabel: "Physical handover",  icon: <Banknote  size={16} /> },
    { value: "UPI",           label: "UPI",           sublabel: "Add txn ID below",  icon: <Smartphone size={16} /> },
    { value: "BANK_TRANSFER", label: "Bank Transfer",  sublabel: "Add ref ID below",  icon: <Building2  size={16} /> },
];

function MarkPaidDialog({
    isOpen, onClose, onConfirm, loading,
    method, onMethodChange,
    referenceId, onReferenceIdChange,
}: MarkPaidDialogProps) {
    const needsRef = method === "UPI" || method === "BANK_TRANSFER";
    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Mark as paid"
            description="Select the payment method used."
            icon={<span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-300"><Check size={18} /></span>}
            closeDisabled={loading}
            className="max-w-sm"
            footer={(
                <>
                    <AppButton variant="quiet" onClick={onClose} disabled={loading} data-dialog-initial-focus>
                        Cancel
                    </AppButton>
                    <AppButton variant="primary" onClick={onConfirm} isLoading={loading} icon={Check}>
                        Confirm payment
                    </AppButton>
                </>
            )}
        >
            <div className="space-y-5">
                {/* Method selector */}
                <div className="space-y-2" role="radiogroup" aria-label="Payment method">
                    {METHOD_OPTIONS.map((opt) => (
                        <button
                            type="button"
                            key={opt.value}
                            onClick={() => onMethodChange(opt.value)}
                            role="radio"
                            aria-checked={method === opt.value}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-3 rounded-[var(--ui-radius-control)] border px-4 py-3 text-left transition-all",
                                method === opt.value
                                    ? "border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] text-[color:var(--text-primary)]"
                                    : cn("text-[color:var(--ui-form-label)]", formSurfaceClass, formSurfaceHoverClass)
                            )}
                        >
                            <span className={cn(
                                "shrink-0",
                                method === opt.value ? "text-[color:var(--ui-tone-success-text)]" : formIconClass
                            )}>
                                {opt.icon}
                            </span>
                            <span className="flex-1">
                                <span className="block text-sm font-medium">{opt.label}</span>
                                <span className={cn("block text-[11px]", formHelpTextClass)}>{opt.sublabel}</span>
                            </span>
                            {method === opt.value && (
                                <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--ui-tone-success-progress)]" />
                            )}
                        </button>
                    ))}
                </div>

                {/* Reference ID input */}
                <div className={cn(
                    "overflow-hidden transition-all duration-200",
                    needsRef ? "max-h-20 opacity-100" : "max-h-0 opacity-0"
                )}>
                    <input
                        id="payment-reference-id"
                        type="text"
                        value={referenceId}
                        onChange={(e) => onReferenceIdChange(e.target.value)}
                        placeholder={method === "UPI" ? "UPI Transaction ID (optional)" : "Bank Reference ID (optional)"}
                        aria-label={method === "UPI" ? "UPI transaction ID" : "Bank reference ID"}
                        className={cn(formControlClass, "px-3 py-2.5 text-sm focus:border-green-500/50")}
                    />
                </div>
            </div>
        </Dialog>
    );
}
