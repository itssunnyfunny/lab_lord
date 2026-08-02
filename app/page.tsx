"use client";

import { useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { organizations } from "@/lib/api/organizations";
import {
  isCheckoutBillingPlanId,
  type CheckoutBillingPlanId,
} from "@/lib/billingPlans";
import { trackEvent } from "@/lib/tracking";
import { LandingNavbar } from "@/components/landing/LandingNavbar";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingMockup } from "@/components/landing/LandingMockup";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingSoftware } from "@/components/landing/LandingSoftware";
import { LandingHowItWorks } from "@/components/landing/LandingHowItWorks";
import { LandingPricing } from "@/components/landing/LandingPricing";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { PageLoadingSkeleton } from "@/components/ui";
import { landingRootClass } from "@/components/ui/landingSurface";

type LandingContentProps = {
  isLoaded: boolean;
  isSignedIn: boolean;
};

const PENDING_BILLING_PLAN_KEY = "lab_lords_pending_billing_plan_v1";

function rememberPendingBillingPlan(planId: CheckoutBillingPlanId) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PENDING_BILLING_PLAN_KEY, planId);
}

function readPendingBillingPlan() {
  if (typeof window === "undefined") return null;
  const planId = window.localStorage.getItem(PENDING_BILLING_PLAN_KEY);
  if (isCheckoutBillingPlanId(planId)) return planId;
  window.localStorage.removeItem(PENDING_BILLING_PLAN_KEY);
  return null;
}

function clearPendingBillingPlan() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PENDING_BILLING_PLAN_KEY);
}

function LandingContent({ isLoaded, isSignedIn }: LandingContentProps) {
  const router = useRouter();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const pendingPlanHandledRef = useRef(false);

  const trackLandingClick = (source: string) => {
    trackEvent("landing_cta_clicked", {
      source,
      signed_in: isSignedIn,
    });
  };

  const handleSignInClick = (source = "landing_nav_sign_in") => {
    if (!isLoaded) return;
    trackLandingClick(source);
    router.push(isSignedIn ? "/app" : "/sign-in");
  };

  const handleWorkspaceClick = (source = "landing_cta") => {
    if (!isLoaded) return;
    trackLandingClick(source);
    clearPendingBillingPlan();

    if (!isSignedIn) {
      router.push("/sign-up");
      return;
    }

    setIsRedirecting(true);
    router.push("/app");
  };

  const handlePlanPurchase = useCallback(async (planId: CheckoutBillingPlanId, trackClick = true) => {
    if (!isLoaded) return;
    if (trackClick) {
      trackEvent("landing_cta_clicked", {
        source: `landing_pricing_${planId.toLowerCase()}`,
        signed_in: isSignedIn,
      });
    }

    if (!isSignedIn) {
      rememberPendingBillingPlan(planId);
      router.push("/sign-up");
      return;
    }

    setIsRedirecting(true);

    try {
      const data = await organizations.getAll();

      if (data.length === 0) {
        rememberPendingBillingPlan(planId);
        router.push(`/onboarding?plan=${planId}`);
      } else {
        clearPendingBillingPlan();
        router.push(`/org/${data[0].id}/settings?billingPlan=${planId}#billing`);
      }
    } catch {
      rememberPendingBillingPlan(planId);
      router.push(`/onboarding?plan=${planId}`);
    }
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || pendingPlanHandledRef.current) return;
    const pendingPlan = readPendingBillingPlan();
    if (!pendingPlan) return;
    pendingPlanHandledRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void handlePlanPurchase(pendingPlan, false);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [handlePlanPurchase, isLoaded, isSignedIn]);

  if (isRedirecting) {
    return <PageLoadingSkeleton label="Loading workspace" variant="workspace" />;
  }

  return (
    <main className={landingRootClass}>
      <LandingNavbar
        isSignedIn={isSignedIn}
        onSignInClick={handleSignInClick}
        onWorkspaceClick={handleWorkspaceClick}
      />
      <div className="overflow-hidden">
        <LandingHero
          isSignedIn={isSignedIn}
          onWorkspaceClick={handleWorkspaceClick}
        />
        <LandingMockup />
      </div>
      <LandingFeatures />
      <LandingSoftware />
      <LandingHowItWorks />
      <LandingPricing onPlanSelect={handlePlanPurchase} />
      <LandingFooter />
    </main>
  );
}

export default function RootPage() {
  const { isLoaded, isSignedIn } = useUser();
  return <LandingContent isLoaded={isLoaded} isSignedIn={isSignedIn ?? false} />;
}
