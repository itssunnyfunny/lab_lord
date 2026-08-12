"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AppPanel } from "@/components/ui";
import {
    pageInsetSurfaceClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
    pageTableBodyDividerClass,
    pageTableHeadClass,
    pageTableRowClass,
} from "@/components/ui/pageSurface";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import {
    getOverdueBulkReviewHref,
    getOverduePaymentHref,
    getOverdueStudentHref,
    updateQueueSelection,
} from "@/lib/overdueQueue";
import { cn } from "@/lib/utils";
import { daysPastDue } from "@/lib/utils/paymentStatus";
import type { CapabilityDecision } from "@/types";
import { ArrowRight, CheckCircle2, LockKeyhole, Phone } from "lucide-react";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";

interface OverduePayment {
    paymentId: string;
    studentId: string;
    studentName: string;
    phone: string | null;
    dueDate: string;
    amount: number;
}

interface OverdueTableProps {
    payments: OverduePayment[];
    branchId: string;
    recordDecision: CapabilityDecision;
}

const actionLinkClass = "inline-flex min-h-11 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] px-3 text-xs font-semibold text-[color:var(--ui-button-secondary-text)] transition-colors hover:bg-[color:var(--ui-button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]";

function DashboardPaymentAction({ href, decision }: { href: string; decision: CapabilityDecision }) {
    if (decision.allowed) return <Link href={href} className={actionLinkClass}>Record payment</Link>;
    if (decision.blocker === "permission") return <Link href={href} className={actionLinkClass}>View payment</Link>;

    return (
        <div className="flex flex-wrap justify-end gap-2">
            <Link href={href} className={actionLinkClass}>View payment</Link>
            <button
                type="button"
                disabled
                aria-describedby="dashboard-overdue-record-blocker"
                className="inline-flex min-h-11 cursor-not-allowed items-center gap-1.5 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] px-3 text-xs font-semibold text-[color:var(--ui-button-secondary-text)] opacity-[var(--ui-control-disabled-opacity)]"
            >
                <LockKeyhole size={13} aria-hidden="true" /> Record payment
            </button>
        </div>
    );
}

