import type { Prisma } from "@/app/generated/prisma/client";
import { describe, expect, it, vi } from "vitest";

import { hashWhatsAppReportConfirmationCode } from "@/lib/whatsappReportConfirmation";
import {
  createWhatsAppReportSourceFingerprint,
  hashWhatsAppReportMetrics,
} from "@/lib/whatsappReportMetrics";
import {
  loadOrCreateWhatsAppReportSnapshotInTransaction,
  verifyWhatsAppReportMessageSource,
  WhatsAppReportService,
} from "@/services/whatsappReport.service";

const ENABLED_ENV = {
  WHATSAPP_INTEGRATION_ENABLED: "true",
  WHATSAPP_REPORTS_ENABLED: "true",
  META_WHATSAPP_MODE: "TEST",
  NODE_ENV: "test",
};

describe("WhatsApp report service safety", () => {
  it("reuses an immutable same-cutoff snapshot and rejects a conflicting cutoff", async () => {
    const cutoff = new Date("2026-08-23T15:30:00.000Z");
    const metrics = {
      branchName: "Central",
      localReportDate: "2026-08-23",
      asOfLocalTime: "21:00",
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
    };
    const snapshot = {
      id: "snapshot_1",
      organizationId: "org_1",
      branchId: "branch_1",
      scope: "BRANCH" as const,
      scopeKey: "branch_1",
      localReportDate: "2026-08-23",
      timeZone: "Asia/Kolkata",
      scheduledCutoffAt: cutoff,
      generatedAt: cutoff,
      metricsVersion: 1,
      metrics,
      metricsHash: hashWhatsAppReportMetrics(metrics),
      sourceFingerprint: createWhatsAppReportSourceFingerprint({
        scope: "BRANCH",
        scopeKey: "branch_1",
        localReportDate: "2026-08-23",
        scheduledCutoffAt: cutoff,
      }),
      createdAt: cutoff,
    };
    const snapshotCreate = vi.fn();
    const messageCreate = vi.fn();
    const tx = {
      whatsAppDailyReportSnapshot: {
        findUnique: vi.fn().mockResolvedValue(snapshot),
        create: snapshotCreate,
      },
      whatsAppMessage: { create: messageCreate },
    } as unknown as Prisma.TransactionClient;
    const scope = {
      scope: "BRANCH" as const,
      scopeKey: "branch_1",
      branchId: "branch_1",
      organizationId: "org_1",
      timeZone: "Asia/Kolkata",
      ownerId: "owner_1",
    };

    await expect(loadOrCreateWhatsAppReportSnapshotInTransaction({
      tx,
      scope,
      localReportDate: "2026-08-23",
      scheduledCutoffAt: cutoff,
      now: new Date("2026-08-23T15:35:00.000Z"),
    })).resolves.toEqual({ snapshot, metrics });
    await expect(loadOrCreateWhatsAppReportSnapshotInTransaction({
      tx,
      scope,
      localReportDate: "2026-08-23",
      scheduledCutoffAt: new Date("2026-08-23T16:00:00.000Z"),
      now: new Date("2026-08-23T16:05:00.000Z"),
    })).rejects.toThrow("Daily report snapshot is unavailable");
    expect(snapshotCreate).not.toHaveBeenCalled();
    expect(messageCreate).not.toHaveBeenCalled();
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
});
