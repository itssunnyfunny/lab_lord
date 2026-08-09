"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Clock3, Loader2, RotateCcw } from "lucide-react";
import { billing, type BillingOperationDto } from "@/lib/api/billing";
import {
  isRazorpayCheckoutPayload,
  isRazorpayCheckoutReady,
  openRazorpayCheckout,
  RazorpayCheckoutScript,
  type RazorpayCheckoutEventResult,
} from "@/components/billing/RazorpayCheckoutLauncher";
import { AppButton, PageShell } from "@/components/ui";
import { Card } from "@/components/ui/Card";

const PROVIDER_CONFIRMED = new Set<BillingOperationDto["operationStatus"]>(["APPLIED", "SCHEDULED"]);
const TERMINAL_OPERATION_STATUSES = new Set<BillingOperationDto["operationStatus"]>([
  "APPLIED",
  "SCHEDULED",
  "ABANDONED",
  "DECLINED",
  "FAILED",
]);
const POLL_INTERVAL_MS = 2_000;
const RECONCILE_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 30;

export type ProcessingReconcileGate = {
  key: string;
  nextAllowedAt: number;
  inFlight: Promise<unknown> | null;
};

export function reconcileWithCooldown(
  gate: ProcessingReconcileGate,
  key: string,
  reconcile: () => Promise<unknown>,
  now = Date.now()
) {
  if (gate.key !== key) {
    gate.key = key;
    gate.nextAllowedAt = 0;
    gate.inFlight = null;
  }
  if (gate.inFlight) return gate.inFlight;
  if (now < gate.nextAllowedAt) return Promise.resolve();

  gate.nextAllowedAt = now + RECONCILE_INTERVAL_MS;
  const request = Promise.resolve().then(reconcile);
  gate.inFlight = request;
  return request.finally(() => {
    if (gate.inFlight === request) gate.inFlight = null;
  });
}

export function preferProviderConfirmedOperation(
  current: BillingOperationDto | null,
  incoming: BillingOperationDto
) {
  if (!current) return incoming;
  if (PROVIDER_CONFIRMED.has(current.operationStatus) && !PROVIDER_CONFIRMED.has(incoming.operationStatus)) {
    return current;
  }
  if (
    TERMINAL_OPERATION_STATUSES.has(current.operationStatus)
    && !TERMINAL_OPERATION_STATUSES.has(incoming.operationStatus)
  ) {
    return current;
  }
  return incoming;
}

export function isBillingOperationTerminal(status: BillingOperationDto["operationStatus"]) {
  return TERMINAL_OPERATION_STATUSES.has(status);
}

function copyFor(operation: BillingOperationDto | null, timedOut: boolean) {
  if (!operation) return { title: "Checking your billing update", body: "We are securely checking Razorpay for confirmation." };
  if (operation.operationStatus === "APPLIED") return { title: "Billing update confirmed", body: "Your account now reflects the provider-confirmed change." };
  if (operation.operationStatus === "SCHEDULED") return { title: "Change scheduled", body: "Your current access stays in place until the effective date shown in billing settings." };
  if (operation.operationStatus === "ABANDONED") return { title: "Payment was not completed", body: "Your current plan or trial has not been changed." };
  if (operation.operationStatus === "DECLINED") return { title: "Authorization was not confirmed", body: "You can retry with a supported card. Check your bank statement before retrying if the provider response was unclear." };
  if (operation.operationStatus === "FAILED") return { title: "We could not apply the billing update", body: operation.message || "Your existing access remains unchanged. You can safely retry." };
  if (timedOut) return { title: "Confirmation is taking longer than usual", body: "You can leave this page. We will keep reconciling the provider state and show the result in billing settings." };
  return { title: "Verifying with Razorpay", body: "Keep this page open while we confirm the subscription, payment, and paid period." };
}

