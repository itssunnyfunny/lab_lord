"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, MessageCircleOff, ShieldCheck } from "lucide-react";
import { AppButton } from "@/components/ui/AppButton";
import { AppSelect } from "@/components/ui/AppSelect";
import { formHelpTextClass, formWarningBannerClass } from "@/components/ui/formSurface";
import { cn } from "@/lib/utils";
import {
  whatsapp,
  type WhatsAppConsentSource,
  type WhatsAppRecipientMutationResult,
  type WhatsAppRecipientRelationship,
  type WhatsAppStudentRecipientState,
} from "@/lib/api/whatsapp";
import {
  WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
  WHATSAPP_OPERATIONAL_CONSENT_STATEMENT,
} from "@/lib/whatsappConsentPolicy";

const RELATIONSHIP_OPTIONS = [
  { value: "SELF", label: "Student" },
  { value: "GUARDIAN", label: "Guardian" },
  { value: "OTHER", label: "Other authorized contact" },
] as const;

const CONSENT_SOURCE_LABELS: Record<WhatsAppConsentSource, string> = {
  IN_PERSON: "In-person attestation",
  REGISTRATION_FORM: "Registration form",
  IMPORT_ATTESTATION: "Bulk attestation",
  WHATSAPP_REPLY: "WhatsApp reply",
  OWNER_CONFIGURATION: "Owner configuration",
  SYSTEM: "System reconciliation",
};

