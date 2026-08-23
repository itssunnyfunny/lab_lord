"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { AppButton } from "@/components/ui/AppButton";
import { Badge } from "@/components/ui/Badge";
import {
  ReadOnlyRow,
  SettingsField,
  SettingsPanel,
  SettingsSelect,
  SettingsToggle,
} from "@/components/settings/SettingsWorkspace";
import {
  whatsapp,
  type WhatsAppBranchAssignmentResponse,
} from "@/lib/api/whatsapp";

function titleCase(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}

function languageLabel(value: string) {
  if (value.toLowerCase() === "hi") return "Hindi";
  if (value.toLowerCase() === "en") return "English";
  return value;
}

export function BranchWhatsAppReadiness({
  response,
  selectedSenderId,
  busy,
  onSelectedSenderChange,
  onAssign,
  onUnassign,
}: {
  response: WhatsAppBranchAssignmentResponse;
  selectedSenderId: string;
  busy: boolean;
  onSelectedSenderChange: (senderId: string) => void;
  onAssign: () => void;
  onUnassign: () => void;
}) {
  const assignment = response.assignment;
  const sender = assignment?.sender ?? null;
  const canManage = response.canManage;
  const currentSenderId = sender?.id ?? "";

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
            <Badge variant={sender.status === "ACTIVE" ? "success" : "warning"}>
              {titleCase(sender.status)}
            </Badge>
            <Badge variant={sender.providerMode === "TEST" ? "purple" : "cyan"}>
              {sender.providerMode}
            </Badge>
          </span>
        ) : "Unavailable"}
      />
      <ReadOnlyRow
        label="Phone registration"
        value={sender?.phoneRegisteredAt ? "Provider verified" : "Not verified"}
      />
      <ReadOnlyRow
        label="Webhook subscription"
        value={sender?.webhookSubscribedAt ? "Provider verified" : "Not verified"}
      />
      <ReadOnlyRow
        label="Default language"
        value={languageLabel(assignment?.defaultLanguage ?? "en")}
      />
      <ReadOnlyRow
        label="Default tone"
        value={titleCase(assignment?.defaultTone ?? "polite")}
      />

      <SettingsField
        label="Message delivery automation"
        description="PR2 establishes connection and readiness only. No reminders or other WhatsApp messages are sent."
      >
        <SettingsToggle
          checked={false}
          onChange={() => undefined}
          disabled
          label="Automation unavailable"
          description="Message delivery remains fixed off until a separately reviewed delivery release."
        />
      </SettingsField>

      {canManage ? (
        <div className="space-y-3 px-5 py-4">
          <SettingsField
            label="Branch sender assignment"
            description="Assignment does not enable message delivery automation."
          >
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
            {sender ? (
              <AppButton
                variant="quiet"
                size="sm"
                disabled={busy}
                onClick={onUnassign}
              >
                Unassign sender
              </AppButton>
            ) : null}
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

export function BranchWhatsAppPanel({
  organizationId,
  branchId,
  canView,
  onAvailabilityChange,
}: {
  organizationId: string;
  branchId: string;
  canView: boolean;
  onAvailabilityChange: (available: boolean) => void;
}) {
  const [response, setResponse] = useState<WhatsAppBranchAssignmentResponse | null>(null);
  const [selectedSenderId, setSelectedSenderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "status" | "error";
    message: string;
  } | null>(null);
  const availabilityHandlerRef = useRef(onAvailabilityChange);

  useEffect(() => {
    availabilityHandlerRef.current = onAvailabilityChange;
  }, [onAvailabilityChange]);

  const loadAssignment = useCallback(async () => {
    const next = await whatsapp.getBranchAssignment(organizationId, branchId);
    setResponse(next);
    availabilityHandlerRef.current(next.enabled);
    setSelectedSenderId(
      next.assignment?.sender?.id
        ?? next.availableSenders[0]?.id
        ?? ""
    );
    return next;
  }, [branchId, organizationId]);

  useEffect(() => {
    let cancelled = false;
    availabilityHandlerRef.current(false);
    setResponse(null);
    setNotice(null);

    if (!canView) return;

    const load = async () => {
      try {
        const next = await whatsapp.getBranchAssignment(organizationId, branchId);
        if (cancelled) return;
        setResponse(next);
        availabilityHandlerRef.current(next.enabled);
        setSelectedSenderId(
          next.assignment?.sender?.id
            ?? next.availableSenders[0]?.id
            ?? ""
        );
      } catch {
        if (!cancelled) availabilityHandlerRef.current(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [branchId, canView, organizationId]);

  if (!canView || !response?.enabled) return null;

  const assign = async () => {
    if (!selectedSenderId || busy) return;
    setBusy(true);
    setNotice({ tone: "status", message: "Assigning the sender to this branch..." });
    try {
      await whatsapp.assignBranch(organizationId, branchId, selectedSenderId);
      await loadAssignment();
      setNotice({
        tone: "status",
        message: "Sender assigned. Message delivery automation remains off.",
      });
    } catch {
      setNotice({ tone: "error", message: "The sender could not be assigned safely." });
    } finally {
      setBusy(false);
    }
  };

  const unassign = async () => {
    if (busy) return;
    setBusy(true);
    setNotice({ tone: "status", message: "Removing the branch sender assignment..." });
    try {
      await whatsapp.unassignBranch(organizationId, branchId);
      await loadAssignment();
      setNotice({ tone: "status", message: "The sender was unassigned from this branch." });
    } catch {
      setNotice({ tone: "error", message: "The sender could not be unassigned safely." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPanel
      id="whatsapp"
      title="WhatsApp"
      description="Readiness for the customer-owned sender assigned to this branch."
      icon={MessageCircle}
    >
      {response.safeReason ? (
        <div className="px-5 py-4 text-sm text-[color:var(--text-secondary)]">
          {response.safeReason}
        </div>
      ) : null}
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
      <BranchWhatsAppReadiness
        response={response}
        selectedSenderId={selectedSenderId}
        busy={busy}
        onSelectedSenderChange={setSelectedSenderId}
        onAssign={() => void assign()}
        onUnassign={() => void unassign()}
      />
    </SettingsPanel>
  );
}
