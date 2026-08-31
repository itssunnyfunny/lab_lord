"use client";

import { useRef, useState } from "react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { formErrorBannerClass, formSuccessBannerClass } from "@/components/ui/formSurface";
import { pageInsetMetricClass } from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";
import {
  WhatsAppDailyReportActions,
  type WhatsAppDailyReportHistoryItemView,
  type WhatsAppDailyReportPreviewView,
  type WhatsAppDailyReportQueueResultView,
  type WhatsAppReportSettingsSummaryView,
} from "@/components/whatsapp/OrganizationWhatsAppReports";

export interface BranchWhatsAppReportsProps {
  branchName: string;
  settings: WhatsAppReportSettingsSummaryView;
  canConfigure: boolean;
  canQueue: boolean;
  blockedReason?: string;
  recentReports: readonly WhatsAppDailyReportHistoryItemView[];
  onSetEnabled: (enabled: boolean) => Promise<void>;
  onPreview: () => Promise<WhatsAppDailyReportPreviewView>;
  onQueue: (idempotencyKey: string) => Promise<WhatsAppDailyReportQueueResultView>;
}

export function BranchWhatsAppReports({
  branchName,
  settings,
  canConfigure,
  canQueue,
  blockedReason,
  recentReports,
  onSetEnabled,
  onPreview,
  onQueue,
}: BranchWhatsAppReportsProps) {
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const operationRef = useRef(false);

  const setEnabled = async () => {
    if (operationRef.current || !canConfigure) return;
    operationRef.current = true;
    setChanging(true);
    setNotice(null);
    try {
      await onSetEnabled(!settings.enabled);
      setNotice({
        tone: "status",
        text: settings.enabled
          ? "Branch report automation disabled. Unsubmitted report work will be revalidated by the server."
          : "Branch report automation enabled prospectively.",
      });
    } catch {
      setNotice({ tone: "error", text: "Branch report automation could not be changed." });
    } finally {
      operationRef.current = false;
      setChanging(false);
    }
  };

  return (
    <div className="space-y-4">
      <AppPanel
        title="Branch report setup"
        description="Permission-bound branch reports use deterministic aggregate metrics, shift-slot occupancy, and the existing branch WhatsApp budget."
        action={<Badge variant={settings.enabled ? "success" : "default"}>{settings.enabled ? "Enabled" : "Disabled"}</Badge>}
        contentClassName="space-y-4"
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className={pageInsetMetricClass}>
            <dt className="text-xs text-[color:var(--text-muted)]">Connected sender</dt>
            <dd className="mt-1 font-medium">{settings.senderLabel || "Not assigned"}</dd>
          </div>
          <div className={pageInsetMetricClass}>
            <dt className="text-xs text-[color:var(--text-muted)]">Budget source</dt>
            <dd className="mt-1 font-medium">Existing branch WhatsApp budget</dd>
          </div>
        </dl>
        {notice ? (
          <p
            className={cn("px-3 py-2 text-sm", notice.tone === "error" ? formErrorBannerClass : formSuccessBannerClass)}
            role={notice.tone === "error" ? "alert" : "status"}
            aria-live={notice.tone === "error" ? "assertive" : "polite"}
          >
            {notice.text}
          </p>
        ) : null}
        <div className="flex justify-end">
          <AppButton
            variant={settings.enabled ? "danger" : "primary"}
            size="sm"
            onClick={() => void setEnabled()}
            disabled={!canConfigure || changing}
            isLoading={changing}
          >
            {settings.enabled ? "Disable scheduled reports" : "Enable scheduled reports"}
          </AppButton>
        </div>
      </AppPanel>

      <WhatsAppDailyReportActions
        scope="BRANCH"
        scopeName={branchName}
        canQueue={canQueue}
        blockedReason={blockedReason}
        recentReports={recentReports}
        onPreview={onPreview}
        onQueue={onQueue}
      />
    </div>
  );
}
