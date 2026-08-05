"use client";

import Link from "next/link";
import { LockKeyhole, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { BILLING_FEATURE_POLICIES, hasFeatureEntitlement, type BillingFeatureKey } from "@/lib/billingPolicy";
import type { BillingExperience } from "@/types/billingExperience";
import { usePathname } from "next/navigation";

export function FeatureUpgradeGate({
  feature,
  experience,
  children,
}: {
  feature: BillingFeatureKey;
  experience: BillingExperience | null | undefined;
  children: ReactNode;
}) {
  const pathname = usePathname();
  if (!experience || hasFeatureEntitlement(experience.entitlements, feature)) return <>{children}</>;
  const policy = BILLING_FEATURE_POLICIES[feature];
  const owner = experience.viewer.isOwner;
  const returnPath = pathname || `/org/${encodeURIComponent(experience.organizationId)}`;
  const upgradeHref = `/org/${encodeURIComponent(experience.organizationId)}/settings?billingPlan=PRO&returnTo=${encodeURIComponent(returnPath)}#billing`;

  return (
    <div className="mx-auto flex min-h-96 max-w-xl flex-col items-center justify-center gap-5 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-500">
        {owner ? <Sparkles className="h-5 w-5" /> : <LockKeyhole className="h-5 w-5" />}
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-amber-600">Standard feature</p>
        <h1 className="mt-2 text-xl font-bold text-[color:var(--ui-text)]">{policy.label}</h1>
        <p className="mt-2 text-sm text-[color:var(--ui-text-muted)]">{owner ? policy.benefit : "Your role allows this feature, but the organization owner needs to enable the Standard plan."}</p>
      </div>
      {owner ? (
        <div className="space-y-3">
          <p className="text-sm text-[color:var(--ui-text-muted)]">Standard: ₹499 × {experience.confirmedQuantity} branch{experience.confirmedQuantity === 1 ? "" : "es"} = ₹{experience.confirmedQuantity * 499}/month. Immediate upgrades may include a prorated charge.</p>
          <Link className="inline-flex h-10 items-center rounded-[var(--ui-radius-control)] bg-[color:var(--ui-button-primary-bg)] px-4 text-sm font-semibold text-[color:var(--ui-button-primary-text)]" href={upgradeHref}>Upgrade to Standard</Link>
        </div>
      ) : (
        <p className="text-sm font-semibold text-[color:var(--ui-text)]">Ask your organization owner to upgrade.</p>
      )}
    </div>
  );
}