export default function BillingProcessingPage({ params }: { params: Promise<{ orgId: string; changeId: string }> }) {
  const { orgId, changeId } = use(params);
  const router = useRouter();
  const [operation, setOperation] = useState<BillingOperationDto | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const [pollGeneration, setPollGeneration] = useState(0);
  const [checkoutReady, setCheckoutReady] = useState(() => isRazorpayCheckoutReady());
  const operationKey = `${orgId}:${changeId}`;
  const operationRef = useRef<{ key: string; value: BillingOperationDto | null }>({
    key: operationKey,
    value: null,
  });
  const reconcileGateRef = useRef<ProcessingReconcileGate>({ key: "", nextAllowedAt: 0, inFlight: null });

  const applyOperation = useCallback((incoming: BillingOperationDto) => {
    if (operationRef.current.key !== operationKey) {
      operationRef.current = { key: operationKey, value: null };
    }
    const preferred = preferProviderConfirmedOperation(operationRef.current.value, incoming);
    operationRef.current.value = preferred;
    setOperation(preferred);
    return preferred;
  }, [operationKey]);

  const reconcileIfDue = useCallback(async () => {
    await reconcileWithCooldown(
      reconcileGateRef.current,
      operationKey,
      () => billing.reconcileOperation(orgId, changeId)
    );
  }, [changeId, operationKey, orgId]);

  useEffect(() => {
    let stopped = false;
    let attempts = 0;
    let timer: number | undefined;

    const check = async () => {
      let preferred: BillingOperationDto;
      try {
        const current = await billing.getOperation(orgId, changeId);
        if (stopped) return;
        preferred = applyOperation(current.operation);
        if (isBillingOperationTerminal(preferred.operationStatus)) {
          setError("");
          return;
        }
      } catch (requestError) {
        if (stopped) return;
        setError(requestError instanceof Error ? requestError.message : "Unable to check billing status");
        attempts += 1;
        if (attempts >= MAX_POLL_ATTEMPTS) {
          setTimedOut(true);
          return;
        }
        timer = window.setTimeout(check, POLL_INTERVAL_MS);
        return;
      }

      let reconciliationError = "";
      try {
        await reconcileIfDue();
      } catch (requestError) {
        reconciliationError = requestError instanceof Error
          ? requestError.message
          : "Razorpay confirmation is temporarily unavailable";
      }

      if (stopped) return;

      try {
        const result = await billing.getOperation(orgId, changeId);
        if (stopped) return;
        preferred = applyOperation(result.operation);
        setError(reconciliationError);
        attempts += 1;
        if (isBillingOperationTerminal(preferred.operationStatus)) return;
        if (attempts >= MAX_POLL_ATTEMPTS) {
          setTimedOut(true);
          return;
        }
        timer = window.setTimeout(check, POLL_INTERVAL_MS);
      } catch (requestError) {
        if (stopped) return;
        setError(requestError instanceof Error ? requestError.message : "Unable to check billing status");
        attempts += 1;
        if (attempts >= MAX_POLL_ATTEMPTS) {
          setTimedOut(true);
          return;
        }
        timer = window.setTimeout(check, POLL_INTERVAL_MS);
      }
    };
    void check();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyOperation, changeId, orgId, pollGeneration, reconcileIfDue]);

  const content = useMemo(() => copyFor(operation, timedOut), [operation, timedOut]);
  const successful = operation?.operationStatus === "APPLIED" || operation?.operationStatus === "SCHEDULED";
  const failed = operation && ["DECLINED", "ABANDONED", "FAILED"].includes(operation.operationStatus);
  const returnPath = operation?.returnPath || `/org/${encodeURIComponent(orgId)}/settings#billing`;

  const retry = async () => {
    if (operation?.type === "SUBSCRIPTION_AUTHORIZATION" && !checkoutReady) {
      setError("Razorpay Checkout is still loading. Please wait a moment and try again.");
      return;
    }
    setRetrying(true);
    setError("");
    try {
      const result = await billing.retryOperation(orgId, changeId) as {
        operation?: BillingOperationDto;
        processingUrl?: string;
        changeId?: string;
      };
      if (result.operation) applyOperation(result.operation);
      if (isRazorpayCheckoutPayload(result)) {
        openRazorpayCheckout({
          payload: result,
          mode: result.subscription_card_change ? "RECOVERY" : "AUTHORIZATION",
          verify: (response) => billing.verifySubscription(orgId, {
            changeId: result.changeId,
            razorpay_subscription_id: response.razorpay_subscription_id ?? result.subscriptionId,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          }),
          recordEvent: async (checkoutResult: RazorpayCheckoutEventResult) => {
            await billing.recordCheckoutEvent(
              orgId,
              result.changeId,
              checkoutResult.event,
              checkoutResult.failure
            );
          },
          navigate: (processingUrl) => {
            router.replace(processingUrl);
            setTimedOut(false);
            setPollGeneration((current) => current + 1);
          },
          onStateChange: (state) => {
            if (["ABANDONED", "DECLINED", "FAILED"].includes(state)) {
              setTimedOut(false);
              setPollGeneration((current) => current + 1);
            }
          },
          onVerificationError: () => setError(""),
        });
        return;
      }

      // Provider-native updates do not use Checkout. Poll this operation again
      // instead of navigating back to the page that is already open.
      setTimedOut(false);
      setPollGeneration((current) => current + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to retry billing update");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <PageShell aria-label="Billing confirmation">
      <RazorpayCheckoutScript
        onReady={() => setCheckoutReady(true)}
        onError={() => setError("Razorpay Checkout could not be loaded. Check your connection and try again.")}
      />
      <div>
        <h1 className="text-2xl font-bold text-[color:var(--ui-text)]">Billing confirmation</h1>
        <p className="text-sm text-[color:var(--ui-text-muted)]">Provider-confirmed subscription processing</p>
      </div>
      <Card className="mx-auto max-w-2xl" noHover>
        <div
          className="flex flex-col items-center gap-5 py-8 text-center"
          aria-busy={!successful && !failed && !timedOut}
        >
          {successful ? <CheckCircle2 className="h-12 w-12 text-emerald-500" /> : failed ? <AlertCircle className="h-12 w-12 text-amber-500" /> : timedOut ? <Clock3 className="h-12 w-12 text-amber-500" /> : <Loader2 className="h-12 w-12 animate-spin text-[color:var(--ui-accent)]" />}
          <div className="space-y-2" role="status" aria-live="polite" aria-atomic="true">
            <h2 className="text-xl font-bold text-[color:var(--ui-text)]">{content.title}</h2>
            <p className="max-w-lg text-sm text-[color:var(--ui-text-muted)]">{content.body}</p>
          </div>
          {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
          <div className="flex flex-wrap justify-center gap-3">
            {failed && (
              <AppButton
                icon={RotateCcw}
                isLoading={retrying}
                disabled={operation.type === "SUBSCRIPTION_AUTHORIZATION" && !checkoutReady}
                onClick={retry}
              >
                {operation.type === "SUBSCRIPTION_AUTHORIZATION" && !checkoutReady ? "Loading secure checkout..." : "Retry safely"}
              </AppButton>
            )}
            {(successful || failed || timedOut) && (
              <Link className="inline-flex h-10 items-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] px-3 text-sm font-semibold text-[color:var(--ui-text)]" href={returnPath}>
                Continue
              </Link>
            )}
          </div>
        </div>
      </Card>
    </PageShell>
  );
}
