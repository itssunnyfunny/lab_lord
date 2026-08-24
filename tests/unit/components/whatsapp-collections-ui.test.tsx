import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovedPaymentReminderPreview,
  ApprovedPaymentReminderReview,
} from "@/components/whatsapp/ApprovedPaymentReminderReview";
import { BranchWhatsAppMessageHistoryList } from "@/components/whatsapp/BranchWhatsAppMessageHistory";
import { StudentWhatsAppConsentControls } from "@/components/whatsapp/StudentWhatsAppConsentControls";
import { BulkWhatsAppConsentControls } from "@/components/whatsapp/BulkWhatsAppConsentControls";
import {
  loadManagedTemplateStatuses,
  WhatsAppSenderSummaryCard,
} from "@/components/whatsapp/OrganizationWhatsAppPanel";
import {
  BranchWhatsAppSettingsEditor,
  type BranchSettingsForm,
} from "@/components/whatsapp/BranchWhatsAppPanel";
import {
  whatsapp,
  type WhatsAppBranchSettings,
  type WhatsAppManagedTemplateInstallation,
  type WhatsAppMessageHistoryItem,
  type WhatsAppPaymentReminderPreview,
  type WhatsAppSenderSummary,
} from "@/lib/api/whatsapp";
import {
  MAX_WHATSAPP_RECIPIENT_BULK_SIZE,
  WHATSAPP_OPERATIONAL_CONSENT_STATEMENT,
} from "@/lib/whatsappConsentPolicy";

