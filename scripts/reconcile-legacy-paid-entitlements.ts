import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeBoundBillingOperation,
  installIsolatedBillingEnvironment,
  loadIsolatedBillingEnvironment,
  parseBillingOperationTargetArguments,
  sanitizeBillingOperationError,
  type BillingEnvironment,
} from "./billing-operation-target";

const OPERATION_SCOPE = "organizations";
const SHA256 = /^[a-f0-9]{64}$/i;

export function legacyPaidEntitlementProposalConfirmation(
  argv: readonly string[],
  apply: boolean
) {
  const values = argv
    .filter(argument => argument.startsWith("--confirm-batch-proposal-hash="))
    .map(argument => argument.slice("--confirm-batch-proposal-hash=".length).trim());
  if (values.length > 1) {
    throw new Error("--confirm-batch-proposal-hash may be provided only once");
  }
  const value = values[0]?.toLowerCase() ?? null;
  if (value && !SHA256.test(value)) {
    throw new Error("--confirm-batch-proposal-hash must be a complete SHA-256 hash");
  }
  if (apply && !value) {
    throw new Error("--apply requires --confirm-batch-proposal-hash from a fresh dry run");
  }
  if (!apply && value) {
    throw new Error("--confirm-batch-proposal-hash is accepted only with --apply");
  }
  return value;
}

export async function runLegacyPaidEntitlementReconciliation(
  argv: string[],
  invocation: BillingEnvironment = process.env
) {
  const arguments_ = parseBillingOperationTargetArguments(argv, {
    expectedScope: OPERATION_SCOPE,
    additionalArgumentPrefixes: ["--confirm-batch-proposal-hash="],
    invocation,
  });
  if (!arguments_.expectedRazorpayMode) {
    throw new Error("--expect-razorpay-mode is required for dry-run and apply modes");
  }
  if (arguments_.scope !== OPERATION_SCOPE || arguments_.organizationIds.length === 0) {
    throw new Error(
      `--scope=${OPERATION_SCOPE} and an explicit --organization-ids allowlist are required`
    );
  }
  const confirmedBatchProposalHash = legacyPaidEntitlementProposalConfirmation(
    argv,
    arguments_.apply
  );
  const isolatedEnvironment = loadIsolatedBillingEnvironment(arguments_.envFile, invocation);
  installIsolatedBillingEnvironment(isolatedEnvironment);

  const [{ prisma }, { LegacyPaidEntitlementTransitionService }] = await Promise.all([
    import("../lib/prisma"),
    import("../services/legacyPaidEntitlementTransition.service"),
  ]);

  async function readDatabaseIdentity() {
    const rows = await prisma.$queryRaw<Array<{ identity: string }>>`
      SELECT "identity"::TEXT AS "identity"
      FROM "BillingDatabaseIdentity"
      WHERE "id" = 1
    `;
    if (rows.length !== 1 || !rows[0]?.identity) {
      throw new Error("Unable to resolve the database-resident billing identity");
    }
    return rows[0].identity;
  }

  try {
    const { targetBinding, result } = await executeBoundBillingOperation({
      arguments: arguments_,
      environment: isolatedEnvironment,
      expectedScope: OPERATION_SCOPE,
      readDatabaseIdentity,
      execute: () => LegacyPaidEntitlementTransitionService.run({
        organizationIds: arguments_.organizationIds,
        providerMode: arguments_.expectedRazorpayMode!,
        apply: arguments_.apply,
        confirmedBatchProposalHash,
      }),
    });
    return {
      targetBinding,
      ...result,
      note: arguments_.apply
        ? "Only exact provider-confirmed settlement proposals were applied; no Razorpay mutation was sent."
        : "Read-only inspection completed. No database or Razorpay state was changed.",
    };
  } finally {
    await prisma.$disconnect();
  }
}

function printUsage() {
  console.log(`Legacy paid-entitlement evidence reconciliation

Dry run (provider reads only; organization scope and mode are mandatory):
  pnpm exec tsx scripts/reconcile-legacy-paid-entitlements.ts --expect-razorpay-mode=TEST|LIVE --scope=${OPERATION_SCOPE} --organization-ids=ORG_IDS [--target=preview|production]

Apply (all exact target bindings plus the fresh dry-run proposal hash are mandatory):
  pnpm exec tsx scripts/reconcile-legacy-paid-entitlements.ts --apply --target=preview|production --expect-razorpay-mode=TEST|LIVE --expect-database-fingerprint=SHA256 --scope=${OPERATION_SCOPE} --organization-ids=ORG_IDS --confirm-batch-proposal-hash=SHA256

Set BILLING_ENV_FILE or pass --env-file to select the isolated environment file.
The command never mutates Razorpay. Ambiguous or malformed evidence is quarantined for manual review.`);
}

const isMainModule =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    printUsage();
  } else {
    try {
      console.log(JSON.stringify(await runLegacyPaidEntitlementReconciliation(argv), null, 2));
    } catch (error) {
      console.error(
        `Legacy paid-entitlement reconciliation failed: ${sanitizeBillingOperationError(error)}`
      );
      process.exitCode = 1;
    }
  }
}
