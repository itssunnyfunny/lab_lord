import { createHash } from "node:crypto";
import { Prisma, type ImportRecipe } from "@/app/generated/prisma/client";
import type { ImportGoal, ImportSourceType } from "@/app/generated/prisma/enums";
import {
    IMPORT_TARGET_FIELDS,
    type ImportEntityType,
    type ImportTargetField,
} from "@/importing/contracts/import-session.contract";
import { IMPORT_ENGINE_VERSION } from "@/importing/contracts/import-v2.contract";
import { normalizeColumnName } from "@/importing/utils/column-normalizer";
import { prisma } from "@/lib/prisma";
import { EntitlementService } from "@/services/entitlement.service";
import { StaffService } from "@/services/staff.service";

export const IMPORT_RECIPE_SCHEMA_VERSION = 1;
export const MAX_IMPORT_RECIPES_PER_LIST = 100;
export const MAX_IMPORT_RECIPE_NAME_LENGTH = 80;
export const MAX_IMPORT_RECIPE_COLUMNS = 64;

const IMPORT_GOALS = new Set<ImportGoal>([
    "STUDENTS",
    "STUDENTS_ALLOCATIONS",
    "FULL",
]);
const IMPORT_SOURCE_TYPES = new Set<ImportSourceType>([
    "CSV",
    "XLSX",
    "XLS",
    "PDF",
    "PASTED_TABLE",
    "OTHER",
]);
const IMPORT_ENTITY_TYPES = new Set<ImportEntityType>([
    "STUDENT",
    "SEAT",
    "SHIFT",
    "ALLOCATION",
    "PAYMENT",
]);
const IMPORT_TARGET_FIELD_SET = new Set<string>(IMPORT_TARGET_FIELDS);

type StoredColumnMapping = {
    sourceColumn: string;
    targetField: ImportTargetField;
};

export type CreateImportRecipeInput = {
    name: string;
    goal: ImportGoal;
    sourceType: ImportSourceType;
    sourceColumns: string[];
    entityTypes: ImportEntityType[];
    columnMappings: Array<{
        sourceColumn: string;
        targetField: ImportTargetField;
    }>;
};

export type PublicImportRecipe = {
    id: string;
    name: string;
    revision: number;
    schemaVersion: number;
    engineVersion: number;
    goal: ImportGoal;
    sourceType: ImportSourceType;
    sourceFingerprint: string;
    sourceColumns: string[];
    entityTypes: ImportEntityType[];
    columnMappings: StoredColumnMapping[];
    useCount: number;
    lastUsedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

type SelectedRecipe = Pick<
    ImportRecipe,
    | "id"
    | "name"
    | "revision"
    | "schemaVersion"
    | "engineVersion"
    | "goal"
    | "sourceType"
    | "normalizedHeaderSignature"
    | "entityTypes"
    | "columnMappings"
    | "useCount"
    | "lastUsedAt"
    | "createdAt"
    | "updatedAt"
>;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isRecipeWriteConflict(error: unknown) {
    const code = asRecord(error)?.code;
    return code === "P2002" || code === "P2034";
}

function normalizeRecipeName(value: unknown) {
    if (typeof value !== "string") throw new Error("Recipe name is required.");
    const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!name) throw new Error("Recipe name is required.");
    if (name.length > MAX_IMPORT_RECIPE_NAME_LENGTH) {
        throw new Error(`Recipe names can contain at most ${MAX_IMPORT_RECIPE_NAME_LENGTH} characters.`);
    }
    return name;
}

export function normalizeImportRecipeSourceColumns(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("At least one source column is required.");
    }
    if (value.length > MAX_IMPORT_RECIPE_COLUMNS) {
        throw new Error(`Import recipes can contain at most ${MAX_IMPORT_RECIPE_COLUMNS} source columns.`);
    }

    const used = new Set<string>();
    return value.map((column, index) => {
        if (typeof column !== "string") throw new Error(`Source column ${index + 1} is invalid.`);
        const base = normalizeColumnName(column.normalize("NFKC"));
        if (!base) throw new Error(`Source column ${index + 1} is blank.`);

        let normalized = base;
        let suffix = 2;
        while (used.has(normalized)) {
            normalized = `${base} ${suffix}`;
            suffix++;
        }
        used.add(normalized);
        return normalized;
    });
}

