"use client";

import Link from "next/link";
import { AlertTriangle, Clock3, CreditCard } from "lucide-react";
import type { BillingExperience } from "@/types/billingExperience";

export function BillingBanner({ experience }: { experience: BillingExperience }) {
  if (experience.accessMode === "READ_ONLY") return null;
  const show = experience.effectivePlan === "STANDARD_TRIAL" || experience.accessMode === "WARNING" || experience.activeOperation;
  if (!show) return null;
  const Icon = experience.accessMode === "WARNING" ? AlertTriangle : experience.activeOperation ? CreditCard : Clock3;
  const billingHref = `/org/${encodeURIComponent(experience.organizationId)}/settings#billing`;
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-[var(--ui-radius-control)] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between" role="status">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div>
          <p className="font-semibold text-[color:var(--ui-text)]">{experience.customerMessage}</p>
          {experience.trialEndsAt && <p className="mt-0.5 text-xs text-[color:var(--ui-text-muted)]">Standard trial ends {new Date(experience.trialEndsAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}.</p>}
        </div>
      </div>
      {experience.viewer.canManageBilling && experience.paymentAction !== "NONE" && (
        <Link className="shrink-0 font-semibold text-amber-600 hover:underline" href={billingHref}>Manage billing</Link>
      )}
    </div>
  );
}
