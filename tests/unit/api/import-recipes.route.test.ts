import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSessionUser: vi.fn(),
    listRecipes: vi.fn(),
    createRecipe: vi.fn(),
    deleteRecipe: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/importing/services/import-recipe.service", () => ({
    ImportRecipeService: {
        listRecipes: mocks.listRecipes,
        createRecipe: mocks.createRecipe,
        deleteRecipe: mocks.deleteRecipe,
    },
}));

describe("branch-authorized import recipe routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
    });

    it("does not invoke recipe services for an unauthenticated request", async () => {
        mocks.getSessionUser.mockResolvedValue(null);
        const { GET, POST } = await import("@/app/api/branches/[branchId]/import-recipes/route");
        const context = { params: Promise.resolve({ branchId: "branch_1" }) };

        const getResponse = await GET(new Request("http://test.local/api/branches/branch_1/import-recipes"), context);
        const postResponse = await POST(new Request("http://test.local/api/branches/branch_1/import-recipes", {
            method: "POST",
            body: JSON.stringify({}),
        }), context);

        expect(getResponse.status).toBe(401);
        expect(postResponse.status).toBe(401);
        expect(mocks.listRecipes).not.toHaveBeenCalled();
        expect(mocks.createRecipe).not.toHaveBeenCalled();
    });

    it("delegates list and create with the authenticated user and branch boundary", async () => {
        mocks.listRecipes.mockResolvedValue([{ id: "recipe_1" }]);
        mocks.createRecipe.mockResolvedValue({ id: "recipe_2" });
        const { GET, POST } = await import("@/app/api/branches/[branchId]/import-recipes/route");
        const context = { params: Promise.resolve({ branchId: "branch_1" }) };
        const input = {
            name: "Students",
            goal: "STUDENTS",
            sourceType: "CSV",
            sourceColumns: ["Name"],
            entityTypes: ["STUDENT"],
            columnMappings: [{ sourceColumn: "Name", targetField: "student.name" }],
        };

        const getResponse = await GET(new Request("http://test.local/api/branches/branch_1/import-recipes"), context);
        const postResponse = await POST(new Request("http://test.local/api/branches/branch_1/import-recipes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
        }), context);

        expect(getResponse.status).toBe(200);
        expect(postResponse.status).toBe(201);
        expect(mocks.listRecipes).toHaveBeenCalledWith("user_1", "branch_1");
        expect(mocks.createRecipe).toHaveBeenCalledWith("user_1", "branch_1", input);
    });

    it("returns the same generic 404 for a foreign or nonexistent recipe id", async () => {
        mocks.deleteRecipe.mockRejectedValue(new Error("Import recipe not found"));
        const { DELETE } = await import("@/app/api/branches/[branchId]/import-recipes/[recipeId]/route");

        const response = await DELETE(
            new Request("http://test.local/api/branches/branch_1/import-recipes/unknown", { method: "DELETE" }),
            { params: Promise.resolve({ branchId: "branch_1", recipeId: "unknown" }) },
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            error: "Import resource not found.",
            code: "IMPORT_NOT_FOUND",
        });
        expect(mocks.deleteRecipe).toHaveBeenCalledWith("user_1", "branch_1", "unknown");
    });
});
