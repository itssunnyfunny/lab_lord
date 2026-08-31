import crypto from "node:crypto";
import { config as loadEnv } from "dotenv";

export type BillingDeploymentTarget = "preview" | "production";
export type BillingRazorpayMode = "TEST" | "LIVE";
export type BillingEnvironment = Record<string, string | undefined>;

export type BillingOperationTargetArguments = {
  apply: boolean;
  envFile: string;
  target?: BillingDeploymentTarget;
  expectedRazorpayMode?: BillingRazorpayMode;
  expectedDatabaseFingerprint?: string;
  scope?: string;
  organizationIds: string[];
};

export type PrismaConnectionDescription = {
  source: "ACCELERATE_URL" | "DATABASE_URL_AS_ACCELERATE" | "DATABASE_URL" | "UNCONFIGURED";
  accelerate: boolean;
};

export const BILLING_OPERATION_ENVIRONMENT_VARIABLES = [
  "DATABASE_URL",
  "ACCELERATE_URL",
  "RAZORPAY_MODE",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_WEBHOOK_OLD_SECRETS",
  "RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES",
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

const CONFLICT_SENSITIVE_VARIABLES = [
  "DATABASE_URL",
  "ACCELERATE_URL",
  "RAZORPAY_MODE",
  "RAZORPAY_KEY_ID",
] as const;

const SENSITIVE_VARIABLES = [
  "DATABASE_URL",
  "ACCELERATE_URL",
  "RAZORPAY_KEY_ID",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "RAZORPAY_TEST_KEY_ID",
  "TEST_API_KEY",
  "Test_API_Key",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_TEST_KEY_SECRET",
  "TEST_KEY_SECRET",
  "Test_Key_Secret",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_TEST_WEBHOOK_SECRET",
  "TEST_WEBHOOK_SECRET",
  "Test_Webhook_Secret",
  "RAZORPAY_WEBHOOK_OLD_SECRETS",
  "CRON_SECRET",
  "CLERK_SECRET_KEY",
] as const;

const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/i;

function argumentValues(argv: string[], name: string) {
  return argv
    .filter(argument => argument.startsWith(`${name}=`))
    .map(argument => argument.slice(name.length + 1).trim());
}

function optionalArgument(argv: string[], name: string) {
  const values = argumentValues(argv, name);
  if (values.length > 1) throw new Error(`${name} may be provided only once`);
  if (values[0] === "") throw new Error(`${name} requires a value`);
  return values[0];
}

export function parseBillingOperationTargetArguments(
  argv: string[],
  options: {
    expectedScope: string;
    additionalArgumentPrefixes?: string[];
    invocation?: BillingEnvironment;
  }
): BillingOperationTargetArguments {
  const invocation = options.invocation ?? process.env;
  const knownPrefixes = [
    "--env-file=",
    "--target=",
    "--expect-razorpay-mode=",
    "--expect-database-fingerprint=",
    "--scope=",
    "--organization-ids=",
    ...(options.additionalArgumentPrefixes ?? []),
  ];
  const unknown = argv.find(argument =>
    argument !== "--apply" &&
    argument !== "--help" &&
    !knownPrefixes.some(prefix => argument.startsWith(prefix))
  );
  if (unknown) throw new Error("Unknown billing operation argument");
  if (argv.filter(argument => argument === "--apply").length > 1) {
    throw new Error("--apply may be provided only once");
  }

  const targetValue = optionalArgument(argv, "--target");
  if (targetValue !== undefined && targetValue !== "preview" && targetValue !== "production") {
    throw new Error("--target must be preview or production");
  }
  const modeValue = optionalArgument(argv, "--expect-razorpay-mode")?.toUpperCase();
  if (modeValue !== undefined && modeValue !== "TEST" && modeValue !== "LIVE") {
    throw new Error("--expect-razorpay-mode must be TEST or LIVE");
  }
  const expectedDatabaseFingerprint = optionalArgument(
    argv,
    "--expect-database-fingerprint"
  );
  if (expectedDatabaseFingerprint && !SHA256_FINGERPRINT.test(expectedDatabaseFingerprint)) {
    throw new Error("--expect-database-fingerprint must be a complete SHA-256 fingerprint");
  }
  const scope = optionalArgument(argv, "--scope");
  if (scope !== undefined && scope !== options.expectedScope) {
    throw new Error(`--scope must be ${options.expectedScope}`);
  }
  const organizationIdValue = optionalArgument(argv, "--organization-ids");
  const organizationIds = organizationIdValue
    ? organizationIdValue.split(",").map(value => value.trim()).filter(Boolean)
    : [];
  if (organizationIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new Error("--organization-ids must contain valid comma-separated organization IDs");
  }
  if (new Set(organizationIds).size !== organizationIds.length) {
    throw new Error("--organization-ids must not contain duplicates");
  }
  if ((scope !== undefined) !== (organizationIds.length > 0)) {
    throw new Error("--scope and --organization-ids must be provided together");
  }

  const apply = argv.includes("--apply");
  if (apply) {
    const missing = [
      ["--target", targetValue],
      ["--expect-razorpay-mode", modeValue],
      ["--expect-database-fingerprint", expectedDatabaseFingerprint],
      ["--scope", scope],
      ["--organization-ids", organizationIds.length > 0 ? "provided" : undefined],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`--apply requires ${missing.join(", ")}`);
    }
  }

  const configuredEnvFile = optionalArgument(argv, "--env-file") ?? invocation.BILLING_ENV_FILE?.trim();
  return {
    apply,
    envFile: configuredEnvFile || ".env",
    target: targetValue as BillingDeploymentTarget | undefined,
    expectedRazorpayMode: modeValue as BillingRazorpayMode | undefined,
    expectedDatabaseFingerprint: expectedDatabaseFingerprint?.toLowerCase(),
    scope,
    organizationIds: [...organizationIds].sort(),
  };
}

