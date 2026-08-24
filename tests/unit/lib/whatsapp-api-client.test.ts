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
});
