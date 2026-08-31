"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, HeartPulse, MessageCircle } from "lucide-react";
import { AppButton } from "@/components/ui/AppButton";
import { Badge } from "@/components/ui/Badge";
import {
  ReadOnlyRow,
  SettingsField,
  SettingsInput,
  SettingsPanel,
  SettingsSelect,
} from "@/components/settings/SettingsWorkspace";
import { BranchWhatsAppMessageHistory } from "@/components/whatsapp/BranchWhatsAppMessageHistory";
import { WhatsAppReportSubscription } from "@/components/whatsapp/WhatsAppReportSubscription";
import { BranchWhatsAppReports } from "@/components/whatsapp/BranchWhatsAppReports";
import { WhatsAppServiceNoticeComposer } from "@/components/whatsapp/WhatsAppServiceNoticeComposer";
import {
  WhatsAppIncidents,
  presentWhatsAppIncidentResponse,
} from "@/components/whatsapp/WhatsAppIncidents";
import {
  presentWhatsAppDailyReportPreview,
  presentWhatsAppDailyReportQueueResult,
} from "@/components/whatsapp/OrganizationWhatsAppReports";
import {
  WHATSAPP_AUTOMATION_STAGES,
  whatsapp,
  type WhatsAppAutomationStage,
  type WhatsAppBranchAssignmentResponse,
  type WhatsAppBranchSettings,
  type WhatsAppManagedLanguage,
  type WhatsAppIncidentListResponse,
  type WhatsAppReportSubscription as WhatsAppReportSubscriptionDto,
  type WhatsAppReportSubscriptionResponse,
  type WhatsAppServiceNoticeListResponse,
} from "@/lib/api/whatsapp";

function titleCase(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}

const STAGE_LABELS: Record<WhatsAppAutomationStage, string> = {
  WELCOME: "Prospective welcome",
  FEE_DUE_MINUS_7: "7 days before due",
  FEE_DUE_MINUS_3: "3 days before due",
  FEE_DUE_MINUS_1: "1 day before due",
  FEE_DUE_TODAY: "Due date",
  PAST_DUE_PLUS_1: "1 day past due",
  PAST_DUE_PLUS_3: "3 days past due",
  PAST_DUE_PLUS_7: "7 days past due",
  PAYMENT_CONFIRMATION: "Payment confirmation",
  PAYMENT_CORRECTION: "Payment correction",
};

export type BranchSettingsForm = {
  defaultLanguage: WhatsAppManagedLanguage;
  defaultTone: "polite" | "friendly" | "firm";
  sendTimeLocal: string;
  dailyAutomaticMessageLimit: string;
  maxAutomaticCollectionMessagesPerCycle: string;
  monthlyBudgetRupees: string;
  rules: Record<WhatsAppAutomationStage, boolean>;
};

function settingsForm(settings: WhatsAppBranchSettings): BranchSettingsForm {
  const rules = Object.fromEntries(
    WHATSAPP_AUTOMATION_STAGES.map(stage => [stage, false])
  ) as Record<WhatsAppAutomationStage, boolean>;
  for (const rule of settings.rules) rules[rule.stage] = rule.enabled;
  return {
    defaultLanguage: settings.defaultLanguage,
    defaultTone: settings.defaultTone,
    sendTimeLocal: settings.sendTimeLocal,
    dailyAutomaticMessageLimit: String(settings.dailyAutomaticMessageLimit),
    maxAutomaticCollectionMessagesPerCycle: String(settings.maxAutomaticCollectionMessagesPerCycle),
    monthlyBudgetRupees: settings.monthlyBudgetMinor === null
      ? ""
      : (settings.monthlyBudgetMinor / 100).toFixed(2).replace(/\.00$/, ""),
    rules,
  };
}

function parseBudgetMinor(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(trimmed)) return undefined;
  const paise = Math.round(Number(trimmed) * 100);
  if (!Number.isSafeInteger(paise) || paise < 1 || paise > 10_000_000) return undefined;
  return paise;
}

function estimatedInr(micros: string | null) {
  if (micros === null || !/^\d+$/.test(micros)) return "Not configured";
  const rupees = Number(micros) / 1_000_000;
  return Number.isFinite(rupees) ? `₹${rupees.toFixed(2)}` : "Unavailable";
}

function requireReportChallenge(response: {
  confirmationCode: string;
  subscription: WhatsAppReportSubscriptionDto;
}) {
  if (!response.confirmationCode || !response.subscription.confirmationExpiresAt) {
    throw new Error("Report confirmation challenge unavailable");
  }
  return {
    code: response.confirmationCode,
    expiresAt: response.subscription.confirmationExpiresAt,
  };
}

