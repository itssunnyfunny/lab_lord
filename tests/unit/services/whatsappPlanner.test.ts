import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  settingsUpdateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    branchWhatsAppSettings: { updateMany: mocks.settingsUpdateMany },
  },
}));

import {
  buildCollectionCandidates,
  buildWelcomeCandidates,
  chooseHighestPriorityCollection,
  createAutomaticMessageSourceFingerprint,
  earlierPaymentActionPaidEventWhere,
  hashWhatsAppPlannerValue,
  loadPlannerCollectionSourcePage,
  loadPlannerPaymentEventPage,
  paymentCorrectionAction,
  verifyAutomaticMessageSource,
  WHATSAPP_PLANNER_MAX_EVENTS_SCANNED,
  WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED,
  WhatsAppPlannerService,
} from "@/services/whatsappPlanner.service";
import { getManagedWhatsAppTemplate } from "@/lib/whatsappManagedTemplates";

const ENABLED_ENV = {
  WHATSAPP_INTEGRATION_ENABLED: "true",
  WHATSAPP_AUTOMATION_PLANNER_ENABLED: "true",
  META_WHATSAPP_MODE: "TEST",
};

const NOW = new Date("2026-08-23T03:00:00.000Z");
const HORIZON_END = new Date("2026-08-24T15:00:00.000Z");
const SLOT = {
  localDate: { year: 2026, month: 8, day: 23 },
  scheduledFor: new Date("2026-08-23T04:30:00.000Z"),
};

function recipient(input: {
  id: string;
  studentId: string;
  phone?: string;
  name?: string;
  joinedAt?: Date;
  createdAt?: Date;
  enrollmentSource?: "MANUAL" | "IMPORT" | "LEGACY";
  monthlyFee?: number;
  allocation?: boolean;
}) {
  const phone = input.phone ?? "+919876543210";
  return {
    id: input.id,
    organizationId: "org_1",
    branchId: "branch_1",
    studentId: input.studentId,
    senderId: "sender_1",
    consentId: `consent_${input.id}`,
    phoneE164: phone,
    status: "ACTIVE" as const,
    verifiedAt: NOW,
    staleAt: null,
    disabledAt: null,
    createdByUserId: "user_1",
    createdAt: NOW,
    updatedAt: NOW,
    consent: {
      id: `consent_${input.id}`,
      senderId: "sender_1",
      phoneE164: phone,
      status: "OPTED_IN" as const,
    },
    student: {
      id: input.studentId,
      name: input.name ?? `Student ${input.studentId}`,
      phone,
      status: "ACTIVE" as const,
      enrollmentSource: input.enrollmentSource ?? "MANUAL",
      joinedAt: input.joinedAt ?? new Date("2026-07-30T00:00:00.000Z"),
      billingStartAt: null,
      monthlyFee: input.monthlyFee ?? 1_000,
      createdAt: input.createdAt ?? new Date("2026-08-23T00:00:00.000Z"),
      seatAllocations: input.allocation
        ? [{
            id: "allocation_1",
            seatId: "seat_1",
            shiftId: "shift_1",
            multiShiftId: null,
            startDate: new Date("2026-08-23T00:00:00.000Z"),
            endDate: null,
            seat: { label: "A-12" },
            shift: { name: "Morning" },
            multiShift: null,
          }]
        : [],
    },
  };
}