export function OverdueTable({ payments, branchId, recordDecision }: OverdueTableProps) {
    const shown = payments.slice(0, 6);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const selectAllRef = useRef<HTMLInputElement>(null);
    const { formatDate, formatNumber } = useUserPreferences();
    const formatMoney = (amount: number) => formatNumber(amount, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });

    const selectedPayments = shown.filter(payment => selectedIds.has(payment.paymentId));
    const shownIds = shown.map(payment => payment.paymentId);
    const selectedShownCount = shownIds.filter(paymentId => selectedIds.has(paymentId)).length;
    const allShownSelected = shown.length > 0 && selectedShownCount === shown.length;
    const someShownSelected = selectedShownCount > 0 && !allShownSelected;

    useEffect(() => {
        if (selectAllRef.current) selectAllRef.current.indeterminate = someShownSelected;
    }, [someShownSelected]);

    const togglePayment = (paymentId: string, checked: boolean) => {
        setSelectedIds(current => updateQueueSelection(current, [paymentId], checked));
    };

    return (
        <AppPanel
            title="Payment completion queue"
            description="Select dues to review, then open each exact payment to record collection."
            action={
                <Link href={`/branch/${encodeURIComponent(branchId)}/overdue`} className={actionLinkClass}>
                    Full queue <ArrowRight size={13} aria-hidden="true" />
                </Link>
            }
            contentClassName="p-0"
            className="h-full"
        >
            {!recordDecision.allowed && recordDecision.blocker !== "permission" && (
                <div id="dashboard-overdue-record-blocker" className={cn("flex flex-col gap-2 border-b px-4 py-3 text-sm", formWarningBannerClass, pageSectionDividerClass)}>
                    <span className="flex items-start gap-2">
                        <LockKeyhole size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span><span className="font-semibold">Recording payments is unavailable.</span> {recordDecision.reason}</span>
                    </span>
                    {recordDecision.recoveryHref && (
                        <Link href={recordDecision.recoveryHref} className="font-semibold underline underline-offset-4">Resolve access</Link>
                    )}
                </div>
            )}

            {payments.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[8px] border border-emerald-400/20 bg-emerald-400/10">
                        <CheckCircle2 size={20} className="text-emerald-300" />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-[color:var(--text-primary)]">No overdue payments returned</p>
                        <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>The latest dashboard update found no open overdue dues.</p>
                    </div>
                </div>
            ) : (
                <>
                    <div className={cn("flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between", pageInsetSurfaceClass, pageSectionDividerClass)}>
                        <label className="inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-[color:var(--text-primary)]">
                            <input
                                ref={selectAllRef}
                                type="checkbox"
                                checked={allShownSelected}
                                onChange={event => setSelectedIds(current => updateQueueSelection(current, shownIds, event.target.checked))}
                                className="h-5 w-5 rounded accent-cyan-500"
                            />
                            Select all {formatNumber(shown.length)} shown
                        </label>
                        <div className="flex flex-wrap items-center gap-3">
                            <span className={cn("text-sm", pageSubtleTextClass)} aria-live="polite">{formatNumber(selectedPayments.length)} selected</span>
                            {selectedPayments.length > 0 && (
                                <Link href={getOverdueBulkReviewHref(branchId, selectedPayments)} className={actionLinkClass}>
                                    {selectedPayments.length === 1 ? "Review selected payment" : "Open matching due queue"}
                                </Link>
                            )}
                        </div>
                    </div>

                    <div className="hidden lg:block">
                        <table className="w-full text-left text-sm">
                            <caption className="sr-only">Dashboard overdue payment completion queue</caption>
                            <thead className={cn("border-b text-xs font-medium text-[color:var(--ui-table-muted)]", pageSectionDividerClass, pageTableHeadClass)}>
                                <tr>
                                    <th scope="col" className="w-12 px-4 py-3"><span className="sr-only">Select</span></th>
                                    <th scope="col" className="px-4 py-3 font-medium">Student</th>
                                    <th scope="col" className="px-4 py-3 font-medium">Due</th>
                                    <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
                                    <th scope="col" className="px-4 py-3 text-right font-medium">Action</th>
                                </tr>
                            </thead>
                            <tbody className={pageTableBodyDividerClass}>
                                {shown.map(payment => {
                                    const overdueDays = daysPastDue(payment.dueDate);
                                    return (
                                        <tr key={payment.paymentId} className={pageTableRowClass}>
                                            <td className="px-4 py-3">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedIds.has(payment.paymentId)}
                                                    onChange={event => togglePayment(payment.paymentId, event.target.checked)}
                                                    aria-label={`Select ${payment.studentName}'s overdue payment`}
                                                    className="h-5 w-5 rounded accent-cyan-500"
                                                />
                                            </td>
                                            <td className="px-4 py-3">
                                                <Link href={getOverdueStudentHref(branchId, payment.studentId)} className="font-medium text-[color:var(--text-primary)] underline-offset-4 hover:underline">
                                                    {payment.studentName}
                                                </Link>
                                                <p className="mt-1 text-xs text-rose-300">{overdueDays === 0 ? "Due today" : `${formatNumber(overdueDays)} days overdue`}</p>
                                            </td>
                                            <td className="px-4 py-3 text-[color:var(--text-secondary)]">
                                                <span>{formatDate(payment.dueDate)}</span>
                                                <span className="mt-1 flex items-center gap-1 text-xs"><Phone size={12} /> {payment.phone ?? "Phone missing"}</span>
                                            </td>
                                            <td className="px-4 py-3 text-right font-semibold text-[color:var(--text-primary)]">{formatMoney(payment.amount)}</td>
                                            <td className="px-4 py-3 text-right"><DashboardPaymentAction href={getOverduePaymentHref(branchId, payment)} decision={recordDecision} /></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <div className={cn("divide-y lg:hidden", pageSectionDividerClass)}>
                        {shown.map(payment => {
                            const overdueDays = daysPastDue(payment.dueDate);
                            return (
                                <div key={payment.paymentId} className="space-y-3 px-4 py-4">
                                    <div className="flex items-start gap-3">
                                        <input
                                            type="checkbox"
                                            checked={selectedIds.has(payment.paymentId)}
                                            onChange={event => togglePayment(payment.paymentId, event.target.checked)}
                                            aria-label={`Select ${payment.studentName}'s overdue payment`}
                                            className="mt-0.5 h-5 w-5 shrink-0 rounded accent-cyan-500"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-start justify-between gap-3">
                                                <Link href={getOverdueStudentHref(branchId, payment.studentId)} className="truncate text-sm font-medium text-[color:var(--text-primary)] underline-offset-4 hover:underline">{payment.studentName}</Link>
                                                <p className="shrink-0 text-sm font-semibold text-[color:var(--text-primary)]">{formatMoney(payment.amount)}</p>
                                            </div>
                                            <p className="mt-1 text-xs text-rose-300">{overdueDays === 0 ? "Due today" : `${formatNumber(overdueDays)} days overdue`}</p>
                                            <p className={cn("mt-1 text-xs", pageSubtleTextClass)}>{formatDate(payment.dueDate)} · {payment.phone ?? "Phone missing"}</p>
                                        </div>
                                    </div>
                                    <div className="flex justify-end"><DashboardPaymentAction href={getOverduePaymentHref(branchId, payment)} decision={recordDecision} /></div>
                                </div>
                            );
                        })}
                    </div>

                    {payments.length > shown.length && (
                        <Link
                            href={`/branch/${encodeURIComponent(branchId)}/overdue`}
                            className={cn("flex min-h-11 w-full items-center justify-center gap-1.5 border-t px-4 py-3 text-xs font-medium text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--ui-table-row-hover-bg)] hover:text-[color:var(--text-primary)]", pageSectionDividerClass)}
                        >
                            View {formatNumber(payments.length - shown.length)} more overdue payments <ArrowRight size={13} />
                        </Link>
                    )}
                </>
            )}
        </AppPanel>
    );
}