function ChecklistItem({ complete, children }: { complete: boolean; children: ReactNode }) {
  const Icon = complete ? CheckCircle2 : Circle;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon
        className={complete
          ? "mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ui-tone-success-text)]"
          : "mt-0.5 h-4 w-4 shrink-0 text-[color:var(--text-muted)]"}
        aria-hidden="true"
      />
      <span><span className="sr-only">{complete ? "Complete: " : "Incomplete: "}</span>{children}</span>
    </li>
  );
}

function requiredTemplateKeys(stages: readonly WhatsAppAutomationStage[], tone: string) {
  const keys = new Set<string>();
  for (const stage of stages) {
    if (stage === "WELCOME") {
      keys.add("WELCOME_GENERAL");
      keys.add("WELCOME_ALLOCATED");
    } else if (stage === "PAYMENT_CONFIRMATION") {
      keys.add("PAYMENT_CONFIRMATION");
    } else if (stage === "PAYMENT_CORRECTION") {
      keys.add("PAYMENT_CORRECTION");
    } else if (stage.startsWith("PAST_DUE")) {
      keys.add(tone === "firm" ? "PAST_DUE_FIRM" : "PAST_DUE_POLITE");
      keys.add("MULTI_STUDENT_COLLECTION_SUMMARY");
    } else {
      keys.add(tone === "friendly" ? "FEE_RENEWAL_FRIENDLY" : "FEE_RENEWAL_POLITE");
      keys.add("MULTI_STUDENT_COLLECTION_SUMMARY");
    }
  }
  return [...keys];
}

