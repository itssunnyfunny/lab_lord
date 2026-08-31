import crypto from "node:crypto";

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const RAZORPAY_REQUEST_TIMEOUT_MS = 15_000;

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
  notes?: Record<string, string> | null;
  created_at?: number;
};

export type RazorpayPlans = {
  entity: "collection";
  count: number;
  items: RazorpayPlan[];
};

export type RazorpayModeValue = "TEST" | "LIVE";

export type RazorpayApiErrorKind =
  | "AUTHENTICATION"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "NETWORK"
  | "REQUEST"
  | "PROVIDER";

export class RazorpayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayConfigurationError";
  }
}

export class RazorpayApiError extends Error {
  readonly status: number | null;
  readonly kind: RazorpayApiErrorKind;

  constructor(message: string, input: { status?: number | null; kind: RazorpayApiErrorKind }) {
    super(message);
    this.name = "RazorpayApiError";
    this.status = input.status ?? null;
    this.kind = input.kind;
  }
}

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
  quantity?: number;
  paid_count?: number;
  remaining_count?: number;
  short_url?: string | null;
  has_scheduled_changes?: boolean;
  change_scheduled_at?: number | null;
  expire_by?: number | null;
  payment_method?: string | null;
  offer_id?: string | null;
  notes?: Record<string, string> | null;
  created_at?: number;
};

export type RazorpayInvoice = {
  id: string;
  entity: "invoice";
  subscription_id?: string | null;
  payment_id?: string | null;
  status: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  billing_start?: number | null;
  billing_end?: number | null;
  issued_at?: number | null;
  paid_at?: number | null;
};

export type RazorpayInvoices = {
  entity: "collection";
  count: number;
  items: RazorpayInvoice[];
};

export type RazorpaySubscriptions = {
  entity: "collection";
  count: number;
  items: RazorpaySubscription[];
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
  fetchPlan?(planId: string): Promise<RazorpayPlan>;
  createSubscription(input: {
    plan_id: string;
    total_count: number;
    quantity: number;
    customer_notify: boolean;
    notes: Record<string, string>;
    start_at?: number;
    expire_by?: number;
    offer_id?: string;
  }): Promise<RazorpaySubscription>;
  fetchSubscription(subscriptionId: string): Promise<RazorpaySubscription>;
  /**
   * Optional because small test doubles and legacy adapters only need the
   * single-subscription API. Replacement provisioning requires this capability
   * to recover a provider create whose HTTP response was lost.
   */
  listSubscriptions?(input?: { count?: number; skip?: number }): Promise<RazorpaySubscriptions>;
  updateSubscription(subscriptionId: string, input: {
    plan_id?: string;
    quantity?: number;
    remaining_count?: number;
    start_at?: number;
    offer_id?: string;
    schedule_change_at: "now" | "cycle_end";
    customer_notify?: boolean;
  }): Promise<RazorpaySubscription>;
  cancelScheduledChanges(subscriptionId: string): Promise<RazorpaySubscription>;
  fetchSubscriptionInvoices(subscriptionId: string): Promise<RazorpayInvoices>;
  cancelSubscription(
    subscriptionId: string,
    input: { cancel_at_cycle_end: boolean }
  ): Promise<RazorpaySubscription>;
}

export interface RazorpayPlanCatalogApiClient extends RazorpayApiClient {
  fetchPlan(planId: string): Promise<RazorpayPlan>;
  listPlans(input?: { count?: number; skip?: number }): Promise<RazorpayPlans>;
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

function deployedServerValue(primaryName: string, aliasNames: string[]) {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnvironment !== "preview" && vercelEnvironment !== "production") {
    return null;
  }

  const primaryValue = process.env[primaryName]?.trim();
  if (!primaryValue) {
    throw new RazorpayConfigurationError(
      `${primaryName} must be configured as a server-only variable in Vercel ${vercelEnvironment}`
    );
  }
  const configuredAlias = aliasNames.find(name => process.env[name]?.trim());
  if (configuredAlias) {
    throw new RazorpayConfigurationError(
      `${configuredAlias} is not supported in Vercel ${vercelEnvironment}; use only server-side ${primaryName}`
    );
  }
  return primaryValue;
}