function normalizedConflictValue(name: typeof CONFLICT_SENSITIVE_VARIABLES[number], value: string) {
  return name === "RAZORPAY_MODE" ? value.trim().toUpperCase() : value.trim();
}

export function buildIsolatedBillingEnvironment(
  loaded: BillingEnvironment,
  invocation: BillingEnvironment
): BillingEnvironment {
  const isolated: BillingEnvironment = {};
  for (const name of BILLING_OPERATION_ENVIRONMENT_VARIABLES) {
    if (loaded[name] !== undefined) isolated[name] = loaded[name];
  }

  const conflicts = CONFLICT_SENSITIVE_VARIABLES.filter(name => {
    const ambientValue = invocation[name]?.trim();
    if (!ambientValue) return false;
    const loadedValue = loaded[name]?.trim();
    return !loadedValue ||
      normalizedConflictValue(name, ambientValue) !== normalizedConflictValue(name, loadedValue);
  });
  if (conflicts.length > 0) {
    throw new Error(
      `Ambient configuration conflicts with BILLING_ENV_FILE for: ${conflicts.join(", ")}`
    );
  }

  const ambientDeployment = invocation.VERCEL_ENV?.trim().toLowerCase();
  const loadedDeployment = loaded.VERCEL_ENV?.trim().toLowerCase();
  if (ambientDeployment && loadedDeployment && ambientDeployment !== loadedDeployment) {
    throw new Error("Ambient configuration conflicts with BILLING_ENV_FILE for: VERCEL_ENV");
  }
  if (ambientDeployment) isolated.VERCEL_ENV = ambientDeployment;

  return isolated;
}

export function loadIsolatedBillingEnvironment(
  envFile: string,
  invocation: BillingEnvironment = process.env
) {
  const loaded: Record<string, string> = {};
  const result = loadEnv({
    path: envFile,
    processEnv: loaded,
    override: true,
    quiet: true,
  });
  if (result.error) throw new Error("Unable to load the requested BILLING_ENV_FILE");
  return buildIsolatedBillingEnvironment(loaded, invocation);
}

export function installIsolatedBillingEnvironment(environment: BillingEnvironment) {
  for (const name of BILLING_OPERATION_ENVIRONMENT_VARIABLES) delete process.env[name];
  for (const name of BILLING_OPERATION_ENVIRONMENT_VARIABLES) {
    const value = environment[name];
    if (value !== undefined) process.env[name] = value;
  }
}

export function describePrismaConnection(
  environment: BillingEnvironment
): PrismaConnectionDescription {
  if (environment.ACCELERATE_URL?.trim()) {
    return { source: "ACCELERATE_URL", accelerate: true };
  }
  if (environment.DATABASE_URL?.trim().startsWith("prisma://")) {
    return { source: "DATABASE_URL_AS_ACCELERATE", accelerate: true };
  }
  if (environment.DATABASE_URL?.trim()) {
    return { source: "DATABASE_URL", accelerate: false };
  }
  return { source: "UNCONFIGURED", accelerate: false };
}

export function databaseFingerprint(databaseIdentity: string) {
  return crypto
    .createHash("sha256")
    .update(`lab-lords-billing-database:v1:${databaseIdentity}`)
    .digest("hex");
}

function expectedModeForTarget(target: BillingDeploymentTarget): BillingRazorpayMode {
  return target === "production" ? "LIVE" : "TEST";
}

function keyMatchesMode(keyId: string | undefined, mode: BillingRazorpayMode) {
  return keyId?.trim().startsWith(mode === "LIVE" ? "rzp_live_" : "rzp_test_") ?? false;
}