export function buildImportRecipeHeaderSignature(
    sourceType: ImportSourceType,
    sourceColumns: readonly string[],
) {
    const normalizedColumns = normalizeImportRecipeSourceColumns([...sourceColumns]);
    return createHash("sha256")
        .update(JSON.stringify({ version: IMPORT_RECIPE_SCHEMA_VERSION, sourceType, columns: normalizedColumns }))
        .digest("hex");
}

function parseSourceType(value: unknown): ImportSourceType {
    if (typeof value !== "string" || !IMPORT_SOURCE_TYPES.has(value as ImportSourceType)) {
        throw new Error("Recipe source type is invalid.");
    }
    return value as ImportSourceType;
}

function parseGoal(value: unknown): ImportGoal {
    if (typeof value !== "string" || !IMPORT_GOALS.has(value as ImportGoal)) {
        throw new Error("Recipe import goal is invalid.");
    }
    return value as ImportGoal;
}

function parseEntityTypes(value: unknown): ImportEntityType[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("At least one recipe entity type is required.");
    }
    const result: ImportEntityType[] = [];
    for (const entityType of value) {
        if (typeof entityType !== "string" || !IMPORT_ENTITY_TYPES.has(entityType as ImportEntityType)) {
            throw new Error("Recipe entity types are invalid.");
        }
        if (!result.includes(entityType as ImportEntityType)) result.push(entityType as ImportEntityType);
    }
    return result;
}

function parseColumnMappings(
    value: unknown,
    originalColumns: string[],
    normalizedColumns: string[],
): StoredColumnMapping[] {
    if (!Array.isArray(value) || value.length !== originalColumns.length) {
        throw new Error("Every source column must have exactly one recipe mapping.");
    }

    const sourceIndexByName = new Map<string, number>();
    originalColumns.forEach((column, index) => {
        const key = column.normalize("NFKC").trim();
        if (sourceIndexByName.has(key)) {
            throw new Error("Duplicate source columns must be positionally disambiguated before saving a recipe.");
        }
        sourceIndexByName.set(key, index);
    });

    const mappingsByIndex = new Map<number, StoredColumnMapping>();
    const usedTargets = new Set<string>();
    for (const item of value) {
        const record = asRecord(item);
        const sourceColumn = record?.sourceColumn;
        const targetField = record?.targetField;
        if (typeof sourceColumn !== "string" || typeof targetField !== "string") {
            throw new Error("Recipe column mappings are invalid.");
        }
        const sourceIndex = sourceIndexByName.get(sourceColumn.normalize("NFKC").trim());
        if (sourceIndex === undefined || mappingsByIndex.has(sourceIndex)) {
            throw new Error("Every source column must have exactly one recipe mapping.");
        }
        if (!IMPORT_TARGET_FIELD_SET.has(targetField)) {
            throw new Error("Recipe column mappings contain an unsupported target field.");
        }
        if (targetField !== "ignore" && usedTargets.has(targetField)) {
            throw new Error(`Only one source column can map to ${targetField}.`);
        }
        if (targetField !== "ignore") usedTargets.add(targetField);
        mappingsByIndex.set(sourceIndex, {
            sourceColumn: normalizedColumns[sourceIndex],
            targetField: targetField as ImportTargetField,
        });
    }

    return normalizedColumns.map((_column, index) => {
        const mapping = mappingsByIndex.get(index);
        if (!mapping) throw new Error("Every source column must have exactly one recipe mapping.");
        return mapping;
    });
}

function parseCreateInput(input: unknown) {
    const record = asRecord(input);
    if (!record) throw new Error("Recipe details are required.");
    const name = normalizeRecipeName(record.name);
    const goal = parseGoal(record.goal);
    const sourceType = parseSourceType(record.sourceType);
    if (!Array.isArray(record.sourceColumns)) throw new Error("At least one source column is required.");
    const originalColumns = record.sourceColumns.map((column, index) => {
        if (typeof column !== "string") throw new Error(`Source column ${index + 1} is invalid.`);
        return column;
    });
    const normalizedColumns = normalizeImportRecipeSourceColumns(originalColumns);
    const entityTypes = parseEntityTypes(record.entityTypes);
    const columnMappings = parseColumnMappings(record.columnMappings, originalColumns, normalizedColumns);

    return {
        name,
        goal,
        sourceType,
        normalizedHeaderSignature: buildImportRecipeHeaderSignature(sourceType, normalizedColumns),
        entityTypes,
        columnMappings,
    };
}

