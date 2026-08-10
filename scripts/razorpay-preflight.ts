import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

export type PreflightTarget = "preview" | "production";
type ExpectedSwitch = "enabled" | "disabled";
type Environment = Record<string, string | undefined>;

export type PreflightArguments = {
  target: PreflightTarget;
  envFile: string;
  mustDifferFrom?: string;
  expectPlanId?: string;
  forbidPlanId?: string;
  expectEmptyProviderCatalog: boolean;
  expectedBillingWrites: ExpectedSwitch;
  expectedV2: ExpectedSwitch;
  expectedMultiMethodSubscriptions: ExpectedSwitch;
  expectedCanaryOrganizationId?: string;
  confirmations: {
    subscriptionSettings: boolean;
    upiIntent: boolean;
    upiQr: boolean;
    webhookEvents: boolean;
    amountEligibility: boolean;
  };
};

type JsonObject = Record<string, unknown>;

export type RecurringMethodsSummary = {
  accountMethods: {
    card: boolean;
    upi: boolean;
    netbanking: boolean;
  };
  recurring: {
    card: { enabled: boolean; supportedEntryCount: number };
    upi: { enabled: boolean; supportedEntryCount: number };
    emandate: {
      enabled: boolean;
      supportedBankCount: number;
      authenticationTypeCount: number;
    };
  };
  checkoutSignals: {
    upiIntent: boolean | null;
    upiQr: boolean | null;
  };
};

export const REQUIRED_MULTI_METHOD_WEBHOOK_EVENTS = [
  "subscription.authenticated",
  "subscription.activated",
  "subscription.charged",
  "subscription.updated",
  "subscription.pending",
  "subscription.halted",
  "subscription.paused",
  "subscription.resumed",
  "subscription.cancelled",
  "subscription.completed",
  "invoice.paid",
  "invoice.partially_paid",
  "payment.authorized",
  "payment.captured",
  "payment.failed",
] as const;

type PlanRow = {
  plan: string;
  amountSubunits: number;
  currency: string;
  period: string;
  interval: number;
  razorpayPlanId: string;
  active: boolean;
  providerMode: string;
};

type SubscriptionRow = {
  providerMode: string;
  status: string;
  quantity: number;
  razorpayPlanId: string;
  razorpaySubscriptionId: string;
};

type OfferRow = {
  providerMode: string;
  active: boolean;
};

type ProvisioningRow = {
  providerMode: string;
  status: string;
};

type OperationRow = {
  operationStatus: string;
  status: string;
  toPlan: string | null;
  toQuantity: number | null;
};

type InvoiceRow = { status: string };
type WebhookReceiptRow = { processedAt: Date | null; processingError: string | null };

const ACTIVE_OPERATION_STATUSES = new Set([
  "CHECKOUT_OPEN",
  "VERIFYING",
  "AWAITING_PROVIDER_CONFIRMATION",
]);

const FORBIDDEN_MUTATION_FLAGS = [
  "--apply",
  "--cleanup",
  "--cancel",
  "--delete",
  "--detach",
  "--migrate",
  "--promote",
  "--write",
];

const PREFLIGHT_ISOLATED_ENVIRONMENT_VARIABLES = [
  "DATABASE_URL",
  "ACCELERATE_URL",
  "RAZORPAY_MODE",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_WEBHOOK_OLD_SECRETS",
  "RAZORPAY_BILLING_WRITES_ENABLED",
  "RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED",
  "RAZORPAY_LIVE_CANARY_ORG_IDS",
  "WORKSPACE_BRANCH_BILLING_V2_ENABLED",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "RAZORPAY_TEST_KEY_ID",
  "RAZORPAY_TEST_KEY_SECRET",
  "RAZORPAY_TEST_WEBHOOK_SECRET",
  "TEST_API_KEY",
  "TEST_KEY_SECRET",
  "TEST_WEBHOOK_SECRET",
  "Test_API_Key",
  "Test_Key_Secret",
  "Test_Webhook_Secret",
  "CRON_SECRET",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPPORT_EMAIL",
  "NEXT_PUBLIC_BUSINESS_ADDRESS",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "VERCEL_ENV",
] as const;

function argumentValue(argument: string, name: string) {
  return argument.startsWith(`${name}=`) ? argument.slice(name.length + 1).trim() : null;
}

function parseSwitch(value: string | null, flag: string): ExpectedSwitch | null {
  if (value === null) return null;
  if (value !== "enabled" && value !== "disabled") {
    throw new Error(`${flag} must be enabled or disabled`);
  }
  return value;
}

