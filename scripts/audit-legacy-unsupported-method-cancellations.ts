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

export async function runLegacyUnsupportedMethodCancellationAudit(
  argv: string[],
  invocation: BillingEnvironment = process.env
) {
  const arguments_ = parseBillingOperationTargetArguments(argv, {
    expectedScope: OPERATION_SCOPE,
    invocation,
  });
  const isolatedEnvironment = loadIsolatedBillingEnvironment(arguments_.envFile, invocation);
  installIsolatedBillingEnvironment(isolatedEnvironment);

  const { prisma } = await import("../lib/prisma");
  try {
    const { targetBinding, result: report } = await executeBoundBillingOperation({
      arguments: arguments_,
      environment: isolatedEnvironment,
      expectedScope: OPERATION_SCOPE,
      readDatabaseIdentity: async () => {
        const rows = await prisma.$queryRaw<Array<{ identity: string }>>`
          SELECT "identity"::TEXT AS "identity"
          FROM "BillingDatabaseIdentity"
          WHERE "id" = 1
        `;
        if (rows.length !== 1 || !rows[0]?.identity) {
          throw new Error("Unable to resolve the database-resident billing identity");
        }
        return rows[0].identity;
      },
      execute: async () => {
        const { LegacyUnsupportedMethodAuditService } = await import(
          "../services/legacyUnsupportedMethodAudit.service"
        );
        return LegacyUnsupportedMethodAuditService.run({
          apply: arguments_.apply,
          organizationIds: arguments_.organizationIds.length > 0
            ? arguments_.organizationIds
            : undefined,
        });
      },
    });
    return {
      ...report,
      targetBinding,
      rows: report.rows.map(row => row.error
        ? {
          ...row,
          error: sanitizeBillingOperationError(new Error(row.error), isolatedEnvironment),
        }
        : row),
    };
  } finally {
    await prisma.$disconnect();
  }
}

function printUsage() {
  console.log(`Legacy unsupported-method cancellation audit

Dry run:
  pnpm exec tsx scripts/audit-legacy-unsupported-method-cancellations.ts [--scope=${OPERATION_SCOPE} --organization-ids=ORG_IDS]

Apply (all target-binding flags are required):
  pnpm exec tsx scripts/audit-legacy-unsupported-method-cancellations.ts --apply --target=preview|production --expect-razorpay-mode=TEST|LIVE --expect-database-fingerprint=SHA256 --scope=${OPERATION_SCOPE} --organization-ids=ORG_IDS

Set BILLING_ENV_FILE to select the isolated environment file.
Every provider fetch and write in apply mode is restricted to the explicit organization allowlist.`);
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
      const report = await runLegacyUnsupportedMethodCancellationAudit(argv);
      console.log(JSON.stringify(report, null, 2));
      if (!report.apply) {
        console.log(
          "Dry run only. Re-run with the exact target binding and --apply after reviewing every MANUAL_REVIEW row."
        );
      }
    } catch (error) {
      console.error(
        `Legacy unsupported-method cancellation audit failed: ${sanitizeBillingOperationError(error)}`
      );
      process.exitCode = 1;
    }
  }
}
