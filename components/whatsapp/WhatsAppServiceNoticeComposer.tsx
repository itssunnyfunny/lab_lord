"use client";

import { useRef, useState } from "react";
import { CalendarClock, CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  SettingsField,
  SettingsInput,
  SettingsSelect,
} from "@/components/settings/SettingsWorkspace";
import {
  formErrorBannerClass,
  formSuccessBannerClass,
  formWarningBannerClass,
} from "@/components/ui/formSurface";
import { pageInsetMetricClass, pageInsetSurfaceClass } from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";

export type WhatsAppServiceNoticeType = "BRANCH_CLOSED" | "HOURS_CHANGED" | "MAINTENANCE_WINDOW";
export type WhatsAppServiceNoticeReason = "PUBLIC_HOLIDAY" | "LOCAL_HOLIDAY" | "MAINTENANCE" | "EMERGENCY" | "ADMINISTRATIVE";
export type WhatsAppServiceNoticeStatus = "QUEUED" | "PARTIAL" | "COMPLETED" | "CANCELLED" | "FAILED";

export interface WhatsAppServiceNoticeDraft {
  type: WhatsAppServiceNoticeType;
  reason: WhatsAppServiceNoticeReason;
  localEffectiveDate: string;
  resumeLocalDate: string | null;
  openingTimeLocal: string | null;
  closingTimeLocal: string | null;
  maintenanceStartTimeLocal: string | null;
  maintenanceEndTimeLocal: string | null;
  delivery: "IMMEDIATE" | "SCHEDULED";
  scheduledForLocal: string | null;
}

export interface WhatsAppServiceNoticePreviewView {
  renderedPreview: string;
  eligibleRecipientCount: number;
  suppressedCount: number;
  estimatedCostMicros: string;
  currency: "INR";
  rateCardVersion: string | null;
  scheduledFor: string;
  budgetRemainingAfterMicros: string | null;
  estimateDisclaimer: string;
}

export interface WhatsAppServiceNoticeQueueResultView {
  noticeId: string;
  status: WhatsAppServiceNoticeStatus;
  queuedMessageCount: number;
  suppressedCount: number;
}

export interface WhatsAppServiceNoticeHistoryItemView {
  id: string;
  type: WhatsAppServiceNoticeType;
  reason: WhatsAppServiceNoticeReason;
  localEffectiveDate: string;
  status: WhatsAppServiceNoticeStatus;
  eligibleRecipientCount: number;
  queuedMessageCount: number;
  suppressedCount: number;
  scheduledFor: string;
  estimatedCostMicros: string;
  canCancel: boolean;
}

export interface WhatsAppServiceNoticeComposerProps {
  branchName: string;
  canManage: boolean;
  blockedReason?: string;
  recentNotices: readonly WhatsAppServiceNoticeHistoryItemView[];
  onPreview: (draft: WhatsAppServiceNoticeDraft) => Promise<WhatsAppServiceNoticePreviewView>;
  onQueue: (draft: WhatsAppServiceNoticeDraft, idempotencyKey: string) => Promise<WhatsAppServiceNoticeQueueResultView>;
  onCancel: (noticeId: string) => Promise<WhatsAppServiceNoticeQueueResultView>;
}

const NOTICE_TYPE_LABELS: Record<WhatsAppServiceNoticeType, string> = {
  BRANCH_CLOSED: "Branch closed",
  HOURS_CHANGED: "Operating hours changed",
  MAINTENANCE_WINDOW: "Maintenance window",
};

const REASON_LABELS: Record<WhatsAppServiceNoticeReason, string> = {
  PUBLIC_HOLIDAY: "Public holiday",
  LOCAL_HOLIDAY: "Local holiday",
  MAINTENANCE: "Maintenance",
  EMERGENCY: "Emergency",
  ADMINISTRATIVE: "Administrative",
};

const NOTICE_TYPE_OPTIONS = [
  { value: "BRANCH_CLOSED", label: "Branch closed" },
  { value: "HOURS_CHANGED", label: "Operating hours changed" },
  { value: "MAINTENANCE_WINDOW", label: "Maintenance window" },
];

const NOTICE_REASON_OPTIONS = [
  { value: "PUBLIC_HOLIDAY", label: "Public holiday" },
  { value: "LOCAL_HOLIDAY", label: "Local holiday" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "EMERGENCY", label: "Emergency" },
  { value: "ADMINISTRATIVE", label: "Administrative" },
];

const NOTICE_DELIVERY_OPTIONS = [
  { value: "IMMEDIATE", label: "Immediate, subject to safety window" },
  { value: "SCHEDULED", label: "Schedule for later" },
];