export function parsePreflightArguments(argv: string[]): PreflightArguments {
  for (const forbidden of FORBIDDEN_MUTATION_FLAGS) {
    if (argv.some(argument => argument === forbidden || argument.startsWith(`${forbidden}=`))) {
      throw new Error(
        `${forbidden} is intentionally unsupported: this preflight is read-only and cannot clean up or mutate billing data`
      );
    }
  }

  const known = [
    "--target=",
    "--env-file=",
    "--must-differ-from=",
    "--expect-plan-id=",
    "--forbid-plan-id=",
    "--expect-billing-writes=",
    "--expect-v2=",
    "--expect-multi-method-subscriptions=",
    "--expect-canary-org-id=",
  ];
  const confirmationFlags = [
    "--confirm-subscription-settings",
    "--confirm-upi-intent",
    "--confirm-upi-qr",
    "--confirm-webhook-events",
    "--confirm-amount-eligibility",
  ] as const;
  const unknown = argv.find(argument =>
    argument !== "--expect-empty-provider-catalog" &&
    !confirmationFlags.includes(argument as typeof confirmationFlags[number]) &&
    !known.some(prefix => argument.startsWith(prefix))
  );
  if (unknown) throw new Error(`Unknown preflight argument: ${unknown}`);

  const targetValue = argv.map(argument => argumentValue(argument, "--target")).find(Boolean);
  if (targetValue !== "preview" && targetValue !== "production") {
    throw new Error("--target=preview or --target=production is required");
  }

  const envFile =
    argv.map(argument => argumentValue(argument, "--env-file")).find(Boolean) ??
    process.env.BILLING_ENV_FILE ??
    ".env";
  const mustDifferFrom = argv
    .map(argument => argumentValue(argument, "--must-differ-from"))
    .find(Boolean) ?? undefined;
  const expectPlanId = argv
    .map(argument => argumentValue(argument, "--expect-plan-id"))
    .find(Boolean) ?? undefined;
  const forbidPlanId = argv
    .map(argument => argumentValue(argument, "--forbid-plan-id"))
    .find(Boolean) ?? undefined;
  const expectedBillingWrites =
    parseSwitch(
      argv.map(argument => argumentValue(argument, "--expect-billing-writes")).find(Boolean) ?? null,
      "--expect-billing-writes"
    ) ?? (targetValue === "preview" ? "enabled" : "disabled");
  const expectedV2 =
    parseSwitch(
      argv.map(argument => argumentValue(argument, "--expect-v2")).find(Boolean) ?? null,
      "--expect-v2"
    ) ?? (targetValue === "preview" ? "enabled" : "disabled");
  const expectedMultiMethodSubscriptions =
    parseSwitch(
      argv
        .map(argument => argumentValue(argument, "--expect-multi-method-subscriptions"))
        .find(Boolean) ?? null,
      "--expect-multi-method-subscriptions"
    ) ?? "disabled";
  const expectedCanaryValues = argv
    .map(argument => argumentValue(argument, "--expect-canary-org-id"))
    .filter((value): value is string => Boolean(value));
  if (expectedCanaryValues.length > 1) {
    throw new Error("Only one --expect-canary-org-id may be provided");
  }
  const expectedCanaryOrganizationId = expectedCanaryValues[0];

  if (mustDifferFrom && !/^[a-f0-9]{64}$/i.test(mustDifferFrom)) {
    throw new Error("--must-differ-from must be a complete SHA-256 database fingerprint");
  }
  for (const [flag, planId] of [
    ["--expect-plan-id", expectPlanId],
    ["--forbid-plan-id", forbidPlanId],
  ] as const) {
    if (planId && !/^plan_[A-Za-z0-9]+$/.test(planId)) {
      throw new Error(`${flag} must contain a Razorpay plan ID`);
    }
  }
  if (expectPlanId && forbidPlanId && expectPlanId === forbidPlanId) {
    throw new Error("The same plan cannot be both expected and forbidden");
  }
  if (expectPlanId && argv.includes("--expect-empty-provider-catalog")) {
    throw new Error("--expect-plan-id conflicts with --expect-empty-provider-catalog");
  }
  if (
    expectedCanaryOrganizationId
    && !/^[A-Za-z0-9_-]{1,128}$/.test(expectedCanaryOrganizationId)
  ) {
    throw new Error("--expect-canary-org-id must contain one organization ID");
  }
  if (targetValue === "preview" && expectedCanaryOrganizationId) {
    throw new Error("--expect-canary-org-id is supported only for Production preflight");
  }

  const confirmations = {
    subscriptionSettings: argv.includes("--confirm-subscription-settings"),
    upiIntent: argv.includes("--confirm-upi-intent"),
    upiQr: argv.includes("--confirm-upi-qr"),
    webhookEvents: argv.includes("--confirm-webhook-events"),
    amountEligibility: argv.includes("--confirm-amount-eligibility"),
  };
  if (expectedMultiMethodSubscriptions === "enabled") {
    const missing = Object.entries(confirmations)
      .filter(([, confirmed]) => !confirmed)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Multi-method preflight requires explicit Dashboard/Test confirmations: ${missing.join(", ")}`
      );
    }
  }

  return {
    target: targetValue,
    envFile,
    mustDifferFrom,
    expectPlanId,
    forbidPlanId,
    expectEmptyProviderCatalog: argv.includes("--expect-empty-provider-catalog"),
    expectedBillingWrites,
    expectedV2,
    expectedMultiMethodSubscriptions,
    expectedCanaryOrganizationId,
    confirmations,
  };
}

function expectedMode(target: PreflightTarget) {
  return target === "production" ? "LIVE" : "TEST";
}

function expectedKeyPrefix(target: PreflightTarget) {
  return target === "production" ? "rzp_live_" : "rzp_test_";
}

function expectedClerkPrefixes(target: PreflightTarget) {
  return target === "production"
    ? { publishable: "pk_live_", secret: "sk_live_" }
    : { publishable: "pk_test_", secret: "sk_test_" };
}

function enabledValue(value: ExpectedSwitch) {
  return value === "enabled" ? "true" : "false";
}

function featureFlagValue(environment: Environment, name: string) {
  const configured = environment[name]?.trim().toLowerCase();
  return configured === undefined || configured === "" ? "false" : configured;
}

export function buildIsolatedPreflightEnvironment(
  loaded: Environment,
  invocation: Environment
) {
  const target = { ...loaded };
  if (invocation.VERCEL_ENV?.trim()) {
    target.VERCEL_ENV = invocation.VERCEL_ENV;
  }
  return target;
}

export function loadPreflightEnvironment(
  envFile: string,
  invocation: Environment = process.env
) {
  const loaded: Record<string, string> = {};
  const result = loadEnv({
    path: envFile,
    processEnv: loaded,
    override: true,
    quiet: true,
  });
  if (result.error) {
    throw new Error(`Unable to load the requested preflight environment file: ${envFile}`);
  }
  return buildIsolatedPreflightEnvironment(loaded, invocation);
}

function installPreflightEnvironment(target: Environment) {
  for (const name of PREFLIGHT_ISOLATED_ENVIRONMENT_VARIABLES) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(target)) {
    if (value !== undefined) process.env[name] = value;
  }
}

function configuredCanaryOrganizations(environment: Environment) {
  return [...new Set(
    (environment.RAZORPAY_LIVE_CANARY_ORG_IDS ?? "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  )];
}

export function validatePreflightEnvironment(
  target: PreflightTarget,
  environment: Environment,
  options: Pick<
    PreflightArguments,
    | "expectedBillingWrites"
    | "expectedV2"
    | "expectedMultiMethodSubscriptions"
    | "expectedCanaryOrganizationId"
  >
) {
  const failures: string[] = [];
  const mode = expectedMode(target);
  const clerkPrefixes = expectedClerkPrefixes(target);
  const requireValue = (name: string) => {
    if (!environment[name]?.trim()) failures.push(`${name} is missing`);
  };

  if (environment.RAZORPAY_MODE?.trim().toUpperCase() !== mode) {
    failures.push(`RAZORPAY_MODE must be ${mode} for ${target}`);
  }
  if (!environment.RAZORPAY_KEY_ID?.trim().startsWith(expectedKeyPrefix(target))) {
    failures.push(`RAZORPAY_KEY_ID does not match ${target} Razorpay mode`);
  }
  requireValue("RAZORPAY_KEY_SECRET");
  requireValue("RAZORPAY_WEBHOOK_SECRET");
  requireValue("CRON_SECRET");
  requireValue("DATABASE_URL");

  if (environment.VERCEL_ENV?.trim().toLowerCase() !== target) {
    failures.push(`VERCEL_ENV must be ${target} for this preflight`);
  }
  if (environment.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim()) {
    failures.push("NEXT_PUBLIC_RAZORPAY_KEY_ID must be removed; use server-only RAZORPAY_KEY_ID");
  }
  if (environment.RAZORPAY_BILLING_WRITES_ENABLED !== enabledValue(options.expectedBillingWrites)) {
    failures.push(
      `RAZORPAY_BILLING_WRITES_ENABLED must be ${enabledValue(options.expectedBillingWrites)}`
    );
  }
  if (environment.WORKSPACE_BRANCH_BILLING_V2_ENABLED !== enabledValue(options.expectedV2)) {
    failures.push(`WORKSPACE_BRANCH_BILLING_V2_ENABLED must be ${enabledValue(options.expectedV2)}`);
  }
  const multiMethodSubscriptions = featureFlagValue(
    environment,
    "RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED"
  );
  if (!new Set(["true", "false"]).has(multiMethodSubscriptions)) {
    failures.push("RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED must be true or false when set");
  } else if (multiMethodSubscriptions !== enabledValue(options.expectedMultiMethodSubscriptions)) {
    failures.push(
      `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED must be ${enabledValue(options.expectedMultiMethodSubscriptions)}`
    );
  }
  const canaryOrganizations = configuredCanaryOrganizations(environment);
  if (!options.expectedCanaryOrganizationId && canaryOrganizations.length > 0) {
    failures.push(
      "RAZORPAY_LIVE_CANARY_ORG_IDS must be empty unless --expect-canary-org-id is provided"
    );
  } else if (
    options.expectedCanaryOrganizationId
    && (
      canaryOrganizations.length !== 1
      || canaryOrganizations[0] !== options.expectedCanaryOrganizationId
    )
  ) {
    failures.push(
      "RAZORPAY_LIVE_CANARY_ORG_IDS must contain exactly the explicitly expected organization"
    );
  }

  const address = environment.NEXT_PUBLIC_BUSINESS_ADDRESS?.trim() ?? "";
  if (!address || /available on request|replace|todo|tbd/i.test(address)) {
    failures.push("NEXT_PUBLIC_BUSINESS_ADDRESS must contain the exact KYC-matching address");
  }
  if (environment.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "") !== "https://lablords.in") {
    failures.push("NEXT_PUBLIC_SITE_URL must be https://lablords.in");
  }
  if (!/^\S+@\S+\.\S+$/.test(environment.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() ?? "")) {
    failures.push("NEXT_PUBLIC_SUPPORT_EMAIL must contain the monitored support address");
  }
  if (!environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim().startsWith(clerkPrefixes.publishable)) {
    failures.push(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY does not match ${target} Clerk mode`);
  }
  if (!environment.CLERK_SECRET_KEY?.trim().startsWith(clerkPrefixes.secret)) {
    failures.push(`CLERK_SECRET_KEY does not match ${target} Clerk mode`);
  }

  return failures;
}