export function getRazorpayKeyId() {
  const deployedKeyId = deployedServerValue("RAZORPAY_KEY_ID", [
    "NEXT_PUBLIC_RAZORPAY_KEY_ID",
    "RAZORPAY_TEST_KEY_ID",
    "TEST_API_KEY",
    "Test_API_Key",
  ]);
  if (deployedKeyId) return deployedKeyId;

  const keyId = firstConfiguredEnv([
    "RAZORPAY_KEY_ID",
    "NEXT_PUBLIC_RAZORPAY_KEY_ID",
    "RAZORPAY_TEST_KEY_ID",
    "TEST_API_KEY",
    "Test_API_Key",
  ]);
  if (!keyId) {
    throw new Error("Razorpay is not configured: RAZORPAY_KEY_ID is missing");
  }
  return keyId;
}

export function parseRazorpayKeyMode(keyId: string): RazorpayModeValue {
  if (keyId.startsWith("rzp_test_")) return "TEST";
  if (keyId.startsWith("rzp_live_")) return "LIVE";
  throw new RazorpayConfigurationError(
    "RAZORPAY_KEY_ID must be a Razorpay Test or Live key (rzp_test_ or rzp_live_)"
  );
}

export function resolveRazorpayMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): RazorpayModeValue {
  const configuredMode = env.RAZORPAY_MODE?.trim().toUpperCase();
  if (configuredMode !== "TEST" && configuredMode !== "LIVE") {
    throw new RazorpayConfigurationError("RAZORPAY_MODE must be explicitly set to TEST or LIVE");
  }

  const keyId = env.RAZORPAY_KEY_ID?.trim();
  if (!keyId) {
    throw new RazorpayConfigurationError("Razorpay is not configured: RAZORPAY_KEY_ID is missing");
  }

  const keyMode = parseRazorpayKeyMode(keyId);
  if (keyMode !== configuredMode) {
    throw new RazorpayConfigurationError(
      `RAZORPAY_MODE=${configuredMode} does not match the configured ${keyMode} key`
    );
  }

  const vercelEnvironment = env.VERCEL_ENV?.trim().toLowerCase();
  if (vercelEnvironment === "production" && configuredMode !== "LIVE") {
    throw new RazorpayConfigurationError("Vercel Production requires RAZORPAY_MODE=LIVE");
  }
  if (
    (vercelEnvironment === "preview" || vercelEnvironment === "development")
    && configuredMode !== "TEST"
  ) {
    throw new RazorpayConfigurationError(
      `Vercel ${vercelEnvironment} requires RAZORPAY_MODE=TEST`
    );
  }

  return configuredMode;
}

export function isRazorpayNotFoundError(error: unknown): error is RazorpayApiError {
  return error instanceof RazorpayApiError && error.kind === "NOT_FOUND";
}

