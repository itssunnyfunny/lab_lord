import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  assertOrganizationWritable: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
  },
}));

vi.mock("@/services/entitlement.service", () => ({
  EntitlementService: {
    assertOrganizationWritable: mocks.assertOrganizationWritable,
  },
}));

import { OrganizationService } from "@/services/organization.service";

describe("OrganizationService writable settings guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ ownerId: "owner_1" });
  });

  it("checks billing write access before validating or updating settings", async () => {
    mocks.assertOrganizationWritable.mockRejectedValue(new Error("Workspace is read-only"));

    await expect(
      OrganizationService.updateSettings("org_1", "owner_1", { unknownField: true })
    ).rejects.toThrow("Workspace is read-only");

    expect(mocks.assertOrganizationWritable).toHaveBeenCalledWith("org_1");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("updates validated settings when the owner workspace is writable", async () => {
    mocks.assertOrganizationWritable.mockResolvedValue({ canWrite: true });
    mocks.update.mockResolvedValue({ id: "org_1", name: "Updated" });

    const result = await OrganizationService.updateSettings("org_1", "owner_1", {
      name: "Updated",
    });

    expect(result).toEqual({ id: "org_1", name: "Updated" });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "org_1" },
      data: { name: "Updated" },
    });
  });
});
