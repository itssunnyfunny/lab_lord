import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppReportSubscription } from "@/components/whatsapp/WhatsAppReportSubscription";
import {
  OrganizationWhatsAppReports,
  WhatsAppDailyReportPreviewCard,
  presentWhatsAppDailyReportPreview,
  presentWhatsAppDailyReportQueueResult,
  type WhatsAppDailyReportPreviewView,
} from "@/components/whatsapp/OrganizationWhatsAppReports";
import { BranchWhatsAppReports } from "@/components/whatsapp/BranchWhatsAppReports";
import {
  WhatsAppServiceNoticeComposer,
  WhatsAppServiceNoticePreviewCard,
} from "@/components/whatsapp/WhatsAppServiceNoticeComposer";
import {
  WhatsAppIncidents,
  WhatsAppUnknownOutcomeList,
  presentWhatsAppIncidentResponse,
} from "@/components/whatsapp/WhatsAppIncidents";
import { WhatsAppSenderSafety } from "@/components/whatsapp/WhatsAppSenderSafety";

const reportPreview: WhatsAppDailyReportPreviewView = {
  scope: "BRANCH",
  localReportDate: "2026-08-24",
  asOfLocalTime: "20:45",
  renderedPreview: "Central Branch daily report for 24 August 2026, as of 20:45.",
  metrics: {
    paymentsRecordedTodayCount: 4,
    paymentsRecordedTodayAmount: "₹4,500.00",
    newStudentsToday: 2,
    activeStudents: 40,
    usedShiftSlots: 31,
    totalShiftCapacity: 48,
    openDueCount: 9,
    openDueAmount: "₹12,000.00",
    overdueCount: 3,
    overdueAmount: "₹2,000.00",
    whatsAppAcceptedToday: 5,
    whatsAppDeliveredToday: 4,
    whatsAppFailedToday: 0,
    whatsAppUnknownToday: 1,
    branchCount: null,
  },
  eligibleRecipientCount: 1,
  suppressedCount: 0,
  estimatedCostMicros: "250000",
  currency: "INR",
  rateCardVersion: "rate-v1",
  estimateDisclaimer: "Estimated customer-owned Meta usage based on the current configured rate card.",
  alreadyQueued: false,
};

