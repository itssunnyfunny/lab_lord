import { afterEach, describe, expect, it } from "vitest";
import {
  assertImportV2Enabled,
  getImportMaxPlannedMutations,
  IMPORT_MAX_PLANNED_MUTATIONS_ENV,
  IMPORT_V2_FLAG,
  ImportMutationLimitConfigurationError,
  ImportV2DisabledError,
  isImportV2Enabled,
} from "@/lib/importFeature";

const originalEnabled = process.env[IMPORT_V2_FLAG];
const originalMutationLimit = process.env[IMPORT_MAX_PLANNED_MUTATIONS_ENV];

afterEach(() => {
  if (originalEnabled === undefined) delete process.env[IMPORT_V2_FLAG];
  else process.env[IMPORT_V2_FLAG] = originalEnabled;

  if (originalMutationLimit === undefined) {
    delete process.env[IMPORT_MAX_PLANNED_MUTATIONS_ENV];
  } else {
    process.env[IMPORT_MAX_PLANNED_MUTATIONS_ENV] = originalMutationLimit;
  }
});

describe("Import Assistance V2 rollout controls", () => {
  it("keeps new V2 imports disabled unless explicitly enabled", () => {
    delete process.env[IMPORT_V2_FLAG];
    expect(isImportV2Enabled()).toBe(false);
    expect(() => assertImportV2Enabled()).toThrow(ImportV2DisabledError);

    process.env[IMPORT_V2_FLAG] = " TRUE ";
    expect(isImportV2Enabled()).toBe(true);
    expect(() => assertImportV2Enabled()).not.toThrow();
  });

  it("accepts only a positive, benchmark-configured mutation cap", () => {
    for (const value of [undefined, "", "0", "-1", "1.5", "many"]) {
      if (value === undefined) delete process.env[IMPORT_MAX_PLANNED_MUTATIONS_ENV];
      else process.env[IMPORT_MAX_PLANNED_MUTATIONS_ENV] = value;

      expect(() => getImportMaxPlannedMutations()).toThrow(
        ImportMutationLimitConfigurationError
      );
    }

    process.env[IMPORT_MAX_PLANNED_MUTATIONS_ENV] = " 50000 ";
    expect(getImportMaxPlannedMutations()).toBe(50000);
  });
});
