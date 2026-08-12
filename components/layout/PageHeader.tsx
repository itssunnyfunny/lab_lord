"use client";

import { Search, Filter, Plus, Download } from "lucide-react";
import { AppButton } from "@/components/ui";
import { formControlClass } from "@/components/ui/formSurface";
import { pageDescriptionClass, pageTitleClass } from "@/components/ui/pageSurface";
import type { ReactNode } from "react";

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    onSearch?: (term: string) => void;
    onFilter?: () => void;
    onAdd?: () => void;
    onExport?: () => void;
    exportLabel?: string;
    exportAriaLabel?: string;
    extraActions?: ReactNode;
    actionLabel?: string;
}

export function PageHeader({
    title,
    subtitle,
    onSearch,
    onFilter,
    onAdd,
    onExport,
    exportLabel,
    exportAriaLabel,
    extraActions,
    actionLabel = "Add New",
}: PageHeaderProps) {
    return (
        <div className="mb-6 flex flex-col justify-between gap-4 md:mb-8 md:flex-row md:items-end">
            <div className="min-w-0">
                <h1 className={`${pageTitleClass} truncate`}>{title}</h1>
                {subtitle && <p className={pageDescriptionClass}>{subtitle}</p>}
            </div>

            <div className="flex w-full flex-wrap items-center gap-3 md:w-auto md:justify-end">
                {onSearch && (
                    <div className="relative group w-full md:w-auto">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-muted)] transition-colors group-focus-within:text-[color:var(--ui-form-accent)]" />
                        <input
                            type="text"
                            placeholder="Search..."
                            aria-label={`Search ${title}`}
                            className={`${formControlClass} h-11 w-full pl-9 pr-4 text-base sm:text-sm md:w-64`}
                            onChange={(e) => onSearch(e.target.value)}
                        />
                    </div>
                )}

                {onFilter && (
                    <AppButton variant="secondary" size="icon" icon={Filter} onClick={onFilter} aria-label="Filter" />
                )}

                {onExport && (
                    <AppButton
                        variant="secondary"
                        size={exportLabel ? "md" : "icon"}
                        icon={Download}
                        onClick={onExport}
                        aria-label={exportAriaLabel ?? exportLabel ?? "Export"}
                    >
                        {exportLabel}
                    </AppButton>
                )}

                {extraActions}

                {onAdd && (
                    <AppButton onClick={onAdd} variant="primary" icon={Plus} className="flex-shrink-0 whitespace-nowrap">
                        {actionLabel}
                    </AppButton>
                )}
            </div>
        </div>
    );
}
