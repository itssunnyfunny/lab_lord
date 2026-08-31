"use client";

import { useRef, useState } from "react";
import { PauseCircle, PlayCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formErrorBannerClass, formSuccessBannerClass, formWarningBannerClass } from "@/components/ui/formSurface";
import { pageInsetMetricClass } from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";

export type WhatsAppSenderPauseReason =
  | "AMBIGUOUS_OUTCOME_BURST"
  | "DEFINITE_FAILURE_BURST"
  | "PROVIDER_RESTRICTED"
  | "RATE_CARD_EXPIRED"
  | "OWNER_PAUSED"
  | "OPERATOR_PAUSED";
export type WhatsAppRateCardState = "CURRENT" | "EXPIRING" | "EXPIRED" | "UNAVAILABLE";
export type WhatsAppResumeBlocker =
  | "PAUSE_DRAINING"
  | "SENDER_NOT_ACTIVE"
  | "RATE_CARD_NOT_CURRENT"
  | "HEALTH_RECONCILIATION_STALE"
  | "PROVIDER_RESTRICTED"
  | "TEMPLATES_UNHEALTHY"
  | "CRITICAL_INCIDENT_OPEN";

export interface WhatsAppSenderSafetyView {
  senderLabel: string;
  senderStatus: "ACTIVE" | "INACTIVE" | "RESTRICTED" | "UNKNOWN";
  paused: boolean;
  pausePending: boolean;
  pauseReason: WhatsAppSenderPauseReason | null;
  pausedAt: string | null;
  pauseRequestedAt: string | null;
  pauseRevision: number;
  ambiguousOutcomeCount: number;
  ambiguousWindowStartedAt: string | null;
  definiteFailureCount: number;
  failureWindowStartedAt: string | null;
  unknownOutcomeCount: number;
  openCriticalIncidentCount: number;
  lastAcceptedAt: string | null;
  lastDeliveredAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthyAt: string | null;
  providerRestricted: boolean;
  templatesHealthy: boolean;
  rateCardState: WhatsAppRateCardState;
  rateCardVersion: string | null;
  rateCardExpiresAt: string | null;
  resumeEligible: boolean;
  resumeBlockers: readonly WhatsAppResumeBlocker[];
}

export interface WhatsAppSenderSafetyProps {
  safety: WhatsAppSenderSafetyView;
  isOwner: boolean;
  blockedReason?: string;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

const PAUSE_REASON_LABELS: Record<WhatsAppSenderPauseReason, string> = {
  AMBIGUOUS_OUTCOME_BURST: "Ambiguous outcome burst",
  DEFINITE_FAILURE_BURST: "Definite provider/system failure burst",
  PROVIDER_RESTRICTED: "Provider restriction",
  RATE_CARD_EXPIRED: "Rate card expired",
  OWNER_PAUSED: "Paused by organization owner",
  OPERATOR_PAUSED: "Paused by operator",
};

const RESUME_BLOCKER_LABELS: Record<WhatsAppResumeBlocker, string> = {
  PAUSE_DRAINING: "An already-admitted provider call is still draining",
  SENDER_NOT_ACTIVE: "Sender is not active",
  RATE_CARD_NOT_CURRENT: "Current, nonexpired rate card is required",
  HEALTH_RECONCILIATION_STALE: "Recent successful health reconciliation is required",
  PROVIDER_RESTRICTED: "Provider restriction remains active",
  TEMPLATES_UNHEALTHY: "Required Utility templates are not healthy",
  CRITICAL_INCIDENT_OPEN: "An active critical incident still prevents resume",
};

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-IN");
}

function rateVariant(state: WhatsAppRateCardState) {
  if (state === "CURRENT") return "success" as const;
  if (state === "EXPIRING") return "warning" as const;
  return "danger" as const;
}

