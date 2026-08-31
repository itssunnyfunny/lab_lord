import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  queueToday: vi.fn(),
  preview: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/whatsappRoute", () => ({
  whatsAppRateLimitResponse: mocks.rateLimit,
}));
vi.mock("@/services/whatsappReport.service", () => ({
  WhatsAppReportService: {
    queueToday: mocks.queueToday,
    preview: mocks.preview,
  },
}));

import {
  handleWhatsAppReportPreview,
  handleWhatsAppReportQueueToday,
} from "@/lib/whatsappReportRoute";

function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("WhatsApp report route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
    mocks.rateLimit.mockReturnValue(null);
  });

  it("requires and forwards a bounded idempotency key for queue-today", async () => {
    mocks.queueToday.mockResolvedValue({
      replayed: false,
      localReportDate: "2026-08-23",
      message: { id: "message_1" },
    });
    const response = await handleWhatsAppReportQueueToday(
      request(
        "/api/branches/branch_1/whatsapp/reports/queue-today",
        {},
        { "idempotency-key": "report-request-123" }
      ),
      { scope: "BRANCH", branchId: "branch_1" }
    );
    expect(response.status).toBe(202);
    expect(mocks.queueToday).toHaveBeenCalledWith({
      scope: "BRANCH",
      branchId: "branch_1",
      actorUserId: "user_1",
      idempotencyKey: "report-request-123",
    });
  });

  it("rejects extra preview fields before calling the service", async () => {
    const response = await handleWhatsAppReportPreview(
      request(
        "/api/organizations/org_1/whatsapp/reports/preview",
        { arbitraryText: "must not reach a provider template" }
      ),
      { scope: "ORGANIZATION", organizationId: "org_1" }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "WHATSAPP_INVALID_REQUEST" });
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("rejects cross-origin report mutations", async () => {
    const crossOrigin = request(
      "/api/branches/branch_1/whatsapp/reports/preview",
      {}
    );
    const altered = new Request(crossOrigin, {
      headers: {
        ...Object.fromEntries(crossOrigin.headers),
        origin: "https://attacker.example",
      },
    });
    const response = await handleWhatsAppReportPreview(
      altered,
      { scope: "BRANCH", branchId: "branch_1" }
    );
    expect(response.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