const sender: WhatsAppSenderSummary = {
  id: "sender_1",
  providerMode: "TEST",
  displayPhoneNumber: "+91 98••• 43210",
  verifiedName: "Central Study Hall",
  qualityRating: "GREEN",
  accountMode: "SANDBOX",
  status: "ACTIVE",
  phoneRegisteredAt: "2026-08-23T10:00:00.000Z",
  webhookSubscribedAt: "2026-08-23T10:00:00.000Z",
  lastHealthCheckAt: "2026-08-23T10:00:00.000Z",
  lastTemplateSyncAt: "2026-08-23T10:00:00.000Z",
  templateCounts: { approved: 1, pending: 1, rejected: 0, other: 0, total: 2 },
  assignedBranches: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WhatsApp collections customer UI", () => {
  it("blocks a manager budget increase and exposes only fixed stages and bounded settings", () => {
    const settings: WhatsAppBranchSettings = {
      branchId: "branch_1",
      enabled: true,
      automationEnabled: false,
      automationEnabledAt: null,
      defaultLanguage: "en_IN",
      defaultTone: "polite",
      sendTimeLocal: "10:00",
      dailyAutomaticMessageLimit: 20,
      maxAutomaticCollectionMessagesPerCycle: 3,
      configurationRevision: 1,
      monthlyBudgetMinor: 10_000,
      timeZone: "Asia/Kolkata",
      sender: { id: "sender_1", status: "ACTIVE", providerMode: "TEST", displayPhoneNumber: "+91••••••3210", lastHealthCheckAt: null },
      rules: [],
      templateHealth: [],
      budget: { month: "2026-08", ceilingMicros: "100000000", reservedMicros: "0", committedMicros: "0", reservedAndCommittedMicros: "0", remainingMicros: "100000000" },
      consentCoverage: { activeStudents: 1, missingPhone: 0, associated: 1, optedIn: 1, optedOut: 0, stale: 0, recipientStatusCounts: { ACTIVE: 1 } },
      deliveryHealth: {},
      deliveryHealthWindowDays: 30,
      lastWebhookReceivedAt: null,
      lastPlannedAt: null,
      lastPlannerErrorCode: null,
    };
    const form: BranchSettingsForm = {
      defaultLanguage: "en_IN",
      defaultTone: "polite",
      sendTimeLocal: "10:00",
      dailyAutomaticMessageLimit: "21",
      maxAutomaticCollectionMessagesPerCycle: "4",
      monthlyBudgetRupees: "200",
      rules: {
        WELCOME: false,
        FEE_DUE_MINUS_7: false,
        FEE_DUE_MINUS_3: false,
        FEE_DUE_MINUS_1: false,
        FEE_DUE_TODAY: true,
        PAST_DUE_PLUS_1: false,
        PAST_DUE_PLUS_3: false,
        PAST_DUE_PLUS_7: false,
        PAYMENT_CONFIRMATION: false,
        PAYMENT_CORRECTION: false,
      },
    };
    const html = renderToStaticMarkup(
      <BranchWhatsAppSettingsEditor
        settings={settings}
        form={form}
        canManage
        isOwner={false}
        busy={false}
        automationConfirmed={false}
        onAutomationConfirmedChange={vi.fn()}
        onFormChange={vi.fn()}
        onSave={vi.fn()}
        onSetDelivery={vi.fn()}
        onSetAutomation={vi.fn()}
      />
    );

    expect(html).toContain("Only the organization owner can increase the budget");
    expect(html).toContain("Only the organization owner can increase automatic message limits");
    expect(html).toContain('max="20"');
    expect(html).toContain('max="3"');
    expect(html).toContain("Due date");
    expect(html).toContain("fixed approved catalogue variant");
    expect(html).toContain("historical dues will not be automatically blasted");
    expect(html).toContain("Meta determines final billing");
    expect(html).toContain("STOP immediately suppresses future unsubmitted messages");
    expect(html).not.toMatch(/textarea|marketing|authentication|otp/i);
  });

  it("shows fixed managed-catalogue status without arbitrary template fields", () => {
    const installation: WhatsAppManagedTemplateInstallation = {
      catalogVersion: 1,
      languages: ["en_IN", "hi"],
      templates: [
        {
          managedKey: "FEE_RENEWAL_POLITE",
          language: "en_IN",
          providerTemplateName: "lablords_fee_renewal_polite_en_in_v1",
          providerTemplateId: "provider_1",
          status: "READY",
          active: true,
          errorCode: null,
          providerCategory: "UTILITY",
          providerStatus: "APPROVED",
          lastSyncedAt: "2026-08-23T10:00:00.000Z",
        },
        {
          managedKey: "FEE_RENEWAL_POLITE",
          language: "hi",
          providerTemplateName: "lablords_fee_renewal_polite_hi_v1",
          providerTemplateId: null,
          status: "UNKNOWN",
          active: false,
          errorCode: "META_MUTATION_OUTCOME_UNKNOWN",
          providerCategory: null,
          providerStatus: null,
          lastSyncedAt: null,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <WhatsAppSenderSummaryCard
        sender={sender}
        canManage
        activeOperation={null}
        installation={installation}
        onRegister={vi.fn()}
        onSync={vi.fn()}
        onInstall={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );

    expect(html).toContain("Lab Lords Utility catalogue v1");
    expect(html).toContain("Languages: English (India), Hindi");
    expect(html).toContain("Provider: Approved · Utility");
    expect(html).toContain("Binding active");
    expect(html).toContain("Last synchronized:");
    expect(html).toContain("Do not retry");
    expect(html).toContain("Install Lab Lords Utility templates");
    expect(html).not.toContain("provider_1");
    expect(html).not.toMatch(/textarea|template body|marketing|authentication|otp/i);
  });

  it("reloads durable managed-template status per sender while isolating a failed read", async () => {
    const installation: WhatsAppManagedTemplateInstallation = {
      catalogVersion: 1,
      languages: ["en_IN"],
      templates: [{
        managedKey: "FEE_RENEWAL_POLITE",
        language: "en_IN",
        providerTemplateName: "lablords_fee_renewal_polite_en_in_v1",
        providerTemplateId: "provider_1",
        status: "READY",
        active: true,
        errorCode: null,
        providerCategory: "UTILITY",
        providerStatus: "APPROVED",
        lastSyncedAt: "2026-08-23T10:00:00.000Z",
      }],
    };
    const getStatus = vi.spyOn(whatsapp, "getManagedTemplateStatus")
      .mockImplementation(async (_organizationId, senderId) => {
        if (senderId === "sender_unavailable") throw new Error("temporarily unavailable");
        return { installation };
      });

    const loaded = await loadManagedTemplateStatuses(
      "org_1",
      ["sender_1", "sender_unavailable"]
    );

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(getStatus).toHaveBeenNthCalledWith(1, "org_1", "sender_1");
    expect(loaded).toEqual({ sender_1: installation });
  });

  it("renders grouped official previews, server suppressions, masking, and the estimate disclaimer", () => {
    const preview: WhatsAppPaymentReminderPreview = {
      selectedPaymentCount: 3,
      eligibleRecipientCount: 1,
      suppressedCount: 1,
      estimatedCostMicros: "250000",
      rateCardVersion: "rate-v1",
      currency: "INR",
      groups: [{
        maskedPhone: "+91••••••3210",
        paymentCount: 2,
        studentCount: 2,
        studentName: "Aarav and Anaya",
        managedTemplateKey: "MULTI_STUDENT_COLLECTION_SUMMARY",
        renderedPreview: "Namaste. Two fee records remain due.",
        scheduledFor: "2026-08-23T10:00:00.000Z",
      }],
      suppressed: [{ paymentId: "payment_3", reason: "CONSENT_OPTED_OUT" }],
      estimateDisclaimer: "Estimated Meta usage. Final charges are determined by Meta.",
    };
    const html = renderToStaticMarkup(<ApprovedPaymentReminderPreview preview={preview} />);

    expect(html).toContain("Shared recipient group: 2 students will receive one summary message");
    expect(html).toContain("+91••••••3210");
    expect(html).toContain("Consent opted out: 1");
    expect(html).toContain("Final charges are determined by Meta");
    expect(html).not.toContain("payment_3");
    expect(html).not.toMatch(/textarea|phone number input|custom message/i);
  });

  it("keeps queueing permission-safe and offers no arbitrary recipient or message controls", () => {
    const html = renderToStaticMarkup(
      <ApprovedPaymentReminderReview
        branchId="branch_1"
        paymentIds={["payment_1"]}
        canSend={false}
        blockedReason="WhatsApp sending requires reviewed branch permission."
      />
    );

    expect(html).toContain("WhatsApp sending requires reviewed branch permission");
    expect(html).toContain("Preview approved reminder (1)");
    expect(html).toContain('disabled=""');
    expect(html).not.toMatch(/textarea|recipient phone|template name|custom message|marketing|otp/i);
  });

  it("uses text status plus an explicit no-retry warning for unknown history", () => {
    const item: WhatsAppMessageHistoryItem = {
      id: "message_1",
      student: { id: "student_1", name: "Synthetic Student" },
      maskedPhone: "+91••••••4321",
      purpose: "MANUAL_REMINDER",
      trigger: "MANUAL",
      automationStage: null,
      managedTemplateKey: "PAST_DUE_POLITE",
      template: { name: "lablords_past_due_polite_en_in_v1", language: "en_IN" },
      status: "UNKNOWN",
      scheduledFor: "2026-08-23T10:00:00.000Z",
      submissionStartedAt: "2026-08-23T10:00:01.000Z",
      acceptedAt: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      safeFailureCode: "META_MUTATION_OUTCOME_UNKNOWN",
      estimatedCostMicros: "250000",
      providerBillable: null,
      providerPricingCategory: null,
      createdBy: { id: "user_1", name: "Synthetic Manager" },
      payments: [],
      createdAt: "2026-08-23T10:00:00.000Z",
    };
    const html = renderToStaticMarkup(<BranchWhatsAppMessageHistoryList items={[item]} />);

    expect(html).toContain("Unknown");
    expect(html).toContain("Lab Lords will not retry automatically because that could send a duplicate message");
    expect(html).toContain("operator review is required");
    expect(html).toContain("+91••••••4321");
    expect(html).not.toContain("wamid");
  });

  it("masks the student phone and requires explicit operational-consent attestation", () => {
    const html = renderToStaticMarkup(
      <StudentWhatsAppConsentControls
        branchId="branch_1"
        student={{
          id: "student_1",
          name: "Synthetic Student",
          phone: "+919876543210",
          status: "ACTIVE",
        }}
        canManage
        initialState={null}
      />
    );

    expect(html).toContain("••••••3210");
    expect(html).not.toContain("+919876543210");
    expect(html).toContain(WHATSAPP_OPERATIONAL_CONSENT_STATEMENT);
    expect(html).toContain("operational-collections-v1");
    expect(html).toContain('aria-label="Recipient relationship"');
    expect(html).toContain('disabled=""');
  });

  it("shows assigned sender, consent source/date, stale evidence, and opted-out state", () => {
    const html = renderToStaticMarkup(
      <StudentWhatsAppConsentControls
        branchId="branch_1"
        student={{
          id: "student_1",
          name: "Synthetic Student",
          phone: "+919999999999",
          status: "ACTIVE",
        }}
        canManage
        initialState={{
          studentId: "student_1",
          studentStatus: "ACTIVE",
          maskedPhone: "••••••9999",
          studentMaskedPhone: "••••••9999",
          assignedSender: {
            id: "sender_1",
            status: "ACTIVE",
            verifiedName: "Central Study Hall",
            maskedPhone: "••••••1234",
          },
          recipient: {
            id: "recipient_1",
            studentId: "student_1",
            relationship: "GUARDIAN",
            status: "DISABLED",
            consentStatus: "OPTED_OUT",
            consentType: "OPERATIONAL",
            policyVersion: "operational-collections-v1",
            maskedPhone: "••••••3210",
            phoneMatchesCurrentStudent: false,
            consentSource: "WHATSAPP_REPLY",
            consentRecordedAt: "2026-08-22T10:00:00.000Z",
            verifiedAt: "2026-08-20T10:00:00.000Z",
            staleAt: "2026-08-21T10:00:00.000Z",
            disabledAt: "2026-08-22T10:00:00.000Z",
          },
        }}
      />
    );

    expect(html).toContain("Central Study Hall");
    expect(html).toContain("WhatsApp reply");
    expect(html).toContain("Operational consent opted out");
    expect(html).toContain("Stale phone evidence");
    expect(html).toContain("Opt-out is active");
    expect(html).toContain("••••••9999");
    expect(html).toContain("••••••3210");
    expect(html).not.toMatch(/\+919999999999|\+919876543210/);
  });

  it("renders a permission-gated, loaded-student-only bulk attestation capped at 100", () => {
    const html = renderToStaticMarkup(
      <BulkWhatsAppConsentControls
        branchId="branch_1"
        students={[
          { id: "student_1", name: "Synthetic One", phone: "+919876543210", status: "ACTIVE" },
          { id: "student_2", name: "Synthetic Two", phone: null, status: "ACTIVE" },
        ]}
        canManage={false}
      />
    );

    expect(html).toContain("2 currently loaded branch students");
    expect(html).toContain(`capped at ${MAX_WHATSAPP_RECIPIENT_BULK_SIZE}`);
    expect(html).toContain("Guardian (default)");
    expect(html).toContain(WHATSAPP_OPERATIONAL_CONSENT_STATEMENT);
    expect(html).toContain("You need WhatsApp management permission");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("+919876543210");
    expect(html).not.toMatch(/type="tel"|name="phone"|textarea/);
  });
});
