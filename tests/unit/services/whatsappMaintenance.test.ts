import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  messageUpdateMany: vi.fn(),
  jobRunStart: vi.fn(),
  jobRunFinish: vi.fn(),
  incidentCreateOrTouch: vi.fn(),
  incidentResolve: vi.fn(),
  recordAmbiguousOutcome: vi.fn(),
  finalizeRequestedPause: vi.fn(),
  reconcileNotice: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/whatsappFeature", () => ({
  isWhatsAppDeliverySchemaAccessEnabled: () => true,
}));

vi.mock("@/services/whatsappJobRun.service", () => ({
  WhatsAppJobRunService: {
    start: mocks.jobRunStart,
    finish: mocks.jobRunFinish,
  },
}));

vi.mock("@/services/whatsappIncident.service", () => ({
  WhatsAppIncidentService: {
    createOrTouchInTransaction: mocks.incidentCreateOrTouch,
    resolveInTransaction: mocks.incidentResolve,
  },
}));

vi.mock("@/services/whatsappSenderSafety.service", () => ({
  WhatsAppSenderSafetyService: {
    recordAmbiguousOutcomeInTransaction: mocks.recordAmbiguousOutcome,
    finalizeRequestedPauseInTransaction: mocks.finalizeRequestedPause,
  },
}));

vi.mock("@/services/whatsappServiceNotice.service", () => ({
  WhatsAppServiceNoticeService: {
    reconcileStatusInTransaction: mocks.reconcileNotice,
  },
}));

import {
  WHATSAPP_JOB_RUN_RETENTION_DAYS,
  WHATSAPP_MAINTENANCE_BATCH_LIMIT,
  WHATSAPP_PENDING_SUBSCRIPTION_MAX_AGE_MS,
  WHATSAPP_REPORT_SNAPSHOT_RETENTION_DAYS,
  WhatsAppMaintenanceService,
} from "@/services/whatsappMaintenance.service";

const NOW = new Date("2026-08-26T05:00:00.000Z");

type StaleMessageRow = Readonly<{
  id: string;
  organizationId: string;
  branchId: string | null;
  senderId: string;
  status: "CLAIMED" | "SUBMITTING";
  providerCallAdmittedAt: Date | null;
}>;

let staleMessageRows: StaleMessageRow[] = [];

