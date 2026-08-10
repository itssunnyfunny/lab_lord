import { describe, expect, it, vi } from "vitest";
import {
  classifyRazorpayFailure,
  isRazorpayCheckoutPayload,
  normalizeRazorpayFailure,
  openRazorpayCheckout,
  type RazorpayConstructor,
  type RazorpayHandlerResponse,
} from "@/components/billing/RazorpayCheckoutLauncher";

type CapturedOptions = {
  config?: Record<string, unknown>;
  method?: Record<string, boolean>;
  prefill?: Record<string, string | undefined>;
  remember_customer: boolean;
  readonly: Record<string, boolean>;
  retry: { enabled: boolean };
  subscription_card_change?: true;
  modal: { ondismiss: () => void | Promise<void> };
  handler: (response: RazorpayHandlerResponse) => void | Promise<void>;
};

function checkoutHarness() {
  let options: CapturedOptions | undefined;
  let failureHandler: ((response: Record<string, unknown>) => void) | undefined;
  const open = vi.fn();

  class FakeRazorpay {
    constructor(nextOptions: CapturedOptions) {
      options = nextOptions;
    }

    open = open;

    on(_event: "payment.failed", handler: (response: Record<string, unknown>) => void) {
      failureHandler = handler;
    }
  }

  return {
    constructor: FakeRazorpay as unknown as RazorpayConstructor,
    get options() {
      if (!options) throw new Error("Checkout was not constructed");
      return options;
    },
    get failureHandler() {
      if (!failureHandler) throw new Error("Failure handler was not registered");
      return failureHandler;
    },
    open,
  };
}

const payload = {
  keyId: "rzp_test_key",
  subscriptionId: "sub_123",
  changeId: "change_123",
  processingUrl: "/org/org_123/billing/processing/change_123",
  name: "Lab Lords",
  description: "Authorize Standard",
  prefill: {
    name: "Lab Lords Demo",
    email: "billing@example.test",
    contact: "+919876543210",
  },
  notes: { organization_id: "org_123" },
  config: { display: { preferences: { show_default_blocks: false } } },
};

function openWithHarness(overrides: Partial<Parameters<typeof openRazorpayCheckout>[0]> = {}) {
  const harness = checkoutHarness();
  const verify = vi.fn().mockResolvedValue({ processingUrl: payload.processingUrl });
  const recordEvent = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  openRazorpayCheckout({
    payload,
    mode: "AUTHORIZATION",
    verify,
    recordEvent,
    navigate,
    razorpayConstructor: harness.constructor,
    ...overrides,
  });
  return { harness, verify, recordEvent, navigate };
}

