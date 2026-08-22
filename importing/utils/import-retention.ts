export const IMPORT_STAGING_RETENTION_DAYS = 30;

const IMPORT_STAGING_RETENTION_MS = IMPORT_STAGING_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Returns the explicit staging deadline used for both draft inactivity and terminal runs. */
export function importStagingPurgeAfter(now = new Date()) {
    return new Date(now.getTime() + IMPORT_STAGING_RETENTION_MS);
}