function countBy<T>(rows: T[], value: (row: T) => string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const key = value(row);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function child(object: JsonObject | undefined, name: string) {
  if (!object) return undefined;
  const match = Object.entries(object).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function capabilityEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    return !new Set(["", "false", "disabled", "inactive", "unavailable", "0"])
      .has(value.trim().toLowerCase());
  }
  if (Array.isArray(value)) return value.some(capabilityEnabled);
  if (isJsonObject(value)) return Object.values(value).some(capabilityEnabled);
  return false;
}

const CAPABILITY_METADATA_KEYS = new Set([
  "active",
  "available",
  "enabled",
  "status",
  "supported",
]);

function supportedEntryCount(value: unknown) {
  if (Array.isArray(value)) return value.filter(capabilityEnabled).length;
  if (!isJsonObject(value)) return capabilityEnabled(value) ? 1 : 0;
  return Object.entries(value).filter(([key, entry]) =>
    !CAPABILITY_METADATA_KEYS.has(key.toLowerCase()) && capabilityEnabled(entry)
  ).length;
}

function collectStringLeaves(value: unknown, target = new Set<string>()) {
  if (typeof value === "string" && value.trim()) target.add(value.trim().toLowerCase());
  else if (Array.isArray(value)) value.forEach(entry => collectStringLeaves(entry, target));
  else if (isJsonObject(value)) Object.values(value).forEach(entry => collectStringLeaves(entry, target));
  return target;
}

