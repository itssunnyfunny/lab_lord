import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getWorkspaceSwitcherModel,
  WorkspaceSwitcherControl,
} from "@/components/layout/WorkspaceSwitcher";
import type { WorkspaceDirectory, WorkspaceDirectoryBranch } from "@/types";

const permissions = {
  students: true,
  view_payments: true,
};

function branch(overrides: Partial<WorkspaceDirectoryBranch> = {}): WorkspaceDirectoryBranch {
  return {
    id: "branch_1",
    name: "Central Branch",
    organizationId: "org_1",
    organizationName: "North Star Labs",
    role: "MANAGER",
    permissions,
    entitlements: [],
    href: "/branch/branch_1",
    ...overrides,
  };
}

describe("WorkspaceSwitcher", () => {
  it("labels owner destinations as Org / Branch and excludes Account", () => {
    const ownerBranch = branch({ role: "OWNER" });
    const directory: WorkspaceDirectory = {
      organizations: [{
        id: "org_1",
        name: "North Star Labs",
        role: "OWNER",
        href: "/org/org_1",
        branches: [ownerBranch],
      }],
      staffBranches: [],
      defaultHref: "/account",
    };

    const model = getWorkspaceSwitcherModel(directory);
    const markup = renderToStaticMarkup(
      <WorkspaceSwitcherControl
        directory={directory}
        pathname="/org/org_1"
        onNavigate={() => undefined}
      />
    );

    expect(model.label).toBe("Org / Branch");
    expect(model.destinations.map(destination => destination.href)).toEqual([
      "/org/org_1",
      "/branch/branch_1",
    ]);
    expect(markup).toContain("Org / Branch");
    expect(markup).toContain("North Star Labs overview");
    expect(markup).toContain("Central Branch");
    expect(markup).not.toContain("Account settings");
    expect(markup).not.toContain('value="/account"');
  });

  it("renders a single branch-only destination as static context", () => {
    const directory: WorkspaceDirectory = {
      organizations: [],
      staffBranches: [branch()],
      defaultHref: "/branch/branch_1",
    };

    const markup = renderToStaticMarkup(
      <WorkspaceSwitcherControl
        directory={directory}
        pathname="/branch/branch_1/payments"
        onNavigate={() => undefined}
      />
    );

    expect(markup).toContain("Branch");
    expect(markup).toContain("Central Branch — North Star Labs");
    expect(markup).not.toContain("<select");
  });

  it("shows only permission-backed staff branch destinations", () => {
    const directory: WorkspaceDirectory = {
      organizations: [],
      staffBranches: [
        branch(),
        branch({
          id: "branch_2",
          name: "South Branch",
          organizationId: "org_2",
          organizationName: "South Star Labs",
          href: "/branch/branch_2",
          role: "STAFF",
        }),
      ],
      defaultHref: "/branch/branch_1",
    };

    const model = getWorkspaceSwitcherModel(directory);

    expect(model.label).toBe("Branch");
    expect(model.destinations.map(destination => destination.href)).toEqual([
      "/branch/branch_1",
      "/branch/branch_2",
    ]);
    expect(model.destinations.every(destination => destination.href.startsWith("/branch/"))).toBe(true);
  });
});