function maskPhone(value: string | null) {
  if (!value) return "No phone recorded";
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••••••${digits.slice(-4)}`;
}

function relationshipLabel(value: WhatsAppRecipientRelationship) {
  return RELATIONSHIP_OPTIONS.find(option => option.value === value)?.label ?? value;
}

function consentStatusLabel(value: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT") {
  if (value === "OPTED_IN") return "Opted in";
  if (value === "OPTED_OUT") return "Opted out";
  return "Unknown";
}

function formatEvidenceDate(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export type StudentWhatsAppConsentControlsProps = {
  branchId: string;
  student: {
    id: string;
    name: string;
    phone: string | null;
    status: string;
  };
  canManage: boolean;
  initialState?: WhatsAppStudentRecipientState | null;
  onChanged?: (recipient: WhatsAppRecipientMutationResult["recipient"] | null) => void;
};

export function StudentWhatsAppConsentControls({
  branchId,
  student,
  canManage,
  initialState,
  onChanged,
}: StudentWhatsAppConsentControlsProps) {
  const [relationship, setRelationship] = useState<WhatsAppRecipientRelationship>(
    initialState?.recipient?.relationship ?? "SELF"
  );
  const [attested, setAttested] = useState(false);
  const [state, setState] = useState<WhatsAppStudentRecipientState | null>(
    initialState ?? null
  );
  const [loading, setLoading] = useState(initialState === undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);
  const recipient = state?.recipient ?? null;
  const assignedSender = state?.assignedSender ?? null;
  const currentMaskedPhone = state?.studentMaskedPhone
    ?? state?.maskedPhone
    ?? maskPhone(student.phone);
  const associationIsCurrent = recipient?.phoneMatchesCurrentStudent === true
    && recipient.status === "ACTIVE";
  const activeRecipient = associationIsCurrent
    && recipient?.consentStatus === "OPTED_IN"
    && recipient.consentType === "OPERATIONAL"
    ? recipient
    : null;
  const withdrawableRecipient = recipient?.consentStatus === "OPTED_IN"
    && recipient.consentType === "OPERATIONAL"
    && recipient.status !== "DISABLED"
    ? recipient
    : null;
  const unavailable = !student.phone
    || student.status !== "ACTIVE"
    || (!loading && assignedSender?.status !== "ACTIVE");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      try {
        const nextState = await whatsapp.getStudentRecipient(branchId, student.id);
        if (cancelled) return;
        setState(nextState);
        if (nextState.recipient) setRelationship(nextState.recipient.relationship);
      } catch {
        if (!cancelled) {
          setNotice({ tone: "error", text: "Current WhatsApp consent status is unavailable." });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [branchId, student.id]);

  const refreshState = async () => {
    const nextState = await whatsapp.getStudentRecipient(branchId, student.id);
    setState(nextState);
    if (nextState.recipient) setRelationship(nextState.recipient.relationship);
    return nextState;
  };

  const recordConsent = async () => {
    if (operationRef.current || busy || loading || unavailable || !attested || !canManage) return;
    operationRef.current = true;
    setBusy(true);
    setNotice({ tone: "status", text: "Recording operational consent…" });
    try {
      const result = await whatsapp.associateRecipient(branchId, {
        studentId: student.id,
        relationship,
        attestation: true,
      });
      await refreshState();
      setAttested(false);
      onChanged?.(result.recipient);
      setNotice({
        tone: "status",
        text: result.changed
          ? "Operational consent and this student-recipient association are active."
          : "The existing operational consent remains active.",
      });
    } catch {
      setNotice({ tone: "error", text: "Consent could not be recorded safely." });
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  const withdrawConsent = async () => {
    if (operationRef.current || busy || loading || !withdrawableRecipient || !canManage) return;
    operationRef.current = true;
    setBusy(true);
    setNotice({ tone: "status", text: "Withdrawing operational consent…" });
    try {
      await whatsapp.disableRecipient(branchId, withdrawableRecipient.id);
      await refreshState();
      onChanged?.(null);
      setNotice({
        tone: "status",
        text: "Operational consent was withdrawn and future unsubmitted messages were cancelled.",
      });
    } catch {
      setNotice({ tone: "error", text: "Consent could not be withdrawn safely." });
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3 text-sm">
        <p className="font-medium text-[color:var(--text-primary)]">{student.name}</p>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-[color:var(--text-muted)]">Current student phone</dt>
            <dd className="mt-0.5 text-[color:var(--text-secondary)]">{currentMaskedPhone}</dd>
          </div>
          <div>
            <dt className="text-[color:var(--text-muted)]">Assigned sender</dt>
            <dd className="mt-0.5 text-[color:var(--text-secondary)]">
              {assignedSender
                ? `${assignedSender.verifiedName ?? "WhatsApp sender"} · ${assignedSender.maskedPhone ?? "Phone unavailable"}`
                : loading ? "Loading…" : "No sender assigned"}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-[color:var(--text-muted)]">
          The server uses the student’s current branch phone; this screen cannot choose another number.
        </p>
      </div>

      {loading ? (
        <p role="status" className="text-sm text-[color:var(--text-secondary)]">
          Loading current consent status…
        </p>
      ) : null}

      {recipient ? (
        <div className={cn(
          "rounded-[var(--ui-radius-control)] border p-3 text-sm",
          activeRecipient
            ? "border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)]"
            : formWarningBannerClass
        )}>
          <div className="flex items-start gap-3">
            {activeRecipient ? (
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {activeRecipient
                  ? "Operational consent active"
                  : recipient.consentStatus === "OPTED_OUT"
                    ? "Operational consent opted out"
                    : "Recipient association needs attention"}
              </p>
              <dl className="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="opacity-70">Association</dt>
                  <dd>{recipient.status.toLowerCase()} · {relationshipLabel(recipient.relationship)}</dd>
                </div>
                <div>
                  <dt className="opacity-70">Operational consent</dt>
                  <dd>{consentStatusLabel(recipient.consentStatus)}</dd>
                </div>
                <div>
                  <dt className="opacity-70">Source and date</dt>
                  <dd>{CONSENT_SOURCE_LABELS[recipient.consentSource]} · {formatEvidenceDate(recipient.consentRecordedAt)}</dd>
                </div>
                <div>
                  <dt className="opacity-70">Phone evidence</dt>
                  <dd>{recipient.maskedPhone ?? "Unavailable"} · verified {formatEvidenceDate(recipient.verifiedAt)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs">
                Policy: {recipient.policyVersion ?? "Version unavailable"}
              </p>
            </div>
          </div>
        </div>
      ) : !loading ? (
        <p className={formHelpTextClass}>No recipient association or operational consent is recorded for this sender.</p>
      ) : null}

      {recipient && (!recipient.phoneMatchesCurrentStudent || recipient.status === "STALE") ? (
        <div className={cn("px-3 py-2 text-sm", formWarningBannerClass)} role="status">
          Stale phone evidence: the saved recipient phone ({recipient.maskedPhone ?? "unavailable"}) does not match the student’s current phone ({currentMaskedPhone}). Record fresh explicit consent before sending.
          {recipient.staleAt ? ` Marked stale ${formatEvidenceDate(recipient.staleAt)}.` : ""}
        </div>
      ) : null}

      {recipient?.consentStatus === "OPTED_OUT" ? (
        <div className={cn("px-3 py-2 text-sm", formWarningBannerClass)} role="status">
          Opt-out is active. Operational WhatsApp messages must not be queued for this recipient.
          {recipient.disabledAt ? ` Association disabled ${formatEvidenceDate(recipient.disabledAt)}.` : ""}
        </div>
      ) : null}

      {!activeRecipient ? (
        <>
          <label className="block text-sm font-medium text-[color:var(--ui-form-label)]" htmlFor={`whatsapp-relationship-${student.id}`}>
            Recipient relationship
          </label>
          <AppSelect
            id={`whatsapp-relationship-${student.id}`}
            aria-label="Recipient relationship"
            value={relationship}
            onValueChange={value => setRelationship(value as WhatsAppRecipientRelationship)}
            options={RELATIONSHIP_OPTIONS}
            disabled={busy || loading || unavailable || !canManage}
          />

          <label className={cn("flex items-start gap-3 text-sm", unavailable || !canManage ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
            <input
              type="checkbox"
              checked={attested}
              onChange={event => setAttested(event.target.checked)}
              disabled={busy || loading || unavailable || !canManage}
              className="mt-0.5 h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
            />
            <span>
              <span className="font-medium">I attest to policy {WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION}:</span>{" "}
              {WHATSAPP_OPERATIONAL_CONSENT_STATEMENT}
              <span className={cn("mt-1 block text-xs", formHelpTextClass)}>
                This records consent; it does not send a message. Consent can be withdrawn at any time.
              </span>
            </span>
          </label>
        </>
      ) : null}

      {unavailable ? (
        <div className={cn("px-3 py-2 text-sm", formWarningBannerClass)} role="status">
          {student.status !== "ACTIVE"
            ? "Only active students can be associated with a WhatsApp recipient."
            : !student.phone
              ? "Add a valid student phone before recording WhatsApp consent."
              : "Assign an active WhatsApp sender to this branch before recording consent."}
        </div>
      ) : null}

      {!canManage ? (
        <p className={formHelpTextClass}>You need WhatsApp management permission to change consent.</p>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
          className={notice.tone === "error"
            ? "text-sm text-[color:var(--ui-form-error-text)]"
            : "text-sm text-[color:var(--text-secondary)]"}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {withdrawableRecipient ? (
          <AppButton
            variant="danger"
            size="sm"
            icon={MessageCircleOff}
            onClick={() => void withdrawConsent()}
            disabled={busy || loading || !canManage}
            isLoading={busy}
          >
            Withdraw consent
          </AppButton>
        ) : null}
        {!activeRecipient ? (
          <AppButton
            variant="primary"
            size="sm"
            icon={ShieldCheck}
            onClick={() => void recordConsent()}
            disabled={busy || loading || unavailable || !canManage || !attested}
            isLoading={busy}
          >
            Record operational consent
          </AppButton>
        ) : null}
      </div>
    </div>
  );
}