function namedCapability(root: JsonObject, requiredPathTerms: string[]) {
  const matches: unknown[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (!isJsonObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const nextPath = [...path, key.toLowerCase()];
      const joined = nextPath.join(".");
      if (requiredPathTerms.every(term => joined.includes(term))) matches.push(entry);
      visit(entry, nextPath);
    }
  };
  visit(root, []);
  if (matches.length === 0) return null;
  return matches.some(capabilityEnabled);
}

/**
 * Summarises the account-specific Methods API response without embedding a
 * bank, app, handle or network catalog in application code. Razorpay remains
 * the source of truth because these lists and account capabilities change.
 */
export function summarizeRecurringMethods(response: unknown): RecurringMethodsSummary {
  if (!isJsonObject(response)) throw new Error("Razorpay Methods API returned an invalid response");

  const recurringValue = child(response, "recurring");
  const recurring = isJsonObject(recurringValue) ? recurringValue : undefined;
  const accountCard = child(response, "card");
  const accountUpi = child(response, "upi");
  const accountNetbanking = child(response, "netbanking");
  const recurringCard = child(recurring, "card");
  const recurringUpi = child(recurring, "upi");
  const recurringEmandate = child(recurring, "emandate");
  const emandateAuthenticationTypes = collectStringLeaves(recurringEmandate);

  return {
    accountMethods: {
      card: capabilityEnabled(accountCard),
      upi: capabilityEnabled(accountUpi),
      netbanking: capabilityEnabled(accountNetbanking),
    },
    recurring: {
      card: {
        enabled: capabilityEnabled(recurringCard),
        supportedEntryCount: supportedEntryCount(recurringCard),
      },
      upi: {
        // Some account responses expose UPI only at the top level while card
        // and eMandate catalogs live under `recurring`.
        enabled: capabilityEnabled(recurringUpi ?? accountUpi),
        supportedEntryCount: supportedEntryCount(recurringUpi ?? accountUpi),
      },
      emandate: {
        enabled: capabilityEnabled(recurringEmandate),
        supportedBankCount: supportedEntryCount(recurringEmandate),
        authenticationTypeCount: emandateAuthenticationTypes.size,
      },
    },
    checkoutSignals: {
      upiIntent: namedCapability(response, ["upi", "intent"]),
      upiQr: namedCapability(response, ["upi", "qr"]),
    },
  };
}