export function WhatsAppSenderSafety({
  safety,
  isOwner,
  blockedReason,
  onPause,
  onResume,
  onRefresh,
}: WhatsAppSenderSafetyProps) {
  const [pauseOpen, setPauseOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [busy, setBusy] = useState<"pause" | "resume" | "refresh" | null>(null);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);

  const run = async (action: "pause" | "resume" | "refresh", operation: () => Promise<void>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(action);
    setNotice(null);
    try {
      await operation();
      if (action === "pause") {
        setPauseOpen(false);
        setNotice({ tone: "status", text: "The local pause gate is active. New provider calls are blocked; any already-admitted bounded call is draining." });
      } else if (action === "resume") {
        setResumeOpen(false);
        setNotice({ tone: "status", text: "Sender delivery resumed. Incidents and history remain preserved; unknown messages were not retried." });
      } else {
        setNotice({ tone: "status", text: "Sender safety and readiness evidence refreshed." });
      }
    } catch {
      setNotice({ tone: "error", text: "The sender safety operation could not be completed. Delivery state should be treated as unchanged." });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  return (
    <AppPanel
      title="Sender delivery safety"
      description="Local circuit breaking stops provider calls when delivery truth or provider health is unsafe. Thresholds are fixed server-side and cannot be changed here."
      action={<Badge variant={safety.paused ? "danger" : "success"}>{safety.pausePending ? "Pause draining" : safety.paused ? "Delivery paused" : "Delivery active"}</Badge>}
      contentClassName="space-y-4"
    >
      {!isOwner ? <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)} role="status">{blockedReason || "Only the organization owner can pause or resume sender delivery."}</div> : null}
      {notice ? <p className={cn("px-3 py-2 text-sm", notice.tone === "error" ? formErrorBannerClass : formSuccessBannerClass)} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>{notice.text}</p> : null}

      {safety.pausePending ? (
        <div className={cn("flex items-start gap-3 p-4", formWarningBannerClass)} role="status">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div><p className="font-semibold">Pause requested for {safety.senderLabel}</p><p className="mt-1 text-sm">New provider calls are blocked. An already-admitted bounded call is still draining; full pause will be recorded automatically. Requested {formatDateTime(safety.pauseRequestedAt)}.</p></div>
        </div>
      ) : safety.paused ? (
        <div className={cn("flex items-start gap-3 p-4", formWarningBannerClass)} role="status">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div><p className="font-semibold">Provider delivery is paused for {safety.senderLabel}</p><p className="mt-1 text-sm">Reason: {safety.pauseReason ? PAUSE_REASON_LABELS[safety.pauseReason] : "Safety state unavailable"}. Paused {formatDateTime(safety.pausedAt)}.</p></div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Sender status</p><p className="mt-1 font-semibold">{safety.senderStatus}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Ambiguous outcomes in window</p><p className="mt-1 font-semibold">{safety.ambiguousOutcomeCount} / 3</p><p className="mt-1 text-xs text-[color:var(--text-muted)]">10-minute fixed window</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Selected definite failures</p><p className="mt-1 font-semibold">{safety.definiteFailureCount} / 10</p><p className="mt-1 text-xs text-[color:var(--text-muted)]">10-minute fixed window</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Unknown / critical</p><p className="mt-1 font-semibold">{safety.unknownOutcomeCount} / {safety.openCriticalIncidentCount}</p></div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Last accepted</p><p className="mt-1 text-sm font-medium">{formatDateTime(safety.lastAcceptedAt)}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Last delivered</p><p className="mt-1 text-sm font-medium">{formatDateTime(safety.lastDeliveredAt)}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Last health check</p><p className="mt-1 text-sm font-medium">{formatDateTime(safety.lastHealthCheckAt)}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Last healthy</p><p className="mt-1 text-sm font-medium">{formatDateTime(safety.lastHealthyAt)}</p></div>
      </div>

      <section className="space-y-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-section-divider)] p-4" aria-labelledby="sender-rate-card-heading">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="sender-rate-card-heading" className="font-semibold">Rate-card and resume readiness</h3><Badge variant={rateVariant(safety.rateCardState)}>{safety.rateCardState}</Badge></div>
        <p className="text-sm text-[color:var(--text-secondary)]">Rate card {safety.rateCardVersion || "unavailable"} · expires {formatDateTime(safety.rateCardExpiresAt)}. Meta determines final billing and category; configured rates are estimates used for reservation safety.</p>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          <li>Provider unrestricted: {safety.providerRestricted ? "No" : "Yes"}</li>
          <li>Required Utility templates healthy: {safety.templatesHealthy ? "Yes" : "No"}</li>
        </ul>
        {safety.resumeBlockers.length > 0 ? <div className={cn("px-3 py-3 text-sm", formWarningBannerClass)}><p className="font-medium">Resume is blocked:</p><ul className="mt-2 list-disc space-y-1 pl-5">{safety.resumeBlockers.map(blocker => <li key={blocker}>{RESUME_BLOCKER_LABELS[blocker]}</li>)}</ul></div> : null}
      </section>

      {safety.unknownOutcomeCount > 0 ? <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)} role="status"><strong>Unknown delivery warning:</strong> do not retry ambiguous messages. Pause/resume never resends them automatically.</div> : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <AppButton variant="secondary" size="sm" icon={RefreshCw} onClick={() => void run("refresh", onRefresh)} disabled={busy !== null} isLoading={busy === "refresh"}>Refresh readiness</AppButton>
        {isOwner && !safety.paused ? <AppButton variant="danger" size="sm" icon={PauseCircle} onClick={() => setPauseOpen(true)} disabled={busy !== null}>Pause sender delivery</AppButton> : null}
        {isOwner && safety.paused && !safety.pausePending ? <AppButton variant="primary" size="sm" icon={PlayCircle} onClick={() => setResumeOpen(true)} disabled={!safety.resumeEligible || busy !== null}>Resume sender delivery</AppButton> : null}
      </div>

      <ConfirmDialog isOpen={pauseOpen} onClose={() => setPauseOpen(false)} onConfirm={() => run("pause", onPause)} title="Pause sender delivery?" description="This immediately blocks new provider delivery calls for this sender in Lab Lords. It preserves messages, incidents, history, and provider configuration." confirmText="Pause delivery" loading={busy === "pause"} variant="danger" />
      <ConfirmDialog isOpen={resumeOpen} onClose={() => setResumeOpen(false)} onConfirm={() => run("resume", onResume)} title="Resume sender delivery?" description={<span className="space-y-2"><span className="block">I confirm the sender is active, the rate card is current, health reconciliation is recent, provider restrictions are clear, Utility templates are healthy, and no critical condition blocks resume.</span><span className="block font-medium">Resume preserves incidents and does not retry unknown messages.</span></span>} confirmText="Confirm safe resume" loading={busy === "resume"} variant="warning" />
    </AppPanel>
  );
}
