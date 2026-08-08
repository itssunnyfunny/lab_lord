"use client";

import { cn } from "@/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

export type DataViewMode = "table" | "grid";

interface DataTableProps<T> {
    columns: { header: string; accessor: keyof T | ((item: T) => ReactNode); className?: string; rowHeader?: boolean }[];
    data: T[];
    caption: string;
    actions?: (item: T) => ReactNode;
    viewMode?: DataViewMode;
    renderGridCard?: (item: T, actions?: (item: T) => ReactNode) => ReactNode;
    gridClassName?: string;
    emptyMessage?: string;
    getRowAttributes?: (item: T, view: "grid" | "table") => HTMLAttributes<HTMLElement>;
}

export function DataTable<T extends { id: string | number }>({
    columns,
    data,
    caption,
    actions,
    viewMode = "table",
    renderGridCard,
    gridClassName,
    emptyMessage = "No data available.",
    getRowAttributes,
}: DataTableProps<T>) {
    const cardGrid = renderGridCard ? (
        <div className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-3", gridClassName)}>
            {data.map((item) => {
                const attributes = getRowAttributes?.(item, "grid");
                return (
                <div
                    key={item.id}
                    {...attributes}
                    className={cn("min-w-0 scroll-mt-24", attributes?.className)}
                >
                    {renderGridCard(item, actions)}
                </div>
                );
            })}
            {data.length === 0 && (
                <div className="col-span-full rounded-[var(--ui-table-radius)] border border-dashed border-[color:var(--ui-table-empty-border)] py-12 text-center text-[color:var(--ui-table-subtle)]">
                    {emptyMessage}
                </div>
            )}
        </div>
    ) : null;

    const tableMinWidth = `${Math.max(44, columns.length * 10 + (actions ? 8 : 0))}rem`;
    const tableView = (
        <div
            role="region"
            aria-label={`${caption} table`}
            tabIndex={0}
            className="w-full overflow-x-auto overflow-y-hidden rounded-[var(--ui-table-radius)] border border-[color:var(--ui-table-border)] bg-[color:var(--ui-table-bg)] shadow-[var(--ui-table-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] scrollbar-thin scrollbar-thumb-cyan-400/35 scrollbar-track-slate-950/50"
        >
            <table className="w-full text-left text-sm" style={{ minWidth: tableMinWidth }}>
                <caption className="sr-only">{caption}</caption>
                <thead className="bg-[color:var(--ui-table-head-bg)]">
                    <tr>
                        {columns.map((col, idx) => (
                            <th
                                key={idx}
                                scope="col"
                                className={cn(
                                    "ui-density-cell px-6 py-4 text-xs font-medium uppercase tracking-wider text-[color:var(--ui-table-muted)]",
                                    col.className
                                )}
                            >
                                {col.header}
                            </th>
                        ))}
                        {actions && <th scope="col" className="ui-density-cell px-6 py-4 text-right text-xs uppercase text-[color:var(--ui-table-muted)]">Actions</th>}
                    </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--ui-table-divider)]">
                    {data.map((item) => {
                        const attributes = getRowAttributes?.(item, "table");
                        return (
                        <tr
                            key={item.id}
                            {...attributes}
                            className={cn(
                                "group scroll-mt-24 transition-colors duration-150 hover:bg-[color:var(--ui-table-row-hover-bg)]",
                                attributes?.className
                            )}
                        >
                            {columns.map((col, idx) => {
                                const Cell = col.rowHeader ? "th" : "td";
                                return (
                                    <Cell
                                        key={idx}
                                        {...(col.rowHeader ? { scope: "row" as const } : {})}
                                        className={cn("ui-density-cell px-6 py-4 text-[color:var(--ui-table-text)]", col.className)}
                                    >
                                        {typeof col.accessor === "function" ? col.accessor(item) : (item[col.accessor] as ReactNode)}
                                    </Cell>
                                );
                            })}
                            {actions && (
                                <td className="ui-density-cell px-6 py-4 text-right">
                                    {actions(item)}
                                </td>
                            )}
                        </tr>
                        );
                    })}
                    {data.length === 0 && (
                        <tr>
                            <td colSpan={columns.length + (actions ? 1 : 0)} className="py-12 text-center text-[color:var(--ui-table-subtle)]">
                                {emptyMessage}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );

    if (viewMode === "grid" && cardGrid) {
        return cardGrid;
    }

    if (cardGrid) {
        return (
            <>
                <div className="md:hidden">{cardGrid}</div>
                <div className="hidden md:block">{tableView}</div>
            </>
        );
    }

    return tableView;
}
