"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { billing } from "@/lib/api/billing";
import { branches } from "@/lib/api/branches";
import type { BillingExperience } from "@/types/billingExperience";

type BillingExperienceContextValue = {
  experience: BillingExperience | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const BillingExperienceContext = createContext<BillingExperienceContextValue | null>(null);

export function BillingExperienceProvider({
  organizationId,
  branchId,
  children,
}: {
  organizationId?: string;
  branchId?: string;
  children: ReactNode;
}) {
  const [experience, setExperience] = useState<BillingExperience | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!organizationId && !branchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = branchId
        ? (await branches.getAccess(branchId)).billingExperience ?? null
        : (await billing.getOverview(organizationId!)).experience;
      setExperience(next);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load billing status");
    } finally {
      setLoading(false);
    }
  }, [branchId, organizationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo(() => ({ experience, loading, error, refresh }), [experience, loading, error, refresh]);
  return <BillingExperienceContext.Provider value={value}>{children}</BillingExperienceContext.Provider>;
}

export function useBillingExperience() {
  return useContext(BillingExperienceContext);
}