export function BranchWhatsAppReadiness({
  response,
  settings = null,
  selectedSenderId,
  busy,
  canManage = response.canManage,
  onSelectedSenderChange,
  onAssign,
  onUnassign,
}: {
  response: WhatsAppBranchAssignmentResponse;
  settings?: WhatsAppBranchSettings | null;
  selectedSenderId: string;
  busy: boolean;
  canManage?: boolean;
  onSelectedSenderChange: (senderId: string) => void;
  onAssign: () => void;
  onUnassign: () => void;
}) {
  const assignment = response.assignment;
  const sender = assignment?.sender ?? null;
  const currentSenderId = sender?.id ?? "";
  const enabledStages = settings?.rules.filter(rule => rule.enabled).map(rule => rule.stage) ?? [];
  const requiredKeys = requiredTemplateKeys(enabledStages, settings?.defaultTone ?? "polite");
  const installedKeys = new Set(settings?.templateHealth.map(template => template.managedKey) ?? []);
  const approvedKeys = new Set(settings?.templateHealth.filter(template =>
    template.active
    && template.template.providerStatus === "APPROVED"
    && template.template.category === "UTILITY"
    && template.template.staleAt === null
  ).map(template => template.managedKey) ?? []);
  const requiredTemplatesInstalled = requiredKeys.length > 0
    && requiredKeys.every(key => installedKeys.has(key));
  const requiredTemplatesApproved = requiredKeys.length > 0
    && requiredKeys.every(key => approvedKeys.has(key));
  const sendTimeConfigured = Boolean(settings && /^\d{2}:\d{2}$/.test(settings.sendTimeLocal));
  const optedInCount = settings?.consentCoverage.optedIn ?? 0;

  return (
    <>
      <ReadOnlyRow
        label="Assigned sender"
        value={sender
          ? `${sender.verifiedName || "WhatsApp business number"} · ${sender.displayPhoneNumber}`
          : "Not assigned"}
      />
      <ReadOnlyRow
        label="Connection readiness"
        value={sender ? (
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <Badge variant={sender.status === "ACTIVE" ? "success" : "warning"}>{titleCase(sender.status)}</Badge>
            <Badge variant={sender.providerMode === "TEST" ? "purple" : "cyan"}>{sender.providerMode}</Badge>
          </span>
        ) : "Unavailable"}
      />
      <ReadOnlyRow
        label="Phone and webhook"
        value={sender?.phoneRegisteredAt && sender.webhookSubscribedAt ? "Provider verified" : "Setup incomplete"}
      />

      <div className="space-y-3 px-5 py-4">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Activation checklist</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          <ChecklistItem complete={sender?.status === "ACTIVE"}>Active sender assigned</ChecklistItem>
          <ChecklistItem complete={requiredTemplatesInstalled}>Managed templates installed</ChecklistItem>
          <ChecklistItem complete={requiredTemplatesApproved}>Required templates approved as Utility</ChecklistItem>
          <ChecklistItem complete={settings?.monthlyBudgetMinor !== null && settings?.monthlyBudgetMinor !== undefined}>Monthly estimated-usage budget</ChecklistItem>
          <ChecklistItem complete={optedInCount > 0}>Operational consent coverage</ChecklistItem>
          <ChecklistItem complete={sendTimeConfigured}>Send time configured</ChecklistItem>
          <ChecklistItem complete={enabledStages.length > 0}>Reminder stages selected</ChecklistItem>
          <ChecklistItem complete={settings?.enabled ?? false}>Branch delivery enabled</ChecklistItem>
          <ChecklistItem complete={settings?.automationEnabled ?? false}>Automation explicitly enabled</ChecklistItem>
        </ul>
      </div>

      {canManage ? (
        <div className="space-y-3 px-5 py-4">
          <SettingsField label="Branch sender assignment" description="Assignment alone does not enable delivery or automation.">
            <SettingsSelect
              value={selectedSenderId}
              onValueChange={onSelectedSenderChange}
              disabled={busy || response.availableSenders.length === 0}
              options={response.availableSenders.length > 0
                ? response.availableSenders.map(option => ({
                    value: option.id,
                    label: `${option.verifiedName || "WhatsApp business number"} · ${option.displayPhoneNumber}`,
                  }))
                : [{ value: "", label: "No active senders available", disabled: true }]}
            />
          </SettingsField>
          <div className="flex flex-wrap justify-end gap-2">
            {sender ? <AppButton variant="quiet" size="sm" disabled={busy} onClick={onUnassign}>Unassign sender</AppButton> : null}
            <AppButton
              variant="primary"
              size="sm"
              isLoading={busy}
              disabled={busy || !selectedSenderId || selectedSenderId === currentSenderId}
              onClick={onAssign}
            >
              Assign sender
            </AppButton>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function BranchWhatsAppSettingsEditor({
  settings,
  form,
  canManage,
  isOwner,
  busy,
  automationConfirmed,
  onAutomationConfirmedChange,
  onFormChange,
  onSave,
  onSetDelivery,
  onSetAutomation,
}: {
  settings: WhatsAppBranchSettings;
  form: BranchSettingsForm;
  canManage: boolean;
  isOwner: boolean;
  busy: boolean;
  automationConfirmed: boolean;
  onAutomationConfirmedChange: (checked: boolean) => void;
  onFormChange: (next: BranchSettingsForm) => void;
  onSave: () => void;
  onSetDelivery: (enabled: boolean) => void;
  onSetAutomation: (enabled: boolean) => void;
}) {
  const parsedBudget = parseBudgetMinor(form.monthlyBudgetRupees);
  const managerBudgetIncrease = !isOwner
    && parsedBudget !== undefined
    && parsedBudget !== null
    && (settings.monthlyBudgetMinor === null || parsedBudget > settings.monthlyBudgetMinor);
  const budgetError = parsedBudget === undefined
    ? "Enter an amount from ₹0.01 to ₹100,000 with at most two decimals."
    : managerBudgetIncrease
      ? "Only the organization owner can increase the budget."
      : null;
  const parsedDailyLimit = Number(form.dailyAutomaticMessageLimit);
  const parsedCycleLimit = Number(form.maxAutomaticCollectionMessagesPerCycle);
  const dailyLimitError = !isOwner
    && Number.isSafeInteger(parsedDailyLimit)
    && parsedDailyLimit > settings.dailyAutomaticMessageLimit
    ? "Only the organization owner can increase automatic message limits."
    : null;
  const cycleLimitError = !isOwner
    && Number.isSafeInteger(parsedCycleLimit)
    && parsedCycleLimit > settings.maxAutomaticCollectionMessagesPerCycle
    ? "Only the organization owner can increase automatic message limits."
    : null;
  const enabledStageCount = settings.rules.filter(rule => rule.enabled).length;
  const enabledStages = settings.rules.filter(rule => rule.enabled).map(rule => rule.stage);
  const requiredKeys = requiredTemplateKeys(enabledStages, settings.defaultTone);
  const approvedKeys = new Set(settings.templateHealth.filter(template =>
    template.active
    && template.template.providerStatus === "APPROVED"
    && template.template.category === "UTILITY"
    && template.template.staleAt === null
  ).map(template => template.managedKey));
  const automationPrerequisitesMet = settings.enabled
    && settings.sender?.status === "ACTIVE"
    && settings.monthlyBudgetMinor !== null
    && /^\d{2}:\d{2}$/.test(settings.sendTimeLocal)
    && enabledStageCount > 0
    && requiredKeys.every(key => approvedKeys.has(key))
    && settings.consentCoverage.optedIn > 0;

  return (
    <>
      <SettingsField label="Default language" description="Only Lab Lords-managed English (India) and Hindi Utility templates are supported.">
        <SettingsSelect
          value={form.defaultLanguage}
          onValueChange={value => onFormChange({ ...form, defaultLanguage: value as WhatsAppManagedLanguage })}
          disabled={!canManage || busy}
          options={[{ value: "en_IN", label: "English (India)" }, { value: "hi", label: "Hindi" }]}
        />
      </SettingsField>
      <SettingsField label="Reminder tone" description="Tone selects a fixed approved catalogue variant; it is not custom text.">
        <SettingsSelect
          value={form.defaultTone}
          onValueChange={value => onFormChange({ ...form, defaultTone: value as BranchSettingsForm["defaultTone"] })}
          disabled={!canManage || busy}
          options={[{ value: "polite", label: "Polite" }, { value: "friendly", label: "Friendly" }, { value: "firm", label: "Firm" }]}
        />
      </SettingsField>
      <SettingsField label="Send time" description={`Local branch time in ${settings.timeZone}.`}>
        <SettingsInput type="time" value={form.sendTimeLocal} onChange={event => onFormChange({ ...form, sendTimeLocal: event.target.value })} disabled={!canManage || busy} />
      </SettingsField>
      <SettingsField label="Daily automatic limit" description={isOwner ? "Automatic messages are additionally limited by consent, stages, frequency, and budget." : "Managers may keep or reduce this limit; only the owner may increase it."} error={dailyLimitError}>
        <SettingsInput type="number" min={1} max={isOwner ? 200 : settings.dailyAutomaticMessageLimit} inputMode="numeric" value={form.dailyAutomaticMessageLimit} onChange={event => onFormChange({ ...form, dailyAutomaticMessageLimit: event.target.value })} disabled={!canManage || busy} />
      </SettingsField>
      <SettingsField label="Collection messages per cycle" description={isOwner ? "Maximum automatic collection reminders per student billing cycle." : "Managers may keep or reduce this limit; only the owner may increase it."} error={cycleLimitError}>
        <SettingsInput type="number" min={1} max={isOwner ? 4 : settings.maxAutomaticCollectionMessagesPerCycle} inputMode="numeric" value={form.maxAutomaticCollectionMessagesPerCycle} onChange={event => onFormChange({ ...form, maxAutomaticCollectionMessagesPerCycle: event.target.value })} disabled={!canManage || busy} />
      </SettingsField>
      <SettingsField
        label="Monthly estimated-usage budget"
        description={isOwner
          ? "Organization owners may set or increase this Lab Lords reservation ceiling."
          : "Managers may keep or reduce the current ceiling; only the owner may increase it."}
        error={budgetError}
      >
        <SettingsInput
          type="text"
          inputMode="decimal"
          value={form.monthlyBudgetRupees}
          onChange={event => onFormChange({ ...form, monthlyBudgetRupees: event.target.value })}
          placeholder="Amount in INR"
          disabled={!canManage || busy || (!isOwner && settings.monthlyBudgetMinor === null)}
          aria-label="Monthly estimated usage budget in INR"
        />
      </SettingsField>

      <div className="space-y-3 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Automation stages</h3>
          <p className="mt-1 text-xs text-[color:var(--text-muted)]">Stages use trusted payment state and fixed approved Utility templates. They start prospectively after activation.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {WHATSAPP_AUTOMATION_STAGES.map(stage => (
            <label key={stage} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={form.rules[stage]}
                onChange={event => onFormChange({ ...form, rules: { ...form.rules, [stage]: event.target.checked } })}
                disabled={!canManage || busy}
                className="h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
              />
              <span>{STAGE_LABELS[stage]}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap justify-end gap-2">
          <AppButton variant="secondary" size="sm" onClick={onSave} disabled={!canManage || busy || Boolean(budgetError || dailyLimitError || cycleLimitError)} isLoading={busy}>Save WhatsApp settings</AppButton>
          <AppButton
            variant={settings.enabled ? "danger" : "primary"}
            size="sm"
            onClick={() => onSetDelivery(!settings.enabled)}
            disabled={!canManage || busy || (!settings.enabled && settings.monthlyBudgetMinor === null)}
          >
            {settings.enabled ? "Disable branch delivery" : "Enable branch delivery"}
          </AppButton>
        </div>
        {settings.enabled ? (
          <>
            {!settings.automationEnabled ? (
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={automationConfirmed}
                  onChange={event => onAutomationConfirmedChange(event.target.checked)}
                  disabled={!canManage || busy}
                  className="mt-0.5 h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
                />
                <span>
                  I understand messages may incur charges in the customer-owned Meta account; only future stages will be automated; historical dues will not be automatically blasted; Meta determines final billing; and STOP immediately suppresses future unsubmitted messages.
                </span>
              </label>
            ) : null}
            <div className="flex justify-end">
              <AppButton
                variant={settings.automationEnabled ? "danger" : "primary"}
                size="sm"
                onClick={() => onSetAutomation(!settings.automationEnabled)}
                disabled={!canManage || busy || (!settings.automationEnabled && (!automationConfirmed || !automationPrerequisitesMet))}
              >
                {settings.automationEnabled ? "Disable automation" : "Enable prospective automation"}
              </AppButton>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function BranchWhatsAppHealth({ settings }: { settings: WhatsAppBranchSettings }) {
  const queuedCount = ["SCHEDULED", "CLAIMED", "SUBMITTING"]
    .reduce((count, status) => count + (settings.deliveryHealth[status] ?? 0), 0);
  const healthEntries = [
    ["Queued", queuedCount],
    ["Accepted", settings.deliveryHealth.ACCEPTED ?? 0],
    ["Delivered", settings.deliveryHealth.DELIVERED ?? 0],
    ["Read", settings.deliveryHealth.READ ?? 0],
    ["Failed", settings.deliveryHealth.FAILED ?? 0],
    ["Unknown", settings.deliveryHealth.UNKNOWN ?? 0],
  ] as const;
  const lastPlannedAt = settings.lastPlannedAt ? new Date(settings.lastPlannedAt) : null;
  const lastPlannedLabel = lastPlannedAt && !Number.isNaN(lastPlannedAt.getTime())
    ? lastPlannedAt.toLocaleString()
    : "Not yet";
  const lastWebhookAt = settings.lastWebhookReceivedAt
    ? new Date(settings.lastWebhookReceivedAt)
    : null;
  const lastWebhookLabel = lastWebhookAt && !Number.isNaN(lastWebhookAt.getTime())
    ? lastWebhookAt.toLocaleString()
    : "Not yet";
  return (
    <>
      <ReadOnlyRow label="Estimated budget ceiling" value={estimatedInr(settings.budget.ceilingMicros)} />
      <ReadOnlyRow label="Reserved estimate" value={estimatedInr(settings.budget.reservedMicros)} />
      <ReadOnlyRow label="Committed estimate" value={estimatedInr(settings.budget.committedMicros)} />
      <ReadOnlyRow label="Estimated remaining" value={estimatedInr(settings.budget.remainingMicros)} />
      <ReadOnlyRow label="Consent coverage" value={`${settings.consentCoverage.optedIn} opted in · ${settings.consentCoverage.associated} associated · ${settings.consentCoverage.activeStudents} active students`} />
      <ReadOnlyRow label="Consent exceptions" value={`${settings.consentCoverage.missingPhone} missing phone · ${settings.consentCoverage.stale} stale · ${settings.consentCoverage.optedOut} opted out`} />
      <ReadOnlyRow label={`Delivery health (${settings.deliveryHealthWindowDays} days)`} value={healthEntries.map(([status, count]) => `${status} ${count}`).join(" · ")} />
      <ReadOnlyRow label="Last signed webhook received" value={lastWebhookLabel} />
      <ReadOnlyRow label="Last planner run" value={lastPlannedLabel} />
      {settings.lastPlannerErrorCode ? (
        <div className="flex items-start gap-3 px-5 py-4 text-sm text-[color:var(--ui-form-error-text)]" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> Planner health code: {settings.lastPlannerErrorCode}
        </div>
      ) : null}
      <div className="px-5 py-4 text-xs text-[color:var(--text-muted)]">Usage figures are Lab Lords estimates. Meta determines final charges in the customer’s Meta account.</div>
    </>
  );
}

export function BranchWhatsAppPanel({
  organizationId,
  branchId,
  branchName,
  canView,
  canManage = false,
  canReceiveReports = false,
  canOperateReports = canReceiveReports,
  canSendNotices = false,
  isOwner = false,
  onAvailabilityChange,
}: {
  organizationId: string;
  branchId: string;
  branchName: string;
  canView: boolean;
  canManage?: boolean;
  canReceiveReports?: boolean;
  canOperateReports?: boolean;
  canSendNotices?: boolean;
  isOwner?: boolean;
  onAvailabilityChange: (available: boolean) => void;
}) {
  const [response, setResponse] = useState<WhatsAppBranchAssignmentResponse | null>(null);
  const [settings, setSettings] = useState<WhatsAppBranchSettings | null>(null);
  const [form, setForm] = useState<BranchSettingsForm | null>(null);
  const [selectedSenderId, setSelectedSenderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [automationConfirmed, setAutomationConfirmed] = useState(false);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; message: string } | null>(null);
  const [reportSubscriptionResponse, setReportSubscriptionResponse] = useState<WhatsAppReportSubscriptionResponse | null>(null);
  const [serviceNoticeResponse, setServiceNoticeResponse] = useState<WhatsAppServiceNoticeListResponse | null>(null);
  const [incidentResponse, setIncidentResponse] = useState<WhatsAppIncidentListResponse | null>(null);
  const availabilityHandlerRef = useRef(onAvailabilityChange);
  const mutationRef = useRef(false);

  useEffect(() => {
    availabilityHandlerRef.current = onAvailabilityChange;
  }, [onAvailabilityChange]);

  const fetchOverview = useCallback(async () => {
    const [assignmentResult, settingsResult, reportSubscriptionResult] = await Promise.allSettled([
      whatsapp.getBranchAssignment(organizationId, branchId),
      whatsapp.getBranchSettings(branchId),
      canReceiveReports
        ? whatsapp.getBranchReportSubscription(branchId)
        : Promise.resolve(null),
    ]);
    if (assignmentResult.status === "rejected") throw assignmentResult.reason;
    const assignment = assignmentResult.value;
    const reportSubscription = reportSubscriptionResult.status === "fulfilled"
      ? reportSubscriptionResult.value
      : null;
    const [incidentResult, serviceNoticeResult] = reportSubscription?.operationsUiEnabled === true
      ? await Promise.allSettled([
          whatsapp.listBranchIncidents(branchId),
          canSendNotices
            ? whatsapp.listBranchServiceNotices(branchId)
            : Promise.resolve(null),
        ])
      : [null, null];
    const incidents = incidentResult?.status === "fulfilled" ? incidentResult.value : null;
    const serviceNotices = serviceNoticeResult?.status === "fulfilled"
      ? serviceNoticeResult.value
      : null;
    if (!assignment.enabled) {
      return { assignment, settings: null, reportSubscription, incidents, serviceNotices };
    }
    // A branch settings row is created by the owner-only sender assignment.
    // Keep that first assignment reachable even though the settings resource
    // correctly returns not-found before the row exists.
    if (settingsResult.status === "rejected") {
      if (!assignment.assignment) {
        return { assignment, settings: null, reportSubscription, incidents, serviceNotices };
      }
      throw settingsResult.reason;
    }
    return {
      assignment,
      settings: settingsResult.value,
      reportSubscription,
      incidents,
      serviceNotices,
    };
  }, [branchId, canReceiveReports, canSendNotices, organizationId]);

  const applyOverview = useCallback((overview: Awaited<ReturnType<typeof fetchOverview>>) => {
    setResponse(overview.assignment);
    setSettings(overview.settings);
    setForm(overview.settings ? settingsForm(overview.settings) : null);
    setReportSubscriptionResponse(
      overview.reportSubscription?.operationsUiEnabled === true
        ? overview.reportSubscription
        : null
    );
    setIncidentResponse(overview.incidents);
    setServiceNoticeResponse(overview.serviceNotices);
    setSelectedSenderId(overview.assignment.assignment?.sender?.id ?? overview.assignment.availableSenders[0]?.id ?? "");
    availabilityHandlerRef.current(overview.assignment.enabled);
  }, []);

  const reload = useCallback(async () => {
    const overview = await fetchOverview();
    applyOverview(overview);
  }, [applyOverview, fetchOverview]);

  useEffect(() => {
    let cancelled = false;
    availabilityHandlerRef.current(false);
    setResponse(null);
    setSettings(null);
    setForm(null);
    setReportSubscriptionResponse(null);
    setIncidentResponse(null);
    setServiceNoticeResponse(null);
    setNotice(null);
    if (!canView) return;
    const load = async () => {
      try {
        const overview = await fetchOverview();
        if (!cancelled) applyOverview(overview);
      } catch {
        if (!cancelled) {
          availabilityHandlerRef.current(false);
          setNotice({ tone: "error", message: "WhatsApp branch settings are unavailable right now." });
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [applyOverview, canView, fetchOverview]);

  if (!canView || !response?.enabled) return null;
  const mayManageBranch = canManage;
  const mayManageAssignment = isOwner && response.canManage;
  const branchReportSubscription = reportSubscriptionResponse?.subscription
    ? {
        ...reportSubscriptionResponse.subscription,
        senderLabel: response.assignment?.sender?.id === reportSubscriptionResponse.subscription.senderId
          ? response.assignment.sender.verifiedName
          : null,
      }
    : null;
  const presentedIncidents = incidentResponse
    ? presentWhatsAppIncidentResponse(incidentResponse, {
        scopeLabel: branchName,
        senderLabels: response.assignment?.sender
          ? {
              [response.assignment.sender.id]: response.assignment.sender.verifiedName
                || response.assignment.sender.displayPhoneNumber,
            }
          : undefined,
      })
    : null;

  const runMutation = async (
    allowed: boolean,
    message: string,
    operation: () => Promise<unknown>
  ) => {
    if (mutationRef.current || busy || !allowed) return;
    mutationRef.current = true;
    setBusy(true);
    setNotice({ tone: "status", message });
    try {
      await operation();
      await reload();
      setAutomationConfirmed(false);
      setNotice({ tone: "status", message: "WhatsApp branch settings were updated." });
    } catch {
      setNotice({ tone: "error", message: "The WhatsApp change could not be applied safely." });
    } finally {
      mutationRef.current = false;
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    if (!form) return;
    const budgetMinor = parseBudgetMinor(form.monthlyBudgetRupees);
    const dailyLimit = Number(form.dailyAutomaticMessageLimit);
    const cycleLimit = Number(form.maxAutomaticCollectionMessagesPerCycle);
    if (budgetMinor === undefined || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 200 || !Number.isInteger(cycleLimit) || cycleLimit < 1 || cycleLimit > 4) {
      setNotice({ tone: "error", message: "Review the budget and message limits before saving." });
      return;
    }
    await runMutation(mayManageBranch, "Saving WhatsApp settings…", () => whatsapp.updateBranchSettings(branchId, {
      defaultLanguage: form.defaultLanguage,
      defaultTone: form.defaultTone,
      sendTimeLocal: form.sendTimeLocal,
      dailyAutomaticMessageLimit: dailyLimit,
      maxAutomaticCollectionMessagesPerCycle: cycleLimit,
      monthlyBudgetMinor: budgetMinor,
      rules: WHATSAPP_AUTOMATION_STAGES.map(stage => ({ stage, enabled: form.rules[stage] })),
    }));
  };

  return (
    <>
    <SettingsPanel id="whatsapp" title="WhatsApp" description="Configure consent-based delivery using only approved Lab Lords Utility templates." icon={MessageCircle}>
      {response.safeReason ? <div className="px-5 py-4 text-sm text-[color:var(--text-secondary)]">{response.safeReason}</div> : null}
      {notice ? (
        <div className="px-5 py-4">
          <p role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"} className={notice.tone === "error" ? "text-sm text-[color:var(--ui-form-error-text)]" : "text-sm text-[color:var(--text-secondary)]"}>{notice.message}</p>
        </div>
      ) : null}
      <BranchWhatsAppReadiness
        response={response}
        settings={settings}
        selectedSenderId={selectedSenderId}
        busy={busy}
        canManage={mayManageAssignment}
        onSelectedSenderChange={setSelectedSenderId}
        onAssign={() => void runMutation(mayManageAssignment, "Assigning the organization-owned sender…", () => whatsapp.assignBranch(organizationId, branchId, selectedSenderId))}
        onUnassign={() => void runMutation(mayManageAssignment, "Removing the sender assignment…", () => whatsapp.unassignBranch(organizationId, branchId))}
      />
      {settings && form ? (
        <BranchWhatsAppSettingsEditor
          settings={settings}
          form={form}
          canManage={mayManageBranch}
          isOwner={isOwner}
          busy={busy}
          automationConfirmed={automationConfirmed}
          onAutomationConfirmedChange={setAutomationConfirmed}
          onFormChange={setForm}
          onSave={() => void saveSettings()}
          onSetDelivery={enabled => void runMutation(mayManageBranch, enabled ? "Enabling branch delivery…" : "Disabling branch delivery…", () => whatsapp.setBranchDelivery(branchId, enabled))}
          onSetAutomation={enabled => void runMutation(mayManageBranch, enabled ? "Enabling prospective automation…" : "Disabling automation…", () => whatsapp.setBranchAutomation(branchId, enabled))}
        />
      ) : null}
      {settings ? (
        <div className="divide-y divide-[color:var(--ui-form-section-divider)]">
          <div className="flex items-center gap-2 px-5 py-4"><HeartPulse className="h-4 w-4 text-[color:var(--ui-form-accent)]" aria-hidden="true" /><h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Delivery health</h3></div>
          <BranchWhatsAppHealth settings={settings} />
          <div className="space-y-3 px-5 py-4"><h3 className="text-sm font-semibold text-[color:var(--text-primary)]">Branch message history</h3><BranchWhatsAppMessageHistory branchId={branchId} /></div>
        </div>
      ) : null}
    </SettingsPanel>
    {reportSubscriptionResponse?.operationsUiEnabled === true ? (
      <>
        <WhatsAppReportSubscription
          scope="BRANCH"
          subscription={branchReportSubscription}
          canManage={canOperateReports}
          blockedReason="Daily-report changes require a writable branch plus WhatsApp viewing, report receiving, payment viewing, analytics, and the WhatsApp entitlement."
          onCreate={async draft => {
            const result = await whatsapp.createBranchReportSubscription(branchId, {
              phone: draft.phoneE164,
              language: draft.language,
              sendTimeLocal: draft.sendTimeLocal,
            });
            setReportSubscriptionResponse(current => current
              ? { ...current, subscription: result.subscription }
              : current);
            return requireReportChallenge(result);
          }}
          onReissue={async () => {
            const result = await whatsapp.reissueBranchReportSubscription(branchId);
            setReportSubscriptionResponse(current => current
              ? { ...current, subscription: result.subscription }
              : current);
            return requireReportChallenge(result);
          }}
          onPause={async () => {
            const result = await whatsapp.pauseBranchReportSubscription(branchId);
            setReportSubscriptionResponse(current => current
              ? { ...current, subscription: result.subscription }
              : current);
          }}
          onRevoke={async () => {
            const result = await whatsapp.revokeBranchReportSubscription(
              branchId,
              reportSubscriptionResponse.subscription?.id
            );
            setReportSubscriptionResponse(current => current
              ? { ...current, subscription: result.subscription }
              : current);
          }}
          onRefresh={async () => {
            const result = await whatsapp.getBranchReportSubscription(branchId);
            if (result.operationsUiEnabled !== true) {
              setReportSubscriptionResponse(null);
              return null;
            }
            setReportSubscriptionResponse(result);
            const subscription = result.subscription;
            if (!subscription) return null;
            return {
              ...subscription,
              senderLabel: response.assignment?.sender?.id === subscription.senderId
                ? response.assignment.sender.verifiedName
                : null,
            };
          }}
        />
        {settings ? (
          <BranchWhatsAppReports
            branchName={branchName}
            settings={{
              enabled: settings.enabled,
              senderId: settings.sender?.id ?? null,
              senderLabel: settings.sender?.displayPhoneNumber ?? null,
              monthlyBudgetMinor: settings.monthlyBudgetMinor,
              budgetSource: "BRANCH",
            }}
            canConfigure={mayManageBranch}
            canQueue={canOperateReports}
            blockedReason="Daily-report preview and queue actions require a writable branch and the complete report-recipient permission set."
            recentReports={[]}
            onSetEnabled={async enabled => {
              await whatsapp.setBranchDelivery(branchId, enabled);
              await reload();
            }}
            onPreview={async () => presentWhatsAppDailyReportPreview(
              await whatsapp.previewBranchDailyReport(branchId)
            )}
            onQueue={async idempotencyKey => presentWhatsAppDailyReportQueueResult(
              await whatsapp.queueBranchDailyReport(branchId, idempotencyKey)
            )}
          />
        ) : null}
        {serviceNoticeResponse ? (
          <WhatsAppServiceNoticeComposer
            branchName={branchName}
            canManage={canSendNotices}
            blockedReason="Operational notices require WhatsApp viewing, sending, management, the WhatsApp entitlement, and a writable branch."
            recentNotices={serviceNoticeResponse.notices}
            onPreview={draft => whatsapp.previewBranchServiceNotice(branchId, draft)}
            onQueue={async (draft, idempotencyKey) => {
              const result = await whatsapp.queueBranchServiceNotice(branchId, draft, idempotencyKey);
              await reload();
              return result;
            }}
            onCancel={async noticeId => {
              const result = await whatsapp.cancelBranchServiceNotice(branchId, noticeId);
              await reload();
              return result;
            }}
          />
        ) : null}
        {presentedIncidents ? (
          <WhatsAppIncidents
            incidents={presentedIncidents.incidents}
            unknownOutcomes={presentedIncidents.unknownOutcomes}
            canAcknowledge={canManage}
            blockedReason="WhatsApp management permission and a writable branch are required to acknowledge incidents."
            nextCursor={null}
            onAcknowledge={async incidentId => {
              await whatsapp.acknowledgeBranchIncident(branchId, incidentId);
              await reload();
            }}
          />
        ) : null}
      </>
    ) : null}
    </>
  );
}
