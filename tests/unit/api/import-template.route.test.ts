import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  buildTemplate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/importing/services/import-template.service", () => ({
  ImportTemplateService: { buildTemplate: mocks.buildTemplate },
}));

describe("GET import template", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires authentication", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/branches/[branchId]/import-sessions/template/route");
    const response = await GET(
      new Request("http://test.local/api/branches/branch_1/import-sessions/template?goal=STUDENTS"),
      { params: Promise.resolve({ branchId: "branch_1" }) },
    );
    expect(response.status).toBe(401);
    expect(mocks.buildTemplate).not.toHaveBeenCalled();
  });

  it("returns an authorized goal-specific download", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: "user_1" });
    mocks.buildTemplate.mockResolvedValueOnce({
      fileName: "students.csv",
      contentType: "text/csv; charset=utf-8",
      body: Buffer.from("Student name\r\nAsha\r\n"),
    });
    const { GET } = await import("@/app/api/branches/[branchId]/import-sessions/template/route");
    const response = await GET(
      new Request("http://test.local/api/branches/branch_1/import-sessions/template?goal=STUDENTS&format=csv"),
      { params: Promise.resolve({ branchId: "branch_1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("students.csv");
    expect(mocks.buildTemplate).toHaveBeenCalledWith("user_1", "branch_1", "STUDENTS", "csv");
  });
});