function getRazorpayKeySecret() {
  const deployedKeySecret = deployedServerValue("RAZORPAY_KEY_SECRET", [
    "RAZORPAY_TEST_KEY_SECRET",
    "TEST_KEY_SECRET",
    "Test_Key_Secret",
  ]);
  if (deployedKeySecret) return deployedKeySecret;

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
  const aliasNames = [
    "RAZORPAY_TEST_WEBHOOK_SECRET",
    "TEST_WEBHOOK_SECRET",
    "Test_Webhook_Secret",
  ];
  const current = deployedServerValue("RAZORPAY_WEBHOOK_SECRET", aliasNames) ?? firstConfiguredEnv([
    "RAZORPAY_WEBHOOK_SECRET",
    ...aliasNames,
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

export function fromRazorpaySubunits(amountSubunits: number, currency: string) {
  if (!Number.isSafeInteger(amountSubunits) || amountSubunits <= 0) {
    throw new Error("Payment amount must be a positive integer");
  }

  const normalizedCurrency = normalizeCurrency(currency);
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? 1 : 100;
  if (amountSubunits % multiplier !== 0) {
    throw new Error("Payment amount cannot be represented in whole currency units");
  }
  return amountSubunits / multiplier;
}

export function hmacSha256Hex(message: string | Uint8Array, secret: string) {
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

export function verifyRazorpayWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string | null
) {
  if (!signature) return false;
  return getRazorpayWebhookSecrets().some(secret => {
    const expected = hmacSha256Hex(rawBody, secret);
    return timingSafeHexEqual(expected, signature);
  });
}

export function sha256Hex(message: string | Uint8Array) {
  return crypto.createHash("sha256").update(message).digest("hex");
}

async function razorpayRequest<T>(path: string, options: RazorpayRequestOptions = {}): Promise<T> {
  const keyId = getRazorpayKeyId();
  const keySecret = getRazorpayKeySecret();
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(`${RAZORPAY_API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(RAZORPAY_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new RazorpayApiError("Unable to reach Razorpay", {
      kind: "NETWORK",
      status: null,
    });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const description =
      payload?.error?.description ||
      payload?.error?.reason ||
      payload?.message ||
      `Razorpay API request failed with ${response.status}`;
    const kind: RazorpayApiErrorKind = response.status === 401
      ? "AUTHENTICATION"
      : response.status === 404
        ? "NOT_FOUND"
        : response.status === 429
          ? "RATE_LIMIT"
          : response.status >= 500
            ? "PROVIDER"
            : "REQUEST";
    throw new RazorpayApiError(description, { status: response.status, kind });
  }

  return payload as T;
}

class DefaultRazorpayClient implements RazorpayPlanCatalogApiClient {
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

  fetchPlan(planId: string) {
    return razorpayRequest<RazorpayPlan>(`/plans/${encodeURIComponent(planId)}`);
  }

  listPlans(input: { count?: number; skip?: number } = {}) {
    const params = new URLSearchParams();
    params.set("count", String(Math.min(Math.max(input.count ?? 100, 1), 100)));
    if (input.skip !== undefined) {
      params.set("skip", String(Math.max(input.skip, 0)));
    }
    return razorpayRequest<RazorpayPlans>(`/plans?${params.toString()}`);
  }

  createSubscription(input: {
    plan_id: string;
    total_count: number;
    quantity: number;
    customer_notify: boolean;
    notes: Record<string, string>;
    start_at?: number;
    expire_by?: number;
    offer_id?: string;
  }) {
    return razorpayRequest<RazorpaySubscription>("/subscriptions", {
      method: "POST",
      body: input,
    });
  }

  fetchSubscription(subscriptionId: string) {
    return razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  listSubscriptions(input: { count?: number; skip?: number } = {}) {
    const params = new URLSearchParams();
    params.set("count", String(Math.min(Math.max(input.count ?? 100, 1), 100)));
    if (input.skip !== undefined) {
      params.set("skip", String(Math.max(input.skip, 0)));
    }
    return razorpayRequest<RazorpaySubscriptions>(`/subscriptions?${params.toString()}`);
  }

  updateSubscription(subscriptionId: string, input: {
    plan_id?: string;
    quantity?: number;
    remaining_count?: number;
    start_at?: number;
    offer_id?: string;
    schedule_change_at: "now" | "cycle_end";
    customer_notify?: boolean;
  }) {
    return razorpayRequest<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: "PATCH", body: input }
    );
  }

  cancelScheduledChanges(subscriptionId: string) {
    return razorpayRequest<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel_scheduled_changes`,
      { method: "POST" }
    );
  }

  fetchSubscriptionInvoices(subscriptionId: string) {
    return razorpayRequest<RazorpayInvoices>(
      `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}`
    );
  }

  cancelSubscription(subscriptionId: string, input: { cancel_at_cycle_end: boolean }) {
    return razorpayRequest<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      {
        method: "POST",
        body: input,
      }
    );
  }
}

const defaultClient = new DefaultRazorpayClient();

export function getRazorpayClient() {
  return testClient ?? defaultClient;
}

export function getRazorpayPlanCatalogClient(): RazorpayPlanCatalogApiClient {
  const client = getRazorpayClient();
  if (!("fetchPlan" in client) || typeof client.fetchPlan !== "function"
    || !("listPlans" in client) || typeof client.listPlans !== "function") {
    throw new RazorpayConfigurationError(
      "The configured Razorpay client does not support plan-catalog verification"
    );
  }
  return client as RazorpayPlanCatalogApiClient;
}
