import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api/core", () => ({ apiClient: mocks }));

import { whatsapp } from "@/lib/api/whatsapp";

describe("WhatsApp customer API client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("installs only the fixed v1 Utility catalogue languages", async () => {
    await whatsapp.installManagedTemplates("org /1", "sender /1", ["en_IN", "hi"]);

    expect(mocks.post).toHaveBeenCalledWith(
      "/organizations/org%20%2F1/whatsapp/senders/sender%20%2F1/managed-templates/install",
      { languages: ["en_IN", "hi"], catalogVersion: 1 },
      { headers: { "Idempotency-Key": expect.any(String) } }
    );
    expect(JSON.stringify(mocks.post.mock.calls[0])).not.toMatch(/body|components|category|marketing|otp/i);
  });

  it("reloads sender-scoped managed catalogue status without mutation headers or template input", async () => {
    await whatsapp.getManagedTemplateStatus("org /1", "sender /1");

    expect(mocks.get).toHaveBeenCalledWith(
      "/organizations/org%20%2F1/whatsapp/senders/sender%20%2F1/managed-templates/install"
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.get.mock.calls)).not.toMatch(/components|templateName|category|token/i);
  });

  it("uses branch-scoped settings, delivery, automation, and masked recipient reads", async () => {
    await whatsapp.getBranchSettings("branch /1");
    await whatsapp.setBranchDelivery("branch /1", true);
    await whatsapp.setBranchAutomation("branch /1", true);
    await whatsapp.getStudentRecipient("branch /1", "student /1");

    expect(mocks.get.mock.calls).toEqual([
      ["/branches/branch%20%2F1/whatsapp/settings"],
      ["/branches/branch%20%2F1/whatsapp/recipients/student/student%20%2F1"],
    ]);
    expect(mocks.post.mock.calls[0][0]).toBe(
      "/branches/branch%20%2F1/whatsapp/delivery/enable"
    );
    expect(mocks.post.mock.calls[1][0]).toBe(
      "/branches/branch%20%2F1/whatsapp/automation/enable"
    );
    expect(mocks.post.mock.calls[1][1]).toEqual({
      confirmChargesAndProspectiveAutomation: true,
    });
  });

  it("submits only bounded student IDs, relationships, and exact bulk attestation", async () => {
    await whatsapp.associateRecipientsBulk("branch /1", [
      { studentId: "student /1", relationship: "GUARDIAN" },
      { studentId: "student_2", relationship: "SELF" },
    ]);

    expect(mocks.post).toHaveBeenCalledWith(
      "/branches/branch%20%2F1/whatsapp/recipients/bulk",
      {
        recipients: [
          { studentId: "student /1", relationship: "GUARDIAN" },
          { studentId: "student_2", relationship: "SELF" },
        ],
        attestation: true,
      },
      { headers: { "Idempotency-Key": expect.any(String) } }
    );
    expect(JSON.stringify(mocks.post.mock.calls[0])).not.toMatch(
      /phoneE164|phoneNumber|customRecipient/
    );
  });

  it("previews and queues only payment IDs with a caller-stable idempotency key", async () => {
    await whatsapp.previewPaymentReminders("branch_1", ["payment_2", "payment_1"]);
    await whatsapp.queuePaymentReminders(
      "branch_1",
      ["payment_2", "payment_1"],
      "manual-request-123"
    );

    expect(mocks.post.mock.calls[0][1]).toEqual({
      paymentIds: ["payment_2", "payment_1"],
    });
    expect(mocks.post.mock.calls[1]).toEqual([
      "/branches/branch_1/whatsapp/payment-reminders",
      { paymentIds: ["payment_2", "payment_1"] },
      { headers: { "Idempotency-Key": "manual-request-123" } },
    ]);
    expect(JSON.stringify(mocks.post.mock.calls)).not.toMatch(/phone|templateName|components|messageText/i);
  });

  it("requests bounded cursor history without exposing recipient filters", async () => {
    await whatsapp.getMessageHistory("branch_1", { cursor: "opaque cursor", limit: 20 });

    expect(mocks.get).toHaveBeenCalledWith(
      "/branches/branch_1/whatsapp/messages?cursor=opaque+cursor&limit=20"
    );
  });

  it("uses scoped report-subscription routes and sends the raw phone only on self-subscription", async () => {
    await whatsapp.getBranchReportSubscription("branch /1");
    await whatsapp.createBranchReportSubscription("branch /1", {
      phone: "+919876543210",
      language: "en_IN",
      sendTimeLocal: "21:00",
    });
    await whatsapp.reissueBranchReportSubscription("branch /1");
    await whatsapp.pauseBranchReportSubscription("branch /1");
    await whatsapp.revokeBranchReportSubscription("branch /1", "subscription_1");

    expect(mocks.get).toHaveBeenCalledWith(
      "/branches/branch%20%2F1/whatsapp/report-subscription"
    );
    expect(mocks.post.mock.calls.map(call => call[0])).toEqual([
      "/branches/branch%20%2F1/whatsapp/report-subscription",
      "/branches/branch%20%2F1/whatsapp/report-subscription/reissue",
      "/branches/branch%20%2F1/whatsapp/report-subscription/pause",
      "/branches/branch%20%2F1/whatsapp/report-subscription/revoke",
    ]);
    expect(mocks.post.mock.calls[0][1]).toEqual({
      phone: "+919876543210",
      language: "en_IN",
      sendTimeLocal: "21:00",
    });
    expect(mocks.post.mock.calls[1][1]).toEqual({});
    expect(mocks.post.mock.calls[2][1]).toEqual({});
    expect(mocks.post.mock.calls[3][1]).toEqual({ subscriptionId: "subscription_1" });
    expect(mocks.post.mock.calls.every(call => (
      typeof call[2]?.headers?.["Idempotency-Key"] === "string"
    ))).toBe(true);
    expect(JSON.stringify(mocks.post.mock.calls)).not.toMatch(/confirmationCode|confirmationHash|providerId/i);
  });

  it("uses owner-scoped organization report settings and subscription routes", async () => {
    await whatsapp.getOrganizationReportSubscription("org /1");
    await whatsapp.createOrganizationReportSubscription("org /1", {
      phone: "+919876543210",
      language: "hi",
      sendTimeLocal: "22:00",
    });
    await whatsapp.getOrganizationReportSettings("org /1");
    await whatsapp.updateOrganizationReportSettings("org /1", {
      senderId: "sender_1",
      monthlyBudgetMinor: 10_000,
    });

    expect(mocks.get.mock.calls).toEqual([
      ["/organizations/org%20%2F1/whatsapp/report-subscription"],
      ["/organizations/org%20%2F1/whatsapp/report-settings"],
    ]);
    expect(mocks.post.mock.calls[0][0]).toBe(
      "/organizations/org%20%2F1/whatsapp/report-subscription"
    );
    expect(mocks.patch).toHaveBeenCalledWith(
      "/organizations/org%20%2F1/whatsapp/report-settings",
      { senderId: "sender_1", monthlyBudgetMinor: 10_000 },
      { headers: { "Idempotency-Key": expect.any(String) } }
    );
  });

  it("previews empty report bodies and preserves the caller idempotency key when queueing", async () => {
    await whatsapp.previewBranchDailyReport("branch /1");
    await whatsapp.queueBranchDailyReport("branch /1", "branch-report-key");
    await whatsapp.previewOrganizationDailyReport("org /1");
    await whatsapp.queueOrganizationDailyReport("org /1", "organization-report-key");

    expect(mocks.post.mock.calls).toEqual([
      ["/branches/branch%20%2F1/whatsapp/reports/preview", {}],
      [
        "/branches/branch%20%2F1/whatsapp/reports/queue-today",
        {},
        { headers: { "Idempotency-Key": "branch-report-key" } },
      ],
      ["/organizations/org%20%2F1/whatsapp/reports/preview", {}],
      [
        "/organizations/org%20%2F1/whatsapp/reports/queue-today",
        {},
        { headers: { "Idempotency-Key": "organization-report-key" } },
      ],
    ]);
  });

  it("uses only typed notice fields and scoped incident operations", async () => {
    const draft = {
      type: "BRANCH_CLOSED" as const,
      reason: "PUBLIC_HOLIDAY" as const,
      localEffectiveDate: "2026-08-25",
      resumeLocalDate: "2026-08-26",
      openingTimeLocal: null,
      closingTimeLocal: null,
      maintenanceStartTimeLocal: null,
      maintenanceEndTimeLocal: null,
      delivery: "IMMEDIATE" as const,
      scheduledForLocal: null,
    };

    await whatsapp.listBranchServiceNotices("branch /1");
    await whatsapp.previewBranchServiceNotice("branch /1", draft);
    await whatsapp.queueBranchServiceNotice("branch /1", draft, "notice-request-1");
    await whatsapp.cancelBranchServiceNotice("branch /1", "notice /1");
    await whatsapp.listBranchIncidents("branch /1");
    await whatsapp.acknowledgeBranchIncident("branch /1", "incident /1");
    await whatsapp.listOrganizationIncidents("org /1");
    await whatsapp.acknowledgeOrganizationIncident("org /1", "incident /2");

    expect(mocks.get.mock.calls).toEqual([
      ["/branches/branch%20%2F1/whatsapp/service-notices?limit=20"],
      ["/branches/branch%20%2F1/whatsapp/incidents?limit=50"],
      ["/organizations/org%20%2F1/whatsapp/incidents?limit=50"],
    ]);
    expect(mocks.post.mock.calls[0]).toEqual([
      "/branches/branch%20%2F1/whatsapp/service-notices/preview",
      draft,
    ]);
    expect(mocks.post.mock.calls[1]).toEqual([
      "/branches/branch%20%2F1/whatsapp/service-notices",
      { ...draft, confirmCustomerCharge: true },
      { headers: { "Idempotency-Key": "notice-request-1" } },
    ]);
    expect(mocks.post.mock.calls[2]).toEqual([
      "/branches/branch%20%2F1/whatsapp/service-notices/notice%20%2F1/cancel",
      { confirmation: true },
      { headers: { "Idempotency-Key": expect.any(String) } },
    ]);
    expect(mocks.post.mock.calls[3]).toEqual([
      "/branches/branch%20%2F1/whatsapp/incidents/incident%20%2F1/acknowledge",
      { confirmation: true },
      { headers: { "Idempotency-Key": expect.any(String) } },
    ]);
    expect(mocks.post.mock.calls[4]).toEqual([
      "/organizations/org%20%2F1/whatsapp/incidents/incident%20%2F2/acknowledge",
      { confirmation: true },
      { headers: { "Idempotency-Key": expect.any(String) } },
    ]);
    expect(JSON.stringify(mocks.post.mock.calls)).not.toMatch(/messageBody|customText|phoneE164|recipientIds/i);
  });

  it("uses owner sender-safety routes with explicit confirmations", async () => {
    await whatsapp.getSenderSafety("org /1", "sender /1");
    await whatsapp.pauseSenderDelivery("org /1", "sender /1");
    await whatsapp.resumeSenderDelivery("org /1", "sender /1");

    expect(mocks.get).toHaveBeenCalledWith(
      "/organizations/org%20%2F1/whatsapp/senders/sender%20%2F1/safety"
    );
    expect(mocks.post.mock.calls).toEqual([
      [
        "/organizations/org%20%2F1/whatsapp/senders/sender%20%2F1/pause",
        { confirmation: true },
        { headers: { "Idempotency-Key": expect.any(String) } },
      ],
      [
        "/organizations/org%20%2F1/whatsapp/senders/sender%20%2F1/resume",
        { confirmation: true },
        { headers: { "Idempotency-Key": expect.any(String) } },
      ],
    ]);
  });
});
