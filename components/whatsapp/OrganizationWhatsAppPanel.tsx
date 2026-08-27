"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, MessageCircle, PackageCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { AppButton } from "@/components/ui/AppButton";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsPanel,
  SettingsSubtleText,
} from "@/components/settings/SettingsWorkspace";
import { MetaEmbeddedSignup } from "@/components/whatsapp/MetaEmbeddedSignup";
import { RegisterPhoneDialog } from "@/components/whatsapp/RegisterPhoneDialog";
import { WhatsAppReportSubscription } from "@/components/whatsapp/WhatsAppReportSubscription";
import {
  OrganizationWhatsAppReports,
  presentWhatsAppDailyReportPreview,
  presentWhatsAppDailyReportQueueResult,
} from "@/components/whatsapp/OrganizationWhatsAppReports";
import {
  WhatsAppIncidents,
  presentWhatsAppIncidentResponse,
} from "@/components/whatsapp/WhatsAppIncidents";
import { WhatsAppSenderSafety } from "@/components/whatsapp/WhatsAppSenderSafety";
import {
  whatsapp,
  type WhatsAppIncidentListResponse,
  type WhatsAppOrganizationReportSettingsResponse,
  type WhatsAppReportSubscription as WhatsAppReportSubscriptionDto,
  type WhatsAppReportSubscriptionResponse,
  type WhatsAppSenderSafety as WhatsAppSenderSafetyDto,
  type WhatsAppSenderStatus,
  type WhatsAppSenderSummary,
  type WhatsAppSendersResponse,
  type WhatsAppManagedTemplateInstallation,
} from "@/lib/api/whatsapp";
import type { WhatsAppBrowserConfig } from "@/types";

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}

function senderStatusVariant(status: WhatsAppSenderStatus) {
  if (status === "ACTIVE") return "success" as const;
  if (status === "RESTRICTED" || status === "NEEDS_REGISTRATION") return "warning" as const;
  if (status === "ERROR" || status === "DISCONNECTED") return "danger" as const;
  return "default" as const;
}

function safeDateLabel(value: string | null) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
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

export async function loadManagedTemplateStatuses(
  organizationId: string,
  senderIds: readonly string[]
) {
  const results = await Promise.allSettled(
    senderIds.map(senderId => whatsapp.getManagedTemplateStatus(organizationId, senderId))
  );
  return Object.fromEntries(results.flatMap((result, index) => {
    if (result.status !== "fulfilled" || result.value.installation.templates.length === 0) {
      return [];
    }
    return [[senderIds[index], result.value.installation]];
  })) as Record<string, WhatsAppManagedTemplateInstallation>;
}

