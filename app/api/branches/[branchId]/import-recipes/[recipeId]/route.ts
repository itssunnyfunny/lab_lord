import { NextResponse } from "next/server";
import { ImportRecipeService } from "@/importing/services/import-recipe.service";
import { toImportApiError } from "@/importing/http/import-api-error";
import { getSessionUser } from "@/lib/auth";

type Params = { params: Promise<{ branchId: string; recipeId: string }> };

export async function DELETE(_request: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, recipeId } = await params;
        return NextResponse.json(await ImportRecipeService.deleteRecipe(user.id, branchId, recipeId));
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to delete import recipe.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
