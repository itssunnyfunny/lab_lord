"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, RefreshCw, ShieldCheck } from "lucide-react";
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
import {
  whatsapp,
  type WhatsAppSenderStatus,
  type WhatsAppSenderSummary,
  type WhatsAppSendersResponse,
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

export function WhatsAppSenderSummaryCard({
  sender,
  canManage,
  activeOperation,
  onRegister,
  onSync,
  onDisconnect,
}: {
  sender: WhatsAppSenderSummary;
  canManage: boolean;
  activeOperation: string | null;
  onRegister: (sender: WhatsAppSenderSummary) => void;
  onSync: (sender: WhatsAppSenderSummary) => void;
  onDisconnect: (sender: WhatsAppSenderSummary) => void;
}) {
  const busy = activeOperation?.endsWith(`:${sender.id}`) ?? false;
  const branchNames = sender.assignedBranches.map(branch => branch.name);

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
  onAvailabilityChange,
}: {
  organizationId: string;
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
  const [registrationSender, setRegistrationSender] = useState<WhatsAppSenderSummary | null>(null);
  const [disconnectSender, setDisconnectSender] = useState<WhatsAppSenderSummary | null>(null);
  const availabilityHandlerRef = useRef(onAvailabilityChange);

  useEffect(() => {
    availabilityHandlerRef.current = onAvailabilityChange;
  }, [onAvailabilityChange]);

  const loadSenders = useCallback(async () => {
    const response = await whatsapp.listSenders(organizationId);
    setSendersResponse(response);
    if (!response.enabled) {
      availabilityHandlerRef.current(false);
      setConfig(previous => previous ? { ...previous, enabled: false } : previous);
    }
    return response;
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    availabilityHandlerRef.current(false);
    setLoading(true);
    setConfig(null);
    setSendersResponse(null);
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
        const response = await whatsapp.listSenders(organizationId);
        if (!cancelled) setSendersResponse(response);
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
    };
  }, [organizationId]);

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

  const syncTemplates = async (sender: WhatsAppSenderSummary) => {
    if (activeOperation) return;
    setActiveOperation(`sync:${sender.id}`);
    setNotice({ tone: "status", message: "Synchronizing provider-approved templates..." });
    try {
      await whatsapp.syncTemplates(organizationId, sender.id);
      await loadSenders();
      setNotice({ tone: "status", message: "Template synchronization completed." });
    } catch {
      setNotice({ tone: "error", message: "Templates could not be synchronized safely." });
    } finally {
      setActiveOperation(null);
    }
  };

  const disconnectLocally = async () => {
    const sender = disconnectSender;
    if (!sender || activeOperation) return;
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
      setActiveOperation(null);
    }
  };

  return (
    <>
      <SettingsPanel
        id="whatsapp"
        title="WhatsApp"
        description="Connect customer-owned Meta assets and review foundational readiness. Message delivery is not active in this release."
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
                  onDisconnect={setDisconnectSender}
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
