import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getWorkspaceSwitcherOptions,
  getWorkspaceSwitcherModel,
  WorkspaceSwitcherControl,
} from "@/components/layout/WorkspaceSwitcher";
import { flattenAppSelectOptions } from "@/components/ui/AppSelect";
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
  it("labels owner destinations as Org / Branch and includes Account settings", () => {
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
    const optionValues = flattenAppSelectOptions(getWorkspaceSwitcherOptions(directory))
      .map(option => option.value);
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
    expect(optionValues).toEqual(["/org/org_1", "/branch/branch_1", "/account"]);
  });

  it("keeps a single branch-only destination in an expandable account menu", () => {
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
    const optionValues = flattenAppSelectOptions(getWorkspaceSwitcherOptions(directory))
      .map(option => option.value);

    expect(markup).toContain("Branch");
    expect(markup).toContain("Central Branch — North Star Labs");
    expect(optionValues).toEqual(["/branch/branch_1", "/account"]);
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain("<select");
  });

  it("keeps account settings available while workspaces are loading or unavailable", () => {
    const loadingMarkup = renderToStaticMarkup(
      <WorkspaceSwitcherControl
        directory={null}
        pathname="/app"
        onNavigate={() => undefined}
      />
    );
    const errorMarkup = renderToStaticMarkup(
      <WorkspaceSwitcherControl
        directory={null}
        error
        pathname="/app"
        onNavigate={() => undefined}
      />
    );
    const loadingOptions = flattenAppSelectOptions(getWorkspaceSwitcherOptions(null));
    const errorOptions = flattenAppSelectOptions(getWorkspaceSwitcherOptions(null, true));

    expect(loadingMarkup).toContain("Loading workspaces");
    expect(errorMarkup).toContain("Workspaces unavailable");
    expect(loadingOptions.map(option => option.value)).toEqual(["__workspace_status__", "/account"]);
    expect(errorOptions.map(option => option.value)).toEqual(["__workspace_status__", "/account"]);
    expect(loadingOptions.find(option => option.value === "/account")?.label).toBe("Account settings");
    expect(errorOptions.find(option => option.value === "/account")?.label).toBe("Account settings");
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
