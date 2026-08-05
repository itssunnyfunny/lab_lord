"use client";

import { useUser } from "@clerk/nextjs";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { organizations } from "@/lib/api/organizations";
import type { CheckoutBillingPlanId } from "@/lib/billingPlans";
import {
  getBillingOnboardingPath,
  getBillingSignUpPath,
  getOrganizationBillingPath,
} from "@/lib/billingFlow";
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

function LandingContent({ isLoaded, isSignedIn }: LandingContentProps) {
  const router = useRouter();
  const [isRedirecting, setIsRedirecting] = useState(false);

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
      router.push(getBillingSignUpPath(planId));
      return;
    }

    setIsRedirecting(true);

    try {
      const data = await organizations.getAll();

      if (data.length === 0) {
        router.push(getBillingOnboardingPath(planId));
      } else {
        router.push(getOrganizationBillingPath(data[0].id, planId));
      }
    } catch {
      router.push(getBillingOnboardingPath(planId));
    }
  }, [isLoaded, isSignedIn, router]);

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
