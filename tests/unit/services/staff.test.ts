import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * UNIT TESTS: StaffService.authorize()
 *
 * Strategy: Mock Prisma entirely — no DB needed.
 * We're testing the PERMISSION_MATRIX logic, not DB queries.
 *
 * Why mock Prisma here:
 *   The authorize() flow does only 2 DB calls:
 *   1. branch.findUnique (to get org owner)
 *   2. staff.findUnique (to get role)
 *   We control both return values, so no real DB needed.
 */

// Mock BEFORE importing — Vitest hoists vi.mock() calls
vi.mock("@/lib/prisma", () => ({
  prisma: {
    branch: {
      findUnique: vi.fn(),
    },
    staff: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: "org_1",
        subscription: {
          plan: "PRO",
          status: "ACTIVE",
          currentEnd: new Date("2099-01-01T00:00:00.000Z"),
        },
        _count: { branches: 1 },
      }),
    },
  },
}));

import { StaffService, PERMISSION_MATRIX } from "@/services/staff.service";
import { prisma } from "@/lib/prisma";
import { STAFF_ACTIONS, StaffPermissionAction } from "@/types";

const mockBranch = (ownerId: string) =>
  prisma.branch.findUnique = vi.fn().mockResolvedValue({
    id: "branch_1",
    name: "Test Branch",
    organizationId: "org_1",
    organization: { id: "org_1", ownerId },
  } as never);

const mockStaff = (
  role: "MANAGER" | "STAFF" | null,
  permissionOverrides: { action: StaffPermissionAction; allowed: boolean }[] = []
) => {
  prisma.staff.findUnique = vi.fn().mockResolvedValue(
    role ? { id: "staff_1", role, permissionOverrides } : null
  );
};

describe("PERMISSION_MATRIX", () => {
  it("manage_org allows no roles (owner only)", () => {
    expect(PERMISSION_MATRIX.manage_org).toEqual([]);
  });

  it("manage_branch allows MANAGER", () => {
    expect(PERMISSION_MATRIX.manage_branch).toContain("MANAGER");
    expect(PERMISSION_MATRIX.manage_branch).not.toContain("STAFF");
  });

  it("students allows MANAGER and STAFF", () => {
    expect(PERMISSION_MATRIX.students).toContain("MANAGER");
    expect(PERMISSION_MATRIX.students).toContain("STAFF");
  });

  it("payment collection allows MANAGER and STAFF", () => {
    expect(PERMISSION_MATRIX.view_payments).toContain("MANAGER");
    expect(PERMISSION_MATRIX.view_payments).toContain("STAFF");
    expect(PERMISSION_MATRIX.mark_payment_paid).toContain("MANAGER");
    expect(PERMISSION_MATRIX.mark_payment_paid).toContain("STAFF");
  });

  it("payment generation and waivers allow MANAGER only", () => {
    expect(PERMISSION_MATRIX.generate_payments).toContain("MANAGER");
    expect(PERMISSION_MATRIX.generate_payments).not.toContain("STAFF");
    expect(PERMISSION_MATRIX.waive_payments).toContain("MANAGER");
    expect(PERMISSION_MATRIX.waive_payments).not.toContain("STAFF");
  });

  it("staff_management allows no roles (owner only)", () => {
    expect(PERMISSION_MATRIX.staff_management).toEqual([]);
  });
});

