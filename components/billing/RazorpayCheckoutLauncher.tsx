"use client";

import Script from "next/script";

export type RazorpayCheckoutMode = "AUTHORIZATION" | "RECOVERY";

export type RazorpayCheckoutEvent =
  | "ABANDONED"
  | "DECLINED"
  | "FAILED"
  | "AWAITING_PROVIDER_CONFIRMATION";

export type RazorpayFailureDetails = {
  failureCategory?: string;
  failureCode?: string;
  description?: string;
  reason?: string;
  source?: string;
  step?: string;
  paymentId?: string;
};

export type RazorpayCheckoutEventResult = {
  event: RazorpayCheckoutEvent;
  failure?: RazorpayFailureDetails;
};

export type RazorpayHandlerResponse = {
  razorpay_payment_id: string;
  razorpay_subscription_id?: string;
  razorpay_signature: string;
};

type RazorpayFailureResponse = {
  error?: {
    code?: unknown;
    description?: unknown;
    reason?: unknown;
    source?: unknown;
    step?: unknown;
    metadata?: Record<string, unknown>;
  };
};

export type RazorpayCheckoutPayloadLike = {
  keyId: string;
  subscriptionId: string;
  changeId: string;
  processingUrl: string;
  name?: string;
  description?: string;
  subscription_card_change?: true;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  /** Razorpay Standard Checkout display configuration supplied by the server. */
  config?: Record<string, unknown>;
  /** Temporary compatibility for older server payloads. Prefer `config`. */
  method?: Record<string, boolean>;
};

type RazorpayOptions = {
  key: string;
  name: string;
  description: string;
  subscription_id: string;
  remember_customer: false;
  subscription_card_change?: true;
  prefill?: RazorpayCheckoutPayloadLike["prefill"];
  readonly: {
    name: false;
    email: false;
    contact: false;
  };
  notes?: Record<string, string>;
  config?: Record<string, unknown>;
  method?: Record<string, boolean>;
  theme: { color: string };
  retry: { enabled: true };
  modal: {
    confirm_close: true;
    ondismiss: () => void | Promise<void>;
  };
  handler: (response: RazorpayHandlerResponse) => void | Promise<void>;
};

type RazorpayInstance = {
  open: () => void;
  on: (
    event: "payment.failed",
    handler: (response: RazorpayFailureResponse) => void
  ) => void;
};

export type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

type CheckoutState =
  | "OPEN"
  | "VERIFYING"
  | "AWAITING_PROVIDER_CONFIRMATION"
  | RazorpayCheckoutEvent;

export type OpenRazorpayCheckoutInput = {
  payload: RazorpayCheckoutPayloadLike;
  mode: RazorpayCheckoutMode;
  verify: (response: RazorpayHandlerResponse) => Promise<{ processingUrl?: string } | void>;
  recordEvent: (result: RazorpayCheckoutEventResult) => Promise<void>;
  navigate: (processingUrl: string) => void;
  onStateChange?: (state: CheckoutState, failure?: RazorpayFailureDetails) => void;
  onEventRecordError?: (error: unknown) => void;
  onVerificationError?: (error: unknown) => void;
  razorpayConstructor?: RazorpayConstructor;
};

const DECLINE_REASONS = new Set([
  "card_declined",
  "card_expired",
  "debit_card_disabled",
  "expired_card",
  "incorrect_card_details",
  "incorrect_cvv",
  "incorrect_pin",
  "incorrect_otp",
  "insufficient_funds",
  "international_transaction_not_allowed",
  "payment_declined",
  "payment_not_authorized",
  "card_not_supported",
  "card_mandate_card_not_supported",
  "transaction_limit_exceeded",
]);

const CUSTOMER_CANCEL_REASONS = new Set([
  "payment_cancelled",
]);

const TECHNICAL_REASONS = new Set([
  "bank_down",
  "gateway_error",
  "issuer_down",
  "network_error",
  "processing_error",
  "payment_failed",
  "server_error",
  "timeout",
]);

function cleanString(value: unknown, limit = 100) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, limit) : undefined;
}

export function normalizeRazorpayFailure(response: RazorpayFailureResponse): RazorpayFailureDetails {
  const error = response.error;
  const metadata = error?.metadata;
  const reason = cleanString(error?.reason);
  return {
    failureCategory: reason,
    failureCode: cleanString(error?.code),
    description: cleanString(error?.description, 300),
    reason,
    source: cleanString(error?.source),
    step: cleanString(error?.step),
    paymentId: cleanString(metadata?.payment_id ?? metadata?.paymentId),
  };
}

