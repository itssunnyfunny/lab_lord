import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetaEmbeddedSignup } from "@/components/whatsapp/MetaEmbeddedSignup";
import { isValidMetaRegistrationPin } from "@/components/whatsapp/RegisterPhoneDialog";
import { WhatsAppSenderSummaryCard } from "@/components/whatsapp/OrganizationWhatsAppPanel";
import { BranchWhatsAppReadiness } from "@/components/whatsapp/BranchWhatsAppPanel";
import type {
  WhatsAppBranchAssignmentResponse,
  WhatsAppSenderSummary,
} from "@/lib/api/whatsapp";

const sender: WhatsAppSenderSummary = {
  id: "sender_local_1",
  providerMode: "TEST",
  displayPhoneNumber: "+91 98765 43210",
  verifiedName: "Central Study Hall",
  qualityRating: "GREEN",
  accountMode: "SANDBOX",
  status: "NEEDS_REGISTRATION",
  phoneRegisteredAt: null,
  webhookSubscribedAt: "2026-08-22T10:00:00.000Z",
  lastHealthCheckAt: "2026-08-22T10:05:00.000Z",
  lastTemplateSyncAt: null,
  templateCounts: { approved: 2, pending: 1, rejected: 0, other: 0, total: 3 },
  assignedBranches: [{ id: "branch_local_1", name: "Central" }],
};

describe("WhatsApp foundation UI", () => {
  it("keeps the SDK deferred until an owner explicitly prepares onboarding", () => {
    const html = renderToStaticMarkup(
      <MetaEmbeddedSignup
        organizationId="org_1"
        config={{
          appId: "public-app-id",
          embeddedSignupConfigId: "public-config-id",
          graphApiVersion: "v1.0",
        }}
        onConnected={() => undefined}
      />
    );

    expect(html).toContain("Prepare Meta connection");
    expect(html).not.toContain("connect.facebook.net");
    expect(html).not.toContain("Send test message");
    expect(html).not.toContain("one-time raw state");
  });

  it("renders only safe readiness details and explicit local-only controls", () => {
    const html = renderToStaticMarkup(
      <WhatsAppSenderSummaryCard
        sender={sender}
        canManage
        activeOperation={null}
        onRegister={vi.fn()}
        onSync={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );

    expect(html).toContain("Central Study Hall");
    expect(html).toContain("Complete registration");
    expect(html).toContain("Synchronize templates");
    expect(html).toContain("Disconnect locally");
    expect(html).not.toContain("Send test");
    expect(html).not.toContain("waba");
    expect(html).not.toContain("phone-number-id");
  });

  it("shows the feature-safe activation checklist and hides mutation controls from viewers", () => {
    const response: WhatsAppBranchAssignmentResponse = {
      enabled: true,
      canManage: false,
      safeReason: null,
      assignment: {
        branchId: "branch_local_1",
        sender: {
          id: sender.id,
          providerMode: sender.providerMode,
          displayPhoneNumber: sender.displayPhoneNumber,
          verifiedName: sender.verifiedName,
          qualityRating: sender.qualityRating,
          status: "ACTIVE",
          phoneRegisteredAt: "2026-08-22T10:00:00.000Z",
          webhookSubscribedAt: sender.webhookSubscribedAt,
        },
        defaultLanguage: "en",
        defaultTone: "polite",
        automationEnabled: false,
      },
      availableSenders: [],
    };
    const html = renderToStaticMarkup(
      <BranchWhatsAppReadiness
        response={response}
        selectedSenderId=""
        busy={false}
        onSelectedSenderChange={vi.fn()}
        onAssign={vi.fn()}
        onUnassign={vi.fn()}
      />
    );

    expect(html).toContain("Activation checklist");
    expect(html).toContain("Managed templates installed");
    expect(html).toContain("Required templates approved as Utility");
    expect(html).toContain("Send time configured");
    expect(html).toContain("Reminder stages selected");
    expect(html).toContain("Automation explicitly enabled");
    expect(html).toContain("Incomplete:");
    expect(html).not.toContain("Assign sender");
    expect(html).not.toContain("Send test");
    expect(html).not.toContain("custom template");
  });

  it("accepts exactly six ASCII digits for Meta phone registration", () => {
    expect(isValidMetaRegistrationPin("123456")).toBe(true);
    expect(isValidMetaRegistrationPin("12345")).toBe(false);
    expect(isValidMetaRegistrationPin("1234567")).toBe(false);
    expect(isValidMetaRegistrationPin("１２３４５６")).toBe(false);
    expect(isValidMetaRegistrationPin("12345a")).toBe(false);
  });
});
