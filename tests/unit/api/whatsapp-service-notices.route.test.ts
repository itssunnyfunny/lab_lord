import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  rateLimit: vi.fn(),
  preview: vi.fn(),
  queue: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/whatsappRoute", () => ({
  whatsAppRateLimitResponse: mocks.rateLimit,
}));
vi.mock("@/services/whatsappServiceNotice.service", () => ({
  WhatsAppServiceNoticeService: {
    preview: mocks.preview,
    queue: mocks.queue,
    list: mocks.list,
    cancel: mocks.cancel,
  },
}));

import { POST as previewNotice } from "@/app/api/branches/[branchId]/whatsapp/service-notices/preview/route";
import {
  GET as listNotices,
  POST as queueNotice,
} from "@/app/api/branches/[branchId]/whatsapp/service-notices/route";
import { POST as cancelNotice } from "@/app/api/branches/[branchId]/whatsapp/service-notices/[noticeId]/cancel/route";

const draft = {
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
} as const;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("WhatsApp service-notice routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
    mocks.rateLimit.mockReturnValue(null);
  });

  it("requires authentication before preview work", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await previewNotice(
      post("/api/branches/branch_1/whatsapp/service-notices/preview", draft),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(response.status).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and arbitrary provider-bound notice fields", async () => {
    const crossOrigin = await previewNotice(new Request(
      "http://localhost/api/branches/branch_1/whatsapp/service-notices/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.test" },
        body: JSON.stringify(draft),
      }
    ), { params: Promise.resolve({ branchId: "branch_1" }) });
    expect(crossOrigin.status).toBe(400);

    const arbitraryText = await previewNotice(
      post("/api/branches/branch_1/whatsapp/service-notices/preview", {
        ...draft,
        message: "Free-form provider text",
      }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(arbitraryText.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("requires idempotency and explicit charge confirmation before queueing", async () => {
    const missingKey = await queueNotice(
      post("/api/branches/branch_1/whatsapp/service-notices", {
        ...draft,
        confirmCustomerCharge: true,
      }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(missingKey.status).toBe(400);

    const missingConfirmation = await queueNotice(
      post("/api/branches/branch_1/whatsapp/service-notices", draft, {
        "idempotency-key": "notice-1",
      }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(missingConfirmation.status).toBe(400);
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("delegates one strictly typed queue operation and returns the accepted shape", async () => {
    mocks.queue.mockResolvedValue({
      replayed: false,
      noticeId: "notice_1",
      status: "QUEUED",
      queuedMessageCount: 2,
      suppressedCount: 1,
    });
    const response = await queueNotice(
      post("/api/branches/branch_1/whatsapp/service-notices", {
        ...draft,
        confirmCustomerCharge: true,
      }, { "idempotency-key": "notice-1" }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      replayed: false,
      noticeId: "notice_1",
      status: "QUEUED",
      queuedMessageCount: 2,
      suppressedCount: 1,
    });
    expect(mocks.queue).toHaveBeenCalledWith({
      actorUserId: "user_1",
      branchId: "branch_1",
      draft,
      idempotencyKey: "notice-1",
      confirmCustomerCharge: true,
    });
  });

  it("strictly validates list queries and cancellation confirmation", async () => {
    const invalidList = await listNotices(
      new Request("http://localhost/api/branches/branch_1/whatsapp/service-notices?limit=0"),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(invalidList.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();

    const invalidCancel = await cancelNotice(
      post("/api/branches/branch_1/whatsapp/service-notices/notice_1/cancel", {
        confirmation: false,
      }),
      { params: Promise.resolve({ branchId: "branch_1", noticeId: "notice_1" }) }
    );
    expect(invalidCancel.status).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
