import { describe, expect, it, vi } from "vitest";
import {
  buildIsolatedBillingEnvironment,
  databaseFingerprint,
  describePrismaConnection,
  executeBoundBillingOperation,
  parseBillingOperationTargetArguments,
  sanitizeBillingOperationError,
  type BillingEnvironment,
} from "@/scripts/billing-operation-target";

const EXPECTED_SCOPE = "organizations";
const DATABASE_IDENTITY = "018f4f4d-4f89-7db1-98d7-aad5dd3f32d1";

function productionEnvironment(): BillingEnvironment {
  return {
    VERCEL_ENV: "production",
    RAZORPAY_MODE: "LIVE",
    RAZORPAY_KEY_ID: "rzp_live_file_identity",
    DATABASE_URL: "postgresql://file-user:file-password@db.example.test:5432/lablords",
  };
}

function applyArguments(fingerprint = databaseFingerprint(DATABASE_IDENTITY)) {
  return parseBillingOperationTargetArguments([
    "--apply",
    "--target=production",
    "--expect-razorpay-mode=LIVE",
    `--expect-database-fingerprint=${fingerprint}`,
    `--scope=${EXPECTED_SCOPE}`,
    "--organization-ids=org_b,org_a",
  ], {
    expectedScope: EXPECTED_SCOPE,
    invocation: { BILLING_ENV_FILE: ".env.production.local" },
  });
}

describe("billing operation arguments", () => {
  it("remains a dry run by default", () => {
    expect(parseBillingOperationTargetArguments([], {
      expectedScope: EXPECTED_SCOPE,
      invocation: { BILLING_ENV_FILE: ".env.preview.local" },
    })).toEqual({
      apply: false,
      envFile: ".env.preview.local",
      target: undefined,
      expectedRazorpayMode: undefined,
      expectedDatabaseFingerprint: undefined,
      scope: undefined,
      organizationIds: [],
    });
  });

  it("requires every exact target binding before apply", () => {
    expect(() => parseBillingOperationTargetArguments(["--apply"], {
      expectedScope: EXPECTED_SCOPE,
      invocation: {},
    })).toThrow(
      "--apply requires --target, --expect-razorpay-mode, --expect-database-fingerprint, --scope, --organization-ids"
    );
  });

  it("rejects an implicit or wrong global scope", () => {
    expect(() => parseBillingOperationTargetArguments([
      "--apply",
      "--target=production",
      "--expect-razorpay-mode=LIVE",
      `--expect-database-fingerprint=${"a".repeat(64)}`,
      "--scope=selected",
    ], {
      expectedScope: EXPECTED_SCOPE,
      invocation: {},
    })).toThrow(`--scope must be ${EXPECTED_SCOPE}`);
  });

  it("normalizes an explicit organization allowlist and rejects incomplete scope", () => {
    expect(applyArguments()).toMatchObject({
      scope: EXPECTED_SCOPE,
      organizationIds: ["org_a", "org_b"],
    });
    expect(() => parseBillingOperationTargetArguments([
      `--scope=${EXPECTED_SCOPE}`,
    ], {
      expectedScope: EXPECTED_SCOPE,
      invocation: {},
    })).toThrow(/provided together/);
  });
});

