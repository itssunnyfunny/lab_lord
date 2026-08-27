import type { Prisma } from "@/app/generated/prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  sanitizeWhatsAppJobCounts,
  WhatsAppJobRunService,
} from "@/services/whatsappJobRun.service";

describe("WhatsApp job-run evidence", () => {
  it("accepts only bounded operational integer counts", () => {
    expect(sanitizeWhatsAppJobCounts({ sendersClaimed: 2, messagesSuppressed: 4 }))
      .toEqual({ sendersClaimed: 2, messagesSuppressed: 4 });
    for (const invalid of [
      { count: "2" },
      { count: 1.5 },
      { count: -1 },
      { count: 2_147_483_648 },
      { estimatedAmount: 10 },
      { recipientPhone: 10 },
      { senderId: 10 },
      { SecretToken: 10 },
    ]) {
      expect(() => sanitizeWhatsAppJobCounts(invalid)).toThrow();
    }
    expect(() => sanitizeWhatsAppJobCounts(Object.fromEntries(
      Array.from({ length: 41 }, (_value, index) => [`count${index}`, index])
    ))).toThrow();
  });

  it("replays an exact invocation and rejects cross-job or cross-mode reuse", async () => {
    const existing = {
      id: "run_1",
      jobType: "HEALTH_RECONCILIATION",
      invocationId: "health:abc",
      providerMode: "TEST",
      status: "SUCCEEDED",
      counts: {},
      safeErrorCode: null,
    };
    const client = {
      whatsAppJobRun: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(WhatsAppJobRunService.start({
      jobType: "HEALTH_RECONCILIATION",
      invocationId: "health:abc",
      providerMode: "TEST",
      client,
    })).resolves.toEqual({ created: false, run: existing });
    await expect(WhatsAppJobRunService.start({
      jobType: "MAINTENANCE",
      invocationId: "health:abc",
      client,
    })).rejects.toThrow();
    await expect(WhatsAppJobRunService.start({
      jobType: "HEALTH_RECONCILIATION",
      invocationId: "health:abc",
      providerMode: "LIVE",
      client,
    })).rejects.toThrow();
    expect(client.whatsAppJobRun.create).not.toHaveBeenCalled();
  });

  it("uses a RUNNING compare-and-set so concurrent finishers cannot overwrite evidence", async () => {
    const running = {
      id: "run_1",
      status: "RUNNING",
      startedAt: new Date("2026-08-24T10:00:00.000Z"),
    };
    const finished = { ...running, status: "SUCCEEDED", counts: { completed: 1 } };
    const client = {
      whatsAppJobRun: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(running)
          .mockResolvedValueOnce(finished),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(WhatsAppJobRunService.finish({
      runId: "run_1",
      status: "FAILED",
      counts: { completed: 0 },
      now: new Date("2026-08-24T10:00:01.000Z"),
      client,
    })).resolves.toEqual({ changed: false, run: finished });
    expect(client.whatsAppJobRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run_1", status: "RUNNING" },
    }));
  });
});
