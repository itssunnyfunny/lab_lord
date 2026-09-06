import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    assertBranchWritable: vi.fn(),
    branchFindUnique: vi.fn(),
    recipeFindMany: vi.fn(),
    recipeFindFirst: vi.fn(),
    recipeCreate: vi.fn(),
    recipeUpdateMany: vi.fn(),
    transaction: vi.fn(),
}));

vi.mock("@/services/staff.service", () => ({
    StaffService: { authorize: mocks.authorize },
}));

vi.mock("@/services/entitlement.service", () => ({
    EntitlementService: { assertBranchWritable: mocks.assertBranchWritable },
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
        branch: { findUnique: mocks.branchFindUnique },
        importRecipe: {
            findMany: mocks.recipeFindMany,
            updateMany: mocks.recipeUpdateMany,
        },
        $transaction: mocks.transaction,
    },
}));

import {
    buildImportRecipeHeaderSignature,
    ImportRecipeService,
} from "@/importing/services/import-recipe.service";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function storedRecipe(overrides: Record<string, unknown> = {}) {
    return {
        id: "recipe_1",
        name: "Student list",
        revision: 1,
        schemaVersion: 1,
        engineVersion: 2,
        goal: "STUDENTS",
        sourceType: "CSV",
        normalizedHeaderSignature: buildImportRecipeHeaderSignature("CSV", ["student name", "phone"]),
        entityTypes: ["STUDENT"],
        columnMappings: [
            { sourceColumn: "student name", targetField: "student.name" },
            { sourceColumn: "phone", targetField: "student.phone" },
        ],
        useCount: 0,
        lastUsedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

describe("ImportRecipeService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue(true);
        mocks.assertBranchWritable.mockResolvedValue(undefined);
        mocks.branchFindUnique.mockResolvedValue({ organizationId: "org_1" });
        mocks.recipeFindFirst.mockResolvedValue(null);
        mocks.recipeCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve(storedRecipe(data))
        );
        mocks.transaction.mockImplementation((callback: (transaction: unknown) => unknown) => callback({
            importRecipe: {
                findFirst: mocks.recipeFindFirst,
                create: mocks.recipeCreate,
            },
        }));
    });

    it("persists only normalized structural recipe data and computes the fingerprint server-side", async () => {
        const recipe = await ImportRecipeService.createRecipe("user_1", "branch_1", {
            name: "  Student   list  ",
            goal: "STUDENTS",
            sourceType: "CSV",
            sourceFingerprint: "caller-controlled-fingerprint",
            sourceColumns: [" Student Name ", "PHONE"],
            entityTypes: ["STUDENT", "STUDENT"],
            columnMappings: [
                {
                    sourceColumn: " Student Name ",
                    targetField: "student.name",
                    confidence: 99,
                    reason: "raw model output",
                    sampleValues: ["Asha Sharma"],
                },
                {
                    sourceColumn: "PHONE",
                    targetField: "student.phone",
                    rawValue: "9876543210",
                },
            ],
            samples: [{ name: "Asha Sharma", phone: "9876543210" }],
            rowValues: [{ name: "Asha Sharma" }],
            branchConfig: { defaultFee: 1500, seats: ["A-01"] },
            importOptions: {
                defaultSeatLabel: "A-01",
                paymentAction: "IMPORT_PAID_UNPAID",
                skipConflictingAllocations: true,
            },
        });

        const data = mocks.recipeCreate.mock.calls[0][0].data;
        expect(data).toEqual({
            organizationId: "org_1",
            branchId: null,
            createdByUserId: "user_1",
            name: "Student list",
            revision: 1,
            schemaVersion: 1,
            engineVersion: 2,
            goal: "STUDENTS",
            sourceType: "CSV",
            normalizedHeaderSignature: buildImportRecipeHeaderSignature("CSV", ["student name", "phone"]),
            entityTypes: ["STUDENT"],
            columnMappings: [
                { sourceColumn: "student name", targetField: "student.name" },
                { sourceColumn: "phone", targetField: "student.phone" },
            ],
        });
        expect(recipe.sourceFingerprint).not.toBe("caller-controlled-fingerprint");
        expect(JSON.stringify(data)).not.toContain("Asha");
        expect(JSON.stringify(data)).not.toContain("9876543210");
        expect(mocks.authorize).toHaveBeenCalledWith("user_1", "branch_1", "students");
        expect(mocks.assertBranchWritable).toHaveBeenCalledWith("branch_1");
    });

    it("lists only active recipes for the authorized branch organization and redacts unexpected JSON fields", async () => {
        mocks.recipeFindMany.mockResolvedValue([
            storedRecipe({
                entityTypes: ["STUDENT", { sample: "secret" }, "UNKNOWN"],
                columnMappings: [
                    {
                        sourceColumn: "student name",
                        targetField: "student.name",
                        rawValue: "Asha Sharma",
                        sampleValues: ["Asha Sharma"],
                    },
                ],
            }),
        ]);

        const recipes = await ImportRecipeService.listRecipes("user_1", "branch_1");

        expect(mocks.recipeFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { organizationId: "org_1", archivedAt: null },
            take: 100,
        }));
        expect(recipes[0]).toEqual(expect.objectContaining({
            entityTypes: ["STUDENT"],
            sourceColumns: ["student name"],
            columnMappings: [{ sourceColumn: "student name", targetField: "student.name" }],
        }));
        expect(JSON.stringify(recipes)).not.toContain("Asha Sharma");
    });

    it("creates a new organization-scoped revision for an existing name", async () => {
        mocks.recipeFindFirst.mockResolvedValue({ revision: 4 });

        await ImportRecipeService.createRecipe("user_1", "branch_2", {
            name: "Student list",
            goal: "STUDENTS",
            sourceType: "PASTED_TABLE",
            sourceColumns: ["Name"],
            entityTypes: ["STUDENT"],
            columnMappings: [{ sourceColumn: "Name", targetField: "student.name" }],
        });

        expect(mocks.recipeFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { organizationId: "org_1", name: "Student list" },
        }));
        expect(mocks.recipeCreate.mock.calls[0][0].data).toEqual(expect.objectContaining({
            organizationId: "org_1",
            branchId: null,
            revision: 5,
        }));
    });

    it("retries a concurrent same-name revision conflict", async () => {
        mocks.transaction
            .mockRejectedValueOnce(Object.assign(new Error("unique conflict"), { code: "P2002" }))
            .mockImplementationOnce((callback: (transaction: unknown) => unknown) => callback({
                importRecipe: {
                    findFirst: mocks.recipeFindFirst,
                    create: mocks.recipeCreate,
                },
            }));

        await expect(ImportRecipeService.createRecipe("user_1", "branch_1", {
            name: "Student list",
            goal: "STUDENTS",
            sourceType: "CSV",
            sourceColumns: ["Name"],
            entityTypes: ["STUDENT"],
            columnMappings: [{ sourceColumn: "Name", targetField: "student.name" }],
        })).resolves.toEqual(expect.objectContaining({ id: "recipe_1" }));

        expect(mocks.transaction).toHaveBeenCalledTimes(2);
    });

    it("returns the same not-found error for missing and foreign recipe ids", async () => {
        mocks.recipeUpdateMany.mockResolvedValue({ count: 0 });

        await expect(
            ImportRecipeService.deleteRecipe("user_1", "branch_1", "foreign_or_missing")
        ).rejects.toThrow("Import recipe not found");
        expect(mocks.recipeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                id: "foreign_or_missing",
                organizationId: "org_1",
                archivedAt: null,
            },
        }));
    });
});

vi.mock("@/services/accessPolicy.service", async importOriginal => {
    const actual = await importOriginal<typeof import("@/services/accessPolicy.service")>();
    const { callerPolicyMock } = await import("@/tests/helpers/accessPolicyCallerMock");
    const { StaffService } = await import("@/services/staff.service");
    const { EntitlementService } = await import("@/services/entitlement.service");
    return { ...actual, AccessPolicy: callerPolicyMock(actual.AccessPolicy, StaffService, EntitlementService) };
});
