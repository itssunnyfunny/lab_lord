import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchSidebar } from "@/components/layout/BranchSidebar";
import type { BranchAccess } from "@/types";

const mocks = vi.hoisted(() => ({
  access: null as BranchAccess | null,
  push: vi.fn(),
  sidebarItems: [] as Array<{ label: string; onClick?: () => void }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/branch/branch_1",
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/hooks/useBranchAccess", () => ({
  useBranchAccess: () => ({
    access: mocks.access,
    loading: false,
    error: null,
    can: vi.fn(),
  }),
}));

vi.mock("@/components/layout/SidebarItem", () => ({
  SidebarItem: (props: { label: string; onClick?: () => void }) => {
    mocks.sidebarItems.push(props);
    return null;
  },
}));

const permissions: BranchAccess["permissions"] = {
  manage_org: false,
  manage_branch: true,
  students: true,
  seat_allocation: true,
  view_payments: true,
  generate_payments: true,
  mark_payment_paid: true,
  waive_payments: true,
  analytics: true,
  staff_management: false,
};

describe("BranchSidebar", () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.sidebarItems.length = 0;
  });

  it("shows the organization control for owners", () => {
    mocks.access = {
      branchId: "branch_1",
      branchName: "Main Branch",
      organizationId: "org_1",
      isOwner: true,
      role: "OWNER",
      effectivePlan: "PRO",
      entitlements: ["MULTI_BRANCH", "STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
      permissions: {
        ...permissions,
        manage_org: true,
        staff_management: true,
      },
    };

    renderToStaticMarkup(<BranchSidebar />);
    const organizationItem = mocks.sidebarItems.find(
      item => item.label === "Back to organization"
    );

    expect(organizationItem).toBeDefined();
    organizationItem?.onClick?.();
    expect(mocks.push).toHaveBeenCalledWith("/org/org_1");
  });

  it("hides the organization control from staff", () => {
    mocks.access = {
      branchId: "branch_1",
      branchName: "Main Branch",
      organizationId: "org_1",
      isOwner: false,
      role: "MANAGER",
      staffId: "staff_1",
      effectivePlan: "PRO",
      entitlements: ["MULTI_BRANCH", "STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
      permissions,
    };

    renderToStaticMarkup(<BranchSidebar />);

    expect(mocks.sidebarItems.map(item => item.label)).not.toContain("Back to organization");
    expect(mocks.sidebarItems.map(item => item.label)).toContain("Branch Settings");
  });
});
