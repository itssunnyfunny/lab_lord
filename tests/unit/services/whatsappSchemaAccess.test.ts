import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prismaTouched: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, {
    get(_target, property) {
      mocks.prismaTouched(String(property));
      return undefined;
    },
  }),
}));

import { WhatsAppFeatureDisabledError } from "@/lib/whatsappFeature";
import { WhatsAppAutomationService } from "@/services/whatsappAutomation.service";
import { WhatsAppMessageService } from "@/services/whatsappMessage.service";
import { WhatsAppRecipientService } from "@/services/whatsappRecipient.service";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("META_WHATSAPP_MODE", "TEST");
  vi.stubEnv("WHATSAPP_INTEGRATION_ENABLED", "true");
  vi.stubEnv("WHATSAPP_META_TEMPLATE_WRITES_ENABLED", "false");
  vi.stubEnv("WHATSAPP_META_MESSAGE_WRITES_ENABLED", "false");
  vi.stubEnv("WHATSAPP_AUTOMATION_PLANNER_ENABLED", "false");
  mocks.prismaTouched.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WhatsApp PR3 feature-surface schema gate", () => {
  it("holds every automation read, update, and disable path before database access", async () => {
    const calls = [
      () => WhatsAppAutomationService.get({ actorUserId: "user_1", branchId: "branch_1" }),
      () => WhatsAppAutomationService.update({
        actorUserId: "user_1",
        branchId: "branch_1",
        changes: {},
      }),
      () => WhatsAppAutomationService.disableDelivery({
        actorUserId: "user_1",
        branchId: "branch_1",
      }),
      () => WhatsAppAutomationService.disableAutomation({
        actorUserId: "user_1",
        branchId: "branch_1",
      }),
    ];

    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(WhatsAppFeatureDisabledError);
    expect(mocks.prismaTouched).not.toHaveBeenCalled();
  });

  it("holds recipient reads and user mutations before database access", async () => {
    const calls = [
      () => WhatsAppRecipientService.getForStudent({
        actorUserId: "user_1",
        branchId: "branch_1",
        studentId: "student_1",
      }),
      () => WhatsAppRecipientService.associate({
        actorUserId: "user_1",
        branchId: "branch_1",
        studentId: "student_1",
        relationship: "SELF",
        attestation: true,
      }),
      () => WhatsAppRecipientService.associateBulk({
        actorUserId: "user_1",
        branchId: "branch_1",
        attestation: true,
        recipients: [{ studentId: "student_1", relationship: "SELF" }],
      }),
      () => WhatsAppRecipientService.disable({
        actorUserId: "user_1",
        branchId: "branch_1",
        recipientId: "recipient_1",
      }),
    ];

    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(WhatsAppFeatureDisabledError);
    expect(mocks.prismaTouched).not.toHaveBeenCalled();
  });

  it("holds message history before database access", async () => {
    await expect(WhatsAppMessageService.history({
      actorUserId: "user_1",
      branchId: "branch_1",
      cursor: null,
      limit: 25,
    })).rejects.toBeInstanceOf(WhatsAppFeatureDisabledError);

    expect(mocks.prismaTouched).not.toHaveBeenCalled();
  });
});
