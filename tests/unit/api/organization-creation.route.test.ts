import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/organizations/route";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { organization: { create: vi.fn() } } }));

describe("retired organization creation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires authentication", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await POST(new Request("http://localhost/api/organizations", { method: "POST" }))).status).toBe(401);
  });

  it("cannot grant legacy access even with a valid old payload", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: "owner" } as never);
    const response = await POST(new Request("http://localhost/api/organizations", {
      method: "POST",
      body: JSON.stringify({ name: "Academy", contactPhone: "9876543210" }),
    }));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "Create workspaces through onboarding.", code: "ONBOARDING_REQUIRED" });
    expect(prisma.organization.create).not.toHaveBeenCalled();
  });
});