describe("StaffService.authorize()", () => {
  const OWNER_ID = "user_owner";
  const OTHER_ID = "user_other";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows org OWNER for any action", async () => {
    mockBranch(OWNER_ID);
    await expect(StaffService.authorize(OWNER_ID, "branch_1", "staff_management")).resolves.toBe(true);
    await expect(StaffService.authorize(OWNER_ID, "branch_1", "manage_org")).resolves.toBe(true);
  });

  it("allows MANAGER to manage_branch", async () => {
    mockBranch(OWNER_ID);
    mockStaff("MANAGER");
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "manage_branch")).resolves.toBe(true);
  });

  it("allows MANAGER to generate_payments", async () => {
    mockBranch(OWNER_ID);
    mockStaff("MANAGER");
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "generate_payments")).resolves.toBe(true);
  });

  it("allows STAFF to view payments and mark paid", async () => {
    mockBranch(OWNER_ID);
    mockStaff("STAFF");
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "view_payments")).resolves.toBe(true);
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "mark_payment_paid")).resolves.toBe(true);
  });

  it("REJECTS STAFF from waiving payments", async () => {
    mockBranch(OWNER_ID);
    mockStaff("STAFF");
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "waive_payments")).rejects.toThrow("Unauthorized");
  });

  it("allows STAFF to view students", async () => {
    mockBranch(OWNER_ID);
    mockStaff("STAFF");
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "students")).resolves.toBe(true);
  });

  it("allows an explicit permission override to grant access beyond role defaults", async () => {
    mockBranch(OWNER_ID);
    mockStaff("STAFF", [{ action: StaffPermissionAction.ANALYTICS, allowed: true }]);
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "analytics")).resolves.toBe(true);
  });

  it("rejects when an explicit permission override disables a role default", async () => {
    mockBranch(OWNER_ID);
    mockStaff("MANAGER", [{ action: StaffPermissionAction.MANAGE_BRANCH, allowed: false }]);
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "manage_branch")).rejects.toThrow("disabled");
  });

  it("REJECTS STAFF from manage_branch", async () => {
    mockBranch(OWNER_ID);
    mockStaff("STAFF");
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "manage_branch")).rejects.toThrow("Unauthorized");
  });

  it("REJECTS MANAGER from staff_management", async () => {
    mockBranch(OWNER_ID);
    mockStaff("MANAGER");
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "staff_management")).rejects.toThrow("Unauthorized");
  });

  it("REJECTS user with no staff record", async () => {
    mockBranch(OWNER_ID);
    mockStaff(null);
    await expect(StaffService.authorize(OTHER_ID, "branch_1", "students")).rejects.toThrow("Not a staff member");
  });

  it("throws Branch not found if branch doesn't exist", async () => {
    prisma.branch.findUnique = vi.fn().mockResolvedValue(null);
    await expect(StaffService.authorize(OWNER_ID, "nonexistent", "students")).rejects.toThrow("Branch not found");
  });
});

describe("StaffService.getBranchAccess()", () => {
  const OWNER_ID = "user_owner";
  const OTHER_ID = "user_other";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all permissions for the organization owner", async () => {
    mockBranch(OWNER_ID);

    const access = await StaffService.getBranchAccess(OWNER_ID, "branch_1");

    expect(access).toMatchObject({
      branchId: "branch_1",
      branchName: "Test Branch",
      organizationId: "org_1",
      isOwner: true,
      role: "OWNER",
      effectivePlan: "PRO",
    });
    expect(access.entitlements).toContain("AI_ACCESS");
    for (const action of STAFF_ACTIONS) {
      expect(access.permissions[action]).toBe(true);
    }
    expect(prisma.staff.findUnique).not.toHaveBeenCalled();
  });

  it("returns role defaults plus explicit permission overrides for staff", async () => {
    mockBranch(OWNER_ID);
    mockStaff("STAFF", [
      { action: StaffPermissionAction.ANALYTICS, allowed: true },
      { action: StaffPermissionAction.MARK_PAYMENT_PAID, allowed: false },
    ]);

    const access = await StaffService.getBranchAccess(OTHER_ID, "branch_1");

    expect(access).toMatchObject({
      branchId: "branch_1",
      branchName: "Test Branch",
      organizationId: "org_1",
      isOwner: false,
      role: "STAFF",
      staffId: "staff_1",
    });
    expect(access.permissions.students).toBe(true);
    expect(access.permissions.analytics).toBe(true);
    expect(access.permissions.mark_payment_paid).toBe(false);
    expect(access.permissions.staff_management).toBe(false);
  });

  it("rejects users who are not staff on the branch", async () => {
    mockBranch(OWNER_ID);
    mockStaff(null);

    await expect(StaffService.getBranchAccess(OTHER_ID, "branch_1")).rejects.toThrow("Not a staff member");
  });
});
