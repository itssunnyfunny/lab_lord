"use client";

import { cn } from "@/lib/utils";
import { LayoutGrid, List, type LucideIcon } from "lucide-react";
import type { DataViewMode } from "./DataTable";

interface ViewToggleProps {
    value: DataViewMode;
    onChange: (value: DataViewMode) => void;
    className?: string;
}

const options: {
    value: DataViewMode;
    label: string;
    Icon: LucideIcon;
    activeClassName: string;
    dotClassName: string;
}[] = [
    {
        value: "table",
        label: "Table view",
        Icon: List,
        activeClassName: "bg-[color:var(--ui-view-toggle-table-active-bg)] text-[color:var(--ui-view-toggle-table-active-text)] ring-[color:var(--ui-view-toggle-table-ring)]",
        dotClassName: "bg-[color:var(--ui-view-toggle-table-dot)] shadow-[var(--ui-view-toggle-table-dot-shadow)]",
    },
    {
        value: "grid",
        label: "Grid view",
        Icon: LayoutGrid,
        activeClassName: "bg-[color:var(--ui-view-toggle-grid-active-bg)] text-[color:var(--ui-view-toggle-grid-active-text)] ring-[color:var(--ui-view-toggle-grid-ring)]",
        dotClassName: "bg-[color:var(--ui-view-toggle-grid-dot)] shadow-[var(--ui-view-toggle-grid-dot-shadow)]",
    },
];

export function ViewToggle({ value, onChange, className }: ViewToggleProps) {
    return (
        <div className={cn("inline-flex items-center gap-1 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-view-toggle-border)] bg-[color:var(--ui-view-toggle-bg)] p-1", className)}>
            {options.map(({ value: optionValue, label, Icon, activeClassName, dotClassName }) => {
                const active = value === optionValue;

                return (
                    <button
                        key={optionValue}
                        type="button"
                        aria-label={label}
                        aria-pressed={active}
                        title={label}
                        onClick={() => onChange(optionValue)}
                        className={cn(
                            "relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-[calc(var(--ui-radius-control)-2px)] text-[color:var(--ui-view-toggle-text)] transition-colors lg:h-8 lg:w-8",
                            "hover:bg-[color:var(--ui-view-toggle-hover-bg)] hover:text-[color:var(--ui-view-toggle-hover-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]",
                            active && "ring-1 shadow-sm",
                            active && activeClassName
                        )}
                    >
                        <Icon size={16} />
                        {active && (
                            <span
                                aria-hidden="true"
                                className={cn("absolute bottom-1 h-1 w-1 rounded-full", dotClassName)}
                            />
                        )}
                    </button>
                );
            })}
        </div>
    );
}
