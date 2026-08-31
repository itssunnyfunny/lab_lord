"use client";

import { useEffect, useRef, useState } from "react";
import { Clock3, RefreshCw, ShieldCheck, UserRoundCheck } from "lucide-react";
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
import { pageInsetSurfaceClass } from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";

export type WhatsAppReportScope = "BRANCH" | "ORGANIZATION";
export type WhatsAppReportLanguage = "en_IN" | "hi";
export type WhatsAppReportSubscriptionStatus =
  | "PENDING_CONFIRMATION"
  | "ACTIVE"
  | "PAUSED"
  | "REVOKED"
  | "STALE"
  | "EXPIRED";

export interface WhatsAppReportSubscriptionView {
  id: string;
  scope: WhatsAppReportScope;
  maskedPhone: string;
  language: WhatsAppReportLanguage;
  sendTimeLocal: string;
  status: WhatsAppReportSubscriptionStatus;
  senderLabel: string | null;
  confirmationExpiresAt: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  staleAt: string | null;
}

export interface WhatsAppReportSubscriptionDraft {
  phoneE164: string;
  language: WhatsAppReportLanguage;
  sendTimeLocal: string;
}

export interface WhatsAppReportChallengeResult {
  code: string;
  expiresAt: string;
}

export interface WhatsAppReportSubscriptionProps {
  scope: WhatsAppReportScope;
  subscription: WhatsAppReportSubscriptionView | null;
  canManage: boolean;
  blockedReason?: string;
  onCreate: (draft: WhatsAppReportSubscriptionDraft) => Promise<WhatsAppReportChallengeResult>;
  onReissue: () => Promise<WhatsAppReportChallengeResult>;
  onPause: () => Promise<void>;
  onRevoke: () => Promise<void>;
  onRefresh: () => Promise<WhatsAppReportSubscriptionView | null>;
}

type BusyAction = "create" | "reissue" | "pause" | "revoke" | "refresh";
type Notice = { tone: "status" | "error"; text: string };

const STATUS_LABELS: Record<WhatsAppReportSubscriptionStatus, string> = {
  PENDING_CONFIRMATION: "Pending confirmation",
  ACTIVE: "Active",
  PAUSED: "Paused",
  REVOKED: "Revoked",
  STALE: "Stale — reconfirm required",
  EXPIRED: "Confirmation expired",
};

const REPORT_LANGUAGE_OPTIONS = [
  { value: "en_IN", label: "English (India)" },
  { value: "hi", label: "Hindi" },
];

function statusVariant(status: WhatsAppReportSubscriptionStatus) {
  if (status === "ACTIVE") return "success" as const;
  if (status === "PENDING_CONFIRMATION") return "warning" as const;
  if (status === "REVOKED" || status === "EXPIRED") return "danger" as const;
  return "default" as const;
}

function formatExpiry(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "soon" : date.toLocaleString("en-IN");
}

function ReportConfirmationChallenge({ challenge }: { challenge: WhatsAppReportChallengeResult }) {
  return (
    <div
      className={cn("space-y-3 p-4", formWarningBannerClass)}
      role="status"
      aria-live="polite"
      data-report-confirmation-challenge
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">Confirm control from the intended WhatsApp phone</p>
          <p className="mt-1 text-sm leading-6">
            Send this exact command to the connected organization sender before {formatExpiry(challenge.expiresAt)}.
          </p>
        </div>
      </div>
      <code className="block overflow-x-auto rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-warning-border)] bg-[color:var(--ui-form-input-bg)] px-3 py-3 text-base font-semibold text-[color:var(--text-primary)]">
        START REPORTS {challenge.code}
      </code>
      <p className="text-xs leading-5">
        This one-time code is shown only in this screen and is not Lab Lords sign-in authentication.
      </p>
    </div>
  );
}

