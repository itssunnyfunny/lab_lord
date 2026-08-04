"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import {
    AlertCircle,
    Calendar,
    Check,
    CheckCheck,
    Copy,
    IndianRupee,
    MessageSquare,
    RefreshCw,
    SlidersHorizontal,
    Sparkles,
    User,
    type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AppButton, AppPanel, LoadingCardGrid, PageShell } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import {
    formCheckboxClass,
    formErrorBannerClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { cn } from "@/lib/utils";
import {
    pageCountBadgeClass,
    pageEmptyStateClass,
    pageFilterShellClass,
    pageGridCardClass,
    pageInsetMetricClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSectionDividerClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";

type MessageLanguage = "en" | "hi";
type ReminderTone = "polite" | "friendly" | "firm";
type IncludeField = "name" | "date" | "fee";

interface MessageDraftInclude {
    name: boolean;
    date: boolean;
    fee: boolean;
}

interface OverdueMessageDraft {
    studentId: string;
    studentName: string;
    phone: string | null;
    dueDate: string;
    amount: number;
    daysOverdue: number;
    paymentCount: number;
    language: MessageLanguage;
    tone: ReminderTone;
    include: MessageDraftInclude;
    message: string;
    createdAt?: string;
    isOutdated?: boolean;
}

interface MessagesResponse {
    language: MessageLanguage;
    tone: ReminderTone;
    include: MessageDraftInclude;
    action: string;
    items: OverdueMessageDraft[];
    meta: {
        cachedCount: number;
        generatedCount: number;
        pendingGenerationCount: number;
        selectedRegenerationCount: number;
        rateLimited: boolean;
        nextAllowedCallAt: string;
        cooldownSeconds: number;
    };
}

const DEFAULT_INCLUDE: MessageDraftInclude = {
    name: true,
    date: true,
    fee: true,
};

const EMPTY_DRAFTS: OverdueMessageDraft[] = [];

const includeOptions: { value: IncludeField; label: string; icon: LucideIcon }[] = [
    { value: "name", label: "Name", icon: User },
    { value: "date", label: "Date", icon: Calendar },
    { value: "fee", label: "Fee", icon: IndianRupee },
];

const toneOptions: { value: ReminderTone; label: string }[] = [
    { value: "polite", label: "Polite" },
    { value: "friendly", label: "Friendly" },
    { value: "firm", label: "Firm" },
];

function formatMoney(amount: number) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(amount);
}

function formatGeneratedAt(value?: string) {
    if (!value) return "Not generated";
    return new Date(value).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatTimeLeft(nextAllowedCallAt?: string) {
    if (!nextAllowedCallAt) return "";
    const diff = new Date(nextAllowedCallAt).getTime() - Date.now();
    if (diff <= 0) return "";
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function ToggleButton<T extends string>({
    value,
    active,
    onClick,
    children,
}: {
    value: T;
    active: boolean;
    onClick: (value: T) => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={() => onClick(value)}
            aria-pressed={active}
            className={cn(
                "rounded-[var(--ui-radius-control)] px-3 py-1.5 text-xs font-semibold transition-colors",
                active
                    ? "bg-[color:var(--ui-view-toggle-table-active-bg)] text-[color:var(--ui-view-toggle-table-active-text)]"
                    : "text-[color:var(--text-secondary)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
            )}
        >
            {children}
        </button>
    );
}

function DraftMessageText({
    draft,
    onCopy,
}: {
    draft: OverdueMessageDraft;
    onCopy: (draft: OverdueMessageDraft) => void;
}) {
    const hasMessage = draft.message.trim().length > 0;

    return (
        <p
            className={cn("text-sm leading-6", hasMessage ? pageMutedTextClass : pageSubtleTextClass)}
            onDoubleClick={() => {
                if (hasMessage) onCopy(draft);
            }}
            title={hasMessage ? "Double-click to copy" : undefined}
        >
            <span>{hasMessage ? draft.message : "No draft generated yet."}</span>
        </p>
    );
}

function MessageCard({
    draft,
    selected,
    copied,
    onSelect,
    onCopy,
}: {
    draft: OverdueMessageDraft;
    selected: boolean;
    copied: boolean;
    onSelect: (studentId: string) => void;
    onCopy: (draft: OverdueMessageDraft) => void;
}) {
    const hasMessage = draft.message.trim().length > 0;

    return (
        <article className={cn(pageGridCardClass, "flex h-full flex-col gap-3")}>
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    className={cn(formCheckboxClass, "mt-1 shrink-0")}
                    checked={selected}
                    onChange={() => onSelect(draft.studentId)}
                    aria-label={`Select ${draft.studentName}`}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
                            {draft.studentName}
                        </h3>
                        <span className="whitespace-nowrap text-xs font-semibold text-rose-300">
                            {draft.daysOverdue}d overdue
                        </span>
                        {draft.phone && (
                            <span className={cn("whitespace-nowrap text-xs", pageSubtleTextClass)}>
                                {draft.phone}
                            </span>
                        )}
                        {draft.isOutdated && <Badge variant="warning">Outdated</Badge>}
                        {!hasMessage && <Badge variant="warning">Draft needed</Badge>}
                        {copied && <Badge variant="success">Copied</Badge>}
                    </div>
                </div>
                <AppButton
                    variant="quiet"
                    size="sm"
                    icon={copied ? CheckCheck : Copy}
                    onClick={() => onCopy(draft)}
                    disabled={!hasMessage}
                >
                    {copied ? "Copied" : "Copy"}
                </AppButton>
            </div>

            <div className={cn("p-3", pageInsetSurfaceClass)}>
                <DraftMessageText draft={draft} onCopy={onCopy} />
            </div>
        </article>
    );
}

export default function AIMessagesPage() {
    const params = useParams();
    const branchId = params.branchId as string;

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.aiMessages} feature="AI_MESSAGES">
            <AIMessagesContent branchId={branchId} />
        </BranchAccessGuard>
    );
}

function AIMessagesContent({ branchId }: { branchId: string }) {
    const [data, setData] = useState<MessagesResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preferencesLoaded, setPreferencesLoaded] = useState(false);
    const [language, setLanguage] = useState<MessageLanguage>("en");
    const [tone, setTone] = useState<ReminderTone>("polite");
    const [include, setInclude] = useState<MessageDraftInclude>(DEFAULT_INCLUDE);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(new Set());
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState("");

    const applyData = useCallback((nextData: MessagesResponse) => {
        setData(nextData);
        setSelectedIds(previous => {
            const available = new Set(nextData.items.map(item => item.studentId));
            return new Set(Array.from(previous).filter(id => available.has(id)));
        });
    }, []);

    const fetchData = useCallback(async (mode: "initial" | "refresh" = "initial") => {
        if (!preferencesLoaded) return;
        if (mode === "initial") setLoading(true);
        if (mode === "refresh") setRefreshing(true);
        setError(null);

        try {
            const res = await fetch(`/api/ai/branch/${branchId}/messages`);
            const json = await res.json().catch(() => null) as MessagesResponse | { error?: string; details?: string } | null;
            if (!res.ok || !json || !("items" in json)) {
                const message = json && !("items" in json)
                    ? json.details ?? json.error
                    : undefined;
                throw new Error(message ?? "Failed to fetch messages");
            }
            applyData(json);
        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : "Failed to fetch messages");
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [applyData, branchId, preferencesLoaded]);

    useEffect(() => {
        async function loadDefaults() {
            try {
                const [branchRes, userRes] = await Promise.all([
                    fetch(`/api/branches/${branchId}`),
                    fetch("/api/users/me"),
                ]);
                const branch = branchRes.ok ? await branchRes.json() : null;
                const user = userRes.ok ? await userRes.json() : null;
                const preferredLanguage = branch?.defaultMessageLanguage || user?.defaultMessageLanguage;
                const preferredTone = branch?.reminderTone;

                setLanguage(preferredLanguage === "hi" ? "hi" : "en");
                setTone(preferredTone === "friendly" || preferredTone === "firm" ? preferredTone : "polite");
            } catch (err) {
                console.error(err);
            } finally {
                setPreferencesLoaded(true);
            }
        }

        void loadDefaults();
    }, [branchId]);

    useEffect(() => {
        void fetchData();
    }, [fetchData]);

    useEffect(() => {
        const interval = setInterval(() => {
            setTimeLeft(formatTimeLeft(data?.meta.nextAllowedCallAt));
        }, 1000);

        setTimeLeft(formatTimeLeft(data?.meta.nextAllowedCallAt));
        return () => clearInterval(interval);
    }, [data?.meta.nextAllowedCallAt]);

    const items = data?.items ?? EMPTY_DRAFTS;
    const selectedCount = selectedIds.size;
    const allSelected = items.length > 0 && selectedCount === items.length;
    const cooldownActive = Boolean(timeLeft);

    const totals = useMemo(() => {
        return {
            students: items.length,
            amount: items.reduce((sum, item) => sum + item.amount, 0),
            outdated: items.filter(item => item.isOutdated).length,
            missingPhone: items.filter(item => !item.phone).length,
        };
    }, [items]);

    const toggleInclude = (field: IncludeField) => {
        setInclude(previous => {
            const next = { ...previous, [field]: !previous[field] };
            return Object.values(next).some(Boolean) ? next : previous;
        });
    };

    const toggleSelected = (studentId: string) => {
        setSelectedIds(previous => {
            const next = new Set(previous);
            if (next.has(studentId)) {
                next.delete(studentId);
            } else {
                next.add(studentId);
            }
            return next;
        });
    };

    const selectAll = () => {
        setSelectedIds(allSelected ? new Set() : new Set(items.map(item => item.studentId)));
    };

    const selectOutdated = () => {
        setSelectedIds(new Set(items.filter(item => item.isOutdated).map(item => item.studentId)));
    };

    const copyDraft = async (draft: OverdueMessageDraft) => {
        if (!draft.message.trim()) return;
        await navigator.clipboard.writeText(draft.message);
        setCopiedId(draft.studentId);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const regenerate = async (studentIds: string[]) => {
        if (studentIds.length === 0) return;
        setError(null);
        setRegeneratingIds(new Set(studentIds));

        try {
            const res = await fetch(`/api/ai/branch/${branchId}/messages`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    language,
                    tone,
                    include,
                    studentIds,
                }),
            });
            const json = await res.json().catch(() => null) as MessagesResponse | { error?: string; details?: string } | null;
            if (!res.ok || !json || !("items" in json)) {
                const message = json && !("items" in json)
                    ? json.details ?? json.error
                    : undefined;
                throw new Error(message ?? "Failed to regenerate messages");
            }

            const regeneratedByStudentId = new Map(json.items.map(item => [item.studentId, item]));
            const selected = new Set(studentIds);
            const currentItems = data?.items ?? EMPTY_DRAFTS;
            const mergedItems = currentItems.map(item => {
                if (!selected.has(item.studentId)) return item;
                return regeneratedByStudentId.get(item.studentId) ?? item;
            });
            const knownIds = new Set(mergedItems.map(item => item.studentId));
            for (const item of json.items) {
                if (selected.has(item.studentId) && !knownIds.has(item.studentId)) {
                    mergedItems.push(item);
                }
            }

            applyData({ ...json, items: mergedItems });
            if (json.meta.rateLimited) {
                setError("Regeneration is cooling down. The current drafts are still available.");
            } else {
                setSelectedIds(previous => {
                    const next = new Set(previous);
                    studentIds.forEach(id => next.delete(id));
                    return next;
                });
            }
        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : "Failed to regenerate messages");
        } finally {
            setRegeneratingIds(new Set());
        }
    };

    return (
        <div className="p-4 md:p-8">
            <PageShell>
                <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                    <PageHeader
                        title="AI Message Drafts"
                        subtitle="Payment follow-up drafts with branch-level tone, language, and selected regeneration controls."
                    />
                    <div className="flex flex-wrap gap-2">
                        <AppButton
                            variant="secondary"
                            icon={RefreshCw}
                            onClick={() => fetchData("refresh")}
                            disabled={refreshing}
                            className={refreshing ? "[&_svg]:animate-spin" : undefined}
                        >
                            Refresh
                        </AppButton>
                        <AppButton
                            variant="primary"
                            icon={Sparkles}
                            onClick={() => regenerate(Array.from(selectedIds))}
                            disabled={selectedCount === 0 || cooldownActive}
                            isLoading={regeneratingIds.size > 0}
                        >
                            Regenerate selected
                        </AppButton>
                    </div>
                </div>

                <AppPanel
                    title="Draft controls"
                    description="Changes apply to the next generated version."
                    action={
                        <span className={cn("flex items-center gap-1.5", pageCountBadgeClass)}>
                            <SlidersHorizontal size={12} />
                            {selectedCount} selected
                        </span>
                    }
                    contentClassName="space-y-4"
                >
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
                        <div>
                            <p className="mb-2 text-xs font-semibold uppercase text-[color:var(--text-muted)]">Language</p>
                            <div className={cn("inline-flex p-1", pageFilterShellClass)}>
                                <ToggleButton value="en" active={language === "en"} onClick={setLanguage}>
                                    English
                                </ToggleButton>
                                <ToggleButton value="hi" active={language === "hi"} onClick={setLanguage}>
                                    Hindi
                                </ToggleButton>
                            </div>
                        </div>

                        <div>
                            <p className="mb-2 text-xs font-semibold uppercase text-[color:var(--text-muted)]">Tone</p>
                            <div className={cn("inline-flex flex-wrap gap-1 p-1", pageFilterShellClass)}>
                                {toneOptions.map(option => (
                                    <ToggleButton
                                        key={option.value}
                                        value={option.value}
                                        active={tone === option.value}
                                        onClick={setTone}
                                    >
                                        {option.label}
                                    </ToggleButton>
                                ))}
                            </div>
                        </div>

                        <div>
                            <p className="mb-2 text-xs font-semibold uppercase text-[color:var(--text-muted)]">Include</p>
                            <div className="flex flex-wrap gap-2">
                                {includeOptions.map(option => {
                                    const Icon = option.icon;
                                    return (
                                        <label
                                            key={option.value}
                                            className={cn("flex cursor-pointer items-center gap-2 px-3 py-2 text-xs", pageInsetSurfaceClass, pageMutedTextClass)}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={include[option.value]}
                                                onChange={() => toggleInclude(option.value)}
                                                className={formCheckboxClass}
                                            />
                                            <Icon size={13} />
                                            <span className="font-semibold">{option.label}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    <div className={cn("grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4", pageSectionDividerClass)}>
                        <Metric label="Students" value={totals.students} />
                        <Metric label="Pending" value={formatMoney(totals.amount)} />
                        <Metric label="Outdated" value={totals.outdated} />
                        <Metric label="No phone" value={totals.missingPhone} />
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <AppButton variant="quiet" size="sm" icon={allSelected ? CheckCheck : Check} onClick={selectAll}>
                            {allSelected ? "Clear all" : "Select all"}
                        </AppButton>
                        <AppButton variant="quiet" size="sm" icon={RefreshCw} onClick={selectOutdated} disabled={totals.outdated === 0}>
                            Select outdated
                        </AppButton>
                    </div>
                </AppPanel>

                {error && (
                    <div className={cn("flex items-start gap-3 px-4 py-3 text-sm", formErrorBannerClass)}>
                        <AlertCircle size={16} className="mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {cooldownActive && (
                    <div className={cn("flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between", formWarningBannerClass)}>
                        <span>Next regeneration opens in {timeLeft}.</span>
                        <span className="font-mono text-xs">{data?.meta.nextAllowedCallAt ? formatGeneratedAt(data.meta.nextAllowedCallAt) : ""}</span>
                    </div>
                )}

                {data?.meta.pendingGenerationCount ? (
                    <div className={cn("flex items-start gap-3 px-4 py-3 text-sm", formWarningBannerClass)}>
                        <AlertCircle size={16} className="mt-0.5 shrink-0" />
                        <span>{data.meta.pendingGenerationCount} draft{data.meta.pendingGenerationCount === 1 ? "" : "s"} will be generated after the cooldown.</span>
                    </div>
                ) : null}

                {loading ? (
                    <LoadingCardGrid cards={4} />
                ) : items.length === 0 ? (
                    <div className={pageEmptyStateClass}>
                        <MessageSquare className="mx-auto mb-4 opacity-60" size={42} />
                        <p className="mb-1 font-medium text-[color:var(--text-primary)]">No overdue drafts</p>
                        <p className={cn("text-sm", pageMutedTextClass)}>There are no overdue students for this message setup.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                        {items.map((draft) => (
                            <MessageCard
                                key={draft.studentId}
                                draft={draft}
                                selected={selectedIds.has(draft.studentId)}
                                copied={copiedId === draft.studentId}
                                onSelect={toggleSelected}
                                onCopy={copyDraft}
                            />
                        ))}
                    </div>
                )}
            </PageShell>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: string | number }) {
    return (
        <div className={pageInsetMetricClass}>
            <p className={cn("text-xs", pageSubtleTextClass)}>{label}</p>
            <p className="mt-1 truncate text-sm font-semibold text-[color:var(--text-primary)]">{value}</p>
        </div>
    );
}