describe("RazorpayCheckoutLauncher", () => {
  it("uses the server display configuration while keeping prefilled contacts editable", () => {
    const { harness } = openWithHarness();

    expect(harness.options.config).toEqual(payload.config);
    expect(harness.options.method).toBeUndefined();
    expect(harness.options.prefill).toEqual(payload.prefill);
    expect(harness.options.remember_customer).toBe(false);
    expect(harness.options.readonly).toEqual({ name: false, email: false, contact: false });
    expect(harness.options.retry).toEqual({ enabled: true });
    expect(harness.open).toHaveBeenCalledOnce();
  });

  it("lets provider-managed Checkout choose eligible methods when config is omitted", () => {
    const { harness } = openWithHarness({ payload: { ...payload, config: undefined } });

    expect(harness.options.config).toBeUndefined();
    expect(harness.options.method).toBeUndefined();
  });

  it("marks recovery Checkout as a card-change flow", () => {
    const { harness } = openWithHarness({ mode: "RECOVERY" });

    expect(harness.options.subscription_card_change).toBe(true);
    expect(harness.options.remember_customer).toBe(false);
  });

  it("keeps a failed attempt provisional when an in-modal retry later succeeds", async () => {
    const { harness, verify, recordEvent, navigate } = openWithHarness();
    harness.failureHandler({
      error: {
        code: "BAD_REQUEST_ERROR",
        reason: "payment_declined",
        description: "The issuer declined this card",
      },
    });

    expect(recordEvent).not.toHaveBeenCalled();

    await harness.options.handler({
      razorpay_payment_id: "pay_success",
      razorpay_subscription_id: "sub_123",
      razorpay_signature: "signature",
    });
    await harness.options.modal.ondismiss();

    expect(verify).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(payload.processingUrl);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("records an untouched dismissal as abandoned", async () => {
    const { harness, recordEvent } = openWithHarness();

    await harness.options.modal.ondismiss();

    expect(recordEvent).toHaveBeenCalledWith({ event: "ABANDONED" });
  });

  it("still reports the dismissal when persisting the browser event is interrupted", async () => {
    const recordEvent = vi.fn().mockRejectedValue(new Error("Network unavailable"));
    const onEventRecordError = vi.fn();
    const onStateChange = vi.fn();
    const { harness } = openWithHarness({ recordEvent, onEventRecordError, onStateChange });

    await harness.options.modal.ondismiss();

    expect(onEventRecordError).toHaveBeenCalledOnce();
    expect(onStateChange).toHaveBeenCalledWith("ABANDONED", undefined);
  });

  it("records normalized decline metadata only when Checkout closes", async () => {
    const { harness, recordEvent } = openWithHarness();
    harness.failureHandler({
      error: {
        code: " BAD_REQUEST_ERROR ",
        reason: "payment_declined",
        description: "Issuer declined",
        source: "bank",
        step: "payment_authorization",
        metadata: { payment_id: "pay_declined" },
      },
    });

    await harness.options.modal.ondismiss();

    expect(recordEvent).toHaveBeenCalledWith({
      event: "DECLINED",
      failure: {
        failureCategory: "payment_declined",
        failureCode: "BAD_REQUEST_ERROR",
        description: "Issuer declined",
        reason: "payment_declined",
        source: "bank",
        step: "payment_authorization",
        paymentId: "pay_declined",
      },
    });
  });

  it("shows an unknown provider-reported payment failure as terminal after Checkout closes", async () => {
    const onStateChange = vi.fn();
    const { harness, recordEvent, navigate } = openWithHarness({ onStateChange });
    harness.failureHandler({
      error: {
        code: "BAD_REQUEST_ERROR",
        reason: "result_unknown",
        description: "The authorization result is unavailable",
        source: "customer",
        metadata: { payment_id: "pay_unknown" },
      },
    });

    await harness.options.modal.ondismiss();

    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "FAILED" }));
    expect(onStateChange).toHaveBeenCalledWith(
      "FAILED",
      expect.objectContaining({ paymentId: "pay_unknown" })
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("treats Razorpay's documented payment_cancelled result as an abandoned Checkout", async () => {
    const { harness, recordEvent, navigate } = openWithHarness();
    harness.failureHandler({
      error: {
        code: "BAD_REQUEST_ERROR",
        reason: "payment_cancelled",
        description: "Customer cancelled the transaction",
        source: "customer",
        metadata: { payment_id: "pay_cancelled" },
      },
    });

    await harness.options.modal.ondismiss();

    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "ABANDONED" }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("sends interrupted verification to the processing fallback", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("Provider fetch timed out"));
    const onVerificationError = vi.fn();
    const onStateChange = vi.fn();
    const { harness, navigate } = openWithHarness({ verify, onVerificationError, onStateChange });

    await harness.options.handler({
      razorpay_payment_id: "pay_uncertain",
      razorpay_subscription_id: "sub_123",
      razorpay_signature: "signature",
    });

    expect(onVerificationError).toHaveBeenCalledOnce();
    expect(onStateChange).toHaveBeenCalledWith("AWAITING_PROVIDER_CONFIRMATION");
    expect(navigate).toHaveBeenCalledWith(payload.processingUrl);
  });
});

describe("Razorpay failure normalization", () => {
  it("separates provider failures from ambiguous outcomes", () => {
    expect(classifyRazorpayFailure({ reason: "insufficient_funds", source: "bank" })).toBe("DECLINED");
    expect(classifyRazorpayFailure({ failureCategory: "network_error" })).toBe("FAILED");
    expect(classifyRazorpayFailure({ source: "gateway" })).toBe("FAILED");
    expect(classifyRazorpayFailure({ failureCategory: "payment_failed" })).toBe("FAILED");
    expect(classifyRazorpayFailure({ failureCategory: "payment_cancelled" })).toBe("ABANDONED");
    expect(classifyRazorpayFailure({
      reason: "card_mandate_card_not_supported",
      source: "customer",
    })).toBe("DECLINED");
    expect(classifyRazorpayFailure({ failureCategory: "unexpected_provider_failure" })).toBe("FAILED");
  });

  it("sanitizes unknown response fields", () => {
    expect(normalizeRazorpayFailure({
      error: {
        code: 500,
        reason: "  gateway_error  ",
        metadata: { payment_id: 123 },
      },
    })).toEqual({
      failureCategory: "gateway_error",
      failureCode: undefined,
      description: undefined,
      reason: "gateway_error",
      source: undefined,
      step: undefined,
      paymentId: undefined,
    });
  });

  it("recognizes only complete Checkout retry payloads", () => {
    expect(isRazorpayCheckoutPayload(payload)).toBe(true);
    expect(isRazorpayCheckoutPayload({ ...payload, subscriptionId: undefined })).toBe(false);
  });
});
