"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    AlertCircle,
    ArrowRight,
    CalendarCheck,
    Command,
    CreditCard,
    Grid,
    Search,
    UserCircle,
    Users,
} from "lucide-react";
import { useBranchAccess } from "@/hooks/useBranchAccess";
import { branchSearch } from "@/lib/api/branchSearch";
import type { TopSearchGroup, TopSearchResult, TopSearchResultType } from "@/lib/topSearch";
import { cn } from "@/lib/utils";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import { SkeletonBlock } from "@/components/ui";
import {
    chromeEmptyStateClass,
    chromeInputClass,
    chromeInputIconClass,
    chromeInputShellClass,
    chromeListIconClass,
    chromeListItemActiveClass,
    chromeListItemClass,
    chromePopoverClass,
    chromePopoverScrollClass,
    chromeSubtleTextClass,
} from "@/components/ui/chromeSurface";

const TYPE_ICONS: Record<TopSearchResultType, typeof Command> = {
    action: Command,
    student: Users,
    payment: CreditCard,
    seat: Grid,
    shift: CalendarCheck,
    staff: UserCircle,
};

function getBranchId(pathname: string | null) {
    const segments = pathname?.split("/").filter(Boolean) ?? [];
    if (segments[0] !== "branch" || !segments[1]) return undefined;
    return segments[1];
}

function DisabledSearch() {
    return (
        <div className={cn(chromeInputShellClass, "opacity-70")}>
            <Search className={chromeInputIconClass} size={16} />
            <input
                type="text"
                disabled
                aria-label="Branch search unavailable"
                placeholder="Open a branch to search"
                className={chromeInputClass}
            />
        </div>
    );
}

