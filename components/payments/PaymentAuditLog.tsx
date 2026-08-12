"use client";

import { useEffect, useState } from "react";
import { payments, AuditLogEntry } from "@/lib/api/payments";
import { ShieldCheck, AlertCircle, History } from "lucide-react";
import { Dialog, SkeletonBlock } from "@/components/ui";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import {
    formErrorBannerClass,
    formHelpTextClass,
    formIconClass,
    formSurfaceClass,
} from "@/components/ui/formSurface";
import { cn } from "@/lib/utils";

const ACTION_LABEL: Record<AuditLogEntry["action"], string> = {
    PAYMENT_MARKED_PAID: "Marked as Paid",
    PAYMENT_WAIVED: "Waived",
};

const ACTION_COLOR: Record<AuditLogEntry["action"], string> = {
    PAYMENT_MARKED_PAID: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    PAYMENT_WAIVED: "text-amber-400 bg-amber-500/10 border-amber-500/20",
};

interface PaymentAuditLogProps {
    paymentId: string;
    studentName: string;
    isOpen: boolean;
    onClose: () => void;
}

export function PaymentAuditLog({
    paymentId,
    studentName,
    isOpen,
    onClose,
}: PaymentAuditLogProps) {
    const { formatDateTime, formatNumber } = useUserPreferences();
    const [logs, setLogs] = useState<AuditLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!isOpen) return;

        queueMicrotask(() => {
            setLoading(true);
            setError(null);
        });

        payments
            .getAuditLog(paymentId)
            .then(setLogs)
            .catch(() => setError("Failed to load audit log."))
            .finally(() => setLoading(false));
    }, [isOpen, paymentId]);

    const formatCurrency = (amount: number) =>
        formatNumber(amount, {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 0,
        });

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Payment history"
            description={studentName}
            closeLabel="Close payment history"
            className="max-w-md"
            icon={(
                <div className="rounded-full bg-violet-500/10 p-2">
                    <History className="h-4 w-4 text-violet-400" aria-hidden="true" />
                </div>
            )}
        >
                <div className="space-y-3">
                    {loading && (
                        <div role="status" aria-live="polite" className="space-y-3">
                            <span className="sr-only">Loading payment history</span>
                            {Array.from({ length: 3 }, (_, index) => (
                                <div key={index} className={cn("flex items-start gap-3 p-3", formSurfaceClass)}>
                                    <SkeletonBlock className="h-8 w-8 rounded-full" />
                                    <div className="min-w-0 flex-1 space-y-2">
                                        <div className="flex items-center gap-2">
                                            <SkeletonBlock className="h-5 w-24 rounded-full" />
                                            <SkeletonBlock className="h-4 w-16" />
                                        </div>
                                        <SkeletonBlock className="h-3 w-4/5" />
                                        <SkeletonBlock className="h-3 w-2/5" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {error && !loading && (
                        <div role="alert" className={cn("flex items-center justify-center gap-2 px-3 py-6 text-sm", formErrorBannerClass)}>
                            <AlertCircle className="h-4 w-4" aria-hidden="true" />
                            {error}
                        </div>
                    )}

                    {!loading && !error && logs.length === 0 && (
                        <div className={cn("py-10 text-center text-sm", formHelpTextClass)}>
                            <ShieldCheck className="mx-auto mb-2 h-8 w-8 opacity-30" aria-hidden="true" />
                            No recorded actions for this payment.
                        </div>
                    )}

                    {!loading && !error && logs.map((log) => (
                        <div
                            key={log.id}
                            className={cn("flex items-start gap-3 p-3", formSurfaceClass)}
                        >
                            <div className="mt-0.5">
                                <ShieldCheck className={cn("h-4 w-4", formIconClass)} aria-hidden="true" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span
                                        className={cn(
                                            "text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border",
                                            ACTION_COLOR[log.action]
                                        )}
                                    >
                                        {ACTION_LABEL[log.action]}
                                    </span>
                                    <span className={cn("text-xs", formHelpTextClass)}>
                                        {formatCurrency(log.details.amount)}
                                    </span>
                                    {log.details.method && (
                                        <span className="rounded border border-[color:var(--ui-form-input-border)] bg-[color:var(--ui-form-input-bg)] px-1.5 py-0.5 text-xs font-medium text-[color:var(--ui-form-label)]">
                                            {log.details.method}
                                        </span>
                                    )}
                                </div>
                                <div className={cn("mt-1.5 flex items-center gap-1 text-xs", formHelpTextClass)}>
                                    <span className="truncate font-medium text-[color:var(--ui-form-label)]">
                                        {log.user.name || log.user.email}
                                    </span>
                                    <span>·</span>
                                    <span>
                                        {formatDateTime(log.createdAt)}
                                    </span>
                                </div>
                                <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-[color:var(--ui-table-subtle)]">
                                    <span>{log.details.from} → {log.details.to}</span>
                                    {log.details.referenceId && (
                                        <span className={cn("font-mono", formHelpTextClass)}>
                                            Ref: {log.details.referenceId}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
        </Dialog>
    );
}
