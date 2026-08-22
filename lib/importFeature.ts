export const IMPORT_V2_FLAG = "IMPORT_V2_ENABLED" as const;
export const IMPORT_MAX_PLANNED_MUTATIONS_ENV = "IMPORT_MAX_PLANNED_MUTATIONS" as const;

export class ImportV2DisabledError extends Error {
  readonly code = "IMPORT_V2_DISABLED";

  constructor() {
    super("New imports are temporarily unavailable");
    this.name = "ImportV2DisabledError";
  }
}

export class ImportMutationLimitConfigurationError extends Error {
  readonly code = "IMPORT_MUTATION_LIMIT_NOT_CONFIGURED";

  constructor() {
    super("The import mutation safety limit is not configured");
    this.name = "ImportMutationLimitConfigurationError";
  }
}

export function isImportV2Enabled() {
  return process.env[IMPORT_V2_FLAG]?.trim().toLowerCase() === "true";
}

export function assertImportV2Enabled() {
  if (!isImportV2Enabled()) {
    throw new ImportV2DisabledError();
  }
}

export function getImportMaxPlannedMutations() {
  const configured = process.env[IMPORT_MAX_PLANNED_MUTATIONS_ENV]?.trim();
  if (!configured || !/^\d+$/.test(configured)) {
    throw new ImportMutationLimitConfigurationError();
  }

  const limit = Number(configured);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new ImportMutationLimitConfigurationError();
  }

  return limit;
}
