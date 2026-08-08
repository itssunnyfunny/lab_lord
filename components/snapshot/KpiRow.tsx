"use client";

import { AppPanel } from "@/components/ui";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { AnalyticsPeriod, analytics, BranchSnapshot } from "@/lib/api/analytics";
import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

interface KpiRowProps {
    title: string;
    value: string;
    trend?: string;
    trendUp?: boolean;
    data?: number[];
}

export function KpiCard({ title, value, trend, trendUp = true, data }: KpiRowProps) {
    const chartData = data ? data.map(v => ({ v })) : [];
    const color = trendUp ? "var(--ui-tone-success-progress)" : "var(--ui-tone-danger-progress)";
    const gradientId = `kpi-gradient-${title.replace(/\s+/g, "-").toLowerCase()}`;

    return (
        <AppPanel className="transition-colors hover:border-[color:var(--ui-card-hover-border)]" contentClassName="p-0">
            <div className="flex items-start justify-between p-5">
                <div>
                    <p className="mb-1 text-sm font-medium text-[color:var(--ui-stat-title)]">{title}</p>
                    <h2 className="text-2xl font-semibold tracking-tight text-[color:var(--ui-stat-value)]">{value}</h2>
                    {trend && (
                        <p className={trendUp ? "mt-1 text-xs text-[color:var(--ui-tone-success-text)]" : "mt-1 text-xs text-[color:var(--ui-tone-danger-text)]"}>
                            {trend}
                        </p>
                    )}
                </div>
            </div>

            <div aria-hidden="true" className="pointer-events-none relative h-16 w-full">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} accessibilityLayer={false}>
                        <defs>
                            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                                <stop offset="95%" stopColor={color} stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <Area
                            type="monotone"
                            dataKey="v"
                            stroke={color}
                            strokeWidth={2}
                            fill={`url(#${gradientId})`}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </AppPanel>
    );
}

export function KpiRow({
    snapshot,
    branchId,
    period = "all",
}: {
    snapshot?: BranchSnapshot;
    branchId?: string;
    period?: AnalyticsPeriod;
}) {
    const [seatTrend, setSeatTrend] = useState<number[] | undefined>();
    const [paymentTrend, setPaymentTrend] = useState<number[] | undefined>();
    const [dueTrend, setDueTrend] = useState<number[] | undefined>();
    const { formatNumber } = useUserPreferences();
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
                const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

                const [seat, pay] = await Promise.all([
                    analytics.getTrends(branchId, { from, to, type: "seat" }),
                    analytics.getTrends(branchId, { from, to, type: "payment", period }),
                ]);

                setSeatTrend(seat.map(t => t.value));
                setPaymentTrend(pay.filter(t => t.category === "Collected").map(t => t.value));
                setDueTrend(pay.filter(t => t.category === "Pending").map(t => t.value));
            } catch (err) {
                console.error("Failed to load KPI trends", err);
            }
        };
        loadTrends();
    }, [branchId, period]);

    if (!snapshot) {
        return (
            <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <KpiCard title="Collected Revenue" value="-" />
                <KpiCard title="Active Students" value="-" />
                <KpiCard title="Due Payments" value="-" />
                <KpiCard title="Total Utilization" value="-" />
            </div>
        );
    }

    return (
        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <KpiCard
                title="Collected Revenue"
                value={formatMoney(snapshot.paidAmount)}
                trend={period === "month" ? "Collected this month" : "Collected all time"}
                data={paymentTrend}
            />
            <KpiCard
                title="Active Students"
                value={formatNumber(snapshot.activeStudents)}
                trend="Current active count"
            />
            <KpiCard
                title="Due Payments"
                value={formatMoney(snapshot.dueAmount)}
                trend="All due payments"
                trendUp={false}
                data={dueTrend}
            />
            <KpiCard
                title="Total Utilization"
                value={formatNumber(snapshot.occupancyRate / 100, {
                    style: "percent",
                    maximumFractionDigits: 2,
                })}
                trend={
                    snapshot.seatDetails
                        ? `${formatNumber(snapshot.seatDetails.totalUsedSlots)} / ${formatNumber(snapshot.seatDetails.totalShiftCapacity)} slots`
                        : undefined
                }
                data={seatTrend}
            />
        </div>
    );
}
