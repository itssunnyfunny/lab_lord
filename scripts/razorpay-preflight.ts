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
  expectedCanaryOrganizationId?: string;
};

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
    "--expect-canary-org-id=",
  ];
  const unknown = argv.find(argument =>
    argument !== "--expect-empty-provider-catalog" &&
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

  return {
    target: targetValue,
    envFile,
    mustDifferFrom,
    expectPlanId,
    forbidPlanId,
    expectEmptyProviderCatalog: argv.includes("--expect-empty-provider-catalog"),
    expectedBillingWrites,
    expectedV2,
    expectedCanaryOrganizationId,
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
    "expectedBillingWrites" | "expectedV2" | "expectedCanaryOrganizationId"
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
        SELECT "operationStatus", "status"
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
    const providerVerification = {
      providerPlanCatalogCount: null as number | null,
      plans: { checked: 0, matched: 0, failures: {} as Record<string, number> },
      subscriptions: { checked: 0, matched: 0, drifted: 0, failures: {} as Record<string, number> },
      forbiddenPlanInaccessible: null as boolean | null,
    };

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
        multiMethodSubscriptions: process.env.RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED,
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
  --expect-canary-org-id=ORG_ID            Explicitly allow one Production canary

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