export function classifyRazorpayFailure(failure: RazorpayFailureDetails): RazorpayCheckoutEvent {
  const reason = (failure.reason ?? failure.failureCategory)?.toLowerCase();
  const code = failure.failureCode?.toLowerCase();
  const description = failure.description?.toLowerCase();
  const source = failure.source?.toLowerCase();

  // Razorpay documents payment_cancelled as a customer cancellation/back action.
  // It is a completed Checkout outcome, not an authorization that needs polling.
  if (reason && CUSTOMER_CANCEL_REASONS.has(reason)) {
    return "ABANDONED";
  }

  if (
    (reason && (DECLINE_REASONS.has(reason) || reason.includes("declin")))
    || description?.includes("declin")
  ) {
    return "DECLINED";
  }

  if (
    (reason && (TECHNICAL_REASONS.has(reason) || /(network|gateway|issuer|bank|server|timeout)/.test(reason)))
    || (code && /(gateway|server|network)/.test(code))
    || (source && /(bank|business|gateway|issuer|network|razorpay)/.test(source))
  ) {
    return "FAILED";
  }

  // This classifier is called only after Razorpay emitted payment.failed and
  // the modal closed. Unknown failure metadata must not leave the customer in
  // an endless verification state. A later provider-confirmed success still
  // wins through the signed callback/webhook reconciliation paths.
  return "FAILED";
}

export function isRazorpayCheckoutPayload(value: unknown): value is RazorpayCheckoutPayloadLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.keyId === "string"
    && typeof candidate.subscriptionId === "string"
    && typeof candidate.changeId === "string"
    && typeof candidate.processingUrl === "string";
}

function browserRazorpayConstructor() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Razorpay?: RazorpayConstructor }).Razorpay;
}

/**
 * Opens one Razorpay modal. A failed attempt stays provisional while the modal
 * is open because Razorpay can retry in-place and later invoke the success
 * handler for the same Checkout instance.
 */
export function openRazorpayCheckout({
  payload,
  mode,
  verify,
  recordEvent,
  navigate,
  onStateChange,
  onEventRecordError,
  onVerificationError,
  razorpayConstructor,
}: OpenRazorpayCheckoutInput) {
  const Razorpay = razorpayConstructor ?? browserRazorpayConstructor();
  if (!Razorpay) throw new Error("Razorpay Checkout is still loading. Please try again in a moment.");

  let verificationStarted = false;
  let lastFailure: RazorpayFailureDetails | null = null;

  const checkout = new Razorpay({
    key: payload.keyId,
    name: payload.name ?? "Lab Lords",
    description: payload.description
      ?? (mode === "RECOVERY" ? "Update card and retry subscription payment" : "Authorize your Lab Lords subscription"),
    subscription_id: payload.subscriptionId,
    // Do not opt the payer into Razorpay's saved-card/one-click experience.
    // Subscription authorization remains provider-managed and the issuer
    // independently decides where its bank/3-D Secure OTP is sent.
    remember_customer: false,
    ...(mode === "RECOVERY" || payload.subscription_card_change
      ? { subscription_card_change: true as const }
      : {}),
    prefill: payload.prefill,
    // Prefill is a convenience only. The payer can use different billing contact details.
    readonly: { name: false, email: false, contact: false },
    notes: payload.notes,
    ...(payload.config ? { config: payload.config } : payload.method ? { method: payload.method } : {}),
    theme: { color: "#22c55e" },
    retry: { enabled: true },
    modal: {
      confirm_close: true,
      ondismiss: async () => {
        if (verificationStarted) return;
        const result: RazorpayCheckoutEventResult = lastFailure
          ? { event: classifyRazorpayFailure(lastFailure), failure: lastFailure }
          : { event: "ABANDONED" };
        try {
          await recordEvent(result);
        } catch (error) {
          onEventRecordError?.(error);
        } finally {
          onStateChange?.(result.event, result.failure);
          if (result.event === "AWAITING_PROVIDER_CONFIRMATION") {
            navigate(payload.processingUrl);
          }
        }
      },
    },
    handler: async (response) => {
      verificationStarted = true;
      lastFailure = null;
      onStateChange?.("VERIFYING");
      try {
        const result = await verify(response);
        navigate(result?.processingUrl ?? payload.processingUrl);
      } catch (error) {
        // The browser callback is not entitlement proof. The processing route
        // continues provider reconciliation when verification is interrupted.
        onVerificationError?.(error);
        onStateChange?.("AWAITING_PROVIDER_CONFIRMATION");
        navigate(payload.processingUrl);
      }
    },
  });

  checkout.on("payment.failed", (response) => {
    lastFailure = normalizeRazorpayFailure(response);
  });

  onStateChange?.("OPEN");
  checkout.open();
  return checkout;
}

export function RazorpayCheckoutScript({
  onReady,
  onError,
}: {
  onReady?: () => void;
  onError?: () => void;
}) {
  return (
    <Script
      id="razorpay-checkout"
      src="https://checkout.razorpay.com/v1/checkout.js"
      strategy="afterInteractive"
      onReady={onReady}
      onError={onError}
    />
  );
}

export function isRazorpayCheckoutReady() {
  return Boolean(browserRazorpayConstructor());
}
