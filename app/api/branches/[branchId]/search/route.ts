import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
    BRANCH_SEARCH_TYPES,
    BranchSearchService,
    type BranchSearchType,
} from "@/services/branchSearch.service";

const SEARCH_TYPE_SET = new Set<string>(BRANCH_SEARCH_TYPES);

function isSearchType(value: string): value is BranchSearchType {
    return SEARCH_TYPE_SET.has(value);
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ branchId: string }> }
) {
    const session = await getSessionUser();
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { branchId } = await params;
        const url = new URL(request.url);
        const query = url.searchParams.get("q") ?? "";
        const requestedTypes = (url.searchParams.get("types") ?? "")
            .split(",")
            .map(value => value.trim())
            .filter(isSearchType);
        const parsedLimit = Number(url.searchParams.get("limit") ?? 5);
        const limit = Number.isFinite(parsedLimit)
            ? Math.max(1, Math.min(Math.trunc(parsedLimit), 10))
            : 5;

        const results = await BranchSearchService.search(session.id, branchId, query, {
            types: requestedTypes,
            limitPerGroup: limit,
        });

        return NextResponse.json(results, {
            headers: { "Cache-Control": "private, no-store" },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Search failed";
        const status = message.includes("not found")
            ? 404
            : message.includes("Unauthorized")
                ? 403
                : 500;
        return NextResponse.json(
            { error: status === 500 ? "Search is temporarily unavailable" : message },
            { status }
        );
    }
}
