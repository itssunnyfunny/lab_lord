import type { Prisma } from "@/app/generated/prisma/client";
import { describe, expect, it, vi } from "vitest";

import { hashWhatsAppReportConfirmationCode } from "@/lib/whatsappReportConfirmation";
import {
  loadOrCreateWhatsAppReportSnapshotInTransaction,
  verifyWhatsAppReportMessageSource,
  WhatsAppReportService,
} from "@/services/whatsappReport.service";

const mocks = vi.hoisted(() => ({
  getDailyReportMetrics: vi.fn(),
}));

vi.mock("@/analytics/whatsapp-report.analytics", () => ({
  getWhatsAppDailyReportMetrics: mocks.getDailyReportMetrics,
}));

const ENABLED_ENV = {
  WHATSAPP_INTEGRATION_ENABLED: "true",
  WHATSAPP_REPORTS_ENABLED: "true",
  META_WHATSAPP_MODE: "TEST",
  NODE_ENV: "test",
};

describe("WhatsApp report service safety", () => {
  it("shares one immutable snapshot for the same cutoff and creates one per distinct cutoff", async () => {
    const firstCutoff = new Date("2026-08-23T15:30:00.000Z");
    const firstMetricsAsOf = new Date("2026-08-23T15:35:00.000Z");
    const laterSameCutoffAsOf = new Date("2026-08-23T15:40:00.000Z");
    const secondCutoff = new Date("2026-08-23T16:00:00.000Z");
    const secondMetricsAsOf = new Date("2026-08-23T16:05:00.000Z");
    const snapshots = new Map<string, Record<string, unknown>>();
    const metricsFor = (metricsAsOfAt: Date, asOfLocalTime: string) => ({
      branchName: "Central",
      localReportDate: "2026-08-23",
      metricsAsOfAt: metricsAsOfAt.toISOString(),
      asOfLocalTime,
      paymentsRecordedTodayCount: 3,
      paymentsRecordedTodayAmount: 12_000,
      newStudentsToday: 2,
      activeStudents: 50,
      usedShiftSlots: 40,
      totalShiftCapacity: 60,
      openDueCount: 5,
      openDueAmount: 7_500,
      overdueCount: 2,
      overdueAmount: 3_000,
      whatsAppAcceptedToday: 8,
      whatsAppDeliveredToday: 7,
      whatsAppFailedToday: 1,
      whatsAppUnknownToday: 0,
    });
    mocks.getDailyReportMetrics.mockImplementation(async (_tx, input) => (
      metricsFor(
        input.metricsAsOfAt,
        input.metricsAsOfAt.getTime() === firstMetricsAsOf.getTime() ? "21:05" : "21:35"
      )
    ));
    const snapshotFindUnique = vi.fn(async input => {
      const identity = input.where
        .scope_scopeKey_localReportDate_scheduledCutoffAt_metricsVersion;
      return snapshots.get(identity.scheduledCutoffAt.toISOString()) ?? null;
    });
    const snapshotCreate = vi.fn(async input => {
      const snapshot = {
        id: `snapshot_${snapshots.size + 1}`,
        ...input.data,
        createdAt: input.data.metricsAsOfAt,
      };
      snapshots.set(input.data.scheduledCutoffAt.toISOString(), snapshot);
      return snapshot;
    });
    const tx = {
      whatsAppDailyReportSnapshot: {
        findUnique: snapshotFindUnique,
        create: snapshotCreate,
      },
    } as unknown as Prisma.TransactionClient;
    const scope = {
      scope: "BRANCH" as const,
      scopeKey: "branch_1",
      branchId: "branch_1",
      organizationId: "org_1",
      timeZone: "Asia/Kolkata",
      ownerId: "owner_1",
    };

    const first = await loadOrCreateWhatsAppReportSnapshotInTransaction({
      tx,
      scope,
      localReportDate: "2026-08-23",
      scheduledCutoffAt: firstCutoff,
      metricsAsOfAt: firstMetricsAsOf,
    });
    const sameCutoff = await loadOrCreateWhatsAppReportSnapshotInTransaction({
      tx,
      scope,
      localReportDate: "2026-08-23",
      scheduledCutoffAt: firstCutoff,
      metricsAsOfAt: laterSameCutoffAsOf,
    });
    const differentCutoff = await loadOrCreateWhatsAppReportSnapshotInTransaction({
      tx,
      scope,
      localReportDate: "2026-08-23",
      scheduledCutoffAt: secondCutoff,
      metricsAsOfAt: secondMetricsAsOf,
    });

    expect(snapshotCreate).toHaveBeenCalledTimes(2);
    expect(mocks.getDailyReportMetrics).toHaveBeenCalledTimes(2);
    expect(sameCutoff.snapshot.id).toBe(first.snapshot.id);
    expect(sameCutoff.snapshot.metricsAsOfAt).toEqual(firstMetricsAsOf);
    expect(sameCutoff.metrics.metricsAsOfAt).toBe(firstMetricsAsOf.toISOString());
    expect(differentCutoff.snapshot.id).not.toBe(first.snapshot.id);
    expect(differentCutoff.snapshot.scheduledCutoffAt).toEqual(secondCutoff);
    expect(differentCutoff.snapshot.metricsAsOfAt).toEqual(secondMetricsAsOf);
    expect(differentCutoff.metrics.metricsAsOfAt).toBe(secondMetricsAsOf.toISOString());
    expect(first.snapshot.sourceFingerprint).not.toBe(
      differentCutoff.snapshot.sourceFingerprint
    );
    expect(snapshotFindUnique.mock.calls.map(call => (
      call[0].where.scope_scopeKey_localReportDate_scheduledCutoffAt_metricsVersion
        .scheduledCutoffAt.toISOString()
    ))).toEqual([
      firstCutoff.toISOString(),
      firstCutoff.toISOString(),
      secondCutoff.toISOString(),
    ]);
  });

  it("increments and expires failed challenges exactly once per attempt", async () => {
    const retryId = "subscription_retry";
    const expireId = "subscription_expire";
    const senderId = "sender_1";
    const phoneE164 = "+919876543210";
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      whatsAppReportSubscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: retryId,
            confirmationCodeHash: hashWhatsAppReportConfirmationCode({
              senderId,
              subscriptionId: retryId,
              phoneE164,
              code: "ABCDEFGHJK",
            }),
            confirmationAttemptCount: 3,
          },
          {
            id: expireId,
            confirmationCodeHash: hashWhatsAppReportConfirmationCode({
              senderId,
              subscriptionId: expireId,
              phoneE164,
              code: "ABCDEFGHJK",
            }),
            confirmationAttemptCount: 4,
          },
        ]),
        updateMany,
      },
    } as unknown as Prisma.TransactionClient;
    await expect(WhatsAppReportService.confirmSubscriptionInTransaction({
      tx,
      senderId,
      phoneE164,
      code: "KJHGFEDCBA",
      env: ENABLED_ENV,
    })).resolves.toEqual({ matched: false, activated: false });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: { in: [retryId] } }),
      data: { confirmationAttemptCount: { increment: 1 } },
    }));
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: { in: [expireId] } }),
      data: expect.objectContaining({ status: "EXPIRED" }),
    }));
  });

  it("fails report-source validation before any write for a non-report row", async () => {
    const tx = {
      whatsAppMessage: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient;
    await expect(verifyWhatsAppReportMessageSource({
      tx,
      messageId: "message_1",
      now: new Date("2026-08-23T15:30:00.000Z"),
      env: ENABLED_ENV,
    })).resolves.toEqual({ valid: false, code: "REPORT_SOURCE_CHANGED" });
  });

  it("rejects a queued report at the exclusive catch-up boundary before authorization", async () => {
    const scheduledCutoffAt = new Date("2026-08-23T15:30:00.000Z");
    const tx = {
      whatsAppMessage: {
        findUnique: vi.fn().mockResolvedValue({
          id: "message_1",
          organizationId: "org_1",
          branchId: "branch_1",
          senderId: "sender_1",
          recipientPhoneE164: "+919876543210",
          purpose: "DAILY_BRANCH_REPORT",
          trigger: "AUTOMATION",
          createdByUserId: null,
          reportSubscriptionId: "subscription_1",
          dailyReportSnapshotId: "snapshot_1",
          templateBindingId: "binding_1",
          templateId: "template_1",
          managedTemplateKey: "DAILY_BRANCH_REPORT",
          catalogVersion: 1,
          catalogHash: "catalog-hash",
          templateVersion: 1,
          settingsRevision: 1,
          localScheduleDate: new Date("2026-08-23T00:00:00.000Z"),
          studentId: null,
          paymentId: null,
          paymentResolutionEventId: null,
          manualSendRequestId: null,
          serviceNoticeId: null,
          automationStage: null,
          frequencyKey: null,
          scheduledFor: scheduledCutoffAt,
          availableAt: new Date("2026-08-23T15:35:00.000Z"),
          sender: {},
          reportSubscription: {
            scope: "BRANCH",
            organizationId: "org_1",
            branchId: "branch_1",
            senderId: "sender_1",
            phoneE164: "+919876543210",
            scopeKey: "branch_1",
            consent: {},
          },
          dailyReportSnapshot: {
            scope: "BRANCH",
            organizationId: "org_1",
            branchId: "branch_1",
            scopeKey: "branch_1",
            timeZone: "Asia/Kolkata",
            scheduledCutoffAt,
          },
          templateBinding: {},
          paymentSources: [],
        }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(verifyWhatsAppReportMessageSource({
      tx,
      messageId: "message_1",
      now: new Date("2026-08-23T16:30:00.000Z"),
      env: ENABLED_ENV,
    })).resolves.toEqual({ valid: false, code: "REPORT_TRUST_WINDOW_EXPIRED" });
  });
});
