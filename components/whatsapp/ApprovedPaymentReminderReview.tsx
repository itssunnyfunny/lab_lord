"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, MessageCircle, ShieldCheck } from "lucide-react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { formWarningBannerClass } from "@/components/ui/formSurface";
import { pageInsetSurfaceClass } from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";
import {
  whatsapp,
  type WhatsAppManualQueueResult,
  type WhatsAppPaymentReminderPreview,
  type WhatsAppPaymentReminderSuppressionReason,
} from "@/lib/api/whatsapp";

function titleCase(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}

function estimatedInr(value: string) {
  if (!/^\d+$/.test(value)) return "Unavailable";
  const amount = Number(value) / 1_000_000;
  return Number.isFinite(amount) ? `₹${amount.toFixed(4)}` : "Unavailable";
}

function suppressionCounts(preview: WhatsAppPaymentReminderPreview) {
  const counts = new Map<WhatsAppPaymentReminderSuppressionReason, number>();
  for (const item of preview.suppressed) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function ApprovedPaymentReminderPreview({
  preview,
}: {
  preview: WhatsAppPaymentReminderPreview;
}) {
  const suppressions = suppressionCounts(preview);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={cn("p-3", pageInsetSurfaceClass)}>
          <p className="text-xs text-[color:var(--text-muted)]">Eligible recipient groups</p>
          <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">{preview.eligibleRecipientCount}</p>
        </div>
        <div className={cn("p-3", pageInsetSurfaceClass)}>
          <p className="text-xs text-[color:var(--text-muted)]">Suppressed payments</p>
          <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">{preview.suppressedCount}</p>
        </div>
        <div className={cn("p-3", pageInsetSurfaceClass)}>
          <p className="text-xs text-[color:var(--text-muted)]">Estimated Meta usage</p>
          <p className="mt-1 text-lg font-semibold text-[color:var(--text-primary)]">{estimatedInr(preview.estimatedCostMicros)}</p>
        </div>
      </div>

      {preview.groups.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {preview.groups.map((group, index) => (
            <div key={`${group.maskedPhone}:${index}`} className={cn("space-y-3 p-3", pageInsetSurfaceClass)}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-[color:var(--text-primary)]">{group.studentName}</p>
                  <p className="mt-1 text-xs text-[color:var(--text-muted)]">{group.maskedPhone}</p>
                </div>
                <Badge variant="cyan">{group.paymentCount} payment{group.paymentCount === 1 ? "" : "s"}</Badge>
              </div>
              {group.studentCount > 1 ? (
                <p className="text-xs text-[color:var(--text-secondary)]">
                  Shared recipient group: {group.studentCount} students will receive one summary message.
                </p>
              ) : null}
              <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-input-bg)] p-3">
                <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--text-primary)]">{group.renderedPreview}</p>
              </div>
              <p className="text-xs text-[color:var(--text-muted)]">
                Fixed catalogue template: {titleCase(group.managedTemplateKey)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className={cn("px-3 py-3 text-sm", formWarningBannerClass)} role="status">
          No selected payment is currently eligible to queue.
        </div>
      )}

      {suppressions.length > 0 ? (
        <div className={cn("space-y-2 px-3 py-3 text-sm", formWarningBannerClass)}>
          <p className="font-medium">Server-side suppressions</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {suppressions.map(([reason, count]) => (
              <li key={reason}>{titleCase(reason)}: {count}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs leading-5 text-[color:var(--text-muted)]">{preview.estimateDisclaimer}</p>
    </div>
  );
}

export function ApprovedPaymentReminderReview({
  branchId,
  paymentIds,
  canSend,
  blockedReason,
}: {
  branchId: string;
  paymentIds: readonly string[];
  canSend: boolean;
  blockedReason?: string;
}) {
  const [previewState, setPreviewState] = useState<{
    selectionKey: string;
    preview: WhatsAppPaymentReminderPreview;
    idempotencyKey: string;
  } | null>(null);
  const [queueResult, setQueueResult] = useState<WhatsAppManualQueueResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "queue" | null>(null);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);
  const selectionKey = [...paymentIds].sort().join(":");
  const currentPreview = previewState?.selectionKey === selectionKey ? previewState : null;
  const currentQueueResult = currentPreview ? queueResult : null;

  const preview = async () => {
    if (operationRef.current || paymentIds.length === 0 || !canSend) return;
    operationRef.current = true;
    setBusy("preview");
    setNotice({ tone: "status", text: "Resolving recipients, consent, payment truth, grouping, templates, and budget…" });
    try {
      const result = await whatsapp.previewPaymentReminders(branchId, paymentIds);
      setPreviewState({
        selectionKey,
        preview: result,
        idempotencyKey: crypto.randomUUID(),
      });
      setQueueResult(null);
      setConfirmed(false);
      setNotice({ tone: "status", text: "Approved Utility-template preview is ready for confirmation." });
    } catch {
      setNotice({ tone: "error", text: "The approved reminder preview is unavailable or the selected payments are not authorized." });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const queue = async () => {
    if (operationRef.current || !currentPreview || !confirmed || currentPreview.preview.groups.length === 0) return;
    operationRef.current = true;
    setBusy("queue");
    setNotice({ tone: "status", text: "Queueing the confirmed recipient groups…" });
    try {
      const result = await whatsapp.queuePaymentReminders(
        branchId,
        paymentIds,
        currentPreview.idempotencyKey
      );
      setQueueResult(result);
      setNotice({
        tone: "status",
        text: `${result.request.queuedMessageCount} message${result.request.queuedMessageCount === 1 ? "" : "s"} queued. Delivery remains subject to send-time revalidation.`,
      });
    } catch {
      setNotice({
        tone: "error",
        text: "The queue result could not be confirmed. Keep this review open before trying the same confirmed action again.",
      });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  return (
    <AppPanel
      title="Approved WhatsApp reminder"
      description="Preview and queue only the official Lab Lords Utility template. Recipient, payment values, template, grouping, suppression, and cost are resolved by the server."
      action={<Badge variant="cyan">Utility only</Badge>}
      contentClassName="space-y-4"
    >
      {!canSend ? (
        <div className={cn("flex items-start gap-3 px-4 py-3 text-sm", formWarningBannerClass)} role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{blockedReason || "You do not have access to queue approved WhatsApp reminders."}</span>
        </div>
      ) : null}

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"} className={notice.tone === "error" ? "text-sm text-[color:var(--ui-form-error-text)]" : "text-sm text-[color:var(--text-secondary)]"}>
          {notice.text}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <AppButton
          variant="secondary"
          size="sm"
          icon={MessageCircle}
          onClick={() => void preview()}
          disabled={!canSend || paymentIds.length === 0 || busy !== null}
          isLoading={busy === "preview"}
        >
          Preview approved reminder ({paymentIds.length})
        </AppButton>
      </div>

      {currentPreview ? <ApprovedPaymentReminderPreview preview={currentPreview.preview} /> : null}

      {currentPreview && currentPreview.preview.groups.length > 0 && !currentQueueResult ? (
        <div className="space-y-3 border-t border-[color:var(--ui-form-section-divider)] pt-4">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={event => setConfirmed(event.target.checked)}
              disabled={busy !== null}
              className="mt-0.5 h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
            />
            <span>
              I reviewed the official preview, server suppressions, recipient grouping, and estimated customer-owned Meta usage.
            </span>
          </label>
          <div className="flex justify-end">
            <AppButton
              variant="primary"
              size="sm"
              icon={ShieldCheck}
              onClick={() => void queue()}
              disabled={!confirmed || busy !== null}
              isLoading={busy === "queue"}
            >
              Confirm and queue {currentPreview.preview.eligibleRecipientCount} recipient group{currentPreview.preview.eligibleRecipientCount === 1 ? "" : "s"}
            </AppButton>
          </div>
        </div>
      ) : null}

      {currentQueueResult ? (
        <div className="flex items-start gap-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] p-3 text-sm" role="status">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Queue request {currentQueueResult.request.status.toLowerCase()}: {currentQueueResult.request.queuedMessageCount} queued, {currentQueueResult.request.suppressedCount} suppressed.
          </span>
        </div>
      ) : null}
    </AppPanel>
  );
}
