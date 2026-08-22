import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  PaymentMethod,
  PaymentResolutionEventSource,
  PaymentStatus,
  PaymentType,
} from "@/types";
import {
  recordPaymentResolutionEvent,
  recordPaymentResolutionEvents,
  type PaymentResolutionSnapshot,
} from "@/services/paymentResolutionEvent.service";

const PERIOD_START = new Date("2026-01-01T00:00:00.000Z");
const DUE_DATE = new Date("2026-02-01T00:00:00.000Z");
const OCCURRED_AT = new Date("2026-02-03T04:05:06.000Z");

function paymentSnapshot(
  overrides: Partial<PaymentResolutionSnapshot> = {}
): PaymentResolutionSnapshot {
  return {
    id: "payment_1",
    branchId: "branch_1",
    status: PaymentStatus.DUE,
    amount: 2450,
    type: PaymentType.MONTHLY,
    periodStart: PERIOD_START,
    dueDate: DUE_DATE,
    paidAt: null,
    paymentMethod: null,
    referenceId: null,
    ...overrides,
  };
}

function transactionMock() {
  const create = vi.fn().mockResolvedValue({ id: "event_1" });
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    paymentResolutionEvent: { create, createMany },
  } as unknown as Prisma.TransactionClient;
  return { tx, create, createMany };
}

describe("paymentResolutionEvent service", () => {
  it("derives the immutable event snapshot from trusted before and after payment records", async () => {
    const { tx, create } = transactionMock();
    const before = paymentSnapshot();
    const after = paymentSnapshot({
      status: PaymentStatus.PAID,
      paidAt: OCCURRED_AT,
      paymentMethod: PaymentMethod.UPI,
      referenceId: "UPI-REF-1",
    });

    await recordPaymentResolutionEvent(tx, {
      before,
      after,
      actorUserId: "user_1",
      source: PaymentResolutionEventSource.PAYMENT_ACTION,
      details: { reason: "manual action" },
      occurredAt: OCCURRED_AT,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        paymentId: "payment_1",
        branchId: "branch_1",
        actorUserId: "user_1",
        source: PaymentResolutionEventSource.PAYMENT_ACTION,
        fromStatus: PaymentStatus.DUE,
        toStatus: PaymentStatus.PAID,
        amount: 2450,
        paymentType: PaymentType.MONTHLY,
        periodStart: PERIOD_START,
        dueDate: DUE_DATE,
        paidAt: OCCURRED_AT,
        paymentMethod: PaymentMethod.UPI,
        referenceId: "UPI-REF-1",
        details: { reason: "manual action" },
        occurredAt: OCCURRED_AT,
      },
    });
  });

  it.each([
    {
      name: "payment identity changes",
      before: paymentSnapshot(),
      after: paymentSnapshot({ id: "payment_2", status: PaymentStatus.PAID }),
      message: "same payment",
    },
    {
      name: "branch ownership changes",
      before: paymentSnapshot(),
      after: paymentSnapshot({ branchId: "branch_2", status: PaymentStatus.PAID }),
      message: "cannot change branch ownership",
    },
    {
      name: "status does not change",
      before: paymentSnapshot(),
      after: paymentSnapshot(),
      message: "requires a real status transition",
    },
    {
      name: "the transition reopens a payment to due",
      before: paymentSnapshot({ status: PaymentStatus.PAID }),
      after: paymentSnapshot({ status: PaymentStatus.DUE }),
      message: "Unsupported payment resolution transition: PAID:DUE",
    },
  ])("rejects when $name", async ({ before, after, message }) => {
    const { tx, create } = transactionMock();

    await expect(
      recordPaymentResolutionEvent(tx, {
        before,
        after,
        actorUserId: "user_1",
        source: PaymentResolutionEventSource.PAYMENT_ACTION,
        occurredAt: OCCURRED_AT,
      })
    ).rejects.toThrow(message);
    expect(create).not.toHaveBeenCalled();
  });

  it("validates every bulk transition before attempting the event insert", async () => {
    const { tx, createMany } = transactionMock();

    await expect(
      recordPaymentResolutionEvents(tx, [
        {
          before: paymentSnapshot(),
          after: paymentSnapshot({ status: PaymentStatus.WAIVED }),
          actorUserId: "user_1",
          source: PaymentResolutionEventSource.STUDENT_INACTIVATION,
          occurredAt: OCCURRED_AT,
        },
        {
          before: paymentSnapshot({ id: "payment_2", branchId: "branch_1" }),
          after: paymentSnapshot({
            id: "payment_2",
            branchId: "foreign_branch",
            status: PaymentStatus.PAID,
          }),
          actorUserId: "user_1",
          source: PaymentResolutionEventSource.STUDENT_INACTIVATION,
          occurredAt: OCCURRED_AT,
        },
      ])
    ).rejects.toThrow("cannot change branch ownership");
    expect(createMany).not.toHaveBeenCalled();
  });
});