describe("isolated billing operation environment", () => {
  it("rejects conflicting ambient database identities", () => {
    expect(() => buildIsolatedBillingEnvironment(
      productionEnvironment(),
      {
        DATABASE_URL: "postgresql://ambient-user:ambient-password@other.example.test/lablords",
        VERCEL_ENV: "production",
      }
    )).toThrow("Ambient configuration conflicts with BILLING_ENV_FILE for: DATABASE_URL");
  });

  it("rejects an ambient Accelerate endpoint when the file does not select it", () => {
    expect(() => buildIsolatedBillingEnvironment(
      productionEnvironment(),
      {
        ACCELERATE_URL: "prisma://ambient-production.example.test/",
        VERCEL_ENV: "production",
      }
    )).toThrow("Ambient configuration conflicts with BILLING_ENV_FILE for: ACCELERATE_URL");
  });

  it("rejects mode and key-identity conflicts without exposing either key", () => {
    const ambientKeyId = "rzp_test_ambient_identity";
    let error: unknown;
    try {
      buildIsolatedBillingEnvironment(productionEnvironment(), {
        RAZORPAY_MODE: "TEST",
        RAZORPAY_KEY_ID: ambientKeyId,
        VERCEL_ENV: "production",
      });
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("RAZORPAY_MODE");
    expect(message).toContain("RAZORPAY_KEY_ID");
    expect(message).not.toContain(ambientKeyId);
    expect(message).not.toContain("rzp_live_file_identity");
  });

  it("installs only allowlisted file values and accepts identical ambient identities", () => {
    const loaded: BillingEnvironment = productionEnvironment();
    loaded.UNRELATED_SECRET = "must-not-be-installed";
    const isolated = buildIsolatedBillingEnvironment(loaded, {
      DATABASE_URL: loaded.DATABASE_URL,
      RAZORPAY_MODE: "live",
      RAZORPAY_KEY_ID: loaded.RAZORPAY_KEY_ID,
      VERCEL_ENV: "production",
    });

    expect(isolated).toMatchObject(productionEnvironment());
    expect(isolated).not.toHaveProperty("UNRELATED_SECRET");
  });
});

describe("exact billing operation target binding", () => {
  it("fails a wrong provider mode before a database read or operation", async () => {
    const readDatabaseIdentity = vi.fn(async () => DATABASE_IDENTITY);
    const execute = vi.fn(async () => "mutated");

    await expect(executeBoundBillingOperation({
      arguments: applyArguments(),
      environment: {
        ...productionEnvironment(),
        RAZORPAY_MODE: "TEST",
        RAZORPAY_KEY_ID: "rzp_test_wrong_mode",
      },
      expectedScope: EXPECTED_SCOPE,
      readDatabaseIdentity,
      execute,
    })).rejects.toThrow(/same deployment target|does not match --expect-razorpay-mode/);
    expect(readDatabaseIdentity).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails a wrong database fingerprint before the operation", async () => {
    const readDatabaseIdentity = vi.fn(async () => DATABASE_IDENTITY);
    const execute = vi.fn(async () => "mutated");

    await expect(executeBoundBillingOperation({
      arguments: applyArguments("0".repeat(64)),
      environment: productionEnvironment(),
      expectedScope: EXPECTED_SCOPE,
      readDatabaseIdentity,
      execute,
    })).rejects.toThrow("Database fingerprint does not match");
    expect(readDatabaseIdentity).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes only after the deployment, mode, fingerprint, and scope all match", async () => {
    const execute = vi.fn(async () => ({ changed: 1 }));
    const result = await executeBoundBillingOperation({
      arguments: applyArguments(),
      environment: productionEnvironment(),
      expectedScope: EXPECTED_SCOPE,
      readDatabaseIdentity: async () => DATABASE_IDENTITY,
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.result).toEqual({ changed: 1 });
    expect(result.targetBinding).toMatchObject({
      apply: true,
      deploymentEnvironment: "production",
      providerMode: "LIVE",
      databaseFingerprint: databaseFingerprint(DATABASE_IDENTITY),
      targetScope: {
        type: EXPECTED_SCOPE,
        organizationCount: 2,
        organizationSetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      prismaConnection: { source: "DATABASE_URL", accelerate: false },
    });
  });
});

describe("safe operational output", () => {
  it("reports Prisma precedence by variable name only", () => {
    const environment = productionEnvironment();
    environment.ACCELERATE_URL = "prisma://accelerate.example.test/?api_key=sensitive";

    const description = describePrismaConnection(environment);
    expect(description).toEqual({ source: "ACCELERATE_URL", accelerate: true });
    expect(JSON.stringify(description)).not.toContain("accelerate.example.test");
    expect(describePrismaConnection({
      DATABASE_URL: "prisma://database-alias.example.test/?api_key=sensitive",
    })).toEqual({ source: "DATABASE_URL_AS_ACCELERATE", accelerate: true });
  });

  it("removes secrets, key identities, and complete database URLs from errors", () => {
    const environment = productionEnvironment();
    environment.TEST_KEY_SECRET = "legacy-key-secret";
    environment.RAZORPAY_WEBHOOK_OLD_SECRETS = "old-webhook-one,old-webhook-two";
    const message = sanitizeBillingOperationError(new Error(
      `Failed ${environment.DATABASE_URL} with ${environment.RAZORPAY_KEY_ID}, ${environment.TEST_KEY_SECRET}, old-webhook-one, old-webhook-two, and postgresql://host.example.test/database`
    ), environment);

    expect(message).not.toContain(environment.DATABASE_URL);
    expect(message).not.toContain(environment.RAZORPAY_KEY_ID);
    expect(message).not.toContain("postgresql://host.example.test/database");
    expect(message).not.toContain("legacy-key-secret");
    expect(message).not.toContain("old-webhook-one");
    expect(message).not.toContain("old-webhook-two");
    expect(message).toContain("redacted");
  });
});
