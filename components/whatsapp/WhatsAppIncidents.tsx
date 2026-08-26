"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, History, ShieldAlert } from "lucide-react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { formErrorBannerClass, formSuccessBannerClass, formWarningBannerClass } from "@/components/ui/formSurface";
import { pageInsetSurfaceClass } from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";
import type { WhatsAppIncidentListResponse } from "@/lib/api/whatsapp";

export type WhatsAppOperationalIncidentType =
  | "UNKNOWN_DELIVERY"
  | "SENDER_RESTRICTED"
  | "TEMPLATE_UNAVAILABLE"
  | "WEBHOOK_STALE"
  | "PLANNER_STALE"
  | "DISPATCH_BACKLOG"
  | "RATE_CARD_EXPIRED"
  | "REPORT_FAILURE"
  | "CIRCUIT_BREAKER_OPEN";
export type WhatsAppOperationalIncidentStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export type WhatsAppOperationalIncidentSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface WhatsAppOperationalIncidentView {
  id: string;
  type: WhatsAppOperationalIncidentType;
  status: WhatsAppOperationalIncidentStatus;
  severity: WhatsAppOperationalIncidentSeverity;
  scopeLabel: string;
  senderLabel: string | null;
  safeCode: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface WhatsAppUnknownOutcomeView {
  id: string;
  scopeLabel: string;
  purpose: "COLLECTION" | "BRANCH_REPORT" | "ORGANIZATION_REPORT" | "SERVICE_NOTICE";
  maskedPhone: string;
  senderLabel: string | null;
  safeFailureCode: string;
  scheduledFor: string;
  submissionStartedAt: string;
  estimatedCostMicros: string;
  laterTrustedStatusAt: string | null;
}

export interface WhatsAppIncidentsProps {
  incidents: readonly WhatsAppOperationalIncidentView[];
  unknownOutcomes: readonly WhatsAppUnknownOutcomeView[];
  canAcknowledge: boolean;
  blockedReason?: string;
  nextCursor: string | null;
  loadingMore?: boolean;
  onAcknowledge: (incidentId: string) => Promise<void>;
  onLoadMore?: (cursor: string) => Promise<void>;
}

const TYPE_LABELS: Record<WhatsAppOperationalIncidentType, string> = {
  UNKNOWN_DELIVERY: "Unknown delivery outcome",
  SENDER_RESTRICTED: "Sender restricted",
  TEMPLATE_UNAVAILABLE: "Utility template unavailable",
  WEBHOOK_STALE: "Webhook evidence stale",
  PLANNER_STALE: "Report planner stale",
  DISPATCH_BACKLOG: "Dispatch backlog",
  RATE_CARD_EXPIRED: "Rate card expired",
  REPORT_FAILURE: "Daily report failure",
  CIRCUIT_BREAKER_OPEN: "Sender circuit breaker open",
};

const PURPOSE_LABELS: Record<WhatsAppUnknownOutcomeView["purpose"], string> = {
  COLLECTION: "Collection message",
  BRANCH_REPORT: "Branch daily report",
  ORGANIZATION_REPORT: "Organization daily report",
  SERVICE_NOTICE: "Operational service notice",
};

function presentUnknownPurpose(purpose: string): WhatsAppUnknownOutcomeView["purpose"] {
  if (purpose === "DAILY_BRANCH_REPORT") return "BRANCH_REPORT";
  if (purpose === "DAILY_ORGANIZATION_REPORT") return "ORGANIZATION_REPORT";
  if (purpose === "SERVICE_NOTICE") return "SERVICE_NOTICE";
  return "COLLECTION";
}

export function presentWhatsAppIncidentResponse(
  response: WhatsAppIncidentListResponse,
  context: {
    scopeLabel: string;
    senderLabels?: Readonly<Record<string, string>>;
  }
) {
  return {
    incidents: response.incidents.map(incident => ({
      id: incident.id,
      type: incident.type,
      status: incident.status,
      severity: incident.severity,
      scopeLabel: context.scopeLabel,
      senderLabel: incident.senderId
        ? context.senderLabels?.[incident.senderId] ?? null
        : null,
      safeCode: incident.safeCode,
      occurrenceCount: incident.occurrenceCount,
      firstSeenAt: incident.firstSeenAt,
      lastSeenAt: incident.lastSeenAt,
      acknowledgedAt: incident.acknowledgedAt,
      resolvedAt: incident.resolvedAt,
    })),
    unknownOutcomes: response.unknownMessages.map(message => ({
      id: message.id,
      scopeLabel: context.scopeLabel,
      purpose: presentUnknownPurpose(message.purpose),
      maskedPhone: message.maskedRecipient,
      senderLabel: context.senderLabels?.[message.senderId] ?? null,
      safeFailureCode: "META_MUTATION_OUTCOME_UNKNOWN",
      scheduledFor: message.scheduledFor,
      submissionStartedAt: message.submissionStartedAt ?? message.scheduledFor,
      estimatedCostMicros: message.estimatedCostMicros ?? "",
      laterTrustedStatusAt: message.laterWebhookArrived
        ? message.providerStatusTimestamp
        : null,
    })),
  } satisfies {
    incidents: WhatsAppOperationalIncidentView[];
    unknownOutcomes: WhatsAppUnknownOutcomeView[];
  };
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-IN");
}

function estimatedInr(value: string) {
  if (!/^\d+$/.test(value)) return "Unavailable";
  const amount = Number(value) / 1_000_000;
  return Number.isFinite(amount) ? `₹${amount.toFixed(4)}` : "Unavailable";
}

function severityVariant(severity: WhatsAppOperationalIncidentSeverity) {
  if (severity === "CRITICAL") return "danger" as const;
  if (severity === "WARNING") return "warning" as const;
  return "default" as const;
}

function statusVariant(status: WhatsAppOperationalIncidentStatus) {
  if (status === "RESOLVED") return "success" as const;
  if (status === "ACKNOWLEDGED") return "cyan" as const;
  return "warning" as const;
}

export function WhatsAppUnknownOutcomeList({
  items,
}: {
  items: readonly WhatsAppUnknownOutcomeView[];
}) {
  if (items.length === 0) {
    return <p className="text-sm text-[color:var(--text-muted)]">No ambiguous delivery outcomes require review.</p>;
  }

  return (
    <ul className="grid gap-3">
      {items.map(item => (
        <li key={item.id} className={cn("space-y-3 p-4", formWarningBannerClass)}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{PURPOSE_LABELS[item.purpose]}</p>
              <p className="mt-1 text-xs">{item.scopeLabel} · {item.maskedPhone} · {item.senderLabel || "Sender unavailable"}</p>
            </div>
            <Badge variant="danger">Unknown</Badge>
          </div>
          <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-[color:var(--text-muted)]">Submission began</dt><dd className="mt-1 font-medium">{formatDateTime(item.submissionStartedAt)}</dd></div>
            <div><dt className="text-[color:var(--text-muted)]">Scheduled</dt><dd className="mt-1 font-medium">{formatDateTime(item.scheduledFor)}</dd></div>
            <div><dt className="text-[color:var(--text-muted)]">Safe code</dt><dd className="mt-1 font-medium">{item.safeFailureCode}</dd></div>
            <div><dt className="text-[color:var(--text-muted)]">Estimated Meta usage</dt><dd className="mt-1 font-medium">{estimatedInr(item.estimatedCostMicros)}</dd></div>
          </dl>
          <p className="flex items-start gap-2 text-sm font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Do not retry. The provider may already have accepted this message, so retrying could send a duplicate. Wait for trusted webhook or reconciliation evidence.</span>
          </p>
          {item.laterTrustedStatusAt ? <p className="text-xs">Later trusted provider status received {formatDateTime(item.laterTrustedStatusAt)}.</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function WhatsAppIncidents({
  incidents,
  unknownOutcomes,
  canAcknowledge,
  blockedReason,
  nextCursor,
  loadingMore = false,
  onAcknowledge,
  onLoadMore,
}: WhatsAppIncidentsProps) {
  const [busyIncidentId, setBusyIncidentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);

  const acknowledge = async (incidentId: string) => {
    if (operationRef.current || !canAcknowledge) return;
    operationRef.current = true;
    setBusyIncidentId(incidentId);
    setNotice(null);
    try {
      await onAcknowledge(incidentId);
      setNotice({ tone: "status", text: "Incident acknowledged. Acknowledgement does not resolve or retry the underlying condition." });
    } catch {
      setNotice({ tone: "error", text: "The incident could not be acknowledged or is no longer available in this scope." });
    } finally {
      operationRef.current = false;
      setBusyIncidentId(null);
    }
  };

  const loadMore = async () => {
    if (operationRef.current || !nextCursor || !onLoadMore) return;
    operationRef.current = true;
    setNotice(null);
    try {
      await onLoadMore(nextCursor);
    } catch {
      setNotice({ tone: "error", text: "More incidents could not be loaded." });
    } finally {
      operationRef.current = false;
    }
  };

  return (
    <div className="space-y-4">
      <AppPanel
        title="Operational incidents"
        description="Tenant-scoped, bounded operational evidence. Details intentionally exclude phone numbers, names, message bodies, provider payloads, and secrets."
        action={<Badge variant={incidents.some(item => item.status === "OPEN") ? "warning" : "success"}>{incidents.filter(item => item.status === "OPEN").length} open</Badge>}
        contentClassName="space-y-4"
      >
        {!canAcknowledge && blockedReason ? <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)} role="status">{blockedReason}</div> : null}
        {notice ? <p className={cn("px-3 py-2 text-sm", notice.tone === "error" ? formErrorBannerClass : formSuccessBannerClass)} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>{notice.text}</p> : null}

        {incidents.length === 0 ? <p className="text-sm text-[color:var(--text-muted)]">No operational incidents in this scope.</p> : (
          <ul className="grid gap-3">
            {incidents.map(item => (
              <li key={item.id} className={cn("space-y-3 p-4", pageInsetSurfaceClass)}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--ui-form-warning-text)]" aria-hidden="true" />
                    <div><p className="font-semibold">{TYPE_LABELS[item.type]}</p><p className="mt-1 text-xs text-[color:var(--text-muted)]">{item.scopeLabel} · {item.senderLabel || "Sender unavailable"} · safe code {item.safeCode}</p></div>
                  </div>
                  <div className="flex flex-wrap gap-2"><Badge variant={severityVariant(item.severity)}>{item.severity}</Badge><Badge variant={statusVariant(item.status)}>{item.status}</Badge></div>
                </div>
                <dl className="grid gap-2 text-xs sm:grid-cols-3">
                  <div><dt className="text-[color:var(--text-muted)]">First seen</dt><dd className="mt-1 font-medium">{formatDateTime(item.firstSeenAt)}</dd></div>
                  <div><dt className="text-[color:var(--text-muted)]">Last seen</dt><dd className="mt-1 font-medium">{formatDateTime(item.lastSeenAt)}</dd></div>
                  <div><dt className="text-[color:var(--text-muted)]">Occurrences</dt><dd className="mt-1 font-medium">{item.occurrenceCount}</dd></div>
                </dl>
                {item.status === "OPEN" && canAcknowledge ? <div className="flex justify-end"><AppButton variant="secondary" size="sm" icon={CheckCircle2} onClick={() => void acknowledge(item.id)} disabled={busyIncidentId !== null} isLoading={busyIncidentId === item.id}>Acknowledge incident</AppButton></div> : null}
              </li>
            ))}
          </ul>
        )}

        {nextCursor && onLoadMore ? <div className="flex justify-center"><AppButton variant="quiet" size="sm" icon={History} onClick={() => void loadMore()} disabled={loadingMore || operationRef.current} isLoading={loadingMore}>Load older incidents</AppButton></div> : null}
      </AppPanel>

      <AppPanel title="Unknown delivery outcomes" description="These terminal ambiguous outcomes require evidence, not a blind resend. There is deliberately no retry action." action={<Badge variant={unknownOutcomes.length > 0 ? "danger" : "success"}>{unknownOutcomes.length} unknown</Badge>} contentClassName="space-y-4">
        <WhatsAppUnknownOutcomeList items={unknownOutcomes} />
      </AppPanel>
    </div>
  );
}
