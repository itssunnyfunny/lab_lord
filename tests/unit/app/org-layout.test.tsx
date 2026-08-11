import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrgLayout from "@/app/org/[orgId]/layout";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  isOwner: vi.fn(),
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/organization.service", () => ({
  OrganizationService: { isOwner: mocks.isOwner },
}));

vi.mock("@/components/layout/OrganizationWorkspaceShell", () => ({
  OrganizationWorkspaceShell: ({
    organizationId,
    children,
  }: {
    organizationId: string;
    children: React.ReactNode;
  }) => <div data-organization-id={organizationId}>{children}</div>,
}));

describe("organization layout access", () => {
  beforeEach(() => {
    mocks.getSessionUser.mockReset();
    mocks.isOwner.mockReset();
    mocks.redirect.mockClear();
  });

  it("renders organization chrome only for the owner", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1" });
    mocks.isOwner.mockResolvedValue(true);

    const result = await OrgLayout({
      children: <span>Organization content</span>,
      params: Promise.resolve({ orgId: "org_1" }),
    });

    expect(mocks.isOwner).toHaveBeenCalledWith("org_1", "owner_1");
    expect(renderToStaticMarkup(result)).toContain('data-organization-id="org_1"');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects authenticated non-owners before rendering organization chrome", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "staff_1" });
    mocks.isOwner.mockResolvedValue(false);

    await expect(OrgLayout({
      children: <span>Restricted content</span>,
      params: Promise.resolve({ orgId: "org_1" }),
    })).rejects.toThrow("NEXT_REDIRECT:/app");

    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("sends signed-out visitors through the safe app entry", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    await expect(OrgLayout({
      children: <span>Restricted content</span>,
      params: Promise.resolve({ orgId: "org_1" }),
    })).rejects.toThrow("NEXT_REDIRECT:/app");

    expect(mocks.isOwner).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });
});
