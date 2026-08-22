import { NextResponse } from "next/server";
import { ImportRecipeService } from "@/importing/services/import-recipe.service";
import { toImportApiError } from "@/importing/http/import-api-error";
import { getSessionUser } from "@/lib/auth";

type Params = { params: Promise<{ branchId: string }> };

export async function GET(_request: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId } = await params;
        return NextResponse.json(await ImportRecipeService.listRecipes(user.id, branchId));
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to list import recipes.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}

export async function POST(request: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId } = await params;
        const input: unknown = await request.json();
        const recipe = await ImportRecipeService.createRecipe(user.id, branchId, input);
        return NextResponse.json(recipe, { status: 201 });
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to create import recipe.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
