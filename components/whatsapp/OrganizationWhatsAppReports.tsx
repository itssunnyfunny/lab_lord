"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, MessageCircle, ShieldCheck } from "lucide-react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
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
import type {
  WhatsAppDailyReportPreview,
  WhatsAppDailyReportQueueResult,
} from "@/lib/api/whatsapp";

export interface WhatsAppDailyReportMetricsView {
  paymentsRecordedTodayCount: number;
  paymentsRecordedTodayAmount: string;
  newStudentsToday: number;
  activeStudents: number;
  usedShiftSlots: number;
  totalShiftCapacity: number;
  openDueCount: number;
  openDueAmount: string;
  overdueCount: number;
  overdueAmount: string;
  whatsAppAcceptedToday: number;
  whatsAppDeliveredToday: number;
  whatsAppFailedToday: number;
  whatsAppUnknownToday: number;
  branchCount: number | null;
}

export interface WhatsAppDailyReportPreviewView {
  scope: "BRANCH" | "ORGANIZATION";
  localReportDate: string;
  asOfLocalTime: string;
  renderedPreview: string;
  metrics: WhatsAppDailyReportMetricsView;
  eligibleRecipientCount: number;
  suppressedCount: number;
  estimatedCostMicros: string;
  currency: "INR";
  rateCardVersion: string | null;
  estimateDisclaimer: string;
  alreadyQueued: boolean;
}

export interface WhatsAppDailyReportQueueResultView {
  status: "QUEUED" | "DUPLICATE" | "SUPPRESSED";
  queuedMessageCount: number;
  suppressedCount: number;
  localReportDate: string;
}

export interface WhatsAppDailyReportHistoryItemView {
  id: string;
  localReportDate: string;
  status: "PLANNED" | "QUEUED" | "SENT" | "DELIVERED" | "PARTIAL" | "FAILED" | "UNKNOWN" | "SUPPRESSED";
  maskedPhone: string;
  scheduledFor: string;
  estimatedCostMicros: string;
}

export interface WhatsAppReportSettingsSummaryView {
  enabled: boolean;
  senderId: string | null;
  senderLabel: string | null;
  monthlyBudgetMinor: number | null;
  budgetSource: "BRANCH" | "ORGANIZATION_REPORT";
}

export interface WhatsAppReportSenderOptionView {
  id: string;
  label: string;
}

export interface WhatsAppDailyReportActionsProps {
  scope: "BRANCH" | "ORGANIZATION";
  scopeName: string;
  canQueue: boolean;
  blockedReason?: string;
  recentReports: readonly WhatsAppDailyReportHistoryItemView[];
  onPreview: () => Promise<WhatsAppDailyReportPreviewView>;
  onQueue: (idempotencyKey: string) => Promise<WhatsAppDailyReportQueueResultView>;
}

function estimatedInr(value: string) {
  if (!/^\d+$/.test(value)) return "Unavailable";
  const amount = Number(value) / 1_000_000;
  return Number.isFinite(amount) ? `₹${amount.toFixed(4)}` : "Unavailable";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-IN");
}

function reportStatusVariant(status: WhatsAppDailyReportHistoryItemView["status"]) {
  if (status === "DELIVERED" || status === "SENT") return "success" as const;
  if (status === "FAILED" || status === "UNKNOWN") return "danger" as const;
  if (status === "PARTIAL" || status === "SUPPRESSED") return "warning" as const;
  return "default" as const;
}

function createIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatReportAmount(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

export function presentWhatsAppDailyReportPreview(
  preview: WhatsAppDailyReportPreview
): WhatsAppDailyReportPreviewView {
  const metrics = preview.metrics;
  return {
    scope: preview.scope,
    localReportDate: preview.localReportDate,
    asOfLocalTime: metrics.asOfLocalTime,
    renderedPreview: preview.template.renderedPreview,
    metrics: {
      paymentsRecordedTodayCount: metrics.paymentsRecordedTodayCount,
      paymentsRecordedTodayAmount: formatReportAmount(metrics.paymentsRecordedTodayAmount),
      newStudentsToday: metrics.newStudentsToday,
      activeStudents: metrics.activeStudents,
      usedShiftSlots: metrics.usedShiftSlots,
      totalShiftCapacity: metrics.totalShiftCapacity,
      openDueCount: metrics.openDueCount,
      openDueAmount: formatReportAmount(metrics.openDueAmount),
      overdueCount: metrics.overdueCount,
      overdueAmount: formatReportAmount(metrics.overdueAmount),
      whatsAppAcceptedToday: metrics.whatsAppAcceptedToday,
      whatsAppDeliveredToday: metrics.whatsAppDeliveredToday,
      whatsAppFailedToday: metrics.whatsAppFailedToday,
      whatsAppUnknownToday: metrics.whatsAppUnknownToday,
      branchCount: "branchCount" in metrics ? metrics.branchCount : null,
    },
    eligibleRecipientCount: 1,
    suppressedCount: 0,
    estimatedCostMicros: preview.estimate.estimatedCostMicros,
    currency: preview.estimate.currency,
    rateCardVersion: preview.estimate.rateCardVersion,
    estimateDisclaimer: preview.estimate.disclaimer,
    alreadyQueued: preview.alreadyQueued,
  };
}

export function presentWhatsAppDailyReportQueueResult(
  result: WhatsAppDailyReportQueueResult
): WhatsAppDailyReportQueueResultView {
  return {
    status: result.replayed ? "DUPLICATE" : "QUEUED",
    queuedMessageCount: 1,
    suppressedCount: 0,
    localReportDate: result.localReportDate,
  };
}

export function WhatsAppDailyReportPreviewCard({
  preview,
}: {
  preview: WhatsAppDailyReportPreviewView;
}) {
  const { metrics } = preview;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {preview.scope === "ORGANIZATION" ? (
          <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Branches</p><p className="mt-1 text-lg font-semibold">{metrics.branchCount ?? 0}</p></div>
        ) : null}
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Payments recorded today</p><p className="mt-1 text-lg font-semibold">{metrics.paymentsRecordedTodayCount} · {metrics.paymentsRecordedTodayAmount}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">New / active students</p><p className="mt-1 text-lg font-semibold">{metrics.newStudentsToday} / {metrics.activeStudents}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Shift slots used</p><p className="mt-1 text-lg font-semibold">{metrics.usedShiftSlots} / {metrics.totalShiftCapacity}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Open due</p><p className="mt-1 text-lg font-semibold">{metrics.openDueCount} · {metrics.openDueAmount}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Overdue</p><p className="mt-1 text-lg font-semibold">{metrics.overdueCount} · {metrics.overdueAmount}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">WhatsApp accepted / delivered</p><p className="mt-1 text-lg font-semibold">{metrics.whatsAppAcceptedToday} / {metrics.whatsAppDeliveredToday}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">WhatsApp failed / unknown</p><p className="mt-1 text-lg font-semibold">{metrics.whatsAppFailedToday} / {metrics.whatsAppUnknownToday}</p></div>
      </div>

      <div className={cn("space-y-2 p-4", pageInsetSurfaceClass)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">Official Utility-template preview</p>
          <div className="flex flex-wrap items-center gap-2">
            {preview.alreadyQueued ? <Badge variant="warning">Already queued</Badge> : null}
            <Badge variant="cyan">As of {preview.asOfLocalTime}</Badge>
          </div>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--text-primary)]">{preview.renderedPreview}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Confirmed recipients</p><p className="mt-1 font-semibold">{preview.eligibleRecipientCount}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Suppressed</p><p className="mt-1 font-semibold">{preview.suppressedCount}</p></div>
        <div className={pageInsetMetricClass}><p className="text-xs text-[color:var(--text-muted)]">Estimated Meta usage</p><p className="mt-1 font-semibold">{estimatedInr(preview.estimatedCostMicros)}</p></div>
      </div>
      <p className="text-xs leading-5 text-[color:var(--text-muted)]">
        {preview.estimateDisclaimer} This is an estimate, not an invoice; Meta determines final billing and category.
      </p>
    </div>
  );
}

