import { createImportRequestHash } from "./import-plan-compiler";

export function createImportAnalysisRunIdentity(input: {
    branchId: string;
    sessionId: string;
    targetRevision: number;
}) {
    if (!input.branchId.trim() || !input.sessionId.trim()) {
        throw new Error("Import analysis run identity is invalid");
    }
    if (!Number.isInteger(input.targetRevision) || input.targetRevision < 0) {
        throw new Error("Import analysis target revision is invalid");
    }
    return {
        idempotencyKey: `analysis:${input.sessionId}:${input.targetRevision}`,
        requestHash: createImportRequestHash({
            kind: "ANALYSIS",
            branchId: input.branchId,
            sessionId: input.sessionId,
            importPlanId: null,
            confirmedPlanVersion: null,
            targetRevision: input.targetRevision,
        }),
    };
}
