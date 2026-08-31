import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceRolloutOrganizationScopes } from "@/scripts/prepare-workspace-billing-rollout";

const scripts = [
  "scripts/prepare-workspace-billing-rollout.ts",
  "scripts/audit-legacy-unsupported-method-cancellations.ts",
] as const;

describe.each(scripts)("%s command boundary", script => {
  it("rejects an unbound apply before loading an environment or importing Prisma", () => {
    const missingEnvironmentFile = "__must_not_be_loaded_before_apply_validation__.env";
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      path.resolve(script),
      "--apply",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BILLING_ENV_FILE: missingEnvironmentFile,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("--apply requires");
    expect(output).toContain("--organization-ids");
    expect(output).not.toContain(missingEnvironmentFile);
    expect(output).not.toContain("Prisma");
  });
});

describe("workspace rollout organization scope", () => {
  it("builds filters for both owner eligibility and branch backfill queries", () => {
    expect(workspaceRolloutOrganizationScopes(["org_a", "org_b"])).toEqual({
      organization: { id: { in: ["org_a", "org_b"] } },
      branch: { organizationId: { in: ["org_a", "org_b"] } },
    });
  });
});
