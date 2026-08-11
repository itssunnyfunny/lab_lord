import { testPrisma } from "../setup/db";

/**
 * FACTORY FUNCTIONS — Why These Exist
 *
 * Without factories, every test file manually writes 30+ lines of setup:
 *   const user = await prisma.user.create({ data: { email: "...", id: "..." } })
 *   const org  = await prisma.organization.create(...)
 *   const branch = ...
 *
 * This causes:
 *   - Copy-paste drift (tests use slightly different data shapes)
 *   - Hard-to-read tests (setup noise drowns out the actual assertion)
 *   - Fragile tests when schema changes (update 1 factory, not 20 files)
 *
 * Usage:
 *   const user   = await createUser();
 *   const branch = await createBranch({ ownerId: user.id });
 *   Overrides let you customize only what matters for the test.
 */

let counter = 0;
const uid = () => `test_${++counter}_${Date.now()}`;

// ─── User ─────────────────────────────────────────────────────────────────────

export async function createUser(overrides: { id?: string; clerkId?: string | null; email?: string; name?: string } = {}) {
  return testPrisma.user.create({
    data: {
      id: overrides.id ?? uid(),
      clerkId: overrides.clerkId,
      email: overrides.email ?? `user_${uid()}@test.com`,
      name: overrides.name ?? "Test User",
    },
  });
}

// ─── Organization ─────────────────────────────────────────────────────────────

export async function createOrg(overrides: {
  ownerId: string;
  name?: string;
  id?: string;
  businessType?: string | null;
  paymentGraceDays?: number;
  billingModelVersion?: "LEGACY" | "WORKSPACE_V2";
  selectedPostTrialPlan?: "BASIC" | "PRO" | null;
} & Record<string, unknown>) {
  return testPrisma.organization.create({
    data: {
      id: overrides.id ?? uid(),
      name: overrides.name ?? "Test Org",
      ownerId: overrides.ownerId,
      businessType: overrides.businessType,
      paymentGraceDays: overrides.paymentGraceDays,
      billingModelVersion: overrides.billingModelVersion,
      selectedPostTrialPlan: overrides.selectedPostTrialPlan,
    },
  });
}

// ─── Branch ───────────────────────────────────────────────────────────────────

export async function createBranch(overrides: {
  organizationId: string;
  name?: string;
  defaultFee?: number;
  defaultAdmissionFee?: number;
  id?: string;
}) {
  return testPrisma.branch.create({
    data: {
      id: overrides.id ?? uid(),
      organizationId: overrides.organizationId,
      name: overrides.name ?? "Test Branch",
      defaultFee: overrides.defaultFee ?? 1000,
      defaultAdmissionFee: overrides.defaultAdmissionFee ?? 0,
    },
  });
}

// ─── Shift ────────────────────────────────────────────────────────────────────

export async function createShift(overrides: {
  branchId: string;
  name?: string;
  startTime?: string | null;
  endTime?: string | null;
  price?: number;
  id?: string;
}) {
  return testPrisma.shift.create({
    data: {
      id: overrides.id ?? uid(),
      branchId: overrides.branchId,
      name: overrides.name ?? "Morning",
      startTime: overrides.startTime ?? "06:00",
      endTime: overrides.endTime ?? "11:59",
      price: overrides.price ?? 0,
    },
  });
}

// ─── Seat ─────────────────────────────────────────────────────────────────────

export async function createSeat(overrides: { branchId: string; label?: string; id?: string }) {
  return testPrisma.seat.create({
    data: {
      id: overrides.id ?? uid(),
      branchId: overrides.branchId,
      label: overrides.label ?? `Seat-${uid()}`,
    },
  });
}

// ─── Student ──────────────────────────────────────────────────────────────────

export async function createStudent(overrides: {
  branchId: string;
  name?: string;
  phone?: string;
  monthlyFee?: number;
  feeLinkedShiftId?: string | null;
  feeLinkedMultiShiftId?: string | null;
  joinedAt?: Date;
  billingStartAt?: Date | null;
  id?: string;
}) {
  return testPrisma.student.create({
    data: {
      id: overrides.id ?? uid(),
      branchId: overrides.branchId,
      name: overrides.name ?? "Test Student",
      phone: overrides.phone ?? "9999999999",
      monthlyFee: overrides.monthlyFee ?? 1000,
      feeLinkedShiftId: overrides.feeLinkedShiftId ?? null,
      feeLinkedMultiShiftId: overrides.feeLinkedMultiShiftId ?? null,
      joinedAt: overrides.joinedAt ?? new Date("2026-01-01T00:00:00.000Z"),
      billingStartAt: overrides.billingStartAt ?? null,
      status: "ACTIVE",
    },
  });
}

