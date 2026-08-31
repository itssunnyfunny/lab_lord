import type { Prisma, WhatsAppMessageStatus } from "@/app/generated/prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  verifyWhatsAppServiceNoticeSource,
  WhatsAppServiceNoticeService,
} from "@/services/whatsappServiceNotice.service";

function reconciliationTx(input: {
  statuses: Partial<Record<WhatsAppMessageStatus, number>>;
  cancelledAt?: Date | null;
}) {
  const notice = {
    id: "notice_1",
    status: "QUEUED",
    cancelledAt: input.cancelledAt ?? null,
    completedAt: null,
  };
  const grouped = Object.entries(input.statuses).map(([status, count]) => ({
    status,
    _count: { _all: count },
  }));
  const update = vi.fn().mockImplementation(({ data }) => ({ ...notice, ...data }));
  const tx = {
    whatsAppServiceNotice: {
      findUnique: vi.fn().mockResolvedValue(notice),
      update,
    },
    whatsAppMessage: {
      groupBy: vi.fn().mockResolvedValue(grouped),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, update };
}

describe("WhatsApp service-notice source and completion", () => {
  it.each([
    [{ DELIVERED: 2 }, "COMPLETED"],
    [{ READ: 1, FAILED: 1 }, "PARTIAL"],
    [{ FAILED: 2 }, "FAILED"],
    [{ CANCELLED: 1, SUPPRESSED: 1 }, "CANCELLED"],
    [{ DELIVERED: 1, UNKNOWN: 1 }, "PARTIAL"],
    [{ ACCEPTED: 1, DELIVERED: 1 }, "QUEUED"],
  ] as const)("reconciles %o to %s", async (statuses, expectedStatus) => {
    const { tx, update } = reconciliationTx({ statuses });
    const result = await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
      tx,
      noticeId: "notice_1",
      now: new Date("2026-08-24T10:00:00.000Z"),
    });

    expect(result.status).toBe(expectedStatus);
    if (expectedStatus === "QUEUED") {
      expect(update).not.toHaveBeenCalled();
    } else {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: expectedStatus }),
      }));
    }
  });

  it("does not falsely finalize a notice with a terminal UNKNOWN child", async () => {
    const { tx, update } = reconciliationTx({ statuses: { UNKNOWN: 2 } });
    await WhatsAppServiceNoticeService.reconcileStatusInTransaction({
      tx,
      noticeId: "notice_1",
      now: new Date("2026-08-24T10:00:00.000Z"),
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PARTIAL" }),
    }));
  });

  it("fails source verification closed before writes for a missing message", async () => {
    const tx = {
      whatsAppMessage: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient;
    await expect(verifyWhatsAppServiceNoticeSource({
      tx,
      messageId: "message_1",
      now: new Date("2026-08-24T10:00:00.000Z"),
    })).resolves.toEqual({ valid: false, code: "NOTICE_SOURCE_MISSING" });
  });
});
