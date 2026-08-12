"use client";

import { AppPanel } from "@/components/ui";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { TrendData } from "@/lib/api/analytics";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface MainChartProps {
    data?: TrendData;
    title?: string;
    variant?: "area" | "bar";
    valueFormatter?: (value: number) => string;
    color?: string;
    emptyLabel?: string;
    contextLabel?: string;
    dataLabel?: string;
}

type DisplayChartPoint = TrendData[number] & {
    displayDate: string;
};

export function buildChartSummary({
    title,
    contextLabel,
    data,
    valueFormatter,
}: {
    title: string;
    contextLabel?: string;
    data: DisplayChartPoint[];
    valueFormatter: (value: number) => string;
}) {
    const subject = contextLabel ?? title;
    if (data.length === 0) return `${subject}. No data points are available.`;

    if (data.length === 1) {
        return `${subject}. ${data[0].displayDate}: ${valueFormatter(data[0].value)}.`;
    }

    const lowest = data.reduce((current, point) => point.value < current.value ? point : current);
    const highest = data.reduce((current, point) => point.value > current.value ? point : current);

    if (lowest.value === highest.value) {
        return `${subject}. ${data.length} data points, all at ${valueFormatter(lowest.value)}.`;
    }

    return `${subject}. ${data.length} data points ranging from ${valueFormatter(lowest.value)} at ${lowest.displayDate} to ${valueFormatter(highest.value)} at ${highest.displayDate}.`;
}

export function MainChart({
    data = [],
    title = "Analytics Trend",
    variant = "area",
    valueFormatter,
    color = "var(--ui-tone-info-progress)",
    emptyLabel = "No trend data available.",
    contextLabel,
    dataLabel,
}: MainChartProps) {
    const { formatDate, formatNumber } = useUserPreferences();
    const resolvedValueFormatter = valueFormatter ?? ((value: number) => formatNumber(value));
    const chartData: DisplayChartPoint[] = data.map(d => ({
        ...d,
        displayDate: variant === "bar"
            ? d.category ?? d.date
            : Number.isNaN(new Date(d.date).getTime())
                ? d.date
                : formatDate(d.date),
    }));
    const chartSummary = buildChartSummary({
        title,
        contextLabel,
        data: chartData,
        valueFormatter: resolvedValueFormatter,
    });
    const firstColumnLabel = dataLabel ?? (variant === "bar" ? "Category" : "Date");

    if (chartData.length === 0) {
        return (
            <AppPanel
                className="col-span-1 flex min-h-[400px] flex-col lg:col-span-2"
                title={title}
                description={chartSummary}
                contentClassName="flex min-h-0 flex-1"
            >
                <div className="flex flex-1 items-center justify-center rounded-[var(--ui-radius-control)] border border-dashed border-[color:var(--ui-table-empty-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-4 text-center text-sm text-[color:var(--text-secondary)]">
                    {emptyLabel}
                </div>
            </AppPanel>
        );
    }

    const tooltipStyle = {
        backgroundColor: "var(--ui-menu-bg)",
        border: "1px solid var(--ui-menu-border)",
        borderRadius: "8px",
    };

    return (
        <AppPanel
            className="col-span-1 flex min-h-[400px] flex-col lg:col-span-2"
            title={title}
            description={chartSummary}
            contentClassName="flex min-h-0 flex-1 flex-col gap-3"
        >
            <div
                role="img"
                aria-label={chartSummary}
                className="min-h-[260px] w-full flex-1 pt-2"
            >
                <ResponsiveContainer width="100%" height="100%">
                    {variant === "bar" ? (
                        <BarChart data={chartData} accessibilityLayer={false}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--ui-table-divider)" />
                            <XAxis dataKey="displayDate" axisLine={false} tickLine={false} tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }} dy={10} />
                            <YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }} tickFormatter={value => resolvedValueFormatter(Number(value))} />
                            <Tooltip
                                cursor={{ fill: "var(--ui-form-muted-surface-bg)" }}
                                contentStyle={tooltipStyle}
                                itemStyle={{ color: "var(--text-primary)" }}
                                formatter={value => resolvedValueFormatter(Number(value))}
                            />
                            <Bar dataKey="value" fill={color} radius={[6, 6, 0, 0]} />
                        </BarChart>
                    ) : (
                        <AreaChart data={chartData} accessibilityLayer={false}>
                            <defs>
                                <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--ui-table-divider)" />
                            <XAxis dataKey="displayDate" axisLine={false} tickLine={false} tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }} dy={10} />
                            <YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }} tickFormatter={value => resolvedValueFormatter(Number(value))} />
                            <Tooltip
                                contentStyle={tooltipStyle}
                                itemStyle={{ color: "var(--text-primary)" }}
                                formatter={value => resolvedValueFormatter(Number(value))}
                            />
                            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
                        </AreaChart>
                    )}
                </ResponsiveContainer>
            </div>

            <details className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-table-border)] bg-[color:var(--ui-form-muted-surface-bg)]">
                <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm font-semibold text-[color:var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] [&::-webkit-details-marker]:hidden">
                    View chart data
                </summary>
                <div
                    role="region"
                    aria-label={`${title} data table`}
                    tabIndex={0}
                    className="overflow-x-auto border-t border-[color:var(--ui-table-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
                >
                    <table className="w-full min-w-[420px] text-left text-sm">
                        <caption className="sr-only">Data displayed in the {title} chart</caption>
                        <thead className="bg-[color:var(--ui-table-head-bg)] text-xs uppercase tracking-wide text-[color:var(--ui-table-muted)]">
                            <tr>
                                <th scope="col" className="px-3 py-2">{firstColumnLabel}</th>
                                <th scope="col" className="px-3 py-2">Value</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[color:var(--ui-table-divider)]">
                            {chartData.map((point, index) => (
                                <tr key={`${point.date}-${point.category ?? "value"}-${index}`}>
                                    <th scope="row" className="px-3 py-2 text-left font-normal text-[color:var(--text-secondary)]">{point.displayDate}</th>
                                    <td className="px-3 py-2 font-medium text-[color:var(--text-primary)]">{resolvedValueFormatter(point.value)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </details>
        </AppPanel>
    );
}