describe("WhatsApp planner pure planning", () => {
  it("uses canonical SHA-256 hashes and deterministic priority tie-breaking", () => {
    expect(hashWhatsAppPlannerValue({ b: 2, a: 1 }))
      .toBe(hashWhatsAppPlannerValue({ a: 1, b: 2 }));
    expect(hashWhatsAppPlannerValue({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
    expect(chooseHighestPriorityCollection([
      { priority: 200, stableId: "due", value: "due" },
      { priority: 301, stableId: "past", value: "past" },
      { priority: 101, stableId: "pre", value: "pre" },
    ])).toBe("past");
  });

  it("welcomes only prospective MANUAL students after grace using current allocation", () => {
    const candidates = buildWelcomeCandidates({
      recipients: [
        recipient({ id: "r_manual", studentId: "manual", allocation: true }),
        recipient({ id: "r_import", studentId: "import", enrollmentSource: "IMPORT" }),
        recipient({ id: "r_legacy", studentId: "legacy", enrollmentSource: "LEGACY" }),
        recipient({
          id: "r_too_new",
          studentId: "too_new",
          createdAt: new Date("2026-08-23T02:55:00.000Z"),
        }),
      ] as never,
      enabledStages: new Set(["WELCOME"]),
      existingStudentIds: new Set(),
      activationAt: new Date("2026-08-22T23:59:00.000Z"),
      now: NOW,
      horizonEnd: HORIZON_END,
      sendTimeLocal: "10:00",
      timeZone: "Asia/Kolkata",
      language: "en_IN",
      branchName: "Central",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      stage: "WELCOME",
      managedTemplateKey: "WELCOME_ALLOCATED",
      studentIds: ["manual"],
      values: {
        studentName: "Student manual",
        branchName: "Central",
        seatLabel: "A-12",
        shiftName: "Morning",
      },
    });
  });

  it("derives T-7 from anniversary cycles without a Payment row", () => {
    const candidates = buildCollectionCandidates({
      recipients: [recipient({ id: "r_1", studentId: "student_1" })] as never,
      payments: [],
      enabledStages: new Set(["FEE_DUE_MINUS_7"]),
      slots: [SLOT],
      now: NOW,
      horizonEnd: HORIZON_END,
      timeZone: "Asia/Kolkata",
      language: "en_IN",
      branchName: "Central",
      tone: "polite",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      stage: "FEE_DUE_MINUS_7",
      paymentIds: [],
      purpose: "FEE_RENEWAL",
      managedTemplateKey: "FEE_RENEWAL_POLITE",
    });
  });

  it("aggregates shared-phone DUE rows and gives past due priority over due today", () => {
    const candidates = buildCollectionCandidates({
      recipients: [
        recipient({ id: "r_1", studentId: "student_1" }),
        recipient({ id: "r_2", studentId: "student_2" }),
      ] as never,
      payments: [
        {
          id: "past_payment",
          studentId: "student_1",
          amount: 1_000,
          dueDate: new Date("2026-08-22T00:00:00.000Z"),
          periodStart: new Date("2026-07-22T00:00:00.000Z"),
        },
        {
          id: "due_today",
          studentId: "student_2",
          amount: 2_000,
          dueDate: new Date("2026-08-23T00:00:00.000Z"),
          periodStart: new Date("2026-07-23T00:00:00.000Z"),
        },
      ],
      enabledStages: new Set([
        "PAST_DUE_PLUS_1",
        "FEE_DUE_TODAY",
        "FEE_DUE_MINUS_7",
      ]),
      slots: [SLOT],
      now: NOW,
      horizonEnd: HORIZON_END,
      timeZone: "Asia/Kolkata",
      language: "en_IN",
      branchName: "Central",
      tone: "firm",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      stage: "PAST_DUE_PLUS_1",
      managedTemplateKey: "MULTI_STUDENT_COLLECTION_SUMMARY",
      studentIds: ["student_1", "student_2"],
      paymentIds: ["due_today", "past_payment"],
      values: { studentCount: "2", amount: "3,000" },
    });
  });

  it("does not fabricate due-today planning without an actual DUE row", () => {
    expect(buildCollectionCandidates({
      recipients: [recipient({ id: "r_1", studentId: "student_1" })] as never,
      payments: [],
      enabledStages: new Set(["FEE_DUE_TODAY"]),
      slots: [SLOT],
      now: NOW,
      horizonEnd: HORIZON_END,
      timeZone: "Asia/Kolkata",
      language: "en_IN",
      branchName: "Central",
      tone: "polite",
    })).toEqual([]);
  });

  it("cancels safe confirmations and corrects only possible acceptance", () => {
    expect(paymentCorrectionAction({ status: "SCHEDULED", submissionStartedAt: null }))
      .toBe("CANCEL");
    expect(paymentCorrectionAction({ status: "CLAIMED", submissionStartedAt: null }))
      .toBe("CANCEL");
    expect(paymentCorrectionAction({
      status: "CLAIMED",
      submissionStartedAt: new Date("2026-08-23T03:00:00.000Z"),
    })).toBe("NONE");
    expect(paymentCorrectionAction({ status: "ACCEPTED", submissionStartedAt: NOW }))
      .toBe("CORRECT");
    expect(paymentCorrectionAction({ status: "UNKNOWN", submissionStartedAt: NOW }))
      .toBe("CORRECT");
    expect(paymentCorrectionAction({ status: "FAILED", submissionStartedAt: NOW }))
      .toBe("NONE");
  });
});

describe("WhatsApp planner durability", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("returns held before any database access when the planner flag is off", async () => {
    await expect(WhatsAppPlannerService.run({ env: {} })).resolves.toMatchObject({
      held: true,
      claimedBranches: 0,
      plannedMessages: 0,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("claims one row with a reclaimable fair lease", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ branchId: "branch_1" }]);
    const update = vi.fn().mockResolvedValue({ branchId: "branch_1" });
    mocks.transaction.mockImplementation(async callback => callback({
      $queryRaw: queryRaw,
      branchWhatsAppSettings: { update },
    }));

    const claim = await WhatsAppPlannerService.claimNextBranch({ now: NOW, env: ENABLED_ENV });

    expect(claim).toMatchObject({ branchId: "branch_1", leaseToken: expect.any(String) });
    const sql = queryRaw.mock.calls[0]![0] as { strings: readonly string[] };
    expect(sql.strings.join(" ")).toContain('settings."plannerLeaseUntil" <=');
    expect(sql.strings.join(" ")).toContain(
      'ORDER BY settings."lastPlannedAt" ASC NULLS FIRST'
    );
    expect(sql.strings.join(" ")).toContain("FOR UPDATE OF settings SKIP LOCKED");
    expect(update).toHaveBeenCalledWith({
      where: { branchId: "branch_1" },
      data: {
        plannerLeaseToken: expect.any(String),
        plannerLeaseUntil: new Date("2026-08-23T03:10:00.000Z"),
      },
    });
  });

  it("isolates a branch failure and continues to the next lease", async () => {
    const first = { branchId: "branch_1", leaseToken: "lease_1" };
    const second = { branchId: "branch_2", leaseToken: "lease_2" };
    vi.spyOn(WhatsAppPlannerService, "claimNextBranch")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null);
    vi.spyOn(WhatsAppPlannerService, "planClaimedBranch")
      .mockRejectedValueOnce(Object.assign(new Error("safe"), { code: "RATE_UNAVAILABLE" }))
      .mockResolvedValueOnce({
        plannedMessages: 2,
        skippedCandidates: 1,
        cancelledMessages: 0,
        errorCode: null,
      });
    const failClaim = vi.spyOn(WhatsAppPlannerService, "failClaim").mockResolvedValue();

    await expect(WhatsAppPlannerService.run({ now: NOW, env: ENABLED_ENV })).resolves.toEqual({
      held: false,
      claimedBranches: 2,
      completedBranches: 1,
      failedBranches: 1,
      plannedMessages: 2,
      skippedCandidates: 1,
      cancelledMessages: 0,
      limitReached: false,
    });
    expect(failClaim).toHaveBeenCalledWith({
      claim: first,
      now: NOW,
      code: "RATE_UNAVAILABLE",
    });
  });

  it("enforces the caller-independent branch batch ceiling", async () => {
    vi.spyOn(WhatsAppPlannerService, "claimNextBranch")
      .mockResolvedValue({ branchId: "branch_1", leaseToken: "lease_1" });
    vi.spyOn(WhatsAppPlannerService, "planClaimedBranch").mockResolvedValue({
      plannedMessages: 0,
      skippedCandidates: 0,
      cancelledMessages: 0,
      errorCode: null,
    });

    const result = await WhatsAppPlannerService.run({ now: NOW, env: ENABLED_ENV, limit: 2 });

    expect(result.claimedBranches).toBe(2);
    expect(result.limitReached).toBe(true);
    expect(WhatsAppPlannerService.planClaimedBranch).toHaveBeenCalledTimes(2);
  });
});

describe("WhatsApp planner bounded scan pagination", () => {
  it("defers a shared-phone group cut by the recipient ceiling and reloads that group whole", async () => {
    const firstPhone = "+919000000001";
    const sharedPhone = "+919000000002";
    const firstRecipient = recipient({
      id: "recipient_first",
      studentId: "student_first",
      phone: firstPhone,
    });
    const sharedRecipients = Array.from({ length: 2_000 }, (_, index) => recipient({
      id: `recipient_shared_${String(index).padStart(4, "0")}`,
      studentId: `student_shared_${String(index).padStart(4, "0")}`,
      phone: sharedPhone,
    }));
    const findMany = vi.fn(async (args: {
      where: { phoneE164?: { gt?: string } };
    }) => args.where.phoneE164?.gt === firstPhone
      ? sharedRecipients
      : [firstRecipient, ...sharedRecipients.slice(0, 1_999)]);
    const tx = {
      whatsAppStudentRecipient: {
        findMany,
        count: vi.fn().mockResolvedValue(2_000),
      },
      payment: {
        groupBy: vi.fn().mockResolvedValue([]),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const first = await loadPlannerCollectionSourcePage({
      tx: tx as never,
      branchId: "branch_1",
      senderId: "sender_1",
      now: NOW,
      horizonEnd: HORIZON_END,
      recipientCursorPhoneE164: null,
    });
    expect(first.recipients.map(row => row.student.id)).toEqual(["student_first"]);
    expect(first.nextRecipientCursorPhoneE164).toBe(firstPhone);

    const second = await loadPlannerCollectionSourcePage({
      tx: tx as never,
      branchId: "branch_1",
      senderId: "sender_1",
      now: NOW,
      horizonEnd: HORIZON_END,
      recipientCursorPhoneE164: first.nextRecipientCursorPhoneE164,
    });
    expect(second.recipients).toHaveLength(2_000);
    expect(new Set(second.recipients.map(row => row.phoneE164))).toEqual(new Set([sharedPhone]));
    expect(second.nextRecipientCursorPhoneE164).toBe(sharedPhone);
  });

  it("advances complete phone groups and defers a whole group when its DUE rows exceed the remaining bound", async () => {
    const phoneOne = "+919000000001";
    const phoneTwo = "+919000000002";
    const firstRecipient = recipient({ id: "recipient_1", studentId: "student_1", phone: phoneOne });
    const secondRecipient = recipient({ id: "recipient_2", studentId: "student_2", phone: phoneTwo });
    const recipientFindMany = vi.fn(async (args: {
      where: { phoneE164?: { gt?: string } };
    }) => args.where.phoneE164?.gt === phoneOne
      ? [secondRecipient]
      : [firstRecipient, secondRecipient]);
    const paymentGroupBy = vi.fn(async (args: {
      where: { studentId: { in: string[] } };
    }) => args.where.studentId.in.map(studentId => ({
      studentId,
      _count: { id: 3_000 },
    })));
    const paymentFindMany = vi.fn(async (args: {
      where: { studentId: { in: string[] } };
    }) => Array.from({ length: 3_000 }, (_, index) => ({
      id: `${args.where.studentId.in[0]}_payment_${index}`,
      studentId: args.where.studentId.in[0]!,
      amount: 1_000,
      dueDate: new Date("2026-08-23T00:00:00.000Z"),
      periodStart: new Date("2026-07-23T00:00:00.000Z"),
    })));
    const tx = {
      whatsAppStudentRecipient: { findMany: recipientFindMany, count: vi.fn() },
      payment: { groupBy: paymentGroupBy, findMany: paymentFindMany },
    };

    const first = await loadPlannerCollectionSourcePage({
      tx: tx as never,
      branchId: "branch_1",
      senderId: "sender_1",
      now: NOW,
      horizonEnd: HORIZON_END,
      recipientCursorPhoneE164: null,
    });
    expect(first.recipients.map(row => row.student.id)).toEqual(["student_1"]);
    expect(first.payments).toHaveLength(3_000);
    expect(first.nextRecipientCursorPhoneE164).toBe(phoneOne);
    expect(paymentFindMany.mock.calls[0]![0]).toMatchObject({
      take: WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED,
      where: { studentId: { in: ["student_1"] } },
    });

    const second = await loadPlannerCollectionSourcePage({
      tx: tx as never,
      branchId: "branch_1",
      senderId: "sender_1",
      now: NOW,
      horizonEnd: HORIZON_END,
      recipientCursorPhoneE164: first.nextRecipientCursorPhoneE164,
    });
    expect(second.recipients.map(row => row.student.id)).toEqual(["student_2"]);
    expect(second.nextRecipientCursorPhoneE164).toBe(phoneTwo);
    expect(recipientFindMany.mock.calls[1]![0]).toMatchObject({
      where: { phoneE164: { gt: phoneOne } },
      orderBy: [{ phoneE164: "asc" }, { id: "asc" }],
    });
  });

  it("skips an unrepresentable DUE group without treating its truncated source as debt-free or blocking the next phone", async () => {
    const firstRecipient = recipient({
      id: "recipient_1",
      studentId: "student_1",
      phone: "+919000000001",
    });
    const secondRecipient = recipient({
      id: "recipient_2",
      studentId: "student_2",
      phone: "+919000000002",
    });
    const tx = {
      whatsAppStudentRecipient: {
        findMany: vi.fn().mockResolvedValue([firstRecipient, secondRecipient]),
        count: vi.fn(),
      },
      payment: {
        groupBy: vi.fn().mockResolvedValue([
          { studentId: "student_1", _count: { id: WHATSAPP_PLANNER_MAX_PAYMENTS_SCANNED + 1 } },
        ]),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const page = await loadPlannerCollectionSourcePage({
      tx: tx as never,
      branchId: "branch_1",
      senderId: "sender_1",
      now: NOW,
      horizonEnd: HORIZON_END,
      recipientCursorPhoneE164: null,
    });

    expect(page.skippedSourceGroups).toBe(1);
    expect(page.recipients.map(row => row.student.id)).toEqual(["student_2"]);
    expect(page.payments).toEqual([]);
    expect(page.nextRecipientCursorPhoneE164).toBe("+919000000002");
  });

  it("uses a compound event keyset, reaches the tail after a full head page, and wraps for retryable rows", async () => {
    const events = Array.from({ length: WHATSAPP_PLANNER_MAX_EVENTS_SCANNED + 1 }, (_, index) => ({
      id: `event_${String(index).padStart(4, "0")}`,
      occurredAt: new Date(NOW.getTime() + index),
      payment: { studentId: `student_${index}`, student: { id: `student_${index}` } },
    }));
    const head = events.slice(0, WHATSAPP_PLANNER_MAX_EVENTS_SCANNED);
    const tail = events.slice(WHATSAPP_PLANNER_MAX_EVENTS_SCANNED);
    const findMany = vi.fn(async (args: {
      where: { AND: Array<{ OR?: Array<{ id?: { gt: string } }> }> };
    }) => {
      const cursorId = args.where.AND[1]?.OR?.[1]?.id?.gt;
      if (!cursorId) return head;
      if (cursorId === head.at(-1)!.id) return tail;
      return [];
    });
    const tx = { paymentResolutionEvent: { findMany } };

    const first = await loadPlannerPaymentEventPage({
      tx: tx as never,
      where: { branchId: "branch_1", toStatus: "PAID" },
      cursor: null,
    });
    expect(first.events).toHaveLength(WHATSAPP_PLANNER_MAX_EVENTS_SCANNED);
    const second = await loadPlannerPaymentEventPage({
      tx: tx as never,
      where: { branchId: "branch_1", toStatus: "PAID" },
      cursor: first.nextCursor,
    });
    expect(second.events.map(event => event.id)).toEqual([tail[0]!.id]);
    expect(findMany.mock.calls[1]![0]).toMatchObject({
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: WHATSAPP_PLANNER_MAX_EVENTS_SCANNED,
      where: {
        AND: [
          expect.any(Object),
          {
            OR: [
              { occurredAt: { gt: head.at(-1)!.occurredAt } },
              { occurredAt: head.at(-1)!.occurredAt, id: { gt: head.at(-1)!.id } },
            ],
          },
        ],
      },
    });

    const wrapped = await loadPlannerPaymentEventPage({
      tx: tx as never,
      where: { branchId: "branch_1", toStatus: "PAID" },
      cursor: second.nextCursor,
    });
    expect(wrapped.events).toHaveLength(WHATSAPP_PLANNER_MAX_EVENTS_SCANNED);
    expect(findMany.mock.calls.at(-1)![0].where.AND).toHaveLength(1);
  });

  it("matches only PAID events before a correction in compound event order", () => {
    expect(earlierPaymentActionPaidEventWhere({
      paymentId: "payment_1",
      occurredAt: NOW,
      id: "correction_b",
    })).toEqual({
      paymentId: "payment_1",
      source: "PAYMENT_ACTION",
      toStatus: "PAID",
      OR: [
        { occurredAt: { lt: NOW } },
        { occurredAt: NOW, id: { lt: "correction_b" } },
      ],
    });
  });
});

describe("automatic source verification", () => {
  const settings = {
    branchId: "branch_1",
    organizationId: "org_1",
    senderId: "sender_1",
    enabled: true,
    automationEnabledAt: new Date("2026-08-22T23:59:00.000Z"),
    configurationRevision: 3,
    defaultLanguage: "en_IN",
    defaultTone: "polite",
    dailyAutomaticMessageLimit: 50,
    maxAutomaticCollectionMessagesPerCycle: 4,
  };

  function automaticMessage(input: {
    candidate: ReturnType<typeof buildWelcomeCandidates>[number]
      | ReturnType<typeof buildCollectionCandidates>[number];
    sourceFingerprint: string;
  }) {
    const definition = getManagedWhatsAppTemplate(input.candidate.managedTemplateKey, "en_IN");
    return {
      id: "message_1",
      organizationId: "org_1",
      branchId: "branch_1",
      senderId: "sender_1",
      studentId: input.candidate.studentIds.length === 1 ? input.candidate.studentIds[0] : null,
      paymentId: null,
      paymentResolutionEventId: null,
      templateId: "template_1",
      templateBindingId: "binding_1",
      recipientPhoneE164: input.candidate.recipientPhoneE164,
      purpose: input.candidate.purpose,
      trigger: "AUTOMATION" as const,
      automationStage: input.candidate.stage,
      managedTemplateKey: input.candidate.managedTemplateKey,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      templateVersion: 2,
      templateVariables: input.candidate.values,
      scheduledFor: input.candidate.scheduledFor,
      localScheduleDate: new Date(Date.UTC(
        input.candidate.localDate.year,
        input.candidate.localDate.month - 1,
        input.candidate.localDate.day
      )),
      settingsRevision: 3,
      sourceFingerprint: input.sourceFingerprint,
      branch: {
        id: "branch_1",
        name: "Central",
        organizationId: "org_1",
        organization: { id: "org_1", timezone: "Asia/Kolkata" },
      },
      templateBinding: {
        id: "binding_1",
        senderId: "sender_1",
        templateId: "template_1",
        managedKey: input.candidate.managedTemplateKey,
        catalogVersion: definition.catalogVersion,
        catalogHash: definition.catalogHash,
        template: { version: 2 },
      },
      paymentResolutionEvent: null,
      paymentSources: [],
    };
  }

  function fingerprint(candidate: ReturnType<typeof buildWelcomeCandidates>[number]
    | ReturnType<typeof buildCollectionCandidates>[number]) {
    const definition = getManagedWhatsAppTemplate(candidate.managedTemplateKey, "en_IN");
    return createAutomaticMessageSourceFingerprint({
      organizationId: "org_1",
      branchId: "branch_1",
      senderId: "sender_1",
      recipientPhoneE164: candidate.recipientPhoneE164,
      recipientIds: candidate.recipientIds,
      settingsRevision: 3,
      templateBindingId: "binding_1",
      templateId: "template_1",
      templateVersion: 2,
      catalogVersion: definition.catalogVersion,
      catalogHash: definition.catalogHash,
      stage: candidate.stage,
      templateVariables: candidate.values,
      facts: candidate.fingerprintFacts,
    });
  }

  it("recomputes a welcome fingerprint and detects changed allocation", async () => {
    const activeRecipient = recipient({
      id: "recipient_1",
      studentId: "student_1",
      allocation: true,
    });
    const [candidate] = buildWelcomeCandidates({
      recipients: [activeRecipient] as never,
      enabledStages: new Set(["WELCOME"]),
      existingStudentIds: new Set(),
      activationAt: settings.automationEnabledAt,
      now: NOW,
      horizonEnd: HORIZON_END,
      sendTimeLocal: "10:00",
      timeZone: "Asia/Kolkata",
      language: "en_IN",
      branchName: "Central",
    });
    const message = automaticMessage({ candidate: candidate!, sourceFingerprint: fingerprint(candidate!) });
    const findRecipients = vi.fn().mockResolvedValue([activeRecipient]);
    const tx = {
      whatsAppMessage: {
        findUnique: vi.fn().mockResolvedValue(message),
        count: vi.fn().mockResolvedValue(1),
      },
      branchWhatsAppSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
      whatsAppAutomationRule: {
        findMany: vi.fn().mockResolvedValue([{ stage: "WELCOME" }]),
      },
      whatsAppStudentRecipient: { findMany: findRecipients },
    };

    await expect(verifyAutomaticMessageSource({
      tx: tx as never,
      messageId: "message_1",
      now: candidate!.scheduledFor,
    })).resolves.toEqual({ valid: true });

    findRecipients.mockResolvedValueOnce([{
      ...activeRecipient,
      student: {
        ...activeRecipient.student,
        seatAllocations: [{
          ...activeRecipient.student.seatAllocations[0]!,
          seat: { label: "B-99" },
        }],
      },
    }]);
    await expect(verifyAutomaticMessageSource({
      tx: tx as never,
      messageId: "message_1",
      now: candidate!.scheduledFor,
    })).resolves.toEqual({ valid: false, code: "SOURCE_CHANGED" });
  });

  it("recomputes a pure pre-due cycle and rejects a changed fee source", async () => {
    const activeRecipient = recipient({ id: "recipient_1", studentId: "student_1" });
    const build = (row: ReturnType<typeof recipient>) => buildCollectionCandidates({
      recipients: [row] as never,
      payments: [],
      enabledStages: new Set(["FEE_DUE_MINUS_7"]),
      slots: [SLOT],
      now: NOW,
      horizonEnd: HORIZON_END,
      timeZone: "Asia/Kolkata",
      language: "en_IN",
      branchName: "Central",
      tone: "polite",
    })[0]!;
    const candidate = build(activeRecipient);
    const message = automaticMessage({ candidate, sourceFingerprint: fingerprint(candidate) });
    const findRecipients = vi.fn().mockResolvedValue([activeRecipient]);
    const messageCount = vi.fn().mockResolvedValue(1);
    const tx = {
      whatsAppMessage: { findUnique: vi.fn().mockResolvedValue(message), count: messageCount },
      branchWhatsAppSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
      whatsAppAutomationRule: {
        findMany: vi.fn().mockResolvedValue([{ stage: "FEE_DUE_MINUS_7" }]),
      },
      whatsAppStudentRecipient: { findMany: findRecipients },
      payment: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await expect(verifyAutomaticMessageSource({
      tx: tx as never,
      messageId: "message_1",
      now: SLOT.scheduledFor,
    })).resolves.toEqual({ valid: true });

    findRecipients.mockResolvedValueOnce([{
      ...activeRecipient,
      student: { ...activeRecipient.student, monthlyFee: 1_200 },
    }]);
    await expect(verifyAutomaticMessageSource({
      tx: tx as never,
      messageId: "message_1",
      now: SLOT.scheduledFor,
    })).resolves.toEqual({ valid: false, code: "SOURCE_CHANGED" });
  });
});
