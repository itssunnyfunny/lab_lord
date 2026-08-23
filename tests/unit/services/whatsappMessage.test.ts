import { describe, expect, it } from "vitest";

import {
  createWhatsAppManualSourceFingerprint,
  createWhatsAppManualRequestHash,
  deriveWhatsAppManualCollectionContent,
  maskWhatsAppPhone,
} from "@/services/whatsappMessage.service";

describe("WhatsApp manual message request identity", () => {
  it("is stable across payment selection order and changes across branch or payment", () => {
    const left = createWhatsAppManualRequestHash("branch-a", ["payment-b", "payment-a"]);
    expect(left).toBe(createWhatsAppManualRequestHash("branch-a", ["payment-a", "payment-b"]));
    expect(left).not.toBe(createWhatsAppManualRequestHash("branch-b", ["payment-a", "payment-b"]));
    expect(left).not.toBe(createWhatsAppManualRequestHash("branch-a", ["payment-a"]));
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it("masks recipient phones for history and preview", () => {
    expect(maskWhatsAppPhone("+919876543210")).toBe("+91••••••3210");
  });

  it("derives current due versus past-due content from the scheduled execution time", () => {
    const payment = {
      id: "payment_1",
      amount: 1200,
      dueDate: new Date("2026-08-23T00:00:00.000Z"),
      student: { id: "student_1", name: "Sample Student" },
    };
    const due = deriveWhatsAppManualCollectionContent({
      payments: [payment],
      language: "en_IN",
      tone: "polite",
      branchName: "Sample Branch",
      timeZone: "Asia/Kolkata",
      at: new Date("2026-08-23T06:00:00.000Z"),
    });
    const pastDue = deriveWhatsAppManualCollectionContent({
      payments: [payment],
      language: "en_IN",
      tone: "polite",
      branchName: "Sample Branch",
      timeZone: "Asia/Kolkata",
      at: new Date("2026-08-24T06:00:00.000Z"),
    });
    expect(due.managedTemplateKey).toBe("FEE_RENEWAL_POLITE");
    expect(pastDue.managedTemplateKey).toBe("PAST_DUE_POLITE");
  });

  it("fingerprints current server facts canonically and detects truth changes", () => {
    const base = {
      branchId: "branch_1",
      branchName: "Sample Branch",
      senderId: "sender_1",
      recipientIds: ["recipient_2", "recipient_1"],
      paymentFacts: [{
        id: "payment_1",
        status: "DUE",
        amount: 1200,
        dueDate: new Date("2026-08-30T00:00:00.000Z"),
        studentId: "student_1",
        studentName: "Sample Student",
      }],
      templateBindingId: "binding_1",
      catalogHash: "a".repeat(64),
      settingsRevision: 2,
      managedTemplateKey: "FEE_RENEWAL_POLITE" as const,
      templateVariables: {
        studentName: "Sample Student",
        amount: "1,200",
        branchName: "Sample Branch",
        dueDate: "30 Aug 2026",
      },
    };
    const fingerprint = createWhatsAppManualSourceFingerprint(base);
    expect(fingerprint).toBe(createWhatsAppManualSourceFingerprint({
      ...base,
      recipientIds: [...base.recipientIds].reverse(),
    }));
    expect(fingerprint).not.toBe(createWhatsAppManualSourceFingerprint({
      ...base,
      paymentFacts: [{ ...base.paymentFacts[0]!, status: "PAID" }],
    }));
    expect(fingerprint).not.toBe(createWhatsAppManualSourceFingerprint({
      ...base,
      branchName: "Renamed Branch",
    }));
  });
});