export function WhatsAppSenderSummaryCard({
  sender,
  canManage,
  activeOperation,
  onRegister,
  onSync,
  onInstall,
  onDisconnect,
  installation = null,
}: {
  sender: WhatsAppSenderSummary;
  canManage: boolean;
  activeOperation: string | null;
  onRegister: (sender: WhatsAppSenderSummary) => void;
  onSync: (sender: WhatsAppSenderSummary) => void;
  onInstall?: (sender: WhatsAppSenderSummary) => void;
  onDisconnect: (sender: WhatsAppSenderSummary) => void;
  installation?: WhatsAppManagedTemplateInstallation | null;
}) {
  const busy = activeOperation !== null;
  const branchNames = sender.assignedBranches.map(branch => branch.name);
  const installationLanguages = installation
    ? [...new Set(installation.templates.map(template => template.language))]
    : [];

  return (
    <SettingsCard className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="font-semibold text-[color:var(--text-primary)]">
            {sender.verifiedName || "WhatsApp business number"}
          </p>
          <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
            {sender.displayPhoneNumber}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={sender.providerMode === "TEST" ? "purple" : "cyan"}>
            {sender.providerMode}
          </Badge>
          <Badge variant={senderStatusVariant(sender.status)}>
            {statusLabel(sender.status)}
          </Badge>
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-[color:var(--text-muted)]">Phone registration</dt>
          <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
            {sender.phoneRegisteredAt ? "Provider verified" : "Registration required"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[color:var(--text-muted)]">Webhook subscription</dt>
          <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
            {sender.webhookSubscribedAt ? "Provider verified" : "Not verified"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[color:var(--text-muted)]">Quality</dt>
          <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
            {sender.qualityRating || "Unavailable"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[color:var(--text-muted)]">Account mode</dt>
          <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
            {sender.accountMode || "Unavailable"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[color:var(--text-muted)]">Last health check</dt>
          <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
            {safeDateLabel(sender.lastHealthCheckAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[color:var(--text-muted)]">Last template sync</dt>
          <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
            {safeDateLabel(sender.lastTemplateSyncAt)}
          </dd>
        </div>
      </dl>

      <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] px-3 py-2 text-xs text-[color:var(--text-secondary)]">
        Templates: {sender.templateCounts.approved} approved, {sender.templateCounts.pending} pending, {sender.templateCounts.rejected} rejected, {sender.templateCounts.other} other.
      </div>

      {installation ? (
        <div className="space-y-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-[color:var(--text-primary)]">
              Lab Lords Utility catalogue v{installation.catalogVersion}
            </p>
            <span className="text-xs text-[color:var(--text-muted)]">
              {installation.templates.filter(template => template.active).length}/{installation.templates.length} active
            </span>
          </div>
          <p className="text-xs text-[color:var(--text-muted)]">
            Languages: {installationLanguages.map(language =>
              language === "hi" ? "Hindi" : "English (India)"
            ).join(", ")}
          </p>
          <ul className="grid gap-2 text-xs sm:grid-cols-2" aria-label="Managed Utility template status">
            {installation.templates.map(template => {
              const providerStatus = template.providerStatus
                ? statusLabel(template.providerStatus)
                : "Not synchronized";
              const providerCategory = template.providerCategory
                ? statusLabel(template.providerCategory)
                : "Category unavailable";
              return (
                <li
                  key={`${template.managedKey}:${template.language}`}
                  className="space-y-1 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{statusLabel(template.managedKey)} · {template.language === "hi" ? "Hindi" : "English (India)"}</span>
                    <span className="shrink-0 font-medium">{statusLabel(template.status)}</span>
                  </div>
                  <p className="text-[color:var(--text-muted)]">
                    Provider: {providerStatus} · {providerCategory}
                  </p>
                  <p className="text-[color:var(--text-muted)]">
                    {template.active ? "Binding active" : "Binding inactive"} · Last synchronized: {safeDateLabel(template.lastSyncedAt)}
                  </p>
                  {template.errorCode ? (
                    <p className="text-[color:var(--ui-form-error-text)]">
                      Review code: {statusLabel(template.errorCode)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {installation.templates.some(template => template.status === "UNKNOWN") ? (
            <p className="flex items-start gap-2 text-xs text-[color:var(--ui-form-warning-text)]" role="alert">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Meta may have accepted a template creation. Do not retry; synchronize or request operator review.
            </p>
          ) : null}
          {installation.templates.some(template => template.status === "REJECTED" || template.status === "FAILED") ? (
            <p className="text-xs text-[color:var(--ui-form-error-text)]" role="status">
              One or more managed Utility templates need review before branch activation.
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <p className="text-xs font-medium text-[color:var(--text-muted)]">Assigned branches</p>
        <p className="mt-1 text-sm text-[color:var(--text-primary)]">
          {branchNames.length > 0 ? branchNames.join(", ") : "No branches assigned"}
        </p>
      </div>

      {canManage ? (
        <div className="flex flex-wrap gap-2 border-t border-[color:var(--ui-form-section-divider)] pt-3">
          {sender.status === "NEEDS_REGISTRATION" ? (
            <AppButton
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onRegister(sender)}
            >
              Complete registration
            </AppButton>
          ) : null}
          {sender.status !== "DISCONNECTED" ? (
            onInstall ? (
              <AppButton
                size="sm"
                variant="secondary"
                icon={PackageCheck}
                isLoading={activeOperation === `install:${sender.id}`}
                disabled={busy || sender.status !== "ACTIVE"}
                onClick={() => onInstall(sender)}
              >
                Install Lab Lords Utility templates
              </AppButton>
            ) : null
          ) : null}
          {sender.status !== "DISCONNECTED" ? (
            <AppButton
              size="sm"
              variant="secondary"
              icon={RefreshCw}
              isLoading={activeOperation === `sync:${sender.id}`}
              disabled={busy}
              onClick={() => onSync(sender)}
            >
              Synchronize templates
            </AppButton>
          ) : null}
          {sender.status !== "DISCONNECTED" ? (
            <AppButton
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => onDisconnect(sender)}
            >
              Disconnect locally
            </AppButton>
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  );
}

export function OrganizationWhatsAppPanel({
  organizationId,
  organizationName,
  onAvailabilityChange,
}: {
  organizationId: string;
  organizationName: string;
  onAvailabilityChange: (available: boolean) => void;
}) {
  const [config, setConfig] = useState<WhatsAppBrowserConfig | null>(null);
  const [sendersResponse, setSendersResponse] = useState<WhatsAppSendersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{
    tone: "status" | "error";
    message: string;
  } | null>(null);
  const [activeOperation, setActiveOperation] = useState<string | null>(null);
  const [installations, setInstallations] = useState<Record<string, WhatsAppManagedTemplateInstallation>>({});
  const [registrationSender, setRegistrationSender] = useState<WhatsAppSenderSummary | null>(null);
  const [disconnectSender, setDisconnectSender] = useState<WhatsAppSenderSummary | null>(null);
  const [reportSubscriptionResponse, setReportSubscriptionResponse] = useState<WhatsAppReportSubscriptionResponse | null>(null);
  const [reportSettingsResponse, setReportSettingsResponse] = useState<WhatsAppOrganizationReportSettingsResponse | null>(null);
  const [incidentResponse, setIncidentResponse] = useState<WhatsAppIncidentListResponse | null>(null);
  const [senderSafety, setSenderSafety] = useState<Record<string, WhatsAppSenderSafetyDto>>({});
  const availabilityHandlerRef = useRef(onAvailabilityChange);
  const operationRef = useRef(false);
  const reportLoadRef = useRef(0);

  useEffect(() => {
    availabilityHandlerRef.current = onAvailabilityChange;
  }, [onAvailabilityChange]);

  const loadReportOperations = useCallback(async () => {
    const requestId = ++reportLoadRef.current;
    try {
      const subscriptionResponse = await whatsapp.getOrganizationReportSubscription(organizationId);
      if (requestId !== reportLoadRef.current) return;
      if (subscriptionResponse.operationsUiEnabled !== true) {
        setReportSubscriptionResponse(null);
        setReportSettingsResponse(null);
        setIncidentResponse(null);
        setSenderSafety({});
        return;
      }
      const [settingsResult, incidentResult] = await Promise.allSettled([
        whatsapp.getOrganizationReportSettings(organizationId),
        whatsapp.listOrganizationIncidents(organizationId),
      ]);
      if (requestId !== reportLoadRef.current) return;
      setReportSubscriptionResponse(subscriptionResponse);
      setReportSettingsResponse(
        settingsResult.status === "fulfilled"
          && settingsResult.value.operationsUiEnabled === true
          ? settingsResult.value
          : null
      );
      setIncidentResponse(incidentResult.status === "fulfilled" ? incidentResult.value : null);
    } catch {
      if (requestId !== reportLoadRef.current) return;
      setReportSubscriptionResponse(null);
      setReportSettingsResponse(null);
      setIncidentResponse(null);
      setSenderSafety({});
    }
  }, [organizationId]);

  const loadSenders = useCallback(async () => {
    const response = await whatsapp.listSenders(organizationId);
    setSendersResponse(response);
    const loadedInstallations = await loadManagedTemplateStatuses(
      organizationId,
      response.senders.map(sender => sender.id)
    );
    setInstallations(current => Object.fromEntries(response.senders.flatMap(sender => {
      const installation = loadedInstallations[sender.id] ?? current[sender.id];
      return installation ? [[sender.id, installation]] : [];
    })));
    if (!response.enabled) {
      availabilityHandlerRef.current(false);
      setConfig(previous => previous ? { ...previous, enabled: false } : previous);
    }
    return response;
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    if (
      reportSubscriptionResponse?.operationsUiEnabled !== true
      || !sendersResponse
    ) {
      return;
    }
    const load = async () => {
      const results = await Promise.allSettled(
        sendersResponse.senders.map(sender => whatsapp.getSenderSafety(organizationId, sender.id))
      );
      if (cancelled) return;
      setSenderSafety(Object.fromEntries(results.flatMap((result, index) => (
        result.status === "fulfilled"
          ? [[sendersResponse.senders[index].id, result.value] as const]
          : []
      ))));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, reportSubscriptionResponse?.operationsUiEnabled, sendersResponse]);

  useEffect(() => {
    let cancelled = false;
    availabilityHandlerRef.current(false);
    setLoading(true);
    setConfig(null);
    setSendersResponse(null);
    setInstallations({});
    setReportSubscriptionResponse(null);
    setReportSettingsResponse(null);
    setIncidentResponse(null);
    setSenderSafety({});
    setNotice(null);

    const load = async () => {
      try {
        const browserConfig = await whatsapp.getBrowserConfig(organizationId);
        if (cancelled) return;
        if (!browserConfig.enabled) {
          availabilityHandlerRef.current(false);
          setConfig(browserConfig);
          return;
        }

        setConfig(browserConfig);
        availabilityHandlerRef.current(true);
        const [response] = await Promise.all([
          whatsapp.listSenders(organizationId),
          loadReportOperations(),
        ]);
        if (cancelled) return;
        setSendersResponse(response);
        const loadedInstallations = await loadManagedTemplateStatuses(
          organizationId,
          response.senders.map(sender => sender.id)
        );
        if (!cancelled) setInstallations(loadedInstallations);
      } catch {
        if (!cancelled) {
          availabilityHandlerRef.current(false);
          setNotice({ tone: "error", message: "WhatsApp settings are unavailable right now." });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      reportLoadRef.current += 1;
    };
  }, [loadReportOperations, organizationId]);

  if (!config?.enabled) return null;

  const canManage = sendersResponse?.canManage ?? false;
  const availableConfig = config.appId
    && config.embeddedSignupConfigId
    && config.graphApiVersion
    ? {
        appId: config.appId,
        embeddedSignupConfigId: config.embeddedSignupConfigId,
        graphApiVersion: config.graphApiVersion,
      }
    : null;
  const connectionDisabled = !canManage || config.connectionAvailability !== "AVAILABLE";
  const connectionReason = sendersResponse?.safeReason ?? config.safeReason;
  const organizationReportSubscription = reportSubscriptionResponse?.subscription
    ? {
        ...reportSubscriptionResponse.subscription,
        senderLabel: sendersResponse?.senders.find(
          sender => sender.id === reportSubscriptionResponse.subscription?.senderId
        )?.verifiedName ?? null,
      }
    : null;
  const organizationIncidents = incidentResponse
    ? presentWhatsAppIncidentResponse(incidentResponse, {
        scopeLabel: organizationName,
        senderLabels: Object.fromEntries((sendersResponse?.senders ?? []).map(sender => [
          sender.id,
          sender.verifiedName || sender.displayPhoneNumber,
        ])),
      })
    : null;

  const refreshSenderSafety = async (senderId: string) => {
    const safety = await whatsapp.getSenderSafety(organizationId, senderId);
    setSenderSafety(current => ({ ...current, [senderId]: safety }));
  };

  const syncTemplates = async (sender: WhatsAppSenderSummary) => {
    if (operationRef.current || activeOperation) return;
    operationRef.current = true;
    setActiveOperation(`sync:${sender.id}`);
    setNotice({ tone: "status", message: "Synchronizing provider-approved templates..." });
    try {
      await whatsapp.syncTemplates(organizationId, sender.id);
      await loadSenders();
      setNotice({ tone: "status", message: "Template synchronization completed." });
    } catch {
      setNotice({ tone: "error", message: "Templates could not be synchronized safely." });
    } finally {
      operationRef.current = false;
      setActiveOperation(null);
    }
  };

  const installManagedTemplates = async (sender: WhatsAppSenderSummary) => {
    if (operationRef.current || activeOperation || sender.status !== "ACTIVE") return;
    operationRef.current = true;
    setActiveOperation(`install:${sender.id}`);
    setNotice({ tone: "status", message: "Installing the fixed Lab Lords Utility catalogue in English and Hindi…" });
    try {
      const response = await whatsapp.installManagedTemplates(
        organizationId,
        sender.id,
        ["en_IN", "hi"]
      );
      setInstallations(current => ({ ...current, [sender.id]: response.installation }));
      await loadSenders();
      const activeCount = response.installation.templates.filter(template => template.active).length;
      setNotice({
        tone: "status",
        message: `${activeCount} managed template${activeCount === 1 ? " is" : "s are"} approved and active. Pending templates remain provider-authoritative.`,
      });
    } catch {
      setNotice({ tone: "error", message: "Managed templates could not be installed safely." });
    } finally {
      operationRef.current = false;
      setActiveOperation(null);
    }
  };

  const disconnectLocally = async () => {
    const sender = disconnectSender;
    if (!sender || operationRef.current || activeOperation) return;
    operationRef.current = true;
    setActiveOperation(`disconnect:${sender.id}`);
    try {
      await whatsapp.disconnectSender(organizationId, sender.id);
      await loadSenders();
      setDisconnectSender(null);
      setNotice({
        tone: "status",
        message: "The sender was disconnected locally. Customer-owned Meta assets were not changed.",
      });
    } catch {
      setDisconnectSender(null);
      setNotice({ tone: "error", message: "The local sender could not be disconnected." });
    } finally {
      operationRef.current = false;
      setActiveOperation(null);
    }
  };

  return (
    <>
      <SettingsPanel
        id="whatsapp"
        title="WhatsApp"
        description="Connect customer-owned Meta assets and install the fixed Lab Lords Utility-template catalogue. No custom, marketing, or authentication template can be entered here."
        icon={MessageCircle}
      >
        {notice ? (
          <div className="px-5 py-4">
            <p
              role={notice.tone === "error" ? "alert" : "status"}
              aria-live={notice.tone === "error" ? "assertive" : "polite"}
              className={notice.tone === "error"
                ? "text-sm text-[color:var(--ui-form-error-text)]"
                : "text-sm text-[color:var(--text-secondary)]"}
            >
              {notice.message}
            </p>
          </div>
        ) : null}

        <div className="px-5 py-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--ui-form-accent)]" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-[color:var(--text-primary)]">
                Customer-owned Meta connection
              </p>
              <SettingsSubtleText className="mt-1">
                Lab Lords receives delegated access only. The customer retains ownership, payment responsibility, and provider charges.
              </SettingsSubtleText>
            </div>
          </div>
        </div>

        {availableConfig ? (
          <MetaEmbeddedSignup
            organizationId={organizationId}
            config={availableConfig}
            disabled={connectionDisabled}
            disabledReason={connectionReason}
            onConnected={async () => {
              await loadSenders();
            }}
          />
        ) : (
          <div className="px-5 py-4 text-sm text-[color:var(--text-secondary)]">
            {connectionReason || "Meta connection setup is currently unavailable."}
          </div>
        )}

        <div className="px-5 py-4">
          {loading ? (
            <p role="status" className="text-sm text-[color:var(--text-secondary)]">
              Loading WhatsApp readiness...
            </p>
          ) : sendersResponse?.senders.length ? (
            <div className="grid gap-3">
              {sendersResponse.senders.map(sender => (
                <WhatsAppSenderSummaryCard
                  key={sender.id}
                  sender={sender}
                  canManage={canManage}
                  activeOperation={activeOperation}
                  onRegister={setRegistrationSender}
                  onSync={senderToSync => void syncTemplates(senderToSync)}
                  onInstall={senderToInstall => void installManagedTemplates(senderToInstall)}
                  onDisconnect={setDisconnectSender}
                  installation={installations[sender.id] ?? null}
                />
              ))}
            </div>
          ) : (
            <SettingsEmptyState>
              No customer-owned WhatsApp senders are connected yet.
            </SettingsEmptyState>
          )}
        </div>
      </SettingsPanel>

      {reportSubscriptionResponse?.operationsUiEnabled === true ? (
        <>
          <WhatsAppReportSubscription
            scope="ORGANIZATION"
            subscription={organizationReportSubscription}
            canManage={canManage}
            blockedReason="Only the organization owner can configure the organization daily-report recipient."
            onCreate={async draft => {
              const response = await whatsapp.createOrganizationReportSubscription(organizationId, {
                phone: draft.phoneE164,
                language: draft.language,
                sendTimeLocal: draft.sendTimeLocal,
              });
              setReportSubscriptionResponse(current => current
                ? { ...current, subscription: response.subscription }
                : current);
              return requireReportChallenge(response);
            }}
            onReissue={async () => {
              const response = await whatsapp.reissueOrganizationReportSubscription(organizationId);
              setReportSubscriptionResponse(current => current
                ? { ...current, subscription: response.subscription }
                : current);
              return requireReportChallenge(response);
            }}
            onPause={async () => {
              const response = await whatsapp.pauseOrganizationReportSubscription(organizationId);
              setReportSubscriptionResponse(current => current
                ? { ...current, subscription: response.subscription }
                : current);
            }}
            onRevoke={async () => {
              const response = await whatsapp.revokeOrganizationReportSubscription(
                organizationId,
                reportSubscriptionResponse.subscription?.id
              );
              setReportSubscriptionResponse(current => current
                ? { ...current, subscription: response.subscription }
                : current);
            }}
            onRefresh={async () => {
              const response = await whatsapp.getOrganizationReportSubscription(organizationId);
              if (response.operationsUiEnabled !== true) {
                setReportSubscriptionResponse(null);
                setReportSettingsResponse(null);
                return null;
              }
              setReportSubscriptionResponse(response);
              const subscription = response.subscription;
              if (!subscription) return null;
              return {
                ...subscription,
                senderLabel: sendersResponse?.senders.find(sender => sender.id === subscription.senderId)?.verifiedName ?? null,
              };
            }}
          />
          {reportSettingsResponse ? <OrganizationWhatsAppReports
            organizationName={organizationName}
            settings={{
              enabled: reportSettingsResponse.settings.enabled,
              senderId: reportSettingsResponse.settings.sender?.id ?? null,
              senderLabel: reportSettingsResponse.settings.sender
                ? `${reportSettingsResponse.settings.sender.verifiedName || "WhatsApp business number"} · ${reportSettingsResponse.settings.sender.maskedPhone}`
                : null,
              monthlyBudgetMinor: reportSettingsResponse.settings.monthlyBudgetMinor,
              budgetSource: "ORGANIZATION_REPORT",
            }}
            canManage={canManage}
            blockedReason="Only the organization owner can configure and queue organization daily reports."
            availableSenders={(sendersResponse?.senders ?? [])
              .filter(sender => sender.status === "ACTIVE")
              .map(sender => ({
                id: sender.id,
                label: `${sender.verifiedName || "WhatsApp business number"} · ${sender.displayPhoneNumber}`,
              }))}
            recentReports={[]}
            onSetEnabled={async enabled => {
              await whatsapp.updateOrganizationReportSettings(organizationId, { enabled });
              await loadReportOperations();
            }}
            onSaveSettings={async changes => {
              await whatsapp.updateOrganizationReportSettings(organizationId, changes);
              await loadReportOperations();
            }}
            onPreview={async () => presentWhatsAppDailyReportPreview(
              await whatsapp.previewOrganizationDailyReport(organizationId)
            )}
            onQueue={async idempotencyKey => presentWhatsAppDailyReportQueueResult(
              await whatsapp.queueOrganizationDailyReport(organizationId, idempotencyKey)
            )}
          /> : null}
          {Object.entries(senderSafety).map(([senderId, safety]) => (
            <WhatsAppSenderSafety
              key={senderId}
              safety={safety}
              isOwner={canManage}
              blockedReason="Only the organization owner can pause or resume sender delivery."
              onPause={async () => {
                await whatsapp.pauseSenderDelivery(organizationId, senderId);
                await refreshSenderSafety(senderId);
              }}
              onResume={async () => {
                await whatsapp.resumeSenderDelivery(organizationId, senderId);
                await refreshSenderSafety(senderId);
              }}
              onRefresh={() => refreshSenderSafety(senderId)}
            />
          ))}
          {organizationIncidents ? (
            <WhatsAppIncidents
              incidents={organizationIncidents.incidents}
              unknownOutcomes={organizationIncidents.unknownOutcomes}
              canAcknowledge={canManage}
              blockedReason="Only the organization owner can acknowledge organization incidents."
              nextCursor={null}
              onAcknowledge={async incidentId => {
                await whatsapp.acknowledgeOrganizationIncident(organizationId, incidentId);
                await loadReportOperations();
              }}
            />
          ) : null}
        </>
      ) : null}

      <RegisterPhoneDialog
        open={Boolean(registrationSender)}
        senderLabel={registrationSender?.displayPhoneNumber ?? "this number"}
        onClose={() => setRegistrationSender(null)}
        onRegister={async pin => {
          const sender = registrationSender;
          if (!sender) throw new Error("Registration sender unavailable");
          await whatsapp.registerSender(organizationId, sender.id, pin);
          await loadSenders();
          setRegistrationSender(null);
          setNotice({ tone: "status", message: "Phone registration was verified by Meta." });
        }}
      />

      <ConfirmDialog
        isOpen={Boolean(disconnectSender)}
        onClose={() => {
          if (!activeOperation) setDisconnectSender(null);
        }}
        onConfirm={disconnectLocally}
        loading={activeOperation?.startsWith("disconnect:") ?? false}
        variant="danger"
        title="Disconnect this sender locally?"
        description="This disables the sender only in Lab Lords and unassigns its branches. It does not deregister the number, revoke the customer’s Meta account, remove templates, or stop provider charges."
        confirmText="Disconnect locally"
        cancelText="Keep sender"
      />
    </>
  );
}
