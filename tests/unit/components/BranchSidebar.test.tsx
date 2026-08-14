import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchSidebar } from "@/components/layout/BranchSidebar";
import type { BranchAccess } from "@/types";

const mocks = vi.hoisted(() => ({
  access: null as BranchAccess | null,
  sidebarItems: [] as Array<{ label: string; href?: string }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/branch/branch_1",
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
  SidebarItem: (props: { label: string; href?: string }) => {
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
      entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
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
    expect(organizationItem?.href).toBe("/org/org_1");
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
      entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
      permissions,
    };

    renderToStaticMarkup(<BranchSidebar />);

    expect(mocks.sidebarItems.map(item => item.label)).not.toContain("Back to organization");
    expect(mocks.sidebarItems.map(item => item.label)).toContain("Branch Settings");
  });

  it("keeps AI reports and messages but removes AI Insights", () => {
    mocks.access = {
      branchId: "branch_1",
      branchName: "Main Branch",
      organizationId: "org_1",
      isOwner: true,
      role: "OWNER",
      effectivePlan: "PRO",
      entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
      permissions: {
        ...permissions,
        manage_org: true,
        staff_management: true,
      },
    };

    renderToStaticMarkup(<BranchSidebar />);

    const labels = mocks.sidebarItems.map(item => item.label);
    expect(labels).not.toContain("AI Insights");
    expect(labels).toContain("AI Reports");
    expect(labels).toContain("AI Messages");
  });

  it("hides AI messages when payment visibility is denied", () => {
    mocks.access = {
      branchId: "branch_1",
      branchName: "Main Branch",
      organizationId: "org_1",
      isOwner: false,
      role: "STAFF",
      staffId: "staff_1",
      effectivePlan: "PRO",
      entitlements: ["ADVANCED_ANALYTICS", "AI_ACCESS"],
      permissions: { ...permissions, manage_branch: false, view_payments: false },
    };

    renderToStaticMarkup(<BranchSidebar />);

    const labels = mocks.sidebarItems.map(item => item.label);
    expect(labels).toContain("AI Reports");
    expect(labels).not.toContain("AI Messages");
  });
});
