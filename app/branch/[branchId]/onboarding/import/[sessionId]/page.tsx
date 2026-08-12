"use client";

import { use } from "react";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import { ImportSessionWizard } from "./_components/ImportSessionWizard";

export default function ImportSessionPage({ params }: { params: Promise<{ branchId: string; sessionId: string }> }) {
    const { branchId, sessionId } = use(params);

    return (
        <BranchAccessGuard branchId={branchId} permission="students">
            {access => (
                <ImportSessionWizard
                    branchId={branchId}
                    sessionId={sessionId}
                    importDecision={getBranchCapabilityDecision(access, "importStudents")}
                />
            )}
        </BranchAccessGuard>
    );
}