function estimatedInr(value: string) {
  if (!/^\d+$/.test(value)) return "Unavailable";
  const amount = Number(value) / 1_000_000;
  return Number.isFinite(amount) ? `₹${amount.toFixed(4)}` : "Unavailable";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-IN");
}

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `notice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function noticeStatusVariant(status: WhatsAppServiceNoticeStatus) {
  if (status === "COMPLETED") return "success" as const;
  if (status === "FAILED") return "danger" as const;
  if (status === "PARTIAL") return "warning" as const;
  return "default" as const;
}

const initialDraft: WhatsAppServiceNoticeDraft = {
  type: "BRANCH_CLOSED",
  reason: "PUBLIC_HOLIDAY",
  localEffectiveDate: "",
  resumeLocalDate: "",
  openingTimeLocal: null,
  closingTimeLocal: null,
  maintenanceStartTimeLocal: null,
  maintenanceEndTimeLocal: null,
  delivery: "IMMEDIATE",
  scheduledForLocal: null,
};

export function WhatsAppServiceNoticePreviewCard({
  preview,
}: {
  preview: WhatsAppServiceNoticePreviewView;
}) {
  return (
    <div className="space-y-4">
      <div className={cn("space-y-2 p-4", pageInsetSurfaceClass)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">Official Utility-template preview</p>
          <Badge variant="cyan">Typed notice</Badge>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--text-primary)]">{preview.renderedPreview}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Unique eligible phones</p><p className="mt-1 text-lg font-semibold">{preview.eligibleRecipientCount}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Suppressed</p><p className="mt-1 text-lg font-semibold">{preview.suppressedCount}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Estimated Meta usage</p><p className="mt-1 text-lg font-semibold">{estimatedInr(preview.estimatedCostMicros)}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Scheduled delivery</p><p className="mt-1 text-sm font-semibold">{formatDateTime(preview.scheduledFor)}</p></div>
      </div>
      {preview.budgetRemainingAfterMicros !== null ? <p className="text-sm text-[color:var(--text-secondary)]">Estimated branch budget remaining after reservation: {estimatedInr(preview.budgetRemainingAfterMicros)}</p> : null}
      <p className="text-xs leading-5 text-[color:var(--text-muted)]">{preview.estimateDisclaimer} This is an estimate, not an invoice; Meta determines final billing and category.</p>
    </div>
  );
}

export function WhatsAppServiceNoticeComposer({
  branchName,
  canManage,
  blockedReason,
  recentNotices,
  onPreview,
  onQueue,
  onCancel,
}: WhatsAppServiceNoticeComposerProps) {
  const [draft, setDraft] = useState<WhatsAppServiceNoticeDraft>(initialDraft);
  const [previewState, setPreviewState] = useState<{ draft: WhatsAppServiceNoticeDraft; preview: WhatsAppServiceNoticePreviewView; idempotencyKey: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [queueResult, setQueueResult] = useState<WhatsAppServiceNoticeQueueResultView | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WhatsAppServiceNoticeHistoryItemView | null>(null);
  const [busy, setBusy] = useState<"preview" | "queue" | "cancel" | null>(null);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);
  const typeFieldsComplete = draft.type === "BRANCH_CLOSED"
    ? Boolean(draft.resumeLocalDate)
    : draft.type === "HOURS_CHANGED"
      ? Boolean(draft.openingTimeLocal && draft.closingTimeLocal)
      : Boolean(draft.maintenanceStartTimeLocal && draft.maintenanceEndTimeLocal);
  const deliveryFieldsComplete = draft.delivery === "IMMEDIATE"
    || Boolean(draft.scheduledForLocal);
  const draftComplete = Boolean(draft.localEffectiveDate)
    && typeFieldsComplete
    && deliveryFieldsComplete;

  const updateDraft = <K extends keyof WhatsAppServiceNoticeDraft>(key: K, value: WhatsAppServiceNoticeDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
    setPreviewState(null);
    setConfirmed(false);
    setQueueResult(null);
  };

  const changeType = (type: WhatsAppServiceNoticeType) => {
    setDraft(current => ({
      ...initialDraft,
      delivery: current.delivery,
      scheduledForLocal: current.scheduledForLocal,
      localEffectiveDate: current.localEffectiveDate,
      type,
      reason: type === "MAINTENANCE_WINDOW" ? "MAINTENANCE" : current.reason,
    }));
    setPreviewState(null);
    setConfirmed(false);
    setQueueResult(null);
  };

  const previewNotice = async () => {
    if (operationRef.current || !canManage) return;
    operationRef.current = true;
    setBusy("preview");
    setNotice({ tone: "status", text: "Resolving the fixed template, unique consented audience, schedule, rate, and budget estimate…" });
    try {
      const result = await onPreview(draft);
      setPreviewState({ draft: { ...draft }, preview: result, idempotencyKey: createIdempotencyKey() });
      setConfirmed(false);
      setQueueResult(null);
      setNotice({ tone: "status", text: "Typed service-notice preview is ready for review." });
    } catch {
      setNotice({ tone: "error", text: "The service-notice preview is unavailable, invalid, over the protected audience limit, or no longer authorized." });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const queueNotice = async () => {
    if (operationRef.current || !previewState || !confirmed || previewState.preview.eligibleRecipientCount === 0) return;
    operationRef.current = true;
    setBusy("queue");
    setNotice({ tone: "status", text: "Queueing one typed notice per unique eligible phone…" });
    try {
      const result = await onQueue(previewState.draft, previewState.idempotencyKey);
      setQueueResult(result);
      setNotice({ tone: "status", text: `${result.queuedMessageCount} notice message${result.queuedMessageCount === 1 ? "" : "s"} queued; ${result.suppressedCount} suppressed.` });
    } catch {
      setNotice({ tone: "error", text: "The queue outcome could not be confirmed. Keep this review open before repeating the same action." });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const cancelNotice = async () => {
    if (operationRef.current || !cancelTarget) return;
    operationRef.current = true;
    setBusy("cancel");
    setNotice(null);
    try {
      const result = await onCancel(cancelTarget.id);
      setCancelTarget(null);
      setNotice({ tone: "status", text: `Cancellation reconciled: ${result.queuedMessageCount} submitted messages remain preserved; safely unsubmitted messages were cancelled.` });
    } catch {
      setNotice({ tone: "error", text: "The notice cancellation could not be confirmed. Submitted or accepted history was not recalled." });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  return (
    <AppPanel
      title="Operational service notice"
      description={`Queue only a fixed branch-closed, changed-hours, or maintenance Utility template for ${branchName}. There is no arbitrary message or recipient field.`}
      action={<Badge variant="cyan">Operational only</Badge>}
      contentClassName="space-y-5"
    >
      {!canManage ? <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)} role="status">{blockedReason || "You need WhatsApp management and sending permission to manage branch-wide notices."}</div> : null}
      {notice ? <p className={cn("px-3 py-2 text-sm", notice.tone === "error" ? formErrorBannerClass : formSuccessBannerClass)} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>{notice.text}</p> : null}

      <div className="overflow-hidden rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-section-divider)]">
        <SettingsField label="Notice type" description="Only the fixed operational catalogue is available.">
          <SettingsSelect
            value={draft.type}
            onValueChange={value => changeType(value as WhatsAppServiceNoticeType)}
            options={NOTICE_TYPE_OPTIONS}
            disabled={!canManage || busy !== null}
            aria-label="Service notice type"
          />
        </SettingsField>

        {draft.type !== "MAINTENANCE_WINDOW" ? (
          <SettingsField label="Fixed reason" description="Free-form reasons are not supported.">
            <SettingsSelect
              value={draft.reason}
              onValueChange={value => updateDraft("reason", value as WhatsAppServiceNoticeReason)}
              options={NOTICE_REASON_OPTIONS}
              disabled={!canManage || busy !== null}
              aria-label="Service notice reason"
            />
          </SettingsField>
        ) : null}

        <SettingsField label={draft.type === "BRANCH_CLOSED" ? "Closure date" : "Effective date"}>
          <SettingsInput type="date" value={draft.localEffectiveDate} onChange={event => updateDraft("localEffectiveDate", event.target.value)} disabled={!canManage || busy !== null} aria-label={draft.type === "BRANCH_CLOSED" ? "Closure local date" : "Effective local date"} />
        </SettingsField>

        {draft.type === "BRANCH_CLOSED" ? (
          <SettingsField label="Operations resume date"><SettingsInput type="date" value={draft.resumeLocalDate ?? ""} onChange={event => updateDraft("resumeLocalDate", event.target.value)} disabled={!canManage || busy !== null} aria-label="Resume local date" /></SettingsField>
        ) : null}

        {draft.type === "HOURS_CHANGED" ? (
          <SettingsField label="Changed operating hours">
            <div className="grid gap-2 sm:grid-cols-2">
              <SettingsInput type="time" value={draft.openingTimeLocal ?? ""} onChange={event => updateDraft("openingTimeLocal", event.target.value)} disabled={!canManage || busy !== null} aria-label="Changed opening time" />
              <SettingsInput type="time" value={draft.closingTimeLocal ?? ""} onChange={event => updateDraft("closingTimeLocal", event.target.value)} disabled={!canManage || busy !== null} aria-label="Changed closing time" />
            </div>
          </SettingsField>
        ) : null}

        {draft.type === "MAINTENANCE_WINDOW" ? (
          <SettingsField label="Maintenance window">
            <div className="grid gap-2 sm:grid-cols-2">
              <SettingsInput type="time" value={draft.maintenanceStartTimeLocal ?? ""} onChange={event => updateDraft("maintenanceStartTimeLocal", event.target.value)} disabled={!canManage || busy !== null} aria-label="Maintenance start time" />
              <SettingsInput type="time" value={draft.maintenanceEndTimeLocal ?? ""} onChange={event => updateDraft("maintenanceEndTimeLocal", event.target.value)} disabled={!canManage || busy !== null} aria-label="Maintenance end time" />
            </div>
          </SettingsField>
        ) : null}

        <SettingsField label="Delivery timing" description="Scheduled delivery must be before the event and no more than 30 days ahead.">
          <SettingsSelect
            value={draft.delivery}
            onValueChange={value => updateDraft("delivery", value as WhatsAppServiceNoticeDraft["delivery"])}
            options={NOTICE_DELIVERY_OPTIONS}
            disabled={!canManage || busy !== null}
            aria-label="Service notice delivery timing"
          />
        </SettingsField>
        {draft.delivery === "SCHEDULED" ? <SettingsField label="Scheduled local date and time"><SettingsInput type="datetime-local" value={draft.scheduledForLocal ?? ""} onChange={event => updateDraft("scheduledForLocal", event.target.value)} disabled={!canManage || busy !== null} aria-label="Scheduled notice date and time" /></SettingsField> : null}
      </div>

      <div className="flex justify-end">
        <AppButton variant="secondary" size="sm" icon={CalendarClock} onClick={() => void previewNotice()} disabled={!canManage || !draftComplete || busy !== null} isLoading={busy === "preview"}>Preview typed notice</AppButton>
      </div>

      {previewState ? <WhatsAppServiceNoticePreviewCard preview={previewState.preview} /> : null}
      {previewState && previewState.preview.eligibleRecipientCount > 0 && !queueResult ? (
        <div className="space-y-3 border-t border-[color:var(--ui-form-section-divider)] pt-4">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy !== null} className="mt-0.5 h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500" />
            <span>I reviewed the fixed operational wording, unique recipient count, suppressions, schedule, budget impact, and estimated customer-owned Meta usage.</span>
          </label>
          <div className="flex justify-end"><AppButton variant="primary" size="sm" icon={ShieldCheck} onClick={() => void queueNotice()} disabled={!confirmed || busy !== null} isLoading={busy === "queue"}>Confirm charges and queue notice</AppButton></div>
        </div>
      ) : null}
      {queueResult ? <div className={cn("flex items-start gap-3 p-3 text-sm", formSuccessBannerClass)} role="status"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>Notice status: {queueResult.status.toLowerCase()}. {queueResult.queuedMessageCount} messages queued and {queueResult.suppressedCount} suppressed.</span></div> : null}

      <section className="space-y-3 border-t border-[color:var(--ui-form-section-divider)] pt-4" aria-labelledby="recent-service-notices-heading">
        <h3 id="recent-service-notices-heading" className="font-semibold">Recent service notices</h3>
        {recentNotices.length === 0 ? <p className="text-sm text-[color:var(--text-muted)]">No service-notice history yet.</p> : (
          <ul className="grid gap-2">
            {recentNotices.map(item => (
              <li key={item.id} className={cn("flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between", pageInsetSurfaceClass)}>
                <div><p className="text-sm font-medium">{NOTICE_TYPE_LABELS[item.type]} · {item.localEffectiveDate}</p><p className="mt-1 text-xs text-[color:var(--text-muted)]">{REASON_LABELS[item.reason]} · {item.eligibleRecipientCount} unique eligible · {item.queuedMessageCount} queued · {item.suppressedCount} suppressed · estimate {estimatedInr(item.estimatedCostMicros)}</p></div>
                <div className="flex flex-wrap items-center gap-2"><Badge variant={noticeStatusVariant(item.status)}>{item.status}</Badge>{item.canCancel && canManage ? <AppButton variant="danger" size="sm" icon={XCircle} onClick={() => setCancelTarget(item)} disabled={busy !== null}>Cancel unsubmitted</AppButton> : null}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog isOpen={Boolean(cancelTarget)} onClose={() => setCancelTarget(null)} onConfirm={cancelNotice} title="Cancel unsubmitted notice messages?" description="Only safely unsubmitted messages will be cancelled and their reservations released. Submitted, accepted, ambiguous, and delivered history is preserved and cannot be recalled." confirmText="Cancel unsubmitted" loading={busy === "cancel"} variant="danger" />
    </AppPanel>
  );
}
