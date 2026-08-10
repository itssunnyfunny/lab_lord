"use client";

import Link from "next/link";
import { Archive, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useBillingExperience } from "@/components/billing/BillingExperienceProvider";
import { billing as billingApi, type BillingCheckoutPayload } from "@/lib/api/billing";
import {
  branches,
  resolveBranchBillingAction,
  type BranchBillingMutationResponse,
} from "@/lib/api/branches";
import { AppButton } from "@/components/ui";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  isRazorpayCheckoutPayload,
  isRazorpayCheckoutReady,
  openRazorpayCheckout,
  RazorpayCheckoutScript,
} from "@/components/billing/RazorpayCheckoutLauncher";

export function BranchActivationGate({ children }: { children: ReactNode }) {
  const billingContext = useBillingExperience();
  const router = useRouter();
  const [working, setWorking] = useState<"retry" | "discard" | "reactivate" | null>(null);
  const [error, setError] = useState("");
  const [checkoutScriptReady, setCheckoutScriptReady] = useState(
    () => isRazorpayCheckoutReady()
  );
  const branch = billingContext?.experience?.branch;
  if (billingContext?.loading && !branch) return <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!branch || branch.billingStatus === "ACTIVE" || branch.billingStatus === "REMOVAL_SCHEDULED") return <>{children}</>;

  const owner = billingContext?.experience?.viewer.isOwner;
  const organizationId = billingContext?.experience?.organizationId;
  const pending = branch.billingStatus === "PENDING_ACTIVATION";

  const launchCheckout = (checkout: BillingCheckoutPayload) => {
    if (!organizationId) throw new Error("Organization billing context is unavailable.");
    if (!checkoutScriptReady && !isRazorpayCheckoutReady()) {
      throw new Error("Razorpay Checkout is still loading. Please try again in a moment.");
    }
    openRazorpayCheckout({
      payload: checkout,
      mode: "AUTHORIZATION",
      verify: response => billingApi.verifySubscription(organizationId, {
        changeId: checkout.changeId,
        razorpay_subscription_id: response.razorpay_subscription_id ?? checkout.subscriptionId,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature,
      }),
      recordEvent: async checkoutResult => {
        await billingApi.recordCheckoutEvent(
          organizationId,
          checkout.changeId,
          checkoutResult.event,
          checkoutResult.failure
        );
      },
      navigate: processingUrl => router.push(processingUrl),
      onStateChange: state => {
        if (state === "ABANDONED" || state === "DECLINED" || state === "FAILED") {
          void billingContext?.refresh();
        }
      },
    });
  };

  const handleBillingResult = async (result: BranchBillingMutationResponse) => {
    const billingAction = resolveBranchBillingAction(result);
    if (
      billingAction === "CHECKOUT_REQUIRED"
      && result.checkout
      && isRazorpayCheckoutPayload(result.checkout)
    ) {
      launchCheckout(result.checkout);
    } else if (result.processingUrl) {
      router.push(result.processingUrl);
    } else {
      await billingContext?.refresh();
    }
  };

  const perform = async (action: "retry" | "discard" | "reactivate") => {
    setWorking(action);
    setError("");
    try {
      if (action === "retry") {
        const result = await branches.retryPendingActivation(branch.id);
        await handleBillingResult(result);
      } else if (action === "discard") {
        await branches.discardPendingActivation(branch.id);
        await billingContext?.refresh();
      } else {
        const result = await branches.reactivate(branch.id);
        await handleBillingResult(result);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update branch billing");
    } finally {
      setWorking(null);
    }
  };
  return (
    <div className="mx-auto flex min-h-96 max-w-xl flex-col items-center justify-center gap-4 text-center">
      <RazorpayCheckoutScript
        onReady={() => setCheckoutScriptReady(true)}
        onError={() => setCheckoutScriptReady(false)}
      />
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
          <Link className="inline-flex items-center px-2 font-semibold text-[color:var(--ui-accent)] hover:underline" href={`/org/${encodeURIComponent(organizationId!)}/settings#billing`}>Open organization billing</Link>
        </div>
      )}
    </div>
  );
}
