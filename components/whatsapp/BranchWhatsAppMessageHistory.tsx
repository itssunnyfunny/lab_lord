"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, History } from "lucide-react";
import { AppButton } from "@/components/ui/AppButton";
import { Badge } from "@/components/ui/Badge";
import { SettingsCard, SettingsEmptyState } from "@/components/settings/SettingsWorkspace";
import {
  whatsapp,
  type WhatsAppMessageHistoryItem,
  type WhatsAppMessageHistoryResponse,
} from "@/lib/api/whatsapp";

function titleCase(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}

function statusVariant(status: string) {
  if (status === "DELIVERED" || status === "READ" || status === "SENT") return "success" as const;
  if (status === "FAILED" || status === "CANCELLED" || status === "SUPPRESSED") return "danger" as const;
  if (status === "UNKNOWN") return "warning" as const;
  return "default" as const;
}

function safeDate(value: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function estimatedCost(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return "Unavailable";
  const rupees = Number(value) / 1_000_000;
  return Number.isFinite(rupees) ? `₹${rupees.toFixed(4)}` : "Unavailable";
}

function paymentAmount(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function BranchWhatsAppMessageHistoryList({
  items,
}: {
  items: readonly WhatsAppMessageHistoryItem[];
}) {
  const hasUnknown = items.some(item => item.status === "UNKNOWN");
  return (
    <div className="space-y-3">
      {hasUnknown ? (
        <div className="flex items-start gap-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-warning-border)] bg-[color:var(--ui-form-warning-bg)] p-3 text-sm" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Provider acceptance could not be confirmed. Lab Lords will not retry automatically because that could send a duplicate message; operator review is required before any manual follow-up.
          </span>
        </div>
      ) : null}

      {items.map(item => (
        <SettingsCard key={item.id} className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-medium text-[color:var(--text-primary)]">
                {item.student?.name ?? "Grouped recipient"}
              </p>
              <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                {item.maskedPhone} · {item.managedTemplateKey ? titleCase(item.managedTemplateKey) : "Template unavailable"}
              </p>
            </div>
            <Badge variant={statusVariant(item.status)}>{titleCase(item.status)}</Badge>
          </div>
          <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-[color:var(--text-muted)]">Purpose</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{titleCase(item.purpose)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Trigger</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
                {titleCase(item.trigger)}{item.automationStage ? ` · ${titleCase(item.automationStage)}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Template</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
                {item.template ? `${item.template.name} · ${item.template.language}` : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Scheduled</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{safeDate(item.scheduledFor)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Estimated usage</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{estimatedCost(item.estimatedCostMicros)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Submitted</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{safeDate(item.submissionStartedAt)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Accepted</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{safeDate(item.acceptedAt)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Sent</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{safeDate(item.sentAt)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Delivered</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{safeDate(item.deliveredAt)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Read</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{safeDate(item.readAt)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Failed</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{safeDate(item.failedAt)}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Provider billing metadata</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
                {item.providerBillable === null ? "Not supplied" : item.providerBillable ? "Billable" : "Not billable"}
                {item.providerPricingCategory ? ` · ${titleCase(item.providerPricingCategory)}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--text-muted)]">Queued by</dt>
              <dd className="mt-1 font-medium text-[color:var(--text-primary)]">{item.createdBy?.name ?? (item.trigger === "AUTOMATION" ? "Automation" : "Unavailable")}</dd>
            </div>
          </dl>
          {item.payments && item.payments.length > 0 ? (
            <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] p-3 text-xs">
              <p className="font-medium text-[color:var(--text-primary)]">Payment context</p>
              <ul className="mt-2 space-y-1 text-[color:var(--text-secondary)]">
                {item.payments.map(payment => (
                  <li key={payment.id}>{titleCase(payment.status)} · {paymentAmount(payment.amount)} · due {safeDate(payment.dueDate)}</li>
                ))}
              </ul>
              {item.paymentResolutionEvent ? (
                <p className="mt-2 text-[color:var(--text-muted)]">
                  Resolution: {titleCase(item.paymentResolutionEvent.fromStatus)} → {titleCase(item.paymentResolutionEvent.toStatus)} · {safeDate(item.paymentResolutionEvent.occurredAt)}
                </p>
              ) : null}
            </div>
          ) : null}
          {item.safeFailureCode ? (
            <p className="text-xs text-[color:var(--ui-form-error-text)]">
              Safe failure code: {item.safeFailureCode}
            </p>
          ) : null}
        </SettingsCard>
      ))}
    </div>
  );
}

export function BranchWhatsAppMessageHistory({ branchId }: { branchId: string }) {
  const [page, setPage] = useState<WhatsAppMessageHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(false);

  const load = useCallback(async (cursor?: string | null) => {
    if (requestRef.current) return;
    requestRef.current = true;
    const more = Boolean(cursor);
    if (more) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const next = await whatsapp.getMessageHistory(branchId, { cursor, limit: 20 });
      setPage(current => more && current
        ? { ...next, items: [...current.items, ...next.items] }
        : next);
    } catch {
      setError("Message history is unavailable right now.");
    } finally {
      requestRef.current = false;
      if (more) setLoadingMore(false);
      else setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p role="status" className="text-sm text-[color:var(--text-secondary)]">Loading message history…</p>;
  }
  if (error && !page) {
    return <p role="alert" className="text-sm text-[color:var(--ui-form-error-text)]">{error}</p>;
  }
  if (!page || page.items.length === 0) {
    return <SettingsEmptyState>No WhatsApp messages have been queued for this branch.</SettingsEmptyState>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 text-sm text-[color:var(--text-secondary)]">
        <span className="inline-flex items-center gap-2"><History className="h-4 w-4" aria-hidden="true" /> {page.total} message{page.total === 1 ? "" : "s"}</span>
        <span>Estimated usage only; Meta determines final charges.</span>
      </div>
      <BranchWhatsAppMessageHistoryList items={page.items} />
      {error ? <p role="alert" className="text-sm text-[color:var(--ui-form-error-text)]">{error}</p> : null}
      {page.nextCursor ? (
        <div className="flex justify-center">
          <AppButton
            variant="secondary"
            size="sm"
            onClick={() => void load(page.nextCursor)}
            disabled={loadingMore}
            isLoading={loadingMore}
          >
            Load more history
          </AppButton>
        </div>
      ) : null}
    </div>
  );
}