function transactionClient() {
  const emptyFindMany = vi.fn().mockResolvedValue([]);
  return {
    $queryRaw: vi.fn().mockResolvedValue(staleMessageRows),
    whatsAppReportSubscription: {
      findMany: emptyFindMany,
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    whatsAppSender: {
      findMany: emptyFindMany,
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    whatsAppMessage: {
      findMany: vi.fn().mockResolvedValue(staleMessageRows),
      updateMany: mocks.messageUpdateMany,
    },
    whatsAppJobRun: {
      findMany: emptyFindMany,
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    whatsAppOperationalIncident: { findMany: emptyFindMany },
    whatsAppMessageEvent: {
      findMany: emptyFindMany,
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    whatsAppDailyReportSnapshot: {
      findMany: emptyFindMany,
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    whatsAppServiceNotice: { findMany: emptyFindMany },
  };
}

describe("WhatsApp maintenance bounds", () => {
  it("keeps every retention and batch bound fixed server-side", () => {
    expect(WHATSAPP_MAINTENANCE_BATCH_LIMIT).toBe(100);
    expect(WHATSAPP_JOB_RUN_RETENTION_DAYS).toBe(30);
    expect(WHATSAPP_REPORT_SNAPSHOT_RETENTION_DAYS).toBe(400);
    expect(WHATSAPP_PENDING_SUBSCRIPTION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1_000);
  });
});

describe("WhatsApp maintenance stale dispatch reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    staleMessageRows = [];
    mocks.messageUpdateMany.mockResolvedValue({ count: 1 });
    mocks.jobRunStart.mockResolvedValue({
      created: true,
      run: { id: "maintenance_run_1", status: "RUNNING" },
    });
    mocks.jobRunFinish.mockResolvedValue({ changed: true });
    mocks.incidentCreateOrTouch.mockResolvedValue({ changed: true });
    mocks.recordAmbiguousOutcome.mockResolvedValue({ counted: true });
    mocks.finalizeRequestedPause.mockResolvedValue({ changed: true });
    mocks.transaction.mockImplementation(async callback => callback(transactionClient()));
  });

  it("requeues a stale unadmitted submission without claiming provider ambiguity", async () => {
    staleMessageRows = [{
      id: "message_unadmitted",
      organizationId: "org_1",
      branchId: "branch_1",
      senderId: "sender_1",
      status: "SUBMITTING",
      providerCallAdmittedAt: null,
    }];

    const result = await WhatsAppMaintenanceService.run({
      invocationId: "maintenance_unadmitted",
      now: NOW,
      env: {},
    });

    expect(mocks.transaction).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      { isolationLevel: "ReadCommitted" }
    );
    expect(mocks.messageUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "message_unadmitted",
        status: "SUBMITTING",
        providerCallAdmittedAt: null,
        leaseUntil: { lt: NOW },
        leaseToken: { not: null },
      },
      data: {
        status: "SCHEDULED",
        claimedAt: null,
        submissionStartedAt: null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(mocks.recordAmbiguousOutcome).not.toHaveBeenCalled();
    expect(mocks.finalizeRequestedPause).not.toHaveBeenCalled();
    expect(mocks.incidentCreateOrTouch).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "message_unadmitted",
      severity: "WARNING",
      safeCode: "PRE_SUBMISSION_LEASE_STALE",
      details: { providerCallAdmitted: false, requeued: true },
    }));
    expect(result.counts).toMatchObject({
      stalePreSubmissionsRecovered: 1,
      staleSubmissionsMarkedUnknown: 0,
    });
  });

  it("marks an admitted stale submission unknown and completes a pending pause after drain", async () => {
    staleMessageRows = [{
      id: "message_admitted",
      organizationId: "org_1",
      branchId: "branch_1",
      senderId: "sender_1",
      status: "SUBMITTING",
      providerCallAdmittedAt: new Date("2026-08-26T04:55:00.000Z"),
    }];

    const result = await WhatsAppMaintenanceService.run({
      invocationId: "maintenance_admitted",
      now: NOW,
      env: {},
    });

    expect(mocks.messageUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "message_admitted",
        status: "SUBMITTING",
        providerCallAdmittedAt: { not: null },
      }),
      data: expect.objectContaining({
        status: "UNKNOWN",
        failureCode: "PROVIDER_UNKNOWN_OUTCOME",
        budgetState: "COMMITTED",
        leaseToken: null,
        leaseUntil: null,
      }),
    }));
    expect(mocks.recordAmbiguousOutcome).toHaveBeenCalledOnce();
    expect(mocks.finalizeRequestedPause).toHaveBeenCalledOnce();
    expect(mocks.recordAmbiguousOutcome.mock.calls[0]![0].tx)
      .toBe(mocks.finalizeRequestedPause.mock.calls[0]![0].tx);
    expect(mocks.messageUpdateMany.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.recordAmbiguousOutcome.mock.invocationCallOrder[0]!);
    expect(mocks.recordAmbiguousOutcome.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.finalizeRequestedPause.mock.invocationCallOrder[0]!);
    expect(mocks.recordAmbiguousOutcome).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "message_admitted",
      organizationId: "org_1",
      branchId: "branch_1",
      senderId: "sender_1",
    }));
    expect(mocks.incidentCreateOrTouch).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({
      stalePreSubmissionsRecovered: 0,
      staleSubmissionsMarkedUnknown: 1,
    });
  });

  it("publishes no recovery counts when the short transaction rolls back", async () => {
    staleMessageRows = [{
      id: "message_rolled_back",
      organizationId: "org_1",
      branchId: "branch_1",
      senderId: "sender_1",
      status: "SUBMITTING",
      providerCallAdmittedAt: null,
    }];
    mocks.incidentCreateOrTouch.mockRejectedValueOnce(new Error("incident write failed"));

    await expect(WhatsAppMaintenanceService.run({
      invocationId: "maintenance_rolled_back",
      limit: 1,
      now: NOW,
      env: {},
    })).rejects.toThrow("incident write failed");

    expect(mocks.jobRunFinish).toHaveBeenCalledWith(expect.objectContaining({
      status: "FAILED",
      counts: expect.objectContaining({
        batchesAtLimit: 0,
        staleMessageLeasesDetected: 0,
        stalePreSubmissionsRecovered: 0,
      }),
    }));
  });
});
