import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorld, createBranch, createStudent, createPayment } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("operational tenant integrity in PostgreSQL", () => {
  beforeEach(resetDatabase);
  afterAll(disconnectDatabase);
  it.each(["sibling", "foreign"])("rejects mixed %s branch references through direct database writes", async scope => {
    const a = await createTestWorld();
    const foreign = await createTestWorld();
    const other = scope === "sibling" ? await createBranch({ organizationId: a.org.id }) : foreign.branch;
    const student = await createStudent({ branchId: a.branch.id });
    const payment = await createPayment({ branchId: a.branch.id, studentId: student.id,
      dueDate: new Date(), periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-02-01") });
    const bundle = await testPrisma.multiShift.create({ data: { branchId: a.branch.id, name: "Bundle",
      components: { create: [{ shiftId: a.shift.id }] } }, include: { components: true } });
    expect(bundle.components[0].branchId).toBe(a.branch.id);
    const draft = await testPrisma.messageDraft.create({ data: { branchId: a.branch.id, studentId: student.id, action: "overdue", message: "Synthetic" } });
    const audit = await testPrisma.auditLog.create({ data: { branchId: a.branch.id, userId: a.user.id,
      paymentId: payment.id, action: "PAYMENT_MARKED_PAID", details: {} } });
    const event = await testPrisma.paymentResolutionEvent.create({ data: { branchId: a.branch.id,
      paymentId: payment.id, source: "PAYMENT_ACTION", fromStatus: "DUE", toStatus: "PAID",
      amount: payment.amount, paymentType: "MONTHLY", periodStart: payment.periodStart, dueDate: payment.dueDate } });
    for (const [table, id] of [["Payment", payment.id], ["AuditLog", audit.id], ["PaymentResolutionEvent", event.id], ["MessageDraft", draft.id], ["MultiShiftComponent", bundle.components[0].id]]) {
      await expect(testPrisma.$executeRawUnsafe(`UPDATE "${table}" SET "branchId"=$1 WHERE id=$2`, other.id, id))
        .rejects.toMatchObject({ meta: { driverAdapterError: { cause: { originalCode: "23503" } } } });
    }
    const otherStudent = await createStudent({ branchId: other.id });
    await expect(testPrisma.student.update({ where: { id: otherStudent.id }, data: { feeLinkedShiftId: a.shift.id } }))
      .rejects.toMatchObject({ code: "P2003" });
    await expect(testPrisma.student.update({ where: { id: otherStudent.id }, data: { feeLinkedMultiShiftId: bundle.id } }))
      .rejects.toMatchObject({ code: "P2003" });
    expect(await testPrisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ branchId: a.branch.id });
  });
  it("preserves branch-owned draft history when the optional student is deleted", async () => {
    const { branch } = await createTestWorld();
    const student = await createStudent({ branchId: branch.id });
    const draft = await testPrisma.messageDraft.create({ data: { branchId: branch.id, studentId: student.id, action: "overdue", message: "Retained" } });
    await testPrisma.student.delete({ where: { id: student.id } });
    expect(await testPrisma.messageDraft.findUniqueOrThrow({ where: { id: draft.id } }))
      .toMatchObject({ branchId: branch.id, studentId: null, message: "Retained" });
  });
});
