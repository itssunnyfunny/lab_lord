import crypto from "node:crypto";

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

const ZERO_DECIMAL_CURRENCIES = new Set(["JPY"]);

export type RazorpayOrder = {
  id: string;
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: "created" | "attempted" | "paid" | string;
  attempts: number;
  created_at: number;
};

export type RazorpayPayment = {
  id: string;
  entity: "payment";
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed" | string;
  order_id: string | null;
  invoice_id?: string | null;
  subscription_id?: string | null;
  method?: string | null;
  captured?: boolean;
  amount_refunded?: number;
  refund_status?: string | null;
  email?: string | null;
  contact?: string | null;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  created_at?: number;
  notes?: Record<string, string> | null;
};

export type RazorpayPlan = {
  id: string;
  entity: "plan";
  interval: number;
  period: string;
  item?: {
    id?: string;
    amount?: number;
    currency?: string;
    name?: string;
    description?: string | null;
  };
  created_at?: number;
};

export type RazorpaySubscription = {
  id: string;
  entity: "subscription";
  plan_id: string;
  customer_id?: string | null;
  status: "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "expired" | string;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  charge_at?: number | null;
  start_at?: number | null;
  end_at?: number | null;
  total_count: number;
  paid_count?: number;
  remaining_count?: number;
  short_url?: string | null;
  notes?: Record<string, string> | null;
};

export type RazorpayOrderPayments = {
  entity: "collection";
  count: number;
  items: RazorpayPayment[];
};

type RazorpayRequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
};

export interface RazorpayApiClient {
  createOrder(input: {
    amount: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
  fetchOrderPayments(orderId: string): Promise<RazorpayOrderPayments>;
  capturePayment(paymentId: string, input: { amount: number; currency: string }): Promise<RazorpayPayment>;
  createPlan(input: {
    period: string;
    interval: number;
    item: { name: string; amount: number; currency: string; description?: string };
    notes: Record<string, string>;
  }): Promise<RazorpayPlan>;
  createSubscription(input: {
    plan_id: string;
    total_count: number;
    quantity: number;
    customer_notify: boolean;
    notes: Record<string, string>;
  }): Promise<RazorpaySubscription>;
  fetchSubscription(subscriptionId: string): Promise<RazorpaySubscription>;
}

let testClient: RazorpayApiClient | null = null;

export function setRazorpayClientForTests(client: RazorpayApiClient | null) {
  testClient = client;
}

function firstConfiguredEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function getRazorpayKeyId() {
  const keyId = firstConfiguredEnv([
    "RAZORPAY_KEY_ID",
    "RAZORPAY_TEST_KEY_ID",
    "TEST_API_KEY",
    "Test_API_Key",
  ]);
  if (!keyId) {
    throw new Error("Razorpay is not configured: RAZORPAY_KEY_ID is missing");
  }
  return keyId;
}

function getRazorpayKeySecret() {
  const keySecret = firstConfiguredEnv([
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_TEST_KEY_SECRET",
    "TEST_KEY_SECRET",
    "Test_Key_Secret",
  ]);
  if (!keySecret) {
    throw new Error("Razorpay is not configured: RAZORPAY_KEY_SECRET is missing");
  }
  return keySecret;
}

export function getRazorpayWebhookSecrets() {
  const current = firstConfiguredEnv([
    "RAZORPAY_WEBHOOK_SECRET",
    "RAZORPAY_TEST_WEBHOOK_SECRET",
    "TEST_WEBHOOK_SECRET",
    "Test_Webhook_Secret",
  ]);
  if (!current) {
    throw new Error("Razorpay webhook is not configured: RAZORPAY_WEBHOOK_SECRET is missing");
  }

  const older = (process.env.RAZORPAY_WEBHOOK_OLD_SECRETS ?? "")
    .split(",")
    .map(secret => secret.trim())
    .filter(Boolean);

  return [current, ...older];
}

export function normalizeCurrency(currency: string | null | undefined) {
  const normalized = (currency || "INR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("Invalid payment currency");
  }
  return normalized;
}

export function toRazorpaySubunits(amount: number, currency: string) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Payment amount must be a positive integer");
  }

  const normalizedCurrency = normalizeCurrency(currency);
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? 1 : 100;
  const subunits = amount * multiplier;

  if (!Number.isSafeInteger(subunits) || subunits <= 0) {
    throw new Error("Payment amount is too large for Razorpay");
  }

  return subunits;
}

export function hmacSha256Hex(message: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function timingSafeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return false;
  }

  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyRazorpayPaymentSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}) {
  const expected = hmacSha256Hex(`${input.orderId}|${input.paymentId}`, getRazorpayKeySecret());
  return timingSafeHexEqual(expected, input.signature);
}

export function verifyRazorpaySubscriptionSignature(input: {
  subscriptionId: string;
  paymentId: string;
  signature: string;
}) {
  const expected = hmacSha256Hex(`${input.paymentId}|${input.subscriptionId}`, getRazorpayKeySecret());
  return timingSafeHexEqual(expected, input.signature);
}

export function verifyRazorpayWebhookSignature(rawBody: string, signature: string | null) {
  if (!signature) return false;
  return getRazorpayWebhookSecrets().some(secret => {
    const expected = hmacSha256Hex(rawBody, secret);
    return timingSafeHexEqual(expected, signature);
  });
}

export function sha256Hex(message: string) {
  return crypto.createHash("sha256").update(message).digest("hex");
}

async function razorpayRequest<T>(path: string, options: RazorpayRequestOptions = {}): Promise<T> {
  const keyId = getRazorpayKeyId();
  const keySecret = getRazorpayKeySecret();
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  const response = await fetch(`${RAZORPAY_API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Razorpay rejected the configured API key/secret. Check that the local test Key ID and Key Secret belong to the same Razorpay test-mode account.");
    }

    const description =
      payload?.error?.description ||
      payload?.error?.reason ||
      payload?.message ||
      `Razorpay API request failed with ${response.status}`;
    throw new Error(description);
  }

  return payload as T;
}

class DefaultRazorpayClient implements RazorpayApiClient {
  createOrder(input: {
    amount: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }) {
    return razorpayRequest<RazorpayOrder>("/orders", {
      method: "POST",
      body: {
        amount: input.amount,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
        partial_payment: false,
      },
    });
  }

  fetchPayment(paymentId: string) {
    return razorpayRequest<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`);
  }

  fetchOrderPayments(orderId: string) {
    return razorpayRequest<RazorpayOrderPayments>(`/orders/${encodeURIComponent(orderId)}/payments`);
  }

  capturePayment(paymentId: string, input: { amount: number; currency: string }) {
    return razorpayRequest<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}/capture`, {
      method: "POST",
      body: input,
    });
  }

  createPlan(input: {
    period: string;
    interval: number;
    item: { name: string; amount: number; currency: string; description?: string };
    notes: Record<string, string>;
  }) {
    return razorpayRequest<RazorpayPlan>("/plans", {
      method: "POST",
      body: input,
    });
  }

  createSubscription(input: {
    plan_id: string;
    total_count: number;
    quantity: number;
    customer_notify: boolean;
    notes: Record<string, string>;
  }) {
    return razorpayRequest<RazorpaySubscription>("/subscriptions", {
      method: "POST",
      body: input,
    });
  }

  fetchSubscription(subscriptionId: string) {
    return razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }
}

const defaultClient = new DefaultRazorpayClient();

export function getRazorpayClient() {
  return testClient ?? defaultClient;
}
