"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
    AlertCircle,
    ArrowLeft,
    Check,
    Copy,
    CreditCard,
    MessageSquare,
    LockKeyhole,
    Phone,
    RefreshCw,
    SearchX,
    Send,
    TriangleAlert,
} from "lucide-react";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { Badge } from "@/components/ui/Badge";
import { AppButton, AppPanel, PageLoadingSkeleton, PageShell } from "@/components/ui";
import { formControlClass, formHelpTextClass, formWarningBannerClass } from "@/components/ui/formSurface";
import {
    pageCountBadgeClass,
    pageDescriptionClass,
    pageEmptyStateClass,
    pageEyebrowClass,
    pageErrorIconClass,
    pageErrorStateClass,
    pageGridCardClass,
    pageGridCardHoverClass,
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
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import {
    getOverdueBulkReviewHref,
    getOverduePaymentHref,
    getOverdueStudentHref,
    updateQueueSelection,
    type OverdueQueuePayment,
} from "@/lib/overdueQueue";
import { cn } from "@/lib/utils";
import type { CapabilityDecision } from "@/types";
import { payments as paymentApi } from "@/lib/api/payments";

interface OverduePayment extends OverdueQueuePayment {
    studentName: string;
    phone: string | null;
    dueDate: string;
    amount: number;
    daysOverdue?: number;
}

interface DraftMessage {
    paymentId: string;
    studentName: string;
    phone: string | null;
    message: string;
}

type QueueFilter = "ALL" | "CRITICAL" | "NO_PHONE";
type MessageLanguage = "EN" | "HI";

const filters: { value: QueueFilter; label: string; description: string }[] = [
    { value: "ALL", label: "Loaded overdue", description: "Loaded follow-up rows" },
    { value: "CRITICAL", label: "Loaded critical", description: "30+ days overdue" },
    { value: "NO_PHONE", label: "Loaded without phone", description: "Needs profile cleanup" },
];

function daysSinceDue(payment: OverduePayment) {
    if (typeof payment.daysOverdue === "number") return Math.max(0, payment.daysOverdue);
    const due = new Date(payment.dueDate);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000));
}

function severityFor(days: number): { label: string; variant: "warning" | "danger" | "purple"; helper: string } {
    if (days >= 30) return { label: "Critical", variant: "danger", helper: "Needs owner follow-up" };
    if (days >= 14) return { label: "Escalate", variant: "purple", helper: "Second reminder window" };
    return { label: "Reminder", variant: "warning", helper: "Fresh overdue item" };
}

export default function OverduePage() {
    const params = useParams();
    const branchId = params.branchId as string;

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.overdue}>
            {access => (
                <OverdueContent
                    key={branchId}
                    branchId={branchId}
                    recordDecision={getBranchCapabilityDecision(access, "paymentsRecord")}
                />
            )}
        </BranchAccessGuard>
    );
}