describe("WhatsApp PR4 presentational UI", () => {
  it("maps the exact report route envelopes without treating estimates as invoices", () => {
    const preview = presentWhatsAppDailyReportPreview({
      scope: "BRANCH",
      localReportDate: "2026-08-24",
      scheduledCutoffAt: "2026-08-24T15:30:00.000Z",
      catchUpEndsAt: "2026-08-24T17:30:00.000Z",
      metricsVersion: 1,
      metrics: {
        branchName: "Central Branch",
        localReportDate: "2026-08-24",
        asOfLocalTime: "20:45",
        paymentsRecordedTodayCount: 4,
        paymentsRecordedTodayAmount: 4500,
        newStudentsToday: 2,
        activeStudents: 40,
        usedShiftSlots: 31,
        totalShiftCapacity: 48,
        openDueCount: 9,
        openDueAmount: 12000,
        overdueCount: 3,
        overdueAmount: 2000,
        whatsAppAcceptedToday: 5,
        whatsAppDeliveredToday: 4,
        whatsAppFailedToday: 0,
        whatsAppUnknownToday: 1,
      },
      template: {
        managedKey: "DAILY_BRANCH_REPORT",
        language: "en_IN",
        renderedPreview: "Deterministic branch report.",
      },
      estimate: {
        currency: "INR",
        estimatedCostMicros: "250000",
        rateCardVersion: "rate-v1",
        rateCardExpiresAt: "2026-08-31T00:00:00.000Z",
        disclaimer: "Estimate only. Meta is authoritative.",
      },
      alreadyQueued: false,
    });
    const queued = presentWhatsAppDailyReportQueueResult({
      replayed: true,
      localReportDate: "2026-08-24",
      message: {
        id: "message_1",
        status: "SCHEDULED",
        trigger: "MANUAL",
        scheduledFor: "2026-08-24T15:30:00.000Z",
        localScheduleDate: "2026-08-24",
        rateCardVersion: "rate-v1",
        estimatedCostMicros: "250000",
        dailyReportSnapshotId: "snapshot_1",
        reportSubscriptionId: "subscription_1",
        createdAt: "2026-08-24T15:00:00.000Z",
      },
    });

    expect(preview.renderedPreview).toBe("Deterministic branch report.");
    expect(preview.metrics.paymentsRecordedTodayAmount).toMatch(/₹\s?4,500/);
    expect(preview.estimateDisclaimer).toContain("Meta is authoritative");
    expect(queued.status).toBe("DUPLICATE");
  });

  it("shows pending, active-ready controls without accepting a raw confirmation code prop", () => {
    const html = renderToStaticMarkup(
      <WhatsAppReportSubscription
        scope="BRANCH"
        subscription={{
          id: "subscription_1",
          scope: "BRANCH",
          maskedPhone: "+91••••••3210",
          language: "en_IN",
          sendTimeLocal: "21:00",
          status: "PENDING_CONFIRMATION",
          senderLabel: "Central Study Hall",
          confirmationExpiresAt: "2026-08-24T18:00:00.000Z",
          activatedAt: null,
          pausedAt: null,
          staleAt: null,
        }}
        canManage
        onCreate={vi.fn(async () => ({ code: "SHOULD_ONLY_ENTER_STATE", expiresAt: "2026-08-24T18:00:00.000Z" }))}
        onReissue={vi.fn(async () => ({ code: "SHOULD_ONLY_ENTER_STATE", expiresAt: "2026-08-24T18:00:00.000Z" }))}
        onPause={vi.fn(async () => undefined)}
        onRevoke={vi.fn(async () => undefined)}
        onRefresh={vi.fn(async () => null)}
      />
    );

    expect(html).toContain("Pending confirmation");
    expect(html).toContain("+91••••••3210");
    expect(html).toContain("Reissue one-time code");
    expect(html).toContain("Refresh confirmation status");
    expect(html).toContain("original one-time code is no longer displayed");
    expect(html).not.toContain("SHOULD_ONLY_ENTER_STATE");
    expect(html).not.toContain("START REPORTS");
    expect(html).not.toMatch(/confirmationCode|code=/i);
  });

  it("renders fixed aggregate daily-report metrics and cost caveats for both scopes", () => {
    const branchPreviewHtml = renderToStaticMarkup(<WhatsAppDailyReportPreviewCard preview={reportPreview} />);
    const organizationPreviewHtml = renderToStaticMarkup(
      <WhatsAppDailyReportPreviewCard
        preview={{ ...reportPreview, scope: "ORGANIZATION", metrics: { ...reportPreview.metrics, branchCount: 3 } }}
      />
    );
    const noOp = vi.fn(async () => undefined);
    const preview = vi.fn(async () => reportPreview);
    const queue = vi.fn(async () => ({ status: "QUEUED" as const, queuedMessageCount: 1, suppressedCount: 0, localReportDate: "2026-08-24" }));
    const organizationHtml = renderToStaticMarkup(
      <OrganizationWhatsAppReports
        organizationName="Synthetic Study Halls"
        settings={{ enabled: true, senderId: "sender_1", senderLabel: "Synthetic Sender", monthlyBudgetMinor: 10_000, budgetSource: "ORGANIZATION_REPORT" }}
        canManage
        availableSenders={[{ id: "sender_1", label: "Synthetic Sender · ••••1234" }]}
        recentReports={[]}
        onSetEnabled={noOp}
        onSaveSettings={vi.fn(async () => undefined)}
        onPreview={preview}
        onQueue={queue}
      />
    );
    const branchHtml = renderToStaticMarkup(
      <BranchWhatsAppReports
        branchName="Central Branch"
        settings={{ enabled: false, senderId: "sender_1", senderLabel: "Synthetic Sender", monthlyBudgetMinor: null, budgetSource: "BRANCH" }}
        canConfigure={false}
        canQueue={false}
        blockedReason="Reviewed branch report permissions are required."
        recentReports={[]}
        onSetEnabled={noOp}
        onPreview={preview}
        onQueue={queue}
      />
    );

    expect(branchPreviewHtml).toContain("Payments recorded today");
    expect(branchPreviewHtml).toContain("Shift slots used");
    expect(branchPreviewHtml).toContain("Open due");
    expect(branchPreviewHtml).toContain("WhatsApp failed / unknown");
    expect(branchPreviewHtml).toContain("Meta determines final billing and category");
    expect(branchPreviewHtml).not.toMatch(/attendance|student name|AI-generated/i);
    expect(organizationPreviewHtml).toContain("Branches");
    expect(organizationHtml).toContain("Separate organization report budget");
    expect(organizationHtml).toContain("Preview today&#x27;s report");
    expect(branchHtml).toContain("Existing branch WhatsApp budget");
    expect(branchHtml).toContain("Reviewed branch report permissions are required");
    expect(branchHtml).toContain('disabled=""');
  });

  it("offers only typed service-notice fields and exposes audience plus estimate in preview", () => {
    const composerHtml = renderToStaticMarkup(
      <WhatsAppServiceNoticeComposer
        branchName="Central Branch"
        canManage
        recentNotices={[{
          id: "notice_1",
          type: "BRANCH_CLOSED",
          reason: "PUBLIC_HOLIDAY",
          localEffectiveDate: "2026-08-25",
          status: "QUEUED",
          eligibleRecipientCount: 12,
          queuedMessageCount: 12,
          suppressedCount: 1,
          scheduledFor: "2026-08-24T15:00:00.000Z",
          estimatedCostMicros: "3000000",
          canCancel: true,
        }]}
        onPreview={vi.fn(async () => ({
          renderedPreview: "Central Branch will be closed on 25 August due to a public holiday.",
          eligibleRecipientCount: 12,
          suppressedCount: 1,
          estimatedCostMicros: "3000000",
          currency: "INR" as const,
          rateCardVersion: "rate-v1",
          scheduledFor: "2026-08-24T15:00:00.000Z",
          budgetRemainingAfterMicros: "10000000",
          estimateDisclaimer: "Estimate only.",
        }))}
        onQueue={vi.fn(async () => ({ noticeId: "notice_2", status: "QUEUED" as const, queuedMessageCount: 12, suppressedCount: 1 }))}
        onCancel={vi.fn(async () => ({ noticeId: "notice_1", status: "CANCELLED" as const, queuedMessageCount: 0, suppressedCount: 1 }))}
      />
    );
    const previewHtml = renderToStaticMarkup(
      <WhatsAppServiceNoticePreviewCard preview={{
        renderedPreview: "Central Branch will be closed on 25 August due to a public holiday.",
        eligibleRecipientCount: 12,
        suppressedCount: 1,
        estimatedCostMicros: "3000000",
        currency: "INR",
        rateCardVersion: "rate-v1",
        scheduledFor: "2026-08-24T15:00:00.000Z",
        budgetRemainingAfterMicros: "10000000",
        estimateDisclaimer: "Estimated customer-owned Meta usage.",
      }} />
    );

    expect(composerHtml).toContain("Branch closed");
    expect(composerHtml).toContain("changed-hours");
    expect(composerHtml).toContain("maintenance Utility template");
    expect(composerHtml).toContain("Public holiday");
    expect(composerHtml).toContain('type="date"');
    expect(composerHtml).toContain("12 unique eligible");
    expect(composerHtml).toContain("Cancel unsubmitted");
    expect(composerHtml).not.toMatch(/textarea|custom message|recipient phone|marketing|promotion|template body/i);
    expect(previewHtml).toContain("Unique eligible phones");
    expect(previewHtml).toContain("12");
    expect(previewHtml).toContain("Meta determines final billing and category");
  });

  it("renders bounded incidents and an UNKNOWN warning with no retry control", () => {
    const unknownOutcome = {
      id: "message_1",
      scopeLabel: "Central Branch",
      purpose: "SERVICE_NOTICE" as const,
      maskedPhone: "+91••••••4321",
      senderLabel: "Synthetic Sender",
      safeFailureCode: "META_MUTATION_OUTCOME_UNKNOWN",
      scheduledFor: "2026-08-24T15:00:00.000Z",
      submissionStartedAt: "2026-08-24T15:00:01.000Z",
      estimatedCostMicros: "250000",
      laterTrustedStatusAt: null,
    };
    const unknownHtml = renderToStaticMarkup(<WhatsAppUnknownOutcomeList items={[unknownOutcome]} />);
    const incidentsHtml = renderToStaticMarkup(
      <WhatsAppIncidents
        incidents={[{
          id: "incident_1",
          type: "CIRCUIT_BREAKER_OPEN",
          status: "OPEN",
          severity: "CRITICAL",
          scopeLabel: "Organization",
          senderLabel: "Synthetic Sender",
          safeCode: "AMBIGUOUS_OUTCOME_BURST",
          occurrenceCount: 3,
          firstSeenAt: "2026-08-24T15:00:00.000Z",
          lastSeenAt: "2026-08-24T15:05:00.000Z",
          acknowledgedAt: null,
          resolvedAt: null,
        }]}
        unknownOutcomes={[unknownOutcome]}
        canAcknowledge
        nextCursor="cursor_2"
        onAcknowledge={vi.fn(async () => undefined)}
        onLoadMore={vi.fn(async () => undefined)}
      />
    );

    expect(unknownHtml).toContain("Unknown");
    expect(unknownHtml).toContain("Do not retry");
    expect(unknownHtml).toContain("could send a duplicate");
    expect(unknownHtml).toContain("+91••••••4321");
    expect(unknownHtml).not.toMatch(/type="button"[^>]*>.*retry/i);
    expect(incidentsHtml).toContain("Sender circuit breaker open");
    expect(incidentsHtml).toContain("CRITICAL");
    expect(incidentsHtml).toContain("Acknowledge incident");
    expect(incidentsHtml).toContain("Load older incidents");
    expect(incidentsHtml).not.toMatch(/\+919876543210|wamid/i);
  });

  it("maps tenant-safe incident responses and normalizes UNKNOWN purposes without raw phones", () => {
    const presented = presentWhatsAppIncidentResponse({
      incidents: [{
        id: "incident_1",
        organizationId: "org_1",
        branchId: "branch_1",
        senderId: "sender_1",
        messageId: "message_1",
        type: "UNKNOWN_DELIVERY",
        severity: "CRITICAL",
        status: "OPEN",
        safeCode: "META_MUTATION_OUTCOME_UNKNOWN",
        firstSeenAt: "2026-08-24T15:00:00.000Z",
        lastSeenAt: "2026-08-24T15:01:00.000Z",
        occurrenceCount: 1,
        acknowledgedAt: null,
        resolvedAt: null,
        resolutionCode: null,
      }],
      unknownMessages: [{
        id: "message_1",
        organizationId: "org_1",
        branchId: "branch_1",
        senderId: "sender_1",
        purpose: "DAILY_BRANCH_REPORT",
        scheduledFor: "2026-08-24T15:00:00.000Z",
        submissionStartedAt: "2026-08-24T15:00:01.000Z",
        estimatedCostMicros: "250000",
        reportSubscriptionId: "subscription_1",
        dailyReportSnapshotId: "snapshot_1",
        serviceNoticeId: null,
        paymentResolutionEventId: null,
        providerStatusTimestamp: null,
        maskedRecipient: "+91••••••3210",
        laterWebhookArrived: false,
      }],
    }, {
      scopeLabel: "Central Branch",
      senderLabels: { sender_1: "Synthetic Sender" },
    });

    expect(presented.incidents[0]).toMatchObject({
      scopeLabel: "Central Branch",
      senderLabel: "Synthetic Sender",
    });
    expect(presented.unknownOutcomes[0]).toMatchObject({
      purpose: "BRANCH_REPORT",
      maskedPhone: "+91••••••3210",
      safeFailureCode: "META_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(JSON.stringify(presented)).not.toMatch(/recipientPhoneE164|\+919876543210/);
  });

  it("shows owner-only circuit-breaker controls, fixed thresholds, blockers, and rate caveats", () => {
    const safety = {
      senderLabel: "Synthetic Sender",
      senderStatus: "ACTIVE" as const,
      paused: true,
      pausePending: false,
      pauseReason: "AMBIGUOUS_OUTCOME_BURST" as const,
      pausedAt: "2026-08-24T15:00:00.000Z",
      pauseRequestedAt: null,
      pauseRevision: 2,
      ambiguousOutcomeCount: 3,
      ambiguousWindowStartedAt: "2026-08-24T14:55:00.000Z",
      definiteFailureCount: 0,
      failureWindowStartedAt: null,
      unknownOutcomeCount: 3,
      openCriticalIncidentCount: 1,
      lastAcceptedAt: "2026-08-24T14:59:00.000Z",
      lastDeliveredAt: "2026-08-24T14:58:00.000Z",
      lastHealthCheckAt: "2026-08-24T14:50:00.000Z",
      lastHealthyAt: "2026-08-24T14:50:00.000Z",
      providerRestricted: false,
      templatesHealthy: true,
      rateCardState: "EXPIRED" as const,
      rateCardVersion: "rate-v1",
      rateCardExpiresAt: "2026-08-24T00:00:00.000Z",
      resumeEligible: false,
      resumeBlockers: ["RATE_CARD_NOT_CURRENT" as const, "CRITICAL_INCIDENT_OPEN" as const],
    };
    const ownerHtml = renderToStaticMarkup(<WhatsAppSenderSafety safety={safety} isOwner onPause={vi.fn(async () => undefined)} onResume={vi.fn(async () => undefined)} onRefresh={vi.fn(async () => undefined)} />);
    const managerHtml = renderToStaticMarkup(<WhatsAppSenderSafety safety={safety} isOwner={false} blockedReason="Only the owner may resume delivery." onPause={vi.fn(async () => undefined)} onResume={vi.fn(async () => undefined)} onRefresh={vi.fn(async () => undefined)} />);

    expect(ownerHtml).toContain("Delivery paused");
    expect(ownerHtml).toContain("Ambiguous outcome burst");
    expect(ownerHtml).toContain("3 / 3");
    expect(ownerHtml).toContain("10-minute fixed window");
    expect(ownerHtml).toContain("EXPIRED");
    expect(ownerHtml).toContain("Current, nonexpired rate card is required");
    expect(ownerHtml).toContain("Resume sender delivery");
    expect(ownerHtml).toContain('disabled=""');
    expect(ownerHtml).toContain("do not retry ambiguous messages");
    expect(ownerHtml).toContain("Meta determines final billing and category");
    expect(managerHtml).toContain("Only the owner may resume delivery");
    expect(managerHtml).not.toContain("Resume sender delivery");
  });
});
