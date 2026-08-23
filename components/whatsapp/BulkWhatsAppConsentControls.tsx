"use client";

import { useMemo, useRef, useState } from "react";
import { CheckCheck, ShieldCheck } from "lucide-react";
import { AppButton } from "@/components/ui/AppButton";
import { AppSelect } from "@/components/ui/AppSelect";
import { formHelpTextClass, formWarningBannerClass } from "@/components/ui/formSurface";
import {
  whatsapp,
  type WhatsAppBulkRecipientResult,
  type WhatsAppBulkRecipientSkipReason,
  type WhatsAppRecipientRelationship,
} from "@/lib/api/whatsapp";
import {
  MAX_WHATSAPP_RECIPIENT_BULK_SIZE,
  WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
  WHATSAPP_OPERATIONAL_CONSENT_STATEMENT,
} from "@/lib/whatsappConsentPolicy";
import { cn } from "@/lib/utils";

const RELATIONSHIP_OPTIONS = [
  { value: "GUARDIAN", label: "Guardian (default)" },
  { value: "SELF", label: "Student" },
  { value: "OTHER", label: "Other authorized contact" },
] as const;

const SKIP_REASON_LABELS: Record<WhatsAppBulkRecipientSkipReason, string> = {
  STUDENT_INACTIVE: "Student is inactive",
  NO_PHONE: "No current student phone",
  INVALID_PHONE: "Current student phone is invalid",
};

export type BulkWhatsAppConsentStudent = {
  id: string;
  name: string;
  phone: string | null;
  status: string;
};

export type BulkWhatsAppConsentControlsProps = {
  branchId: string;
  students: readonly BulkWhatsAppConsentStudent[];
  canManage: boolean;
};

