import { describe, expect, it } from "vitest";

import {
  createWhatsAppServiceNoticeMessageKey,
  createWhatsAppServiceNoticeRequestHash,
  createWhatsAppServiceNoticeSourceFingerprint,
  resolveWhatsAppServiceNoticeDraft,
  serviceNoticeHasExpired,
  serviceNoticeTemplateValues,
  type WhatsAppServiceNoticeDraft,
} from "@/lib/whatsappServiceNotice";

const NOW = new Date("2026-08-24T04:00:00.000Z"); // 09:30 Asia/Kolkata

function closedDraft(
  overrides: Partial<WhatsAppServiceNoticeDraft> = {}
): WhatsAppServiceNoticeDraft {
  return {
    type: "BRANCH_CLOSED",
    reason: "PUBLIC_HOLIDAY",
    localEffectiveDate: "2026-08-25",
    resumeLocalDate: "2026-08-26",
    openingTimeLocal: null,
    closingTimeLocal: null,
    maintenanceStartTimeLocal: null,
    maintenanceEndTimeLocal: null,
    delivery: "IMMEDIATE",
    scheduledForLocal: null,
    ...overrides,
  };
}

function resolve(draft: WhatsAppServiceNoticeDraft, now = NOW) {
  return resolveWhatsAppServiceNoticeDraft({
    draft,
    now,
    timeZone: "Asia/Kolkata",
    branchSendTimeLocal: "10:00",
  });
}

describe("typed WhatsApp service notices", () => {
  it("resolves only server-approved closure variables without a student or arbitrary body", () => {
    const resolved = resolve(closedDraft());
    const values = serviceNoticeTemplateValues({
      draft: resolved.draft,
      branchName: "Central Study Hall",
      language: "en_IN",
    });

    expect(resolved.managedTemplateKey).toBe("BRANCH_CLOSED_NOTICE");
    expect(resolved.scheduledFor).toBe(NOW);
    expect(values).toEqual({
      branchName: "Central Study Hall",
      closureDate: "25 Aug 2026",
      reason: "a public holiday",
      resumeDate: "26 Aug 2026",
    });
    expect(Object.keys(values)).not.toContain("studentName");
    expect(Object.keys(values)).not.toContain("message");
  });

  it("validates each fixed shape, calendar ordering, horizon, and maintenance reason", () => {
    expect(() => resolve(closedDraft({ type: "OTHER" as never }))).toThrow();
    expect(() => resolve(closedDraft({ reason: "PROMOTION" as never }))).toThrow();
    expect(() => resolve(closedDraft({ localEffectiveDate: "2026-02-30" }))).toThrow();
    expect(() => resolve(closedDraft({ localEffectiveDate: "2026-08-23" }))).toThrow();
    expect(() => resolve(closedDraft({
      localEffectiveDate: "2026-09-24",
      resumeLocalDate: "2026-09-25",
    }))).toThrow("at most 30 days");
    expect(() => resolve(closedDraft({ resumeLocalDate: "2026-08-25" }))).toThrow(
      "Resume date must follow"
    );
    expect(() => resolve({
      ...closedDraft(),
      type: "HOURS_CHANGED",
      resumeLocalDate: null,
      openingTimeLocal: "18:00",
      closingTimeLocal: "09:00",
    })).toThrow("end time must follow");
    expect(() => resolve({
      ...closedDraft(),
      type: "MAINTENANCE_WINDOW",
      reason: "ADMINISTRATIVE",
      resumeLocalDate: null,
      maintenanceStartTimeLocal: "12:00",
      maintenanceEndTimeLocal: "13:00",
    })).toThrow();
  });

  it("enforces the local safety window and requires scheduled delivery before the event", () => {
    expect(() => resolve(closedDraft({
      delivery: "SCHEDULED",
      scheduledForLocal: "2026-08-25T10:00",
    }))).toThrow("precede the effective event");

    const afterWindow = new Date("2026-08-24T15:45:00.000Z"); // 21:15 local
    expect(() => resolve(closedDraft({
      localEffectiveDate: "2026-08-24",
      resumeLocalDate: "2026-08-25",
    }), afterWindow)).toThrow("on or before the closure date");

    const scheduled = resolve(closedDraft({
      delivery: "SCHEDULED",
      scheduledForLocal: "2026-08-24T10:00",
    }));
    expect(scheduled.scheduledFor.toISOString()).toBe("2026-08-24T04:30:00.000Z");
  });

  it("keeps idempotency and source fingerprints deterministic and phone-safe", () => {
    const draft = closedDraft();
    const reordered = Object.fromEntries(
      Object.entries(draft).reverse()
    ) as WhatsAppServiceNoticeDraft;
    expect(createWhatsAppServiceNoticeRequestHash({ branchId: "branch_1", draft }))
      .toBe(createWhatsAppServiceNoticeRequestHash({ branchId: "branch_1", draft: reordered }));

    const fingerprintInput = {
      noticeId: "notice_1",
      organizationId: "org_1",
      branchId: "branch_1",
      branchName: "Central",
      senderId: "sender_1",
      recipientPhoneE164: "+919876543210",
      type: "BRANCH_CLOSED" as const,
      reason: "PUBLIC_HOLIDAY" as const,
      localEffectiveDate: "2026-08-25",
      effectiveStartAt: new Date("2026-08-24T18:30:00.000Z"),
      effectiveEndAt: null,
      resumeAt: new Date("2026-08-25T18:30:00.000Z"),
      scheduledFor: NOW,
      templateBindingId: "binding_1",
      managedTemplateKey: "BRANCH_CLOSED_NOTICE" as const,
      catalogHash: "a".repeat(64),
      settingsRevision: 2,
      templateVariables: { branchName: "Central" },
    };
    const fingerprint = createWhatsAppServiceNoticeSourceFingerprint(fingerprintInput);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("9876543210");
    expect(createWhatsAppServiceNoticeSourceFingerprint({
      ...fingerprintInput,
      recipientPhoneE164: "+919999999999",
    })).not.toBe(fingerprint);
    expect(createWhatsAppServiceNoticeMessageKey({
      kind: "dedupe",
      noticeId: "notice_1",
      senderId: "sender_1",
      recipientPhoneE164: "+919876543210",
    })).not.toContain("9876543210");
  });

  it("treats a closure as expired at resume and a maintenance window at its end", () => {
    expect(serviceNoticeHasExpired({
      type: "BRANCH_CLOSED",
      localEffectiveDate: "2026-08-25",
      effectiveEndAt: null,
      resumeAt: new Date("2026-08-25T18:30:00.000Z"),
      now: new Date("2026-08-25T18:30:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).toBe(true);
    expect(serviceNoticeHasExpired({
      type: "MAINTENANCE_WINDOW",
      localEffectiveDate: "2026-08-25",
      effectiveEndAt: new Date("2026-08-25T07:30:00.000Z"),
      resumeAt: null,
      now: new Date("2026-08-25T07:29:59.999Z"),
      timeZone: "Asia/Kolkata",
    })).toBe(false);
  });
});
