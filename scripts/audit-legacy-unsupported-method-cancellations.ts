import { config } from "dotenv";

config({ path: process.env.BILLING_ENV_FILE ?? ".env", override: false });

const { LegacyUnsupportedMethodAuditService } = await import(
  "../services/legacyUnsupportedMethodAudit.service"
);

const report = await LegacyUnsupportedMethodAuditService.run({
  apply: process.argv.includes("--apply"),
});

console.log(JSON.stringify(report, null, 2));

if (!report.apply) {
  console.log("Dry run only. Re-run with --apply after reviewing every MANUAL_REVIEW row.");
}