function SearchPopoverSkeleton() {
    return (
        <div role="status" aria-live="polite" className="space-y-2 px-3 py-3">
            <span className="sr-only">Searching this branch</span>
            {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 rounded-[var(--ui-radius-control)] px-1 py-2">
                    <SkeletonBlock className="h-8 w-8" />
                    <div className="min-w-0 flex-1 space-y-2">
                        <SkeletonBlock className="h-4 w-36 max-w-full" />
                        <SkeletonBlock className="h-3 w-48 max-w-full" />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function BranchTopSearch() {
    const pathname = usePathname();
    const router = useRouter();
    const branchId = getBranchId(pathname);
    const { access, loading: accessLoading, error: accessError } = useBranchAccess(branchId);
    const rootRef = useRef<HTMLDivElement>(null);
    const loadSeq = useRef(0);
    const listboxId = `branch-search-${useId().replace(/:/g, "")}`;
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const [groups, setGroups] = useState<TopSearchGroup[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(-1);

    const indexedGroups = useMemo(() => {
        let index = 0;
        return groups.map(group => ({
            ...group,
            results: group.results.map(result => ({ result, index: index++ })),
        }));
    }, [groups]);
    const flatResults = useMemo(
        () => indexedGroups.flatMap(group => group.results.map(item => item.result)),
        [indexedGroups]
    );

    const optionId = useCallback((result: TopSearchResult) => (
        `${listboxId}-${result.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
    ), [listboxId]);

    useEffect(() => {
        loadSeq.current += 1;
        setQuery("");
        setOpen(false);
        setGroups([]);
        setLoadError(null);
        setSelectedIndex(-1);
    }, [branchId]);

    useEffect(() => {
        if (!open || !branchId || !access) return;

        const seq = ++loadSeq.current;
        const timer = window.setTimeout(() => {
            setLoading(true);
            setLoadError(null);
            branchSearch.search(branchId, query)
                .then(results => {
                    if (seq !== loadSeq.current) return;
                    setGroups(results);
                })
                .catch(error => {
                    if (seq !== loadSeq.current) return;
                    setGroups([]);
                    setLoadError(error instanceof Error ? error.message : "Search is temporarily unavailable.");
                })
                .finally(() => {
                    if (seq === loadSeq.current) setLoading(false);
                });
        }, query.trim() ? 200 : 0);

        return () => window.clearTimeout(timer);
    }, [access, branchId, open, query]);

    useEffect(() => {
        if (!open) return;
        const handleMouseDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handleMouseDown);
        return () => document.removeEventListener("mousedown", handleMouseDown);
    }, [open]);

    useEffect(() => {
        setSelectedIndex(current => {
            if (!open || flatResults.length === 0) return -1;
            return current >= 0 && current < flatResults.length ? current : 0;
        });
    }, [flatResults.length, open]);

    const executeResult = useCallback((result: TopSearchResult) => {
        setOpen(false);
        setQuery("");
        router.push(result.href);
    }, [router]);

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
            setOpen(false);
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setSelectedIndex(current => {
                if (flatResults.length === 0) return -1;
                if (event.key === "ArrowDown") {
                    return current < 0 ? 0 : (current + 1) % flatResults.length;
                }
                return current <= 0 ? flatResults.length - 1 : current - 1;
            });
            return;
        }
        if (event.key === "Enter" && selectedIndex >= 0) {
            const selected = flatResults[selectedIndex];
            if (selected) {
                event.preventDefault();
                executeResult(selected);
            }
        }
    };

    if (!branchId) return <DisabledSearch />;

    const disabled = accessLoading || Boolean(accessError) || !access;
    const placeholder = accessLoading
        ? "Checking branch access..."
        : accessError
            ? "Search unavailable"
            : "Search branch...";
    const hasResults = flatResults.length > 0;
    const trimmedQuery = query.trim();

    return (
        <div ref={rootRef} className={chromeInputShellClass}>
            <div className="relative group">
                <Search
                    className={cn(chromeInputIconClass, disabled && "group-focus-within:text-[color:var(--ui-form-icon)]")}
                    size={16}
                />
                <input
                    role="combobox"
                    type="search"
                    value={query}
                    disabled={disabled}
                    placeholder={placeholder}
                    onFocus={() => setOpen(true)}
                    onChange={event => {
                        setQuery(event.target.value);
                        setOpen(true);
                    }}
                    onKeyDown={handleKeyDown}
                    aria-label="Search current branch"
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-expanded={open && !disabled}
                    aria-controls={listboxId}
                    aria-activedescendant={selectedIndex >= 0 && flatResults[selectedIndex]
                        ? optionId(flatResults[selectedIndex])
                        : undefined}
                    className={cn(chromeInputClass, disabled && "cursor-not-allowed opacity-70")}
                />
                <span className="sr-only" role="status" aria-live="polite">
                    {loading ? "Searching" : `${flatResults.length} search results available`}
                </span>
            </div>

            {open && !disabled && (
                <div className={cn(chromePopoverClass, "sm:absolute sm:left-0 sm:right-0 sm:top-12")}>
                    <div
                        id={listboxId}
                        role="listbox"
                        aria-label="Branch search results"
                        className={chromePopoverScrollClass}
                    >
                        {loading && <SearchPopoverSkeleton />}
                        {loadError && (
                            <div role="alert" className={cn("mx-2 mb-2 flex items-start gap-2 px-3 py-2 text-xs leading-5", formWarningBannerClass)}>
                                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                                <span>{loadError}</span>
                            </div>
                        )}

                        {!loading && indexedGroups.map(group => {
                            const groupLabelId = `${listboxId}-${group.id}-label`;
                            return (
                                <div key={group.id} role="group" aria-labelledby={groupLabelId} className="py-1">
                                    <div id={groupLabelId} className={cn("px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider", chromeSubtleTextClass)}>
                                        {group.label}
                                    </div>
                                    <div className="space-y-0.5 px-1.5">
                                        {group.results.map(({ result, index }) => {
                                            const Icon = TYPE_ICONS[result.type];
                                            const selected = index === selectedIndex;
                                            return (
                                                <button
                                                    id={optionId(result)}
                                                    key={result.id}
                                                    type="button"
                                                    role="option"
                                                    aria-selected={selected}
                                                    onMouseEnter={() => setSelectedIndex(index)}
                                                    onMouseDown={event => {
                                                        event.preventDefault();
                                                        executeResult(result);
                                                    }}
                                                    className={cn(chromeListItemClass, selected && chromeListItemActiveClass)}
                                                >
                                                    <span className={cn(
                                                        chromeListIconClass,
                                                        result.type === "action"
                                                            ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                                                            : ""
                                                    )}>
                                                        <Icon size={15} />
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-sm font-semibold">{result.title}</span>
                                                        <span className={cn("block truncate text-xs", chromeSubtleTextClass)}>{result.subtitle}</span>
                                                    </span>
                                                    <ArrowRight size={14} className={cn(
                                                        "flex-shrink-0 transition-opacity",
                                                        selected ? "text-[color:var(--ui-form-accent)] opacity-100" : "text-[color:var(--text-muted)] opacity-0"
                                                    )} />
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}

                        {!loading && !loadError && !hasResults && (
                            <div className={chromeEmptyStateClass}>
                                {trimmedQuery.length === 1
                                    ? "Type one more character to search branch records."
                                    : trimmedQuery
                                        ? `No matches for “${trimmedQuery}”.`
                                        : "No searchable actions are available for this branch."}
                            </div>
                        )}
                        {!loading && !trimmedQuery && hasResults && (
                            <div className={cn("border-t border-[color:var(--ui-panel-header-border)] px-4 py-2 text-xs", chromeSubtleTextClass)}>
                                Type at least two characters to search records.
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
