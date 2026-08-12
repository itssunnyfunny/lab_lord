import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAFF_ACTIONS, type StaffAction } from "@/types";

const mocks = vi.hoisted(() => ({
  getBranchAccess: vi.fn(),
  getBillingExperience: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/staff.service", () => ({
  StaffService: { getBranchAccess: mocks.getBranchAccess },
}));
vi.mock("@/services/billingExperience.service", () => ({
  BillingExperienceService: { getForBranch: mocks.getBillingExperience },
}));

function permissions(): Record<StaffAction, boolean> {
  return STAFF_ACTIONS.reduce((result, action) => {
    result[action] = true;
    return result;
  }, {} as Record<StaffAction, boolean>);
}

describe("BranchSearchService capability filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBranchAccess.mockResolvedValue({
      branchId: "branch_1",
      branchName: "Main",
      organizationId: "org_1",
      isOwner: true,
      role: "OWNER",
      effectivePlan: "PRO",
      entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
      permissions: permissions(),
    });
  });

  it("does not suggest mutation actions in a read-only workspace", async () => {
    mocks.getBillingExperience.mockResolvedValue({
      accessMode: "READ_ONLY",
      customerMessage: "Restore billing to make changes.",
      branch: { billingStatus: "ACTIVE" },
    });
    const { BranchSearchService } = await import("@/services/branchSearch.service");

    const groups = await BranchSearchService.search("user_1", "branch_1", "add", {
      types: ["actions"],
    });

    expect(groups.flatMap(group => group.results)).toEqual([]);
  });

  it("keeps permitted mutation actions available in an active writable workspace", async () => {
    mocks.getBillingExperience.mockResolvedValue({
      accessMode: "FULL",
      customerMessage: "",
      branch: { billingStatus: "ACTIVE" },
    });
    const { BranchSearchService } = await import("@/services/branchSearch.service");

    const groups = await BranchSearchService.search("user_1", "branch_1", "add", {
      types: ["actions"],
    });

    expect(groups.flatMap(group => group.results).map(result => result.title))
      .toContain("Add Student");
  });
});
