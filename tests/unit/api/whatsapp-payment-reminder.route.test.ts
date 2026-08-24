import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  preview: vi.fn(),
  queue: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/services/whatsappMessage.service", () => ({
  WhatsAppMessageService: {
    previewPaymentReminders: mocks.preview,
    queuePaymentReminders: mocks.queue,
  },
}));

function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://test.local",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("WhatsApp payment reminder routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
  });

  it("requires local authentication before preview", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const { POST } = await import(
      "@/app/api/branches/[branchId]/whatsapp/payment-reminders/preview/route"
    );
    const response = await POST(
      request("/api/branches/branch_1/whatsapp/payment-reminders/preview", {
        paymentIds: ["payment_1"],
      }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(response.status).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("accepts payment IDs only and delegates preview without queueing", async () => {
    mocks.preview.mockResolvedValue({ eligibleRecipientCount: 1, suppressedCount: 0 });
    const { POST } = await import(
      "@/app/api/branches/[branchId]/whatsapp/payment-reminders/preview/route"
    );
    const response = await POST(
      request("/api/branches/branch_1/whatsapp/payment-reminders/preview", {
        paymentIds: ["payment_1"],
      }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith({
      actorUserId: "user_1",
      branchId: "branch_1",
      paymentIds: ["payment_1"],
    });
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("requires and forwards a bounded idempotency key for queueing", async () => {
    const { POST } = await import(
      "@/app/api/branches/[branchId]/whatsapp/payment-reminders/route"
    );
    const missing = await POST(
      request("/api/branches/branch_1/whatsapp/payment-reminders", {
        paymentIds: ["payment_1"],
      }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(missing.status).toBe(400);
    expect(mocks.queue).not.toHaveBeenCalled();

    mocks.queue.mockResolvedValue({ replayed: false, request: { id: "request_1" } });
    const queued = await POST(
      request("/api/branches/branch_1/whatsapp/payment-reminders", {
        paymentIds: ["payment_1"],
      }, { "idempotency-key": "manual-request-0001" }),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    );
    expect(queued.status).toBe(202);
    expect(mocks.queue).toHaveBeenCalledWith({
      actorUserId: "user_1",
      branchId: "branch_1",
      paymentIds: ["payment_1"],
      idempotencyKey: "manual-request-0001",
    });
  });
});
