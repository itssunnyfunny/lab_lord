import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RAZORPAY_WEBHOOK_BYTES } from "@/lib/razorpayWebhook";

const mocks = vi.hoisted(() => ({
  handleRazorpayWebhook: vi.fn(),
}));

vi.mock("@/services/billing.service", () => ({
  BillingService: {
    handleRazorpayWebhook: mocks.handleRazorpayWebhook,
  },
}));

describe("POST /api/razorpay/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleRazorpayWebhook.mockResolvedValue({ ok: true });
  });

  it("rejects an excessive Content-Length before accessing the body", async () => {
    let bodyAccessed = false;
    const request = {
      headers: new Headers({
        "content-length": String(MAX_RAZORPAY_WEBHOOK_BYTES + 1),
      }),
      get body() {
        bodyAccessed = true;
        throw new Error("body must not be accessed");
      },
    } as unknown as Request;
    const { POST } = await import("@/app/api/razorpay/webhook/route");

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Razorpay webhook payload is too large" });
    expect(bodyAccessed).toBe(false);
    expect(mocks.handleRazorpayWebhook).not.toHaveBeenCalled();
  });

  it("cancels an underreported chunked body at the first byte above the limit", async () => {
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(MAX_RAZORPAY_WEBHOOK_BYTES));
          return;
        }
        if (pulls === 2) {
          controller.enqueue(Uint8Array.of(1));
          return;
        }
        throw new Error("reader continued after the configured maximum");
      },
      cancel() {
        cancellations += 1;
      },
    }, { highWaterMark: 0 });
    const request = {
      headers: new Headers({ "content-length": "1" }),
      body,
    } as Request;
    const { POST } = await import("@/app/api/razorpay/webhook/route");

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(pulls).toBe(2);
    expect(cancellations).toBe(1);
    expect(mocks.handleRazorpayWebhook).not.toHaveBeenCalled();
  });

  it("passes an exact-limit body to billing as untouched bytes", async () => {
    const rawBody = new Uint8Array(MAX_RAZORPAY_WEBHOOK_BYTES);
    rawBody[0] = 123;
    rawBody[rawBody.length - 1] = 125;
    const request = new Request("http://test.local/api/razorpay/webhook", {
      method: "POST",
      headers: {
        "content-length": String(rawBody.byteLength),
        "x-razorpay-signature": "exact-signature",
        "x-razorpay-event-id": "evt_exact_limit",
      },
      body: rawBody,
    });
    const { POST } = await import("@/app/api/razorpay/webhook/route");

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.handleRazorpayWebhook).toHaveBeenCalledTimes(1);
    const [receivedBody, signature, eventId] = mocks.handleRazorpayWebhook.mock.calls[0]!;
    expect(Buffer.isBuffer(receivedBody)).toBe(true);
    expect(receivedBody).toEqual(Buffer.from(rawBody));
    expect(signature).toBe("exact-signature");
    expect(eventId).toBe("evt_exact_limit");
  });
});