// ─── SeatAllocation ───────────────────────────────────────────────────────────

export async function createAllocation(overrides: {
  seatId: string;
  studentId: string;
  shiftId: string;
  startDate?: Date;
  endDate?: Date | null;
  id?: string;
}) {
  return testPrisma.seatAllocation.create({
    data: {
      id: overrides.id ?? uid(),
      seatId: overrides.seatId,
      studentId: overrides.studentId,
      shiftId: overrides.shiftId,
      startDate: overrides.startDate ?? new Date("2026-01-01T00:00:00.000Z"),
      endDate: overrides.endDate ?? null,
    },
  });
}

// ─── Payment ──────────────────────────────────────────────────────────────────

export async function createPayment(overrides: {
  branchId: string;
  studentId: string;
  dueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  amount?: number;
  status?: "DUE" | "PAID" | "WAIVED";
  type?: "MONTHLY" | "ADMISSION";
  id?: string;
}) {
  return testPrisma.payment.create({
    data: {
      id: overrides.id ?? uid(),
      branchId: overrides.branchId,
      studentId: overrides.studentId,
      amount: overrides.amount ?? 1000,
      status: overrides.status ?? "DUE",
      type: overrides.type ?? "MONTHLY",
      dueDate: overrides.dueDate,
      periodStart: overrides.periodStart,
      periodEnd: overrides.periodEnd,
    },
  });
}

// ─── Staff ────────────────────────────────────────────────────────────────────

export async function createStaff(overrides: {
  userId: string;
  branchId: string;
  role?: "MANAGER" | "STAFF";
  id?: string;
}) {
  return testPrisma.staff.create({
    data: {
      id: overrides.id ?? uid(),
      userId: overrides.userId,
      branchId: overrides.branchId,
      role: overrides.role ?? "STAFF",
    },
  });
}

export async function createSaasSubscription(overrides: {
  organizationId: string;
  plan?: "BASIC" | "PRO";
  status?: "ACTIVE" | "EXPIRED";
}) {
  const plan = overrides.plan ?? "PRO";
  const status = overrides.status ?? "ACTIVE";
  const amount = plan === "BASIC" ? 299 : 499;
  return testPrisma.organizationSubscription.create({
    data: {
      id: uid(),
      organizationId: overrides.organizationId,
      currentOrganizationId: overrides.organizationId,
      providerMode: "TEST",
      plan,
      amount,
      amountSubunits: amount * 100,
      currency: "INR",
      period: "monthly",
      interval: 1,
      totalCount: 120,
      razorpayPlanId: `plan_${plan.toLowerCase()}_${uid()}`,
      razorpaySubscriptionId: `sub_${plan.toLowerCase()}_${uid()}`,
      status,
      currentEnd: status === "ACTIVE"
        ? new Date(Date.now() + 86_400_000)
        : new Date(Date.now() - 86_400_000),
    },
  });
}

// ─── Convenience: full world ───────────────────────────────────────────────────

/**
 * Creates a complete test world: User → Org → Branch → Shift → Seat.
 * Use this as your starting point in integration tests.
 *
 * Returns: { user, org, branch, shift, seat }
 */
export async function createTestWorld(overrides: {
  shiftName?: string;
  shiftStart?: string;
  shiftEnd?: string;
  defaultFee?: number;
  defaultAdmissionFee?: number;
} = {}) {
  const user = await createUser();
  const org = await createOrg({ ownerId: user.id });
  const branch = await createBranch({
    organizationId: org.id,
    defaultFee: overrides.defaultFee,
    defaultAdmissionFee: overrides.defaultAdmissionFee,
  });
  const shift = await createShift({
    branchId: branch.id,
    name: overrides.shiftName ?? "Morning",
    startTime: overrides.shiftStart ?? "06:00",
    endTime: overrides.shiftEnd ?? "11:59",
  });
  const seat = await createSeat({ branchId: branch.id });
  return { user, org, branch, shift, seat };
}