function OverdueContent({ branchId, recordDecision }: { branchId: string; recordDecision: CapabilityDecision }) {
    const router = useRouter();
    const { formatDate, formatDateTime, formatNumber } = useUserPreferences();
    const formatMoney = (amount: number) => formatNumber(amount, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [generatingDrafts, setGeneratingDrafts] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const [payments, setPayments] = useState<OverduePayment[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [total, setTotal] = useState(0);
    const [drafts, setDrafts] = useState<DraftMessage[]>([]);
    const [language, setLanguage] = useState<MessageLanguage>("EN");
    const [filter, setFilter] = useState<QueueFilter>("ALL");
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const selectAllRef = useRef<HTMLInputElement>(null);

    const fetchOverdue = useCallback(async (
        mode: "initial" | "refresh" | "more" = "initial",
        cursor?: string | null
    ) => {
        if (mode === "refresh") setRefreshing(true);
        if (mode === "initial") setLoading(true);
        if (mode === "more") setLoadingMore(true);
        if (mode !== "more") setError(null);
        setLoadMoreError(null);

        try {
            const page = await paymentApi.listOverdue(branchId, { cursor });
            const nextPayments: OverduePayment[] = page.items;
            if (mode === "more") {
                setPayments(current => {
                    const knownIds = new Set(current.map(payment => payment.paymentId));
                    return [
                        ...current,
                        ...nextPayments.filter(payment => !knownIds.has(payment.paymentId)),
                    ];
                });
            } else {
                setPayments(nextPayments);
                setSelectedIds(current => {
                    const available = new Set(nextPayments.map(payment => payment.paymentId));
                    return new Set([...current].filter(paymentId => available.has(paymentId)));
                });
            }
            setNextCursor(page.nextCursor);
            setTotal(page.total);
            setUpdatedAt(new Date());
            setError(null);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to load overdue payments.";
            if (mode === "more") setLoadMoreError(message);
            else setError(message);
        } finally {
            if (mode === "initial") setLoading(false);
            if (mode === "refresh") setRefreshing(false);
            if (mode === "more") setLoadingMore(false);
        }
    }, [branchId]);

    useEffect(() => {
        void fetchOverdue();
    }, [fetchOverdue]);

    useEffect(() => {
        async function loadDefaultLanguage() {
            try {
                const [branchRes, userRes] = await Promise.all([
                    fetch(`/api/branches/${branchId}`),
                    fetch("/api/users/me"),
                ]);
                const branch = branchRes.ok ? await branchRes.json() : null;
                const user = userRes.ok ? await userRes.json() : null;
                const preferred = branch?.defaultMessageLanguage || user?.defaultMessageLanguage;
                setLanguage(preferred === "hi" ? "HI" : "EN");
            } catch (err) {
                console.error(err);
            }
        }
        void loadDefaultLanguage();
    }, [branchId]);

    const sortedPayments = useMemo(() => {
        return [...payments].sort((a, b) => {
            const dayDiff = daysSinceDue(b) - daysSinceDue(a);
            if (dayDiff !== 0) return dayDiff;
            return b.amount - a.amount;
        });
    }, [payments]);

    const visiblePayments = useMemo(() => {
        return sortedPayments.filter((payment) => {
            if (filter === "CRITICAL") return daysSinceDue(payment) >= 30;
            if (filter === "NO_PHONE") return !payment.phone;
            return true;
        });
    }, [filter, sortedPayments]);

    const selectedPayments = useMemo(
        () => payments.filter(payment => selectedIds.has(payment.paymentId)),
        [payments, selectedIds]
    );
    const visiblePaymentIds = useMemo(
        () => visiblePayments.map(payment => payment.paymentId),
        [visiblePayments]
    );
    const visibleSelectedCount = visiblePaymentIds.filter(paymentId => selectedIds.has(paymentId)).length;
    const allVisibleSelected = visiblePaymentIds.length > 0 && visibleSelectedCount === visiblePaymentIds.length;
    const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

    useEffect(() => {
        if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
    }, [someVisibleSelected]);

    const totals = useMemo(() => {
        const totalAmount = payments.reduce((sum, payment) => sum + payment.amount, 0);
        const critical = payments.filter(payment => daysSinceDue(payment) >= 30);
        const missingPhone = payments.filter(payment => !payment.phone);
        const oldestDays = payments.reduce((max, payment) => Math.max(max, daysSinceDue(payment)), 0);

        return {
            totalAmount,
            criticalCount: critical.length,
            missingPhoneCount: missingPhone.length,
            oldestDays,
        };
    }, [payments]);

    const generateDrafts = async () => {
        setGeneratingDrafts(true);
        try {
            const nextDrafts = selectedPayments.map((payment) => {
                const amount = formatMoney(payment.amount);
                const date = formatDate(payment.dueDate);
                const message = language === "EN"
                    ? `Hi ${payment.studentName}, your ${amount} payment due on ${date} is pending. Please clear it at the earliest. Thank you.`
                    : `नमस्ते ${payment.studentName}, ${date} को देय ${amount} भुगतान अभी बाकी है। कृपया इसे जल्द जमा करें। धन्यवाद।`;

                return {
                    paymentId: payment.paymentId,
                    studentName: payment.studentName,
                    phone: payment.phone,
                    message,
                };
            });
            setDrafts(nextDrafts);
        } finally {
            setGeneratingDrafts(false);
        }
    };

    const copyToClipboard = async (text: string, id: string) => {
        await navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const togglePayment = (paymentId: string, checked: boolean) => {
        setSelectedIds(current => updateQueueSelection(current, [paymentId], checked));
    };

    const toggleAllVisible = (checked: boolean) => {
        setSelectedIds(current => updateQueueSelection(current, visiblePaymentIds, checked));
    };

    const bulkReviewHref = getOverdueBulkReviewHref(branchId, selectedPayments);

    if (loading) {
        return <PageLoadingSkeleton label="Loading overdue queue" variant="table" rows={5} />;
    }

    if (error && !updatedAt) {
        return (
            <div className={pageErrorStateClass}>
                <AlertCircle className={pageErrorIconClass} />
                <h2 className="text-xl font-semibold">Overdue queue did not load</h2>
                <p className={pageMutedTextClass}>{error}</p>
                <AppButton variant="secondary" icon={RefreshCw} onClick={() => fetchOverdue()}>
                    Try again
                </AppButton>
            </div>
        );
    }

    return (
        <PageShell>
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <AppButton variant="quiet" size="sm" icon={ArrowLeft} onClick={() => router.back()}>
                        Back
                    </AppButton>
                    <p className={cn(pageEyebrowClass, "mt-4")}>Collections queue</p>
                    <h1 className={cn(pageTitleClass, "mt-2 truncate")}>Overdue collections</h1>
                    <p className={pageDescriptionClass}>
                        Work the collection queue by urgency, fix missing contact details, then copy reminder drafts for manual follow-up.
                    </p>
                    {updatedAt && (
                        <p className={cn("mt-2 text-xs", pageSubtleTextClass)}>
                            Updated {formatDateTime(updatedAt)}
                        </p>
                    )}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                    <AppButton
                        variant="secondary"
                        icon={RefreshCw}
                        onClick={() => fetchOverdue("refresh")}
                        disabled={refreshing}
                        className={refreshing ? "[&_svg]:animate-spin" : undefined}
                    >
                        Refresh
                    </AppButton>
                    <AppButton
                        variant="primary"
                        icon={CreditCard}
                        onClick={() => router.push(bulkReviewHref)}
                    >
                        {selectedPayments.length === 1 ? "Review selected payment" : "Review due payments"}
                    </AppButton>
                </div>
            </header>

                {error && updatedAt && (
                    <div className={cn("flex items-start gap-3 px-4 py-3 text-sm", formWarningBannerClass)} role="status">
                        <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span>
                            Refresh failed. Showing data last updated {formatDateTime(updatedAt)}. {error}
                        </span>
                    </div>
                )}

                {!recordDecision.allowed && recordDecision.blocker !== "permission" && (
                    <div id="overdue-record-blocker" className={cn("flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between", formWarningBannerClass)}>
                        <span className="flex items-start gap-2">
                            <LockKeyhole size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <span><span className="font-semibold">Recording payments is unavailable.</span> {recordDecision.reason}</span>
                        </span>
                        {recordDecision.recoveryHref && (
                            <Link href={recordDecision.recoveryHref} className="shrink-0 font-semibold underline underline-offset-4">
                                Resolve access
                            </Link>
                        )}
                    </div>
                )}

                {payments.length === 0 ? (
                    <div className={pageEmptyStateClass}>
                        <SearchX size={36} className="mb-4 opacity-60" />
                        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">No overdue payments</h2>
                        <p className={cn("mt-2 max-w-md text-sm", pageMutedTextClass)}>
                            The collection queue is clear. New overdue payments will appear here after the grace period.
                        </p>
                    </div>
                ) : (
                    <>
                        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <MetricCard label="Loaded overdue amount" value={formatMoney(totals.totalAmount)} detail={`${payments.length} of ${total} open payments loaded`} tone="danger" />
                            <MetricCard label="Loaded critical" value={formatNumber(totals.criticalCount)} detail="30+ days overdue in loaded rows" tone="danger" />
                            <MetricCard label="Loaded missing phone" value={formatNumber(totals.missingPhoneCount)} detail="Profile cleanup in loaded rows" tone={totals.missingPhoneCount > 0 ? "warning" : "success"} />
                            <MetricCard label="Oldest due" value={`${formatNumber(totals.oldestDays)}d`} detail="Oldest loaded payment" tone={totals.oldestDays >= 30 ? "danger" : "warning"} />
                        </section>

                        <AppPanel
                            title="Collection Queue"
                            description="Oldest dues load first. Filters and bulk selection apply to the rows currently loaded."
                            action={
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                    <select
                                        aria-label="Reminder language"
                                        className={cn(formControlClass, "h-9 w-full bg-[color:var(--ui-form-input-select-bg)] px-3 text-xs sm:w-32")}
                                        value={language}
                                        onChange={(event) => setLanguage(event.target.value as MessageLanguage)}
                                    >
                                        <option value="EN">English</option>
                                        <option value="HI">Hindi</option>
                                    </select>
                                    <AppButton
                                        size="sm"
                                        variant="primary"
                                        icon={MessageSquare}
                                        onClick={generateDrafts}
                                        disabled={selectedPayments.length === 0}
                                        isLoading={generatingDrafts}
                                    >
                                        Draft selected ({selectedPayments.length})
                                    </AppButton>
                                </div>
                            }
                            contentClassName="space-y-4"
                        >
                            <div className="grid gap-2 md:grid-cols-3">
                                {filters.map(item => {
                                    const active = filter === item.value;
                                    const count = item.value === "ALL"
                                        ? payments.length
                                        : item.value === "CRITICAL"
                                            ? totals.criticalCount
                                            : totals.missingPhoneCount;

                                    return (
                                        <button
                                            key={item.value}
                                            type="button"
                                            onClick={() => setFilter(item.value)}
                                            aria-pressed={active}
                                            className={cn(
                                                "cursor-pointer rounded-[var(--ui-radius-control)] border px-3 py-2 text-left transition-colors",
                                                active
                                                    ? "border-[color:var(--ui-form-input-focus-border)] bg-[color:var(--ui-form-input-bg)] text-[color:var(--text-primary)]"
                                                    : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--text-secondary)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
                                            )}
                                        >
                                            <span className="flex items-center justify-between gap-3">
                                                <span className="text-sm font-semibold">{item.label}</span>
                                                <span className={pageCountBadgeClass}>{count}</span>
                                            </span>
                                            <span className={cn("mt-1 block text-xs", pageSubtleTextClass)}>{item.description}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className={cn("flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between", pageInsetSurfaceClass)}>
                                <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-[color:var(--text-primary)]">
                                    <input
                                        ref={selectAllRef}
                                        type="checkbox"
                                        checked={allVisibleSelected}
                                        onChange={event => toggleAllVisible(event.target.checked)}
                                        disabled={visiblePayments.length === 0}
                                        className="h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
                                    />
                                    Select all {visiblePayments.length} shown
                                </label>
                                <div className="flex flex-wrap items-center gap-3">
                                    <span className={cn("text-sm", pageMutedTextClass)} aria-live="polite">
                                        {selectedPayments.length} selected
                                    </span>
                                    {selectedPayments.length > 0 && (
                                        <Link
                                            href={bulkReviewHref}
                                            className="inline-flex h-10 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] px-3 text-sm font-semibold text-[color:var(--ui-button-secondary-text)] transition-colors hover:bg-[color:var(--ui-button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
                                        >
                                            {selectedPayments.length === 1 ? "Review selected payment" : "Open matching due queue"}
                                        </Link>
                                    )}
                                </div>
                            </div>

                            {totals.missingPhoneCount > 0 && (
                                <div className={cn("flex items-start gap-3 px-4 py-3 text-sm", formWarningBannerClass)}>
                                    <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                                    <span>{totals.missingPhoneCount} loaded overdue student{totals.missingPhoneCount === 1 ? "" : "s"} need a phone number before reminders can be sent cleanly.</span>
                                </div>
                            )}

                            {visiblePayments.length === 0 ? (
                                <div className={cn("min-h-[220px]", pageEmptyStateClass)}>
                                    <SearchX size={30} className="mb-3 opacity-60" />
                                    <p className="font-medium text-[color:var(--text-primary)]">No payments in this queue</p>
                                    <p className={cn("mt-1 text-sm", pageMutedTextClass)}>Switch filters to continue collection work.</p>
                                </div>
                            ) : (
                                <>
                                    <div className="grid gap-3 lg:hidden">
                                        {visiblePayments.map(payment => (
                                            <OverduePaymentCard
                                                key={payment.paymentId}
                                                payment={payment}
                                                branchId={branchId}
                                                selected={selectedIds.has(payment.paymentId)}
                                                onSelectedChange={checked => togglePayment(payment.paymentId, checked)}
                                                recordDecision={recordDecision}
                                            />
                                        ))}
                                    </div>

                                    <div className={cn("hidden lg:block", pageTableShellClass)}>
                                        <div className="overflow-x-auto" role="region" aria-label="Overdue payments completion queue" tabIndex={0}>
                                            <table className="w-full min-w-[760px] text-left text-sm">
                                                <caption className="sr-only">Overdue payments completion queue</caption>
                                                <thead className={pageTableHeadClass}>
                                                    <tr>
                                                        <th scope="col" className="w-12 px-5 py-4">
                                                            <span className="sr-only">Select payment</span>
                                                        </th>
                                                        <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-[color:var(--ui-table-muted)]">Student</th>
                                                        <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-[color:var(--ui-table-muted)]">Contact</th>
                                                        <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-[color:var(--ui-table-muted)]">Age</th>
                                                        <th scope="col" className="px-5 py-4 text-xs font-medium uppercase tracking-wider text-[color:var(--ui-table-muted)]">Due date</th>
                                                        <th scope="col" className="px-5 py-4 text-right text-xs font-medium uppercase tracking-wider text-[color:var(--ui-table-muted)]">Amount</th>
                                                        <th scope="col" className="px-5 py-4 text-right text-xs font-medium uppercase tracking-wider text-[color:var(--ui-table-muted)]">Action</th>
                                                    </tr>
                                                </thead>
                                                <tbody className={pageTableBodyDividerClass}>
                                                    {visiblePayments.map(payment => {
                                                        const days = daysSinceDue(payment);
                                                        const severity = severityFor(days);

                                                        return (
                                                            <tr key={payment.paymentId} className={pageTableRowClass}>
                                                                <td className="px-5 py-4">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={selectedIds.has(payment.paymentId)}
                                                                        onChange={event => togglePayment(payment.paymentId, event.target.checked)}
                                                                        aria-label={`Select ${payment.studentName}'s overdue payment`}
                                                                        className="h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
                                                                    />
                                                                </td>
                                                                <td className="px-5 py-4">
                                                                    <Link
                                                                        href={getOverdueStudentHref(branchId, payment.studentId)}
                                                                        className="font-medium text-[color:var(--text-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
                                                                    >
                                                                        {payment.studentName}
                                                                    </Link>
                                                                    <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>{severity.helper}</p>
                                                                </td>
                                                                <td className="px-5 py-4">
                                                                    {payment.phone ? (
                                                                        <span className={cn("inline-flex items-center gap-1.5 text-sm", pageMutedTextClass)}>
                                                                            <Phone size={13} /> {payment.phone}
                                                                        </span>
                                                                    ) : (
                                                                        <Badge variant="warning">No phone</Badge>
                                                                    )}
                                                                </td>
                                                                <td className="px-5 py-4">
                                                                    <Badge variant={severity.variant}>{days} days</Badge>
                                                                </td>
                                                                <td className={cn("px-5 py-4", pageMutedTextClass)}>{formatDate(payment.dueDate)}</td>
                                                                <td className="px-5 py-4 text-right font-semibold text-[color:var(--text-primary)]">{formatMoney(payment.amount)}</td>
                                                                <td className="px-5 py-4 text-right">
                                                                    <PaymentQueueAction
                                                                        href={getOverduePaymentHref(branchId, payment)}
                                                                        decision={recordDecision}
                                                                    />
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </>
                            )}

                            <div className="flex flex-col items-center gap-3 border-t border-[color:var(--ui-form-section-divider)] pt-4 text-center">
                                <p id="overdue-pagination-status" className={cn("text-sm", pageMutedTextClass)} aria-live="polite">
                                    Showing {payments.length} of {total} overdue payment{total === 1 ? "" : "s"}
                                </p>
                                {nextCursor && (
                                    <AppButton
                                        type="button"
                                        variant="secondary"
                                        onClick={() => void fetchOverdue("more", nextCursor)}
                                        isLoading={loadingMore}
                                        disabled={loadingMore}
                                        aria-describedby="overdue-pagination-status"
                                        className="min-h-11 min-w-36 justify-center"
                                    >
                                        {loadingMore ? "Loading..." : "Load more payments"}
                                    </AppButton>
                                )}
                                {loadMoreError && (
                                    <div className={cn("flex items-center gap-2 px-3 py-2 text-sm", formWarningBannerClass)} role="alert">
                                        <AlertCircle size={14} aria-hidden="true" />
                                        <span>{loadMoreError}</span>
                                    </div>
                                )}
                            </div>
                        </AppPanel>

                        {drafts.length > 0 && (
                            <AppPanel
                                title="Reminder Drafts"
                                description="Drafts are not sent automatically. Copy the message and send through your normal channel."
                                action={<Badge variant="warning">Manual send</Badge>}
                                contentClassName="space-y-4"
                            >
                                <div className={cn("flex items-start gap-3 px-4 py-3 text-sm", formWarningBannerClass)}>
                                    <Send size={16} className="mt-0.5 shrink-0" />
                                    <span>These messages can affect collections. Review names, amounts, and tone before sending.</span>
                                </div>

                                <div className="grid gap-4 lg:grid-cols-2">
                                    {drafts.map((draft) => (
                                        <div key={draft.paymentId} className={cn(pageGridCardClass, pageGridCardHoverClass)}>
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="truncate font-semibold text-[color:var(--text-primary)]">{draft.studentName}</p>
                                                    <p className={cn("mt-1 flex items-center gap-1.5 text-xs", pageSubtleTextClass)}>
                                                        <Phone size={12} /> {draft.phone || "Phone not added"}
                                                    </p>
                                                </div>
                                                {!draft.phone && <Badge variant="warning">Needs phone</Badge>}
                                            </div>

                                            <div className={cn("mt-4 p-3", pageInsetSurfaceClass)}>
                                                <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--ui-table-text)]">{draft.message}</p>
                                            </div>

                                            <div className={cn("mt-4 flex justify-end border-t pt-4", pageSectionDividerClass)}>
                                                <AppButton
                                                    size="sm"
                                                    variant="secondary"
                                                    icon={copiedId === draft.paymentId ? Check : Copy}
                                                    onClick={() => copyToClipboard(draft.message, draft.paymentId)}
                                                >
                                                    {copiedId === draft.paymentId ? "Copied" : "Copy message"}
                                                </AppButton>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </AppPanel>
                        )}
                    </>
                )}
        </PageShell>
    );
}

function MetricCard({
    label,
    value,
    detail,
    tone,
}: {
    label: string;
    value: string | number;
    detail: string;
    tone: "danger" | "warning" | "success";
}) {
    const valueClass = tone === "danger"
        ? "text-[color:var(--ui-tone-danger-text)]"
        : tone === "warning"
            ? "text-[color:var(--ui-tone-warning-text)]"
            : "text-[color:var(--ui-tone-success-text)]";

    return (
        <div className={pageInsetMetricClass}>
            <p className={cn("text-xs font-medium uppercase tracking-wide", pageSubtleTextClass)}>{label}</p>
            <p className={cn("mt-2 text-2xl font-semibold tracking-tight", valueClass)}>{value}</p>
            <p className={cn("mt-1 text-xs", pageMutedTextClass)}>{detail}</p>
        </div>
    );
}

const queueActionLinkClass = "inline-flex min-h-10 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] px-3 text-xs font-semibold text-[color:var(--ui-button-secondary-text)] transition-colors hover:bg-[color:var(--ui-button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]";

function PaymentQueueAction({ href, decision }: { href: string; decision: CapabilityDecision }) {
    if (decision.allowed) {
        return <Link href={href} className={queueActionLinkClass}>Record payment</Link>;
    }

    if (decision.blocker === "permission") {
        return <Link href={href} className={queueActionLinkClass}>View payment</Link>;
    }

    return (
        <div className="inline-flex flex-wrap justify-end gap-2">
            <Link href={href} className={queueActionLinkClass}>View payment</Link>
            <button
                type="button"
                disabled
                aria-describedby="overdue-record-blocker"
                className="inline-flex min-h-10 cursor-not-allowed items-center justify-center gap-1.5 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] px-3 text-xs font-semibold text-[color:var(--ui-button-secondary-text)] opacity-[var(--ui-control-disabled-opacity)]"
            >
                <LockKeyhole size={13} aria-hidden="true" />
                Record payment
            </button>
        </div>
    );
}

function OverduePaymentCard({
    payment,
    branchId,
    selected,
    onSelectedChange,
    recordDecision,
}: {
    payment: OverduePayment;
    branchId: string;
    selected: boolean;
    onSelectedChange: (checked: boolean) => void;
    recordDecision: CapabilityDecision;
}) {
    const { formatDate, formatNumber } = useUserPreferences();
    const formattedAmount = formatNumber(payment.amount, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });
    const days = daysSinceDue(payment);
    const severity = severityFor(days);

    return (
        <div className={cn(pageGridCardClass, pageGridCardHoverClass)}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={event => onSelectedChange(event.target.checked)}
                        aria-label={`Select ${payment.studentName}'s overdue payment`}
                        className="mt-0.5 h-5 w-5 shrink-0 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
                    />
                    <div className="min-w-0">
                    <Link
                        href={getOverdueStudentHref(branchId, payment.studentId)}
                        className="truncate font-semibold text-[color:var(--text-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
                    >
                        {payment.studentName}
                    </Link>
                    <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>{severity.helper}</p>
                    </div>
                </div>
                <Badge variant={severity.variant}>{days} days</Badge>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className={pageInsetMetricClass}>
                    <p className={cn("text-xs", pageSubtleTextClass)}>Amount</p>
                    <p className="mt-1 font-semibold text-[color:var(--text-primary)]">{formattedAmount}</p>
                </div>
                <div className={pageInsetMetricClass}>
                    <p className={cn("text-xs", pageSubtleTextClass)}>Due date</p>
                    <p className={cn("mt-1 text-xs", pageMutedTextClass)}>{formatDate(payment.dueDate)}</p>
                </div>
            </div>

            <div className={cn("mt-3 flex items-center gap-2 text-sm", payment.phone ? pageMutedTextClass : formHelpTextClass)}>
                <Phone size={14} />
                {payment.phone || "Phone number missing"}
            </div>

            <div className={cn("mt-4 flex justify-end border-t pt-4", pageSectionDividerClass)}>
                <PaymentQueueAction href={getOverduePaymentHref(branchId, payment)} decision={recordDecision} />
            </div>
        </div>
    );
}