function safeStoredEntityTypes(value: Prisma.JsonValue): ImportEntityType[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ImportEntityType =>
        typeof item === "string" && IMPORT_ENTITY_TYPES.has(item as ImportEntityType)
    );
}

function safeStoredColumnMappings(value: Prisma.JsonValue): StoredColumnMapping[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        const record = asRecord(item);
        if (
            typeof record?.sourceColumn !== "string"
            || typeof record.targetField !== "string"
            || !IMPORT_TARGET_FIELD_SET.has(record.targetField)
        ) {
            return [];
        }
        return [{
            sourceColumn: record.sourceColumn,
            targetField: record.targetField as ImportTargetField,
        }];
    });
}

function toPublicRecipe(recipe: SelectedRecipe): PublicImportRecipe {
    const columnMappings = safeStoredColumnMappings(recipe.columnMappings);
    return {
        id: recipe.id,
        name: recipe.name,
        revision: recipe.revision,
        schemaVersion: recipe.schemaVersion,
        engineVersion: recipe.engineVersion,
        goal: recipe.goal,
        sourceType: recipe.sourceType,
        sourceFingerprint: recipe.normalizedHeaderSignature,
        sourceColumns: columnMappings.map(mapping => mapping.sourceColumn),
        entityTypes: safeStoredEntityTypes(recipe.entityTypes),
        columnMappings,
        useCount: recipe.useCount,
        lastUsedAt: recipe.lastUsedAt?.toISOString() ?? null,
        createdAt: recipe.createdAt.toISOString(),
        updatedAt: recipe.updatedAt.toISOString(),
    };
}

const RECIPE_SELECT = {
    id: true,
    name: true,
    revision: true,
    schemaVersion: true,
    engineVersion: true,
    goal: true,
    sourceType: true,
    normalizedHeaderSignature: true,
    entityTypes: true,
    columnMappings: true,
    useCount: true,
    lastUsedAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

async function organizationIdForAuthorizedBranch(userId: string, branchId: string) {
    await StaffService.authorize(userId, branchId, "students");
    const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: { organizationId: true },
    });
    if (!branch) throw new Error("Import resource not found");
    return branch.organizationId;
}

export class ImportRecipeService {
    static async listRecipes(userId: string, branchId: string) {
        const organizationId = await organizationIdForAuthorizedBranch(userId, branchId);
        const recipes = await prisma.importRecipe.findMany({
            where: { organizationId, archivedAt: null },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: MAX_IMPORT_RECIPES_PER_LIST,
            select: RECIPE_SELECT,
        });
        return recipes.map(toPublicRecipe);
    }

    static async createRecipe(userId: string, branchId: string, input: unknown) {
        const organizationId = await organizationIdForAuthorizedBranch(userId, branchId);
        await EntitlementService.assertBranchWritable(branchId);
        const recipeInput = parseCreateInput(input);

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const created = await prisma.$transaction(async transaction => {
                    const latest = await transaction.importRecipe.findFirst({
                        where: { organizationId, name: recipeInput.name },
                        orderBy: { revision: "desc" },
                        select: { revision: true },
                    });
                    return transaction.importRecipe.create({
                        data: {
                            organizationId,
                            branchId: null,
                            createdByUserId: userId,
                            name: recipeInput.name,
                            revision: (latest?.revision ?? 0) + 1,
                            schemaVersion: IMPORT_RECIPE_SCHEMA_VERSION,
                            engineVersion: IMPORT_ENGINE_VERSION,
                            goal: recipeInput.goal,
                            sourceType: recipeInput.sourceType,
                            normalizedHeaderSignature: recipeInput.normalizedHeaderSignature,
                            entityTypes: recipeInput.entityTypes,
                            columnMappings: recipeInput.columnMappings,
                        },
                        select: RECIPE_SELECT,
                    });
                }, {
                    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                });
                return toPublicRecipe(created);
            } catch (error) {
                if (!isRecipeWriteConflict(error)) throw error;
            }
        }
        throw new Error("The recipe changed while it was being saved. Please retry.");
    }

    static async deleteRecipe(userId: string, branchId: string, recipeId: string) {
        const organizationId = await organizationIdForAuthorizedBranch(userId, branchId);
        await EntitlementService.assertBranchWritable(branchId);
        const result = await prisma.importRecipe.updateMany({
            where: { id: recipeId, organizationId, archivedAt: null },
            data: { archivedAt: new Date() },
        });
        if (result.count === 0) throw new Error("Import recipe not found");
        return { deleted: true as const };
    }
}