export async function bindBillingOperationTarget(options: {
  arguments: BillingOperationTargetArguments;
  environment: BillingEnvironment;
  expectedScope: string;
  readDatabaseIdentity: () => Promise<string>;
}) {
  const { arguments: arguments_, environment } = options;
  const deploymentEnvironment = environment.VERCEL_ENV?.trim().toLowerCase();
  const providerMode = environment.RAZORPAY_MODE?.trim().toUpperCase();
  const failures: string[] = [];

  if (arguments_.apply) {
    if (!arguments_.target) failures.push("Apply target is missing");
    if (!arguments_.expectedRazorpayMode) failures.push("Apply Razorpay mode is missing");
    if (!arguments_.expectedDatabaseFingerprint) {
      failures.push("Apply database fingerprint is missing");
    }
    if (!arguments_.scope) failures.push("Apply scope is missing");
    if (arguments_.organizationIds.length === 0) {
      failures.push("Apply organization allowlist is missing");
    }
  }

  if (deploymentEnvironment !== "preview" && deploymentEnvironment !== "production") {
    failures.push("VERCEL_ENV must be preview or production");
  }
  if (providerMode !== "TEST" && providerMode !== "LIVE") {
    failures.push("RAZORPAY_MODE must be TEST or LIVE");
  } else if (!keyMatchesMode(environment.RAZORPAY_KEY_ID, providerMode)) {
    failures.push("RAZORPAY_KEY_ID does not match RAZORPAY_MODE");
  }
  if (!environment.DATABASE_URL?.trim()) failures.push("DATABASE_URL is missing");
  if (
    (deploymentEnvironment === "preview" || deploymentEnvironment === "production") &&
    (providerMode === "TEST" || providerMode === "LIVE") &&
    expectedModeForTarget(deploymentEnvironment) !== providerMode
  ) {
    failures.push("VERCEL_ENV and RAZORPAY_MODE do not identify the same deployment target");
  }
  if (arguments_.target && deploymentEnvironment !== arguments_.target) {
    failures.push("Configured VERCEL_ENV does not match --target");
  }
  if (arguments_.expectedRazorpayMode && providerMode !== arguments_.expectedRazorpayMode) {
    failures.push("Configured RAZORPAY_MODE does not match --expect-razorpay-mode");
  }
  if (
    arguments_.target &&
    arguments_.expectedRazorpayMode &&
    expectedModeForTarget(arguments_.target) !== arguments_.expectedRazorpayMode
  ) {
    failures.push("--target and --expect-razorpay-mode conflict");
  }
  if (arguments_.scope && arguments_.scope !== options.expectedScope) {
    failures.push("Configured operation scope is not allowed for this script");
  }
  if (
    (arguments_.scope !== undefined) !== (arguments_.organizationIds.length > 0)
  ) {
    failures.push("Configured operation scope and organization allowlist are incomplete");
  }
  if (failures.length > 0) throw new Error(failures.join("; "));

  const databaseIdentity = await options.readDatabaseIdentity();
  if (!databaseIdentity) throw new Error("Unable to resolve the database-resident billing identity");
  const actualDatabaseFingerprint = databaseFingerprint(databaseIdentity);
  if (
    arguments_.expectedDatabaseFingerprint &&
    actualDatabaseFingerprint !== arguments_.expectedDatabaseFingerprint
  ) {
    throw new Error("Database fingerprint does not match --expect-database-fingerprint");
  }

  return {
    apply: arguments_.apply,
    deploymentEnvironment,
    providerMode,
    databaseFingerprint: actualDatabaseFingerprint,
    targetScope: arguments_.scope
      ? {
        type: arguments_.scope,
        organizationCount: arguments_.organizationIds.length,
        organizationSetFingerprint: crypto
          .createHash("sha256")
          .update(
            `lab-lords-billing-operation-organizations:v1:${arguments_.organizationIds.join("\n")}`
          )
          .digest("hex"),
      }
      : null,
    prismaConnection: describePrismaConnection(environment),
  };
}

export async function executeBoundBillingOperation<T>(options: {
  arguments: BillingOperationTargetArguments;
  environment: BillingEnvironment;
  expectedScope: string;
  readDatabaseIdentity: () => Promise<string>;
  execute: () => Promise<T>;
}) {
  const targetBinding = await bindBillingOperationTarget(options);
  const result = await options.execute();
  return { targetBinding, result };
}

export function sanitizeBillingOperationError(
  error: unknown,
  environment: BillingEnvironment = process.env
) {
  let message = error instanceof Error ? error.message : "Billing operation failed";
  const redactions = SENSITIVE_VARIABLES.flatMap(name => {
    const value = environment[name];
    const values = name === "RAZORPAY_WEBHOOK_OLD_SECRETS"
      ? [value, ...(value?.split(",").map(entry => entry.trim()) ?? [])]
      : [value];
    return values
      .filter((entry): entry is string => Boolean(entry?.trim()))
      .map(entry => ({ name, value: entry }));
  }).sort((left, right) => right.value.length - left.value.length);
  for (const redaction of redactions) {
    message = message.replaceAll(redaction.value, `[${redaction.name} redacted]`);
  }
  return message
    .replace(/\b(?:postgres(?:ql)?|prisma):\/\/[^\s'"<>]+/gi, "[database-url redacted]")
    .replace(/\brzp_(?:test|live)_[A-Za-z0-9_-]+\b/g, "[RAZORPAY_KEY_ID redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[credentials-redacted]@");
}
