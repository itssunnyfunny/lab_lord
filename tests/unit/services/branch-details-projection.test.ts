import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchAccess, StaffAction } from "@/types";

const mocks = vi.hoisted(() => ({
  branchFindUnique: vi.fn(),
  branchUpdate: vi.fn(),
  getBranchAccess: vi.fn(),
  authorize: vi.fn(),
  assertBranchWritable: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    branch: {
      findUnique: mocks.branchFindUnique,
      update: mocks.branchUpdate,
    },
  },
}));

vi.mock("@/services/staff.service", () => ({
  StaffService: {
    getBranchAccess: mocks.getBranchAccess,
    authorize: mocks.authorize,
  },
}));

vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    assertBranchWritable: mocks.assertBranchWritable,
  },
}));

import { BranchService } from "@/services/branch.service";

const branchRecord = {
  id: "branch_1",
  organizationId: "org_1",
  name: "Main Branch",
  city: "Delhi",
  address: "Private branch address",
  contactPhone: "+91 98765 43210",
  openingTime: "06:00",
  closingTime: "22:00",
  defaultFee: 1500,
  defaultAdmissionFee: 300,
  defaultMessageLanguage: "hi",
  reminderTone: "firm",
  aiEnabled: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  lastDataChange: new Date("2026-08-01T00:00:00.000Z"),
  aiLastCalledAt: null,
  aiStatus: "IDLE",
  billingStatus: "ACTIVE",
  billingActivatedAt: null,
  billingArchivedAt: null,
  organization: {
    id: "org_1",
    name: "Private Organization",
    ownerId: "owner_1",
    legalName: "Private Legal Name",
    contactEmail: "owner@example.com",
    billingMutationLeaseToken: "secret-lease-token",
  },
  _count: {
    seats: 20,
    students: 12,
    shifts: 3,
    payments: 4,
    staff: 2,
  },
  shifts: [
    {
      id: "shift_1",
      name: "Morning",
      startTime: "06:00",
      endTime: "09:59",
      price: 900,
      isReserved: false,
    },
  ],
  staff: [
    {
      id: "staff_1",
      role: "STAFF",
      user: { id: "user_2", name: "Staff User", email: "staff@example.com" },
    },
  ],
};

function permissions(overrides: Partial<Record<StaffAction, boolean>> = {}) {
  return {
    manage_org: false,
    manage_branch: false,
    students: false,
    seat_allocation: false,
    view_payments: false,
    generate_payments: false,
    mark_payment_paid: false,
    waive_payments: false,
    analytics: false,
    view_whatsapp: false,
    send_whatsapp: false,
    manage_whatsapp: false,
    receive_whatsapp_reports: false,
    staff_management: false,
    ...overrides,
  } satisfies Record<StaffAction, boolean>;
}

function access(permissionOverrides: Partial<Record<StaffAction, boolean>>): BranchAccess {
  return {
    branchId: "branch_1",
    branchName: "Main Branch",
    organizationId: "org_1",
    isOwner: false,
    role: "STAFF",
    staffId: "staff_1",
    permissions: permissions(permissionOverrides),
    effectivePlan: "PRO",
    entitlements: ["STAFF_MANAGEMENT"],
  };
}

describe("BranchService branch response projection", () => {
  it.each([false, true])("omits staff identities and counts without entitlement (owner=%s)", async isOwner => {
    mocks.getBranchAccess.mockResolvedValue({ ...access({ manage_branch: true }), isOwner, entitlements: [] });
    const read = await BranchService.getBranchDetails("user_2", "branch_1");
    const updated = await BranchService.updateSettings("user_2", "branch_1", { name: "Main Branch" });
    for (const result of [read, updated]) {
      expect(result).not.toHaveProperty("staff");
      expect(result?._count).not.toHaveProperty("staff");
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.branchFindUnique.mockResolvedValue(branchRecord);
    mocks.branchUpdate.mockResolvedValue(branchRecord);
    mocks.authorize.mockResolvedValue(true);
    mocks.assertBranchWritable.mockResolvedValue({ canWrite: true });
  });

  it("returns only payment-authorized counts and safe organization identity to payment-only staff", async () => {
    mocks.getBranchAccess.mockResolvedValue(access({ view_payments: true }));

    const details = await BranchService.getBranchDetails("user_2", "branch_1");

    expect(details).toMatchObject({
      id: "branch_1",
      organizationId: "org_1",
      name: "Main Branch",
      defaultMessageLanguage: "hi",
      reminderTone: "firm",
      organization: { id: "org_1", name: "Private Organization" },
      _count: { payments: 4 },
    });
    expect(details?.organization).toEqual({ id: "org_1", name: "Private Organization" });
    expect(details?._count).toEqual({ payments: 4 });
    expect(details).not.toHaveProperty("address");
    expect(details).not.toHaveProperty("defaultAdmissionFee");
    expect(details).not.toHaveProperty("shifts");
    expect(details).not.toHaveProperty("staff");
  });

  it("returns only seat and shift data to seat-only staff", async () => {
    mocks.getBranchAccess.mockResolvedValue(access({ seat_allocation: true }));

    const details = await BranchService.getBranchDetails("user_2", "branch_1");

    expect(details).toMatchObject({
      id: "branch_1",
      organizationId: "org_1",
      name: "Main Branch",
      organization: { id: "org_1", name: "Private Organization" },
      _count: { seats: 20, shifts: 3 },
      shifts: [{ id: "shift_1" }],
    });
    expect(details?._count).toEqual({ seats: 20, shifts: 3 });
    expect(details).not.toHaveProperty("address");
    expect(details).not.toHaveProperty("defaultFee");
    expect(details).not.toHaveProperty("payments");
    expect(details).not.toHaveProperty("staff");
  });

  it("keeps manager settings data but omits denied payment counts after update", async () => {
    mocks.getBranchAccess.mockResolvedValue(access({
      manage_branch: true,
      students: true,
      seat_allocation: true,
      view_payments: false,
    }));

    const updated = await BranchService.updateSettings("manager_1", "branch_1", {
      name: "Updated Branch",
    });

    expect(updated).toMatchObject({
      id: "branch_1",
      address: "Private branch address",
      defaultAdmissionFee: 300,
      organization: { id: "org_1", name: "Private Organization" },
      _count: {
        seats: 20,
        students: 12,
        shifts: 3,
        staff: 2,
      },
      shifts: [{ id: "shift_1" }],
      staff: [{ id: "staff_1" }],
    });
    expect(updated.organization).toEqual({ id: "org_1", name: "Private Organization" });
    expect(updated._count).not.toHaveProperty("payments");
    expect(mocks.branchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "branch_1" },
      data: expect.objectContaining({ name: "Updated Branch" }),
    }));
  });
});

vi.mock("@/services/accessPolicy.service", async importOriginal => {
    const actual = await importOriginal<typeof import("@/services/accessPolicy.service")>();
    const { callerPolicyMock } = await import("@/tests/helpers/accessPolicyCallerMock");
    const { StaffService } = await import("@/services/staff.service");
    const { EntitlementService } = await import("@/services/entitlement.service");
    return { ...actual, AccessPolicy: callerPolicyMock(actual.AccessPolicy, StaffService, EntitlementService) };
});
