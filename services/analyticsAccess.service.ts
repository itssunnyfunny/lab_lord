import { AccessPolicy } from "@/services/accessPolicy.service";
import { getBranchHealthSnapshot } from "@/analytics/branch.analytics";
import { getOrganizationHealthSnapshot } from "@/analytics/org.analytics";
import { getOverduePaymentsPage, getPaymentPeriodStats, type AnalyticsPeriod } from "@/analytics/payment.analytics";
import { getBranchHealthTrend } from "@/analytics/trends/branch.trends";
import { getPaymentTrend } from "@/analytics/trends/payment.trends";
import { getSeatUtilizationTrend } from "@/analytics/trends/seat.trends";

/** Interactive analytics entry points. The analytics directory is an internal
 * read layer shared with tenant-scoped AI and machine-owned reports. */
export class AnalyticsAccessService {
    static async overduePayments(actorId: string, branchId: string, options: Parameters<typeof getOverduePaymentsPage>[1]) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "overdueView");
        return getOverduePaymentsPage(branchId, options);
    }
    static async branchSnapshot(actorId: string, branchId: string, period: AnalyticsPeriod) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "analyticsView");
        const [health, finance] = await Promise.all([
            getBranchHealthSnapshot(branchId), getPaymentPeriodStats(branchId, undefined, period),
        ]);
        return { health, finance };
    }
    static async organizationSnapshot(actorId: string, organizationId: string) {
        await AccessPolicy.authorizeOrganization(actorId, organizationId, { entitlement: "ADVANCED_ANALYTICS" });
        return getOrganizationHealthSnapshot(organizationId);
    }
    static async healthTrend(actorId: string, branchId: string, from: Date, to: Date) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "analyticsView");
        return getBranchHealthTrend(branchId, from, to);
    }
    static async paymentTrend(actorId: string, branchId: string, from: Date, to: Date, period: AnalyticsPeriod) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "analyticsView");
        return getPaymentTrend(branchId, from, to, "DAY", period);
    }
    static async seatTrend(actorId: string, branchId: string, from: Date, to: Date) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "analyticsView");
        return getSeatUtilizationTrend(branchId, from, to);
    }
}