export function WhatsAppDailyReportActions({
  scope,
  scopeName,
  canQueue,
  blockedReason,
  recentReports,
  onPreview,
  onQueue,
}: WhatsAppDailyReportActionsProps) {
  const [previewState, setPreviewState] = useState<{ preview: WhatsAppDailyReportPreviewView; idempotencyKey: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [queueResult, setQueueResult] = useState<WhatsAppDailyReportQueueResultView | null>(null);
  const [busy, setBusy] = useState<"preview" | "queue" | null>(null);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);

  const previewReport = async () => {
    if (operationRef.current || !canQueue) return;
    operationRef.current = true;
    setBusy("preview");
    setNotice({ tone: "status", text: "Building a deterministic aggregate preview…" });
    try {
      const result = await onPreview();
      setPreviewState({ preview: result, idempotencyKey: createIdempotencyKey() });
      setConfirmed(false);
      setQueueResult(null);
      setNotice({ tone: "status", text: "Preview ready. Review the aggregate metrics, recipients, and estimate before queueing." });
    } catch {
      setNotice({ tone: "error", text: "The report preview is unavailable or no longer authorized." });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const queueReport = async () => {
    if (
      operationRef.current
      || !previewState
      || !confirmed
      || previewState.preview.eligibleRecipientCount === 0
      || previewState.preview.alreadyQueued
    ) return;
    operationRef.current = true;
    setBusy("queue");
    setNotice({ tone: "status", text: "Queueing the confirmed daily report…" });
    try {
      const result = await onQueue(previewState.idempotencyKey);
      setQueueResult(result);
      setNotice({ tone: "status", text: `${result.queuedMessageCount} report message${result.queuedMessageCount === 1 ? "" : "s"} queued; ${result.suppressedCount} suppressed.` });
    } catch {
      setNotice({ tone: "error", text: "The queue outcome could not be confirmed. Keep this review open before repeating the action." });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  return (
    <AppPanel
      title={`Today's ${scope === "ORGANIZATION" ? "organization" : "branch"} report`}
      description={`Preview aggregate operational metrics for ${scopeName}. Previewing does not reserve budget, queue a message, or call Meta.`}
      action={<Badge variant="cyan">Utility only</Badge>}
      contentClassName="space-y-4"
    >
      {!canQueue ? <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)} role="status">{blockedReason || "You do not have permission to preview or queue this report."}</div> : null}
      {notice ? <p className={cn("px-3 py-2 text-sm", notice.tone === "error" ? formErrorBannerClass : formSuccessBannerClass)} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>{notice.text}</p> : null}

      <div className="flex justify-end">
        <AppButton variant="secondary" size="sm" icon={MessageCircle} onClick={() => void previewReport()} disabled={!canQueue || busy !== null} isLoading={busy === "preview"}>Preview today&apos;s report</AppButton>
      </div>

      {previewState ? <WhatsAppDailyReportPreviewCard preview={previewState.preview} /> : null}

      {previewState?.preview.alreadyQueued ? (
        <p className={cn("px-3 py-2 text-sm", formWarningBannerClass)} role="status">
          Today&apos;s report is already queued. The server-side daily deduplication key prevents another message.
        </p>
      ) : null}

      {previewState && previewState.preview.eligibleRecipientCount > 0 && !previewState.preview.alreadyQueued && !queueResult ? (
        <div className="space-y-3 border-t border-[color:var(--ui-form-section-divider)] pt-4">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy !== null} className="mt-0.5 h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500" />
            <span>I reviewed the aggregate snapshot, confirmed recipient count, suppressions, and estimated customer-owned Meta usage.</span>
          </label>
          <div className="flex justify-end">
            <AppButton variant="primary" size="sm" icon={ShieldCheck} onClick={() => void queueReport()} disabled={!confirmed || busy !== null} isLoading={busy === "queue"}>Confirm and queue today&apos;s report</AppButton>
          </div>
        </div>
      ) : null}

      {queueResult ? <div className={cn("flex items-start gap-3 p-3 text-sm", formSuccessBannerClass)} role="status"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>Queue status: {queueResult.status.toLowerCase()}. Delivery remains subject to send-time authorization, consent, sender health, rate, and budget checks.</span></div> : null}

      <section aria-labelledby={`${scope.toLowerCase()}-recent-report-heading`} className="space-y-3 border-t border-[color:var(--ui-form-section-divider)] pt-4">
        <h3 id={`${scope.toLowerCase()}-recent-report-heading`} className="font-semibold">Recent daily reports</h3>
        {recentReports.length === 0 ? <p className="text-sm text-[color:var(--text-muted)]">No daily report history yet.</p> : (
          <ul className="grid gap-2">
            {recentReports.map(report => (
              <li key={report.id} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between", pageInsetSurfaceClass)}>
                <div><p className="text-sm font-medium">{report.localReportDate} · {report.maskedPhone}</p><p className="mt-1 text-xs text-[color:var(--text-muted)]">Scheduled {formatDateTime(report.scheduledFor)} · estimate {estimatedInr(report.estimatedCostMicros)}</p></div>
                <Badge variant={reportStatusVariant(report.status)}>{report.status.replaceAll("_", " ")}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppPanel>
  );
}

export interface OrganizationWhatsAppReportsProps {
  organizationName: string;
  settings: WhatsAppReportSettingsSummaryView;
  canManage: boolean;
  blockedReason?: string;
  availableSenders: readonly WhatsAppReportSenderOptionView[];
  recentReports: readonly WhatsAppDailyReportHistoryItemView[];
  onSetEnabled: (enabled: boolean) => Promise<void>;
  onSaveSettings: (settings: { senderId: string; monthlyBudgetMinor: number }) => Promise<void>;
  onPreview: () => Promise<WhatsAppDailyReportPreviewView>;
  onQueue: (idempotencyKey: string) => Promise<WhatsAppDailyReportQueueResultView>;
}

export function OrganizationWhatsAppReports({
  organizationName,
  settings,
  canManage,
  blockedReason,
  availableSenders,
  recentReports,
  onSetEnabled,
  onSaveSettings,
  onPreview,
  onQueue,
}: OrganizationWhatsAppReportsProps) {
  const [changing, setChanging] = useState(false);
  const [selectedSenderId, setSelectedSenderId] = useState(settings.senderId ?? "");
  const [monthlyBudgetRupees, setMonthlyBudgetRupees] = useState(
    settings.monthlyBudgetMinor === null ? "" : (settings.monthlyBudgetMinor / 100).toFixed(2)
  );
  const [settingNotice, setSettingNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const settingOperationRef = useRef(false);
  const senderOptions = useMemo(() => availableSenders.length > 0
    ? availableSenders.map(sender => ({ value: sender.id, label: sender.label }))
    : [{ value: "", label: "No active sender available", disabled: true }], [availableSenders]);
  const parsedBudgetMinor = /^\d{1,6}(?:\.\d{1,2})?$/.test(monthlyBudgetRupees.trim())
    ? Math.round(Number(monthlyBudgetRupees) * 100)
    : null;
  const budgetValid = parsedBudgetMinor !== null
    && Number.isSafeInteger(parsedBudgetMinor)
    && parsedBudgetMinor >= 1
    && parsedBudgetMinor <= 10_000_000;

  useEffect(() => {
    setSelectedSenderId(settings.senderId ?? "");
  }, [settings.senderId]);

  useEffect(() => {
    setMonthlyBudgetRupees(
      settings.monthlyBudgetMinor === null ? "" : (settings.monthlyBudgetMinor / 100).toFixed(2)
    );
  }, [settings.monthlyBudgetMinor]);

  const setEnabled = async () => {
    if (settingOperationRef.current || !canManage) return;
    settingOperationRef.current = true;
    setChanging(true);
    setSettingNotice(null);
    try {
      await onSetEnabled(!settings.enabled);
      setSettingNotice({ tone: "status", text: settings.enabled ? "Organization report automation disabled." : "Organization report automation enabled prospectively." });
    } catch {
      setSettingNotice({ tone: "error", text: "Organization report automation could not be changed." });
    } finally {
      settingOperationRef.current = false;
      setChanging(false);
    }
  };

  const saveSettings = async () => {
    if (
      settingOperationRef.current
      || !canManage
      || !selectedSenderId
      || !budgetValid
      || parsedBudgetMinor === null
    ) return;
    settingOperationRef.current = true;
    setChanging(true);
    setSettingNotice(null);
    try {
      await onSaveSettings({
        senderId: selectedSenderId,
        monthlyBudgetMinor: parsedBudgetMinor,
      });
      setSettingNotice({ tone: "status", text: "Organization report sender and budget saved. Sender changes require recipient reconfirmation." });
    } catch {
      setSettingNotice({ tone: "error", text: "Organization report sender and budget could not be saved." });
    } finally {
      settingOperationRef.current = false;
      setChanging(false);
    }
  };

  return (
    <div className="space-y-4">
      <AppPanel title="Organization report setup" description="Owner-only organization rollups use a separate organization-report budget and a confirmed recipient." action={<Badge variant={settings.enabled ? "success" : "default"}>{settings.enabled ? "Enabled" : "Disabled"}</Badge>} contentClassName="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className={pageInsetMetricClass}><dt className="text-xs text-[color:var(--text-muted)]">Connected sender</dt><dd className="mt-1 font-medium">{settings.senderLabel || "Not assigned"}</dd></div>
          <div className={pageInsetMetricClass}><dt className="text-xs text-[color:var(--text-muted)]">Budget source</dt><dd className="mt-1 font-medium">Separate organization report budget</dd></div>
          <div className={pageInsetMetricClass}><dt className="text-xs text-[color:var(--text-muted)]">Monthly ceiling</dt><dd className="mt-1 font-medium">{settings.monthlyBudgetMinor === null ? "Not configured" : `₹${(settings.monthlyBudgetMinor / 100).toFixed(2)}`}</dd></div>
        </dl>
        <div className="overflow-hidden rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-section-divider)]">
          <SettingsField label="Report sender" description="Changing the sender makes existing report subscriptions stale and requires fresh confirmation.">
            <SettingsSelect
              value={selectedSenderId}
              onValueChange={setSelectedSenderId}
              options={senderOptions}
              disabled={!canManage || changing}
              aria-label="Organization report sender"
            />
          </SettingsField>
          <SettingsField
            label="Monthly report budget"
            description="Separate reservation ceiling for organization daily reports. Enter ₹0.01 through ₹100,000."
            error={monthlyBudgetRupees.length > 0 && !budgetValid ? "Enter a valid amount from ₹0.01 through ₹100,000." : null}
          >
            <SettingsInput
              type="text"
              inputMode="decimal"
              value={monthlyBudgetRupees}
              onChange={event => setMonthlyBudgetRupees(event.target.value)}
              disabled={!canManage || changing}
              aria-label="Organization report monthly budget in INR"
            />
          </SettingsField>
          <div className="flex justify-end border-t border-[color:var(--ui-form-section-divider)] p-4">
            <AppButton variant="secondary" size="sm" onClick={() => void saveSettings()} disabled={!canManage || changing || !selectedSenderId || !budgetValid} isLoading={changing}>Save report setup</AppButton>
          </div>
        </div>
        {settingNotice ? <p className={cn("px-3 py-2 text-sm", settingNotice.tone === "error" ? formErrorBannerClass : formSuccessBannerClass)} role={settingNotice.tone === "error" ? "alert" : "status"} aria-live={settingNotice.tone === "error" ? "assertive" : "polite"}>{settingNotice.text}</p> : null}
        <div className="flex justify-end"><AppButton variant={settings.enabled ? "danger" : "primary"} size="sm" onClick={() => void setEnabled()} disabled={!canManage || changing || (!settings.enabled && (!settings.senderId || settings.monthlyBudgetMinor === null))} isLoading={changing}>{settings.enabled ? "Disable scheduled reports" : "Enable scheduled reports"}</AppButton></div>
      </AppPanel>
      <WhatsAppDailyReportActions scope="ORGANIZATION" scopeName={organizationName} canQueue={canManage} blockedReason={blockedReason} recentReports={recentReports} onPreview={onPreview} onQueue={onQueue} />
    </div>
  );
}
