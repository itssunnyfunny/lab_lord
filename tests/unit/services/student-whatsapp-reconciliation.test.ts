import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  authorize: vi.fn(),
  assertBranchWritable: vi.fn(),
  assignSeatToShifts: vi.fn(),
  recordPaymentResolutionEvents: vi.fn(),
  reconcilePhone: vi.fn(),
  reconcileInactivation: vi.fn(),
  prismaBranchFindUnique: vi.fn(),
  prismaStudentFindUnique: vi.fn(),
  txBranchFindUnique: vi.fn(),
  txBranchUpdate: vi.fn(),
  txStudentFindMany: vi.fn(),
  txStudentCreate: vi.fn(),
  txStudentUpdate: vi.fn(),
  txPaymentCreate: vi.fn(),
  txPaymentFindMany: vi.fn(),
  txPaymentUpdateManyAndReturn: vi.fn(),
  txSeatAllocationUpdateMany: vi.fn(),
  txAuditCreateMany: vi.fn(),
  schemaProbe: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    branch: { findUnique: mocks.prismaBranchFindUnique },
    student: { findUnique: mocks.prismaStudentFindUnique },
  },
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));

vi.mock("@/services/seatAllocation.service", () => ({
  SeatAllocationService: { assignSeatToShifts: mocks.assignSeatToShifts },
}));

vi.mock("@/services/paymentResolutionEvent.service", () => ({
  recordPaymentResolutionEvents: mocks.recordPaymentResolutionEvents,
}));

vi.mock("@/services/whatsappRecipient.service", () => ({
  WhatsAppRecipientService: {
    reconcileStudentPhoneChangeInTransaction: mocks.reconcilePhone,
    reconcileStudentInactivationInTransaction: mocks.reconcileInactivation,
  },
}));

import { StudentService } from "@/services/student.service";

const branch = {
  id: "branch_1",
  organizationId: "org_1",
  defaultFee: 0,
  defaultAdmissionFee: 0,
};

const tx = {
  $queryRaw: mocks.schemaProbe,
  branch: {
    findUnique: mocks.txBranchFindUnique,
    update: mocks.txBranchUpdate,
  },
  student: {
    findMany: mocks.txStudentFindMany,
    create: mocks.txStudentCreate,
    update: mocks.txStudentUpdate,
  },
  payment: {
    create: mocks.txPaymentCreate,
    findMany: mocks.txPaymentFindMany,
    updateManyAndReturn: mocks.txPaymentUpdateManyAndReturn,
  },
  seatAllocation: { updateMany: mocks.txSeatAllocationUpdateMany },
  auditLog: { createMany: mocks.txAuditCreateMany },
};

const originalIntegrationFlag = process.env.WHATSAPP_INTEGRATION_ENABLED;
const originalPlannerFlag = process.env.WHATSAPP_AUTOMATION_PLANNER_ENABLED;
const originalTemplateFlag = process.env.WHATSAPP_META_TEMPLATE_WRITES_ENABLED;
const originalMessageFlag = process.env.WHATSAPP_META_MESSAGE_WRITES_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_INTEGRATION_ENABLED = "true";
  process.env.WHATSAPP_AUTOMATION_PLANNER_ENABLED = "true";
  mocks.prismaBranchFindUnique.mockResolvedValue(branch);
  mocks.prismaStudentFindUnique.mockResolvedValue({
    id: "student_1",
    branchId: "branch_1",
    name: "Asha",
    phone: "+91 98765 43210",
    status: "ACTIVE",
    monthlyFee: 1000,
    branch,
  });
  mocks.txBranchFindUnique.mockResolvedValue(branch);
  mocks.txStudentFindMany.mockResolvedValue([]);
  mocks.txStudentCreate.mockImplementation(async ({ data }) => ({
    id: "student_new",
    ...data,
  }));
  mocks.txStudentUpdate.mockImplementation(async ({ data }) => ({
    id: "student_1",
    branchId: "branch_1",
    ...data,
  }));
  mocks.txBranchUpdate.mockResolvedValue(branch);
  mocks.txPaymentFindMany.mockResolvedValue([]);
  mocks.txPaymentUpdateManyAndReturn.mockResolvedValue([]);
  mocks.txSeatAllocationUpdateMany.mockResolvedValue({ count: 0 });
  mocks.schemaProbe.mockResolvedValue([{ ready: false }]);
  mocks.transaction.mockImplementation(async callback => callback(tx));
});