export function BulkWhatsAppConsentControls({
  branchId,
  students,
  canManage,
}: BulkWhatsAppConsentControlsProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [relationship, setRelationship] = useState<WhatsAppRecipientRelationship>("GUARDIAN");
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WhatsAppBulkRecipientResult | null>(null);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);
  const loadedStudentsById = useMemo(
    () => new Map(students.map(student => [student.id, student])),
    [students]
  );
  const selectedStudents = [...selectedIds]
    .map(id => loadedStudentsById.get(id))
    .filter((student): student is BulkWhatsAppConsentStudent => Boolean(student));

  const toggleStudent = (studentId: string, checked: boolean) => {
    setResult(null);
    if (
      checked
      && !selectedIds.has(studentId)
      && selectedStudents.length >= MAX_WHATSAPP_RECIPIENT_BULK_SIZE
    ) {
      setNotice({
        tone: "error",
        text: `Select at most ${MAX_WHATSAPP_RECIPIENT_BULK_SIZE} currently loaded students.`,
      });
      return;
    }
    setSelectedIds(previous => {
      const next = new Set(
        [...previous].filter(id => loadedStudentsById.has(id))
      );
      if (!checked) {
        next.delete(studentId);
        return next;
      }
      next.add(studentId);
      return next;
    });
    setNotice(null);
  };

  const selectLoadedStudents = () => {
    const boundedIds = students
      .slice(0, MAX_WHATSAPP_RECIPIENT_BULK_SIZE)
      .map(student => student.id);
    setSelectedIds(new Set(boundedIds));
    setResult(null);
    setNotice(students.length > MAX_WHATSAPP_RECIPIENT_BULK_SIZE
      ? {
          tone: "status",
          text: `Selected the first ${MAX_WHATSAPP_RECIPIENT_BULK_SIZE} of ${students.length} currently loaded students.`,
        }
      : null);
  };

  const submit = async () => {
    if (
      operationRef.current
      || busy
      || !canManage
      || !attested
      || selectedStudents.length < 1
      || selectedStudents.length > MAX_WHATSAPP_RECIPIENT_BULK_SIZE
    ) return;

    operationRef.current = true;
    setBusy(true);
    setResult(null);
    setNotice({ tone: "status", text: "Recording bounded operational consent…" });
    try {
      const nextResult = await whatsapp.associateRecipientsBulk(
        branchId,
        selectedStudents.map(student => ({ studentId: student.id, relationship }))
      );
      setResult(nextResult);
      setAttested(false);
      setSelectedIds(new Set());
      setNotice({
        tone: "status",
        text: `Bulk consent finished for ${nextResult.requestedCount} selected students.`,
      });
    } catch {
      setNotice({
        tone: "error",
        text: "Bulk consent could not be recorded safely. No alternate phone numbers were submitted.",
      });
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3 text-sm">
        <p className="font-medium text-[color:var(--text-primary)]">
          Select from {students.length} currently loaded branch student{students.length === 1 ? "" : "s"}
        </p>
        <p className={cn("mt-1 text-xs", formHelpTextClass)}>
          A single request is capped at {MAX_WHATSAPP_RECIPIENT_BULK_SIZE}. The server resolves each current student phone; this workflow has no phone-number field.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <AppButton
            variant="secondary"
            size="sm"
            onClick={selectLoadedStudents}
            disabled={busy || !canManage || students.length === 0}
          >
            Select loaded students
          </AppButton>
          <AppButton
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelectedIds(new Set());
              setResult(null);
            }}
            disabled={busy || selectedStudents.length === 0}
          >
            Clear selection
          </AppButton>
        </div>
      </div>

      <fieldset disabled={busy || !canManage}>
        <legend className="text-sm font-medium text-[color:var(--ui-form-label)]">
          Loaded students ({selectedStudents.length}/{MAX_WHATSAPP_RECIPIENT_BULK_SIZE} selected)
        </legend>
        <div className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] p-2">
          {students.map(student => {
            const checked = selectedIds.has(student.id);
            return (
              <label
                key={student.id}
                className="flex cursor-pointer items-start gap-3 rounded-[var(--ui-radius-control)] px-2 py-2 text-sm hover:bg-[color:var(--ui-form-surface-hover-bg)]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={event => toggleStudent(student.id, event.target.checked)}
                  className="mt-0.5 h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[color:var(--text-primary)]">{student.name}</span>
                  <span className={cn("block text-xs", formHelpTextClass)}>
                    {student.status.toLowerCase()} · {student.phone ? "Current phone on file" : "No current phone"}
                  </span>
                </span>
              </label>
            );
          })}
          {students.length === 0 ? (
            <p className={cn("px-2 py-4 text-center text-sm", formHelpTextClass)}>
              No students are loaded in this roster view.
            </p>
          ) : null}
        </div>
      </fieldset>

      <AppSelect
        id="bulk-whatsapp-relationship"
        label="Relationship for every selected student"
        value={relationship}
        options={RELATIONSHIP_OPTIONS}
        onValueChange={value => setRelationship(value as WhatsAppRecipientRelationship)}
        disabled={busy || !canManage}
      />

      <label className={cn("flex items-start gap-3 text-sm", !canManage ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
        <input
          type="checkbox"
          checked={attested}
          onChange={event => setAttested(event.target.checked)}
          disabled={busy || !canManage}
          className="mt-0.5 h-5 w-5 rounded border-[color:var(--ui-form-input-border)] accent-cyan-500"
        />
        <span>
          <span className="font-medium">I attest for every selected student to policy {WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION}:</span>{" "}
          {WHATSAPP_OPERATIONAL_CONSENT_STATEMENT}
          <span className={cn("mt-1 block text-xs", formHelpTextClass)}>
            This records operational consent only. It does not send messages or permit promotional messaging.
          </span>
        </span>
      </label>

      {!canManage ? (
        <p className={formHelpTextClass}>You need WhatsApp management permission to record bulk consent.</p>
      ) : null}

      {result ? (
        <div className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-badge-success-border)] bg-[color:var(--ui-badge-success-bg)] p-3 text-sm" role="status">
          <p className="flex items-center gap-2 font-medium">
            <CheckCheck className="h-4 w-4" aria-hidden="true" />
            {result.associatedCount} associated · {result.unchangedCount} unchanged · {result.skipped.length} skipped
          </p>
          {result.skipped.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {result.skipped.map(item => (
                <li key={item.studentId}>
                  {loadedStudentsById.get(item.studentId)?.name ?? "Selected student"}: {SKIP_REASON_LABELS[item.reason]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
          className={notice.tone === "error"
            ? cn("px-3 py-2 text-sm", formWarningBannerClass)
            : "text-sm text-[color:var(--text-secondary)]"}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="flex justify-end">
        <AppButton
          variant="primary"
          icon={ShieldCheck}
          onClick={() => void submit()}
          disabled={busy || !canManage || !attested || selectedStudents.length === 0}
          isLoading={busy}
        >
          Record consent for {selectedStudents.length} selected
        </AppButton>
      </div>
    </div>
  );
}
