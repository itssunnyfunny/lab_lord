"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, Loader2, RotateCcw } from "lucide-react";
import { billing, type BillingOperationDto } from "@/lib/api/billing";
import { AppButton, PageShell } from "@/components/ui";
import { Card } from "@/components/ui/Card";

const TERMINAL = new Set(["APPLIED", "DECLINED", "ABANDONED", "FAILED", "SCHEDULED"]);

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
  const [operation, setOperation] = useState<BillingOperationDto | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let stopped = false;
    let attempts = 0;

    const check = async () => {
      try {
        if (attempts === 0) await billing.reconcileOperation(orgId, changeId);
        const result = await billing.getOperation(orgId, changeId);
        if (stopped) return;
        setOperation(result.operation);
        setError("");
        attempts += 1;
        if (TERMINAL.has(result.operation.operationStatus)) return;
        if (attempts >= 30) {
          setTimedOut(true);
          return;
        }
        window.setTimeout(check, 2_000);
      } catch (requestError) {
        if (stopped) return;
        setError(requestError instanceof Error ? requestError.message : "Unable to check billing status");
      }
    };
    void check();
    return () => { stopped = true; };
  }, [changeId, orgId]);

  const content = useMemo(() => copyFor(operation, timedOut), [operation, timedOut]);
  const successful = operation?.operationStatus === "APPLIED" || operation?.operationStatus === "SCHEDULED";
  const failed = operation && ["DECLINED", "ABANDONED", "FAILED"].includes(operation.operationStatus);
  const returnPath = operation?.returnPath || `/org/${encodeURIComponent(orgId)}/settings#billing`;

  const retry = async () => {
    setRetrying(true);
    setError("");
    try {
      const result = await billing.retryOperation(orgId, changeId) as { operation?: BillingOperationDto; processingUrl?: string; changeId?: string };
      if (result.operation) setOperation(result.operation);
      if (result.changeId && result.processingUrl) window.location.assign(result.processingUrl);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to retry billing update");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <PageShell aria-label="Billing confirmation">
      <div>
        <h1 className="text-2xl font-bold text-[color:var(--ui-text)]">Billing confirmation</h1>
        <p className="text-sm text-[color:var(--ui-text-muted)]">Provider-confirmed subscription processing</p>
      </div>
      <Card className="mx-auto max-w-2xl" noHover>
        <div className="flex flex-col items-center gap-5 py-8 text-center">
          {successful ? <CheckCircle2 className="h-12 w-12 text-emerald-500" /> : failed ? <AlertCircle className="h-12 w-12 text-amber-500" /> : timedOut ? <Clock3 className="h-12 w-12 text-amber-500" /> : <Loader2 className="h-12 w-12 animate-spin text-[color:var(--ui-accent)]" />}
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-[color:var(--ui-text)]">{content.title}</h2>
            <p className="max-w-lg text-sm text-[color:var(--ui-text-muted)]">{content.body}</p>
          </div>
          {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
          <div className="flex flex-wrap justify-center gap-3">
            {failed && <AppButton icon={RotateCcw} isLoading={retrying} onClick={retry}>Retry safely</AppButton>}
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