export function validateRecurringMethods(
  summary: RecurringMethodsSummary,
  requireMultiMethodSubscriptions: boolean
) {
  if (!requireMultiMethodSubscriptions) return [];
  const failures: string[] = [];
  if (!summary.accountMethods.card || !summary.recurring.card.enabled) {
    failures.push("Razorpay Methods API does not report recurring Card capability");
  }
  if (!summary.accountMethods.upi || !summary.recurring.upi.enabled) {
    failures.push("Razorpay Methods API does not report UPI capability for this account");
  }
  if (
    !summary.recurring.emandate.enabled
    || summary.recurring.emandate.supportedBankCount === 0
  ) {
    failures.push("Razorpay Methods API does not report any recurring eMandate banks");
  }
  if (summary.checkoutSignals.upiIntent === false) {
    failures.push("Razorpay Methods API explicitly reports UPI Intent as unavailable");
  }
  if (summary.checkoutSignals.upiQr === false) {
    failures.push("Razorpay Methods API explicitly reports UPI QR as unavailable");
  }
  return failures;
}

export async function fetchRazorpayMethods(
  keyId: string,
  fetchImplementation: typeof fetch = fetch
) {
  const auth = Buffer.from(`${keyId}:`).toString("base64");
  let response: Response;
  try {
    response = await fetchImplementation("https://api.razorpay.com/v1/methods", {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Unable to reach the Razorpay Methods API");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Razorpay Methods API request failed with ${response.status}`);
  }
  return payload;
}

export function databaseFingerprint(databaseIdentity: string) {
  return crypto
    .createHash("sha256")
    .update(`lab-lords-billing-database:v1:${databaseIdentity}`)
    .digest("hex");
}

function idFingerprint(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function providerErrorCategory(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/401|credential|api key|unauthor/i.test(message)) return "authentication";
  if (/404|not found/i.test(message)) return "not_found";
  if (/429|rate limit/i.test(message)) return "rate_limited";
  if (/timeout|network|fetch failed|ECONN/i.test(message)) return "network";
  return "provider_error";
}

function redactedError(error: unknown) {
  let message = error instanceof Error ? error.message : "Preflight failed";
  for (const name of [
    "DATABASE_URL",
    "ACCELERATE_URL",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "CRON_SECRET",
    "CLERK_SECRET_KEY",
  ]) {
    const secret = process.env[name];
    if (secret && secret.length >= 4) message = message.replaceAll(secret, `[${name} redacted]`);
  }
  return message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[credentials-redacted]@");
}

async function runPreflight(arguments_: PreflightArguments) {
  // Load into an isolated object first. Ambient DATABASE_URL/ACCELERATE_URL or
  // Razorpay credentials must never influence the requested audit target.
  const targetEnvironment = loadPreflightEnvironment(arguments_.envFile);
  installPreflightEnvironment(targetEnvironment);

  const failures = validatePreflightEnvironment(arguments_.target, process.env, arguments_);
  if (failures.length > 0) {
    console.log(JSON.stringify({ ok: false, target: arguments_.target, failures }, null, 2));
    process.exitCode = 1;
    return;
  }

  const expectedProviderMode = expectedMode(arguments_.target);
  const [{ prisma }, razorpayModule] = await Promise.all([
    import("../lib/prisma"),
    import("../lib/razorpay"),
  ]);

  try {
    const [
      databaseRows,
      plans,
      subscriptions,
      offers,
      provisionings,
      operations,
      invoices,
      webhookReceipts,
    ] = await Promise.all([
      prisma.$queryRaw<Array<{ identity: string }>>`
        SELECT "identity"::TEXT AS "identity"
        FROM "BillingDatabaseIdentity"
        WHERE "id" = 1
      `,
      prisma.$queryRaw<PlanRow[]>`
        SELECT "plan", "amountSubunits", "currency", "period", "interval",
               "razorpayPlanId", "active", "providerMode"
        FROM "SaasRazorpayPlan"
      `,
      prisma.$queryRaw<SubscriptionRow[]>`
        SELECT "providerMode", "status", "quantity", "razorpayPlanId", "razorpaySubscriptionId"
        FROM "OrganizationSubscription"
      `,
      prisma.$queryRaw<OfferRow[]>`
        SELECT "providerMode", "active"
        FROM "BillingOffer"
      `,
      prisma.$queryRaw<ProvisioningRow[]>`
        SELECT "providerMode", "status"
        FROM "RazorpayPlanProvisioning"
      `,
      prisma.$queryRaw<OperationRow[]>`
        SELECT "operationStatus", "status", "toPlan"::TEXT, "toQuantity"
        FROM "OrganizationBillingChange"
      `,
      prisma.$queryRaw<InvoiceRow[]>`
        SELECT "status"
        FROM "OrganizationSubscriptionInvoice"
      `,
      prisma.$queryRaw<WebhookReceiptRow[]>`
        SELECT "processedAt", "processingError"
        FROM "RazorpayWebhookEvent"
      `,
    ]);

    if (databaseRows.length !== 1 || !databaseRows[0]?.identity) {
      throw new Error("Unable to resolve the database-resident billing identity");
    }
    const fingerprint = databaseFingerprint(databaseRows[0].identity);

    const wrongModePlans = plans.filter(row => row.providerMode !== expectedProviderMode);
    const wrongModeSubscriptions = subscriptions.filter(row => row.providerMode !== expectedProviderMode);
    const wrongModeOffers = offers.filter(row => row.providerMode !== expectedProviderMode);
    const wrongModeProvisionings = provisionings.filter(row => row.providerMode !== expectedProviderMode);
    if (wrongModePlans.length > 0) failures.push("Plan catalog contains rows from another provider mode");
    if (wrongModeSubscriptions.length > 0) failures.push("Subscriptions contain rows from another provider mode");
    if (wrongModeOffers.length > 0) failures.push("Offers contain rows from another provider mode");
    if (wrongModeProvisionings.length > 0) {
      failures.push("Plan provisioning records contain rows from another provider mode");
    }

    if (arguments_.mustDifferFrom && fingerprint === arguments_.mustDifferFrom.toLowerCase()) {
      failures.push("Database fingerprint matches the environment that must remain isolated");
    }
    if (
      arguments_.expectEmptyProviderCatalog &&
      (
        plans.length > 0 || subscriptions.length > 0 || offers.length > 0
        || provisionings.length > 0 || invoices.length > 0 || webhookReceipts.length > 0
      )
    ) {
      failures.push("Provider catalog and receipts are not empty before the first Production authorization");
    }
    if (arguments_.expectPlanId) {
      const expectedPlan = plans.find(row => row.razorpayPlanId === arguments_.expectPlanId);
      if (!expectedPlan || !expectedPlan.active || expectedPlan.providerMode !== expectedProviderMode) {
        failures.push("The expected provider plan is not an active mapping in this environment");
      }
    }
    if (arguments_.forbidPlanId && plans.some(row => row.razorpayPlanId === arguments_.forbidPlanId)) {
      failures.push("The forbidden provider plan is stored in this environment");
    }

    const razorpay = razorpayModule.getRazorpayClient();
    const planCatalogClient = razorpayModule.getRazorpayPlanCatalogClient();
    const requireMultiMethodSubscriptions =
      arguments_.expectedMultiMethodSubscriptions === "enabled";
    const maximumConfiguredChargeSubunitsByCurrency = plans.reduce<Record<string, number>>(
      (maximums, plan) => {
        const currency = plan.currency.toUpperCase();
        maximums[currency] = Math.max(maximums[currency] ?? 0, plan.amountSubunits);
        return maximums;
      },
      {}
    );
    const plansById = new Map(plans.map(plan => [plan.razorpayPlanId, plan]));
    for (const subscription of subscriptions) {
      const plan = plansById.get(subscription.razorpayPlanId);
      if (!plan) continue;
      const currency = plan.currency.toUpperCase();
      maximumConfiguredChargeSubunitsByCurrency[currency] = Math.max(
        maximumConfiguredChargeSubunitsByCurrency[currency] ?? 0,
        plan.amountSubunits * subscription.quantity
      );
    }
    for (const operation of operations) {
      if (
        !["QUEUED", "PROCESSING", "AWAITING_PAYMENT"].includes(operation.status)
        || !operation.toPlan
        || !operation.toQuantity
      ) continue;
      const targetPlan = plans.find(plan =>
        plan.active
        && plan.providerMode === expectedProviderMode
        && plan.plan === operation.toPlan
      );
      if (!targetPlan) continue;
      const currency = targetPlan.currency.toUpperCase();
      maximumConfiguredChargeSubunitsByCurrency[currency] = Math.max(
        maximumConfiguredChargeSubunitsByCurrency[currency] ?? 0,
        targetPlan.amountSubunits * operation.toQuantity
      );
    }
    const providerVerification = {
      providerPlanCatalogCount: null as number | null,
      plans: { checked: 0, matched: 0, failures: {} as Record<string, number> },
      subscriptions: { checked: 0, matched: 0, drifted: 0, failures: {} as Record<string, number> },
      forbiddenPlanInaccessible: null as boolean | null,
      recurringMethods: {
        checked: false,
        summary: null as RecurringMethodsSummary | null,
        dashboardConfirmations: arguments_.confirmations,
        requiredWebhookEvents: REQUIRED_MULTI_METHOD_WEBHOOK_EVENTS,
        maximumConfiguredChargeSubunitsByCurrency,
        amountEligibilitySource:
          "Razorpay Checkout and the issuing bank remain authoritative for method/amount eligibility",
      },
    };

    try {
      const methodsResponse = await fetchRazorpayMethods(process.env.RAZORPAY_KEY_ID!);
      const recurringMethods = summarizeRecurringMethods(methodsResponse);
      providerVerification.recurringMethods.checked = true;
      providerVerification.recurringMethods.summary = recurringMethods;
      failures.push(...validateRecurringMethods(recurringMethods, requireMultiMethodSubscriptions));
    } catch (error) {
      failures.push(`The Razorpay Methods API could not be inspected (${providerErrorCategory(error)})`);
    }

    try {
      let skip = 0;
      let providerPlanCount = 0;
      for (;;) {
        const page = await planCatalogClient.listPlans({ count: 100, skip });
        providerPlanCount += page.items.length;
        if (page.items.length < 100) break;
        skip += page.items.length;
        if (skip >= 10_000) throw new Error("Provider plan catalog exceeds the preflight safety limit");
      }
      providerVerification.providerPlanCatalogCount = providerPlanCount;
      if (arguments_.expectEmptyProviderCatalog && providerPlanCount > 0) {
        failures.push("The Razorpay account plan catalog is not empty before first Production authorization");
      }
    } catch (error) {
      const category = providerErrorCategory(error);
      failures.push(`The Razorpay plan catalog could not be listed (${category})`);
    }

    if (arguments_.forbidPlanId) {
      try {
        await planCatalogClient.fetchPlan(arguments_.forbidPlanId);
        providerVerification.forbiddenPlanInaccessible = false;
        failures.push("The forbidden plan is accessible with this environment's Razorpay credentials");
      } catch (error) {
        const inaccessible =
          razorpayModule.isRazorpayNotFoundError(error) ||
          (error instanceof razorpayModule.RazorpayApiError &&
            error.kind === "REQUEST" &&
            error.status === 400);
        if (inaccessible) {
          providerVerification.forbiddenPlanInaccessible = true;
        } else {
          providerVerification.forbiddenPlanInaccessible = false;
          failures.push(
            `The forbidden plan's provider isolation could not be proven (${providerErrorCategory(error)})`
          );
        }
      }
    }

    const activeExpectedPlans = plans.filter(
      row => row.active && row.providerMode === expectedProviderMode
    );
    for (const localPlan of activeExpectedPlans) {
      providerVerification.plans.checked += 1;
      try {
        const providerPlan = await planCatalogClient.fetchPlan(localPlan.razorpayPlanId);
        const matches =
          providerPlan.id === localPlan.razorpayPlanId &&
          providerPlan.interval === localPlan.interval &&
          providerPlan.period === localPlan.period &&
          providerPlan.item?.amount === localPlan.amountSubunits &&
          providerPlan.item?.currency?.toUpperCase() === localPlan.currency.toUpperCase();
        if (matches) providerVerification.plans.matched += 1;
        else failures.push("A provider plan does not match its local catalog snapshot");
      } catch (error) {
        const category = providerErrorCategory(error);
        providerVerification.plans.failures[category] =
          (providerVerification.plans.failures[category] ?? 0) + 1;
        failures.push("A mapped plan could not be fetched with the configured provider credentials");
      }
    }

    for (const localSubscription of subscriptions.filter(
      row => row.providerMode === expectedProviderMode
    )) {
      providerVerification.subscriptions.checked += 1;
      try {
        const providerSubscription = await razorpay.fetchSubscription(
          localSubscription.razorpaySubscriptionId
        );
        const matches =
          providerSubscription.id === localSubscription.razorpaySubscriptionId &&
          providerSubscription.plan_id === localSubscription.razorpayPlanId &&
          (providerSubscription.quantity ?? 1) === localSubscription.quantity;
        if (matches) providerVerification.subscriptions.matched += 1;
        else {
          providerVerification.subscriptions.drifted += 1;
          failures.push("A provider subscription differs from its local plan or quantity snapshot");
        }
      } catch (error) {
        const category = providerErrorCategory(error);
        providerVerification.subscriptions.failures[category] =
          (providerVerification.subscriptions.failures[category] ?? 0) + 1;
        failures.push("A subscription could not be fetched with the configured provider credentials");
      }
    }

    const activeOperations = operations.filter(row => ACTIVE_OPERATION_STATUSES.has(row.operationStatus));
    const unresolvedOperations = operations.filter(row =>
      ["QUEUED", "PROCESSING", "AWAITING_PAYMENT"].includes(row.status)
    );
    if (arguments_.target === "production" && (activeOperations.length > 0 || unresolvedOperations.length > 0)) {
      failures.push("Production contains unresolved billing operations");
    }
    const output = {
      ok: failures.length === 0,
      target: arguments_.target,
      providerMode: expectedProviderMode,
      databaseFingerprint: fingerprint,
      switches: {
        billingWrites: process.env.RAZORPAY_BILLING_WRITES_ENABLED,
        multiMethodSubscriptions: featureFlagValue(
          process.env,
          "RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED"
        ),
        workspaceBillingV2: process.env.WORKSPACE_BRANCH_BILLING_V2_ENABLED,
        liveCanary: {
          count: configuredCanaryOrganizations(process.env).length,
          idFingerprints: configuredCanaryOrganizations(process.env).map(idFingerprint),
        },
      },
      catalog: {
        plans: {
          total: plans.length,
          byMode: countBy(plans, row => row.providerMode),
          activeByMode: countBy(plans.filter(row => row.active), row => row.providerMode),
          activeIdFingerprints: activeExpectedPlans.map(row => ({
            plan: row.plan,
            fingerprint: idFingerprint(row.razorpayPlanId),
          })),
        },
        subscriptions: {
          total: subscriptions.length,
          byMode: countBy(subscriptions, row => row.providerMode),
          byStatus: countBy(subscriptions, row => row.status),
        },
        offers: {
          total: offers.length,
          byMode: countBy(offers, row => row.providerMode),
          activeByMode: countBy(offers.filter(row => row.active), row => row.providerMode),
        },
        provisioning: {
          total: provisionings.length,
          byMode: countBy(provisionings, row => row.providerMode),
          byStatus: countBy(provisionings, row => row.status),
        },
      },
      operations: {
        active: activeOperations.length,
        unresolved: unresolvedOperations.length,
        activeByStatus: countBy(activeOperations, row => row.operationStatus),
        internalByStatus: countBy(operations, row => row.status),
      },
      receipts: {
        invoices: { total: invoices.length, byStatus: countBy(invoices, row => row.status) },
        webhooks: {
          total: webhookReceipts.length,
          unprocessed: webhookReceipts.filter(row => !row.processedAt).length,
          withErrors: webhookReceipts.filter(row => Boolean(row.processingError)).length,
        },
      },
      providerVerification,
      assertions: {
        environmentAndKeyModeMatch: true,
        containsNoCrossModeRows:
          wrongModePlans.length === 0 &&
          wrongModeSubscriptions.length === 0 &&
          wrongModeOffers.length === 0 &&
          wrongModeProvisionings.length === 0,
        databaseIsIsolated: arguments_.mustDifferFrom
          ? fingerprint !== arguments_.mustDifferFrom.toLowerCase()
          : null,
        providerCatalogIsEmpty: arguments_.expectEmptyProviderCatalog
          ? plans.length === 0 &&
            subscriptions.length === 0 &&
            offers.length === 0 &&
            provisionings.length === 0 &&
            invoices.length === 0 &&
            webhookReceipts.length === 0 &&
            providerVerification.providerPlanCatalogCount === 0
          : null,
        expectedPlanIsStored: arguments_.expectPlanId
          ? plans.some(
              row =>
                row.razorpayPlanId === arguments_.expectPlanId &&
                row.active &&
                row.providerMode === expectedProviderMode
            )
          : null,
        forbiddenPlanIsAbsent: arguments_.forbidPlanId
          ? !plans.some(row => row.razorpayPlanId === arguments_.forbidPlanId)
          : null,
        forbiddenPlanIsProviderInaccessible: arguments_.forbidPlanId
          ? providerVerification.forbiddenPlanInaccessible
          : null,
        recurringMethodsMatchRolloutExpectation:
          providerVerification.recurringMethods.summary === null
            ? false
            : validateRecurringMethods(
                providerVerification.recurringMethods.summary,
                requireMultiMethodSubscriptions
              ).length === 0,
        dashboardReadinessConfirmed: requireMultiMethodSubscriptions
          ? Object.values(arguments_.confirmations).every(Boolean)
          : null,
      },
      failures: [...new Set(failures)],
      note: "Read-only audit complete. No database or Razorpay mutation was attempted.",
    };

    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

function printUsage() {
  console.log(`Razorpay environment preflight (read-only)

Usage:
  pnpm exec tsx scripts/razorpay-preflight.ts --target=preview [options]
  pnpm exec tsx scripts/razorpay-preflight.ts --target=production [options]

Options:
  --env-file=PATH                         Load a specific local environment file
  --must-differ-from=SHA256               Assert database isolation
  --expect-empty-provider-catalog         Assert local provider rows and Razorpay plans are empty
  --expect-plan-id=plan_...               Assert a provider plan is stored and fetchable
  --forbid-plan-id=plan_...               Assert a provider plan is not stored here
  --expect-billing-writes=enabled|disabled
  --expect-v2=enabled|disabled
  --expect-multi-method-subscriptions=enabled|disabled
  --expect-canary-org-id=ORG_ID            Explicitly allow one Production canary
  --confirm-subscription-settings          Attest Card, UPI and eMandate are enabled for Subscriptions
  --confirm-upi-intent                     Attest Standard Checkout UPI Intent was tested
  --confirm-upi-qr                         Attest desktop UPI QR was tested
  --confirm-webhook-events                 Attest every reported required webhook event is configured
  --confirm-amount-eligibility             Attest configured plan/quantity amounts were tested in Checkout

The confirmation flags are required when multi-method subscriptions are expected.
This command has no mutation or cleanup mode.`);
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    printUsage();
  } else {
    try {
      await runPreflight(parsePreflightArguments(argv));
    } catch (error) {
      console.error(`Razorpay preflight failed: ${redactedError(error)}`);
      process.exitCode = 1;
    }
  }
}
