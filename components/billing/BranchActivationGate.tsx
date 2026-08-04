"use client";

import Link from "next/link";
import { Archive, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useBillingExperience } from "@/components/billing/BillingExperienceProvider";
import { branches } from "@/lib/api/branches";
import { AppButton } from "@/components/ui";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function BranchActivationGate({ children }: { children: ReactNode }) {
  const billing = useBillingExperience();
  const router = useRouter();
  const [working, setWorking] = useState<"retry" | "discard" | "reactivate" | null>(null);
  const [error, setError] = useState("");
  const branch = billing?.experience?.branch;
  if (billing?.loading && !branch) return <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!branch || branch.billingStatus === "ACTIVE" || branch.billingStatus === "REMOVAL_SCHEDULED") return <>{children}</>;

  const owner = billing?.experience?.viewer.isOwner;
  const pending = branch.billingStatus === "PENDING_ACTIVATION";
  const perform = async (action: "retry" | "discard" | "reactivate") => {
    setWorking(action);
    setError("");
    try {
      if (action === "retry") {
        const result = await branches.retryPendingActivation(branch.id) as { processingUrl?: string };
        if (result.processingUrl) router.push(result.processingUrl);
      } else if (action === "discard") {
        await branches.discardPendingActivation(branch.id);
        await billing?.refresh();
      } else {
        const result = await branches.reactivate(branch.id) as { processingUrl?: string };
        if (result.processingUrl) router.push(result.processingUrl);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update branch billing");
    } finally {
      setWorking(null);
    }
  };
  return (
    <div className="mx-auto flex min-h-96 max-w-xl flex-col items-center justify-center gap-4 text-center">
      <Archive className="h-10 w-10 text-amber-500" />
      <div>
        <h1 className="text-xl font-bold text-[color:var(--ui-text)]">{pending ? "Branch activation is pending" : "This branch is archived"}</h1>
        <p className="mt-2 text-sm text-[color:var(--ui-text-muted)]">{pending ? "Operational changes stay blocked until Razorpay confirms the branch quantity update." : "Existing data remains readable. Reactivation requires a provider-confirmed quantity increase."}</p>
      </div>
      {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
      {owner && (
        <div className="flex flex-wrap justify-center gap-2">
          {pending ? (
            <>
              <AppButton isLoading={working === "retry"} onClick={() => perform("retry")}>Retry activation</AppButton>
              <AppButton variant="danger" isLoading={working === "discard"} onClick={() => perform("discard")}>Discard pending branch</AppButton>
            </>
          ) : (
            <AppButton isLoading={working === "reactivate"} onClick={() => perform("reactivate")}>Reactivate branch</AppButton>
          )}
          <Link className="inline-flex items-center px-2 font-semibold text-[color:var(--ui-accent)] hover:underline" href={`/org/${encodeURIComponent(billing!.experience!.organizationId)}/settings#billing`}>Open organization billing</Link>
        </div>
      )}
    </div>
  );
}