export function WhatsAppReportSubscription({
  scope,
  subscription,
  canManage,
  blockedReason,
  onCreate,
  onReissue,
  onPause,
  onRevoke,
  onRefresh,
}: WhatsAppReportSubscriptionProps) {
  const [phoneE164, setPhoneE164] = useState("");
  const [language, setLanguage] = useState<WhatsAppReportLanguage>("en_IN");
  const [sendTimeLocal, setSendTimeLocal] = useState("21:00");
  const [challenge, setChallenge] = useState<WhatsAppReportChallengeResult | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const operationRef = useRef(false);

  useEffect(() => {
    if (!challenge) return;
    const remaining = new Date(challenge.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setChallenge(null);
      return;
    }
    const timeoutId = window.setTimeout(() => setChallenge(null), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timeoutId);
  }, [challenge]);

  useEffect(() => {
    if (subscription?.status !== "PENDING_CONFIRMATION") setChallenge(null);
  }, [subscription?.status]);

  const run = async (action: BusyAction, operation: () => Promise<void>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(action);
    setNotice(null);
    try {
      await operation();
    } catch {
      setNotice({
        tone: "error",
        text: "The report-subscription operation could not be completed. No confirmation should be assumed.",
      });
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const createSubscription = () => run("create", async () => {
    const result = await onCreate({ phoneE164: phoneE164.trim(), language, sendTimeLocal });
    setChallenge(result);
    setPhoneE164("");
    setNotice({ tone: "status", text: "Pending confirmation. Send the exact command shown below from the intended phone." });
  });

  const reissue = () => run("reissue", async () => {
    const result = await onReissue();
    setChallenge(result);
    setNotice({ tone: "status", text: "A new one-time confirmation command is ready. The previous code is no longer valid." });
  });

  const refresh = () => run("refresh", async () => {
    const latest = await onRefresh();
    if (latest?.status === "ACTIVE") {
      setChallenge(null);
      setNotice({ tone: "status", text: "Phone control confirmed. Daily reports are active." });
    } else {
      setNotice({ tone: "status", text: "Confirmation status refreshed." });
    }
  });

  const pause = () => run("pause", async () => {
    await onPause();
    setChallenge(null);
    setNotice({ tone: "status", text: "Daily report delivery was paused." });
  });

  const revoke = () => run("revoke", async () => {
    await onRevoke();
    setChallenge(null);
    setRevokeOpen(false);
    setNotice({ tone: "status", text: "The report subscription was revoked." });
  });

  const pending = subscription?.status === "PENDING_CONFIRMATION";
  const canCreate = !subscription || subscription.status === "REVOKED" || subscription.status === "EXPIRED";
  const needsReissue = pending
    || subscription?.status === "STALE"
    || subscription?.status === "EXPIRED"
    || subscription?.status === "PAUSED";
  const scopeLabel = scope === "ORGANIZATION" ? "organization" : "branch";

  return (
    <AppPanel
      title={`${scope === "ORGANIZATION" ? "Organization" : "Branch"} daily report recipient`}
      description={`Reports contain only deterministic aggregate ${scopeLabel} metrics. The current user must prove control of the receiving phone through WhatsApp.`}
      action={subscription ? <Badge variant={statusVariant(subscription.status)}>{STATUS_LABELS[subscription.status]}</Badge> : <Badge>Not configured</Badge>}
      contentClassName="space-y-4"
    >
      {!canManage ? (
        <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)} role="status">
          {blockedReason || `You do not have permission to manage this ${scopeLabel} report subscription.`}
        </div>
      ) : null}

      {notice ? (
        <p
          className={cn("px-3 py-2 text-sm", notice.tone === "error" ? formErrorBannerClass : formSuccessBannerClass)}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
        >
          {notice.text}
        </p>
      ) : null}

      {subscription ? (
        <dl className={cn("grid gap-3 p-4 sm:grid-cols-2", pageInsetSurfaceClass)}>
          <div><dt className="text-xs text-[color:var(--text-muted)]">Recipient</dt><dd className="mt-1 font-medium">{subscription.maskedPhone}</dd></div>
          <div><dt className="text-xs text-[color:var(--text-muted)]">Local send time</dt><dd className="mt-1 font-medium">{subscription.sendTimeLocal}</dd></div>
          <div><dt className="text-xs text-[color:var(--text-muted)]">Language</dt><dd className="mt-1 font-medium">{subscription.language === "hi" ? "Hindi" : "English (India)"}</dd></div>
          <div><dt className="text-xs text-[color:var(--text-muted)]">Connected sender</dt><dd className="mt-1 font-medium">{subscription.senderLabel || "Unavailable"}</dd></div>
        </dl>
      ) : null}

      {canCreate ? (
        <div className="overflow-hidden rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-section-divider)]">
          <SettingsField label="Your WhatsApp phone" description="Enter your own phone in E.164 format. It is not trusted until the inbound challenge succeeds.">
            <SettingsInput type="tel" inputMode="tel" autoComplete="tel" placeholder="+919876543210" value={phoneE164} onChange={event => setPhoneE164(event.target.value)} disabled={!canManage || busy !== null} aria-label="Report recipient phone" />
          </SettingsField>
          <SettingsField label="Report language">
            <SettingsSelect
              value={language}
              onValueChange={value => setLanguage(value as WhatsAppReportLanguage)}
              options={REPORT_LANGUAGE_OPTIONS}
              disabled={!canManage || busy !== null}
              aria-label="Report language"
            />
          </SettingsField>
          <SettingsField label="Daily send time" description="Choose a local time from 18:00 through 23:30.">
            <SettingsInput type="time" min="18:00" max="23:30" step="900" value={sendTimeLocal} onChange={event => setSendTimeLocal(event.target.value)} disabled={!canManage || busy !== null} aria-label="Daily report send time" />
          </SettingsField>
          <div className="flex justify-end border-t border-[color:var(--ui-form-section-divider)] p-4">
            <AppButton variant="primary" size="sm" icon={UserRoundCheck} onClick={() => void createSubscription()} disabled={!canManage || !phoneE164.trim() || busy !== null} isLoading={busy === "create"}>
              Create pending subscription
            </AppButton>
          </div>
        </div>
      ) : null}

      {pending && !challenge ? (
        <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)} role="status">
          The original one-time code is no longer displayed. Reissue a code, then send the exact command from {subscription.maskedPhone}.
        </div>
      ) : null}

      {challenge ? <ReportConfirmationChallenge challenge={challenge} /> : null}

      {subscription && canManage ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          {needsReissue ? (
            <AppButton variant="secondary" size="sm" icon={RefreshCw} onClick={() => void reissue()} disabled={busy !== null} isLoading={busy === "reissue"}>Reissue one-time code</AppButton>
          ) : null}
          {pending ? (
            <AppButton variant="secondary" size="sm" icon={Clock3} onClick={() => void refresh()} disabled={busy !== null} isLoading={busy === "refresh"}>Refresh confirmation status</AppButton>
          ) : null}
          {subscription.status === "ACTIVE" ? (
            <AppButton variant="secondary" size="sm" onClick={() => void pause()} disabled={busy !== null} isLoading={busy === "pause"}>Pause reports</AppButton>
          ) : null}
          {subscription.status !== "REVOKED" ? (
            <AppButton variant="danger" size="sm" onClick={() => setRevokeOpen(true)} disabled={busy !== null}>Revoke subscription</AppButton>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        isOpen={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={revoke}
        title="Revoke report subscription?"
        description="Future unsubmitted reports for this subscription will be suppressed. A new subscription requires fresh phone confirmation."
        confirmText="Revoke subscription"
        loading={busy === "revoke"}
        variant="danger"
      />
    </AppPanel>
  );
}
