import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ImportQuestionService } from "@/importing/services/import-question.service";
import { parseExpectedImportRevision, readImportJson } from "@/importing/http/import-request";
import { toImportApiError } from "@/importing/http/import-api-error";

type Params = { params: Promise<{ branchId: string; sessionId: string }> };

export async function GET(_req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const questions = await ImportQuestionService.listQuestions(user.id, branchId, sessionId);
        return NextResponse.json(questions);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to list import questions.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}

export async function POST(req: Request, { params }: Params) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const { branchId, sessionId } = await params;
        const body = await readImportJson<{
            expectedRevision?: unknown;
            questionId?: unknown;
            answer?: unknown;
            applyToAffectedRows?: unknown;
        }>(req);
        const detail = await ImportQuestionService.answerQuestion(user.id, branchId, sessionId, {
            expectedRevision: parseExpectedImportRevision(body.expectedRevision),
            questionId: typeof body.questionId === "string" ? body.questionId : "",
            answer: body.answer,
            applyToAffectedRows: Boolean(body.applyToAffectedRows),
        });
        return NextResponse.json(detail);
    } catch (error) {
        const apiError = toImportApiError(error, "Failed to answer import question.");
        return NextResponse.json(apiError.body, { status: apiError.status });
    }
}
