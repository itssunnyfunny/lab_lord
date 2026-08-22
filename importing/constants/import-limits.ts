export const MAX_IMPORT_ROWS = 2_000;

export function importRowLimitMessage(rowCount: number) {
    return `This import has ${rowCount.toLocaleString("en-IN")} rows. The current wizard supports up to ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} rows per import.`;
}