afterEach(() => {
  if (originalIntegrationFlag === undefined) delete process.env.WHATSAPP_INTEGRATION_ENABLED;
  else process.env.WHATSAPP_INTEGRATION_ENABLED = originalIntegrationFlag;
  if (originalPlannerFlag === undefined) delete process.env.WHATSAPP_AUTOMATION_PLANNER_ENABLED;
  else process.env.WHATSAPP_AUTOMATION_PLANNER_ENABLED = originalPlannerFlag;
  if (originalTemplateFlag === undefined) delete process.env.WHATSAPP_META_TEMPLATE_WRITES_ENABLED;
  else process.env.WHATSAPP_META_TEMPLATE_WRITES_ENABLED = originalTemplateFlag;
  if (originalMessageFlag === undefined) delete process.env.WHATSAPP_META_MESSAGE_WRITES_ENABLED;
  else process.env.WHATSAPP_META_MESSAGE_WRITES_ENABLED = originalMessageFlag;
});

describe("StudentService WhatsApp provenance and reconciliation", () => {
  it("marks normal user-created students MANUAL without changing creation atomicity", async () => {
    await StudentService.createStudent("user_1", "branch_1", {
      name: "Asha",
      phone: "9876543210",
      monthlyFee: 0,
      admissionFee: 0,
    });

    expect(mocks.txStudentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: "branch_1",
        enrollmentSource: "MANUAL",
        status: "ACTIVE",
      }),
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("marks the shared import primitive IMPORT", async () => {
    await StudentService.createImportedStudentInTransaction(
      "user_1",
      "branch_1",
      {
        name: "Imported Asha",
        phone: "9876543210",
        monthlyFee: 0,
        admissionFee: 0,
      },
      tx as never
    );

    expect(mocks.txStudentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ enrollmentSource: "IMPORT", status: "ACTIVE" }),
    });
  });

  it("reconciles a changed phone inside the profile-update transaction", async () => {
    await StudentService.updateStudentProfile("user_1", "student_1", {
      phone: "9123456789",
    });

    expect(mocks.reconcilePhone).toHaveBeenCalledWith({
      tx,
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
      newPhone: "+91 91234 56789",
    });
    expect(mocks.txStudentUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reconcilePhone.mock.invocationCallOrder[0]
    );
  });

  it("does not touch PR3 tables before the database-first expansion is enabled", async () => {
    delete process.env.WHATSAPP_AUTOMATION_PLANNER_ENABLED;
    delete process.env.WHATSAPP_META_MESSAGE_WRITES_ENABLED;

    await StudentService.updateStudentProfile("user_1", "student_1", {
      phone: "9123456789",
    });

    expect(mocks.txStudentUpdate).toHaveBeenCalled();
    expect(mocks.reconcilePhone).not.toHaveBeenCalled();
  });

  it("reconciles mappings when template-only rollout state can already contain recipients", async () => {
    delete process.env.WHATSAPP_AUTOMATION_PLANNER_ENABLED;
    delete process.env.WHATSAPP_META_MESSAGE_WRITES_ENABLED;
    process.env.WHATSAPP_META_TEMPLATE_WRITES_ENABLED = "true";

    await StudentService.updateStudentProfile("user_1", "student_1", {
      phone: "9123456789",
    });

    expect(mocks.reconcilePhone).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      studentId: "student_1",
    }));
  });

  it("reconciles mappings after migration while every write kill switch is off", async () => {
    delete process.env.WHATSAPP_AUTOMATION_PLANNER_ENABLED;
    delete process.env.WHATSAPP_META_MESSAGE_WRITES_ENABLED;
    delete process.env.WHATSAPP_META_TEMPLATE_WRITES_ENABLED;
    mocks.schemaProbe.mockResolvedValue([{ ready: true }]);

    await StudentService.updateStudentProfile("user_1", "student_1", {
      phone: "9123456789",
    });

    expect(mocks.reconcilePhone).toHaveBeenCalled();
  });

  it("reconciles inactivation before the same transaction commits", async () => {
    await StudentService.updateStudentStatus(
      "user_1",
      "student_1",
      "INACTIVE",
      "KEEP"
    );

    expect(mocks.reconcileInactivation).toHaveBeenCalledWith({
      tx,
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
      now: expect.any(Date),
    });
    expect(mocks.reconcilePhone).not.toHaveBeenCalled();
  });
});
