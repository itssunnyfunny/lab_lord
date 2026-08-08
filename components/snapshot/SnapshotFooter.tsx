"use client";

import { AppPanel } from "@/components/ui";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { analytics, BranchSnapshot, TrendData } from "@/lib/api/analytics";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const tooltipStyle = {
    backgroundColor: "var(--ui-menu-bg)",
    border: "1px solid var(--ui-menu-border)",
    borderRadius: "8px",
};

export function SnapshotFooter({ snapshot, branchId }: { snapshot?: BranchSnapshot; branchId?: string }) {
    const [studentTrends, setStudentTrends] = useState<TrendData>([]);
    const [paymentTrends, setPaymentTrends] = useState<TrendData>([]);
    const { formatDate, formatNumber } = useUserPreferences();
    const formatMoney = (amount: number) => formatNumber(amount, {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    });

    useEffect(() => {
        if (!branchId) return;
        const loadTrends = async () => {
            try {
                const to = new Date().toISOString();
                const from = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

                const [stu, pay] = await Promise.all([
                    analytics.getTrends(branchId, { from, to, type: "students" }),
                    analytics.getTrends(branchId, { from, to, type: "payment" }),
                ]);

                setStudentTrends(stu);
                setPaymentTrends(pay);
            } catch (err) {
                console.error("Failed to load footer trends", err);
            }
        };
        loadTrends();
    }, [branchId]);

    const studentData = useMemo(() => {
        const dataByDate = new Map<string, { name: string; active: number; inactive: number }>();
        studentTrends.forEach(trend => {
            const point = dataByDate.get(trend.date) ?? {
                name: formatDate(trend.date, { weekday: "short" }),
                active: 0,
                inactive: 0,
            };
            if (trend.category === "Active") point.active = trend.value;
            if (trend.category === "Inactive") point.inactive = trend.value;
            dataByDate.set(trend.date, point);
        });
        return Array.from(dataByDate.values());
    }, [formatDate, studentTrends]);

    const paymentData = useMemo(() => {
        const dataByDate = new Map<string, { name: string; paid: number; due: number }>();
        paymentTrends.forEach(trend => {
            const point = dataByDate.get(trend.date) ?? {
                name: formatDate(trend.date, { weekday: "short" }),
                paid: 0,
                due: 0,
            };
            if (trend.category === "Collected") point.paid = trend.value;
            if (trend.category === "Pending") point.due = trend.value;
            dataByDate.set(trend.date, point);
        });
        return Array.from(dataByDate.values());
    }, [formatDate, paymentTrends]);

    if (!snapshot) return null;

    return (
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AppPanel title="Active vs. Inactive Students" className="flex h-[300px] flex-col" contentClassName="min-h-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={studentData.length > 0 ? studentData : [{ name: "Loading", active: 0, inactive: 0 }]} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }} dy={10} />
                        <YAxis
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }}
                            tickFormatter={value => formatNumber(Number(value))}
                        />
                        <Tooltip
                            cursor={{ fill: "var(--ui-form-muted-surface-bg)" }}
                            contentStyle={tooltipStyle}
                            itemStyle={{ color: "var(--text-primary)" }}
                            formatter={(value: number | string | undefined, name: string | number | undefined) => [
                                formatNumber(Number(value ?? 0)),
                                String(name ?? ""),
                            ]}
                        />
                        <Bar name="Active" dataKey="active" fill="var(--ui-tone-info-progress)" radius={[4, 4, 0, 0]} stackId="a" />
                        <Bar name="Inactive" dataKey="inactive" fill="var(--ui-tone-neutral-progress)" radius={[4, 4, 0, 0]} stackId="a" />
                    </BarChart>
                </ResponsiveContainer>
            </AppPanel>

            <AppPanel title="Due vs. Paid Payments" className="flex h-[300px] flex-col" contentClassName="min-h-0 flex-1">
                <div className="flex h-full items-end justify-between pb-4">
                    <div className="space-y-4">
                        <div>
                            <p className="text-sm text-[color:var(--text-secondary)]">Collected</p>
                            <h3 className="text-2xl font-semibold text-[color:var(--text-primary)]">{formatMoney(snapshot.paidAmount)}</h3>
                        </div>
                        <div>
                            <p className="text-sm text-[color:var(--text-secondary)]">Pending</p>
                            <h3 className="text-2xl font-semibold text-[color:var(--ui-tone-danger-text)]">{formatMoney(snapshot.dueAmount)}</h3>
                        </div>
                    </div>
                    <div className="ml-10 h-[200px] flex-1">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={paymentData.length > 0 ? paymentData : [{ name: "Loading", paid: 0, due: 0 }]} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }} dy={10} />
                                <YAxis
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{ fill: "var(--ui-table-muted)", fontSize: 12 }}
                                    tickFormatter={value => formatMoney(Number(value))}
                                />
                                <Tooltip
                                    cursor={{ fill: "transparent" }}
                                    contentStyle={tooltipStyle}
                                    itemStyle={{ color: "var(--text-primary)" }}
                                    formatter={(value: number | string | undefined, name: string | number | undefined) => [formatMoney(Number(value ?? 0)), String(name ?? "")]}
                                />
                                <Bar name="Collected" dataKey="paid" fill="var(--ui-tone-success-progress)" radius={[4, 4, 0, 0]} stackId="b" />
                                <Bar name="Pending" dataKey="due" fill="var(--ui-tone-danger-progress)" radius={[4, 4, 0, 0]} stackId="b" />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </AppPanel>
        </div>
    );
}
