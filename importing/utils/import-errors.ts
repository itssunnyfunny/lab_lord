export const PDF_PARSE_ERROR = "Could not read this PDF. Please upload Excel/CSV or paste table.";

export class ImportParserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImportParserError";
    }
}

export class ImportValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImportValidationError";
    }
}

export class ImportRevisionConflictError extends Error {
    readonly code = "IMPORT_REVISION_CONFLICT";

    constructor() {
        super("Import revision changed");
        this.name = "ImportRevisionConflictError";
    }
}

export class ImportIdempotencyConflictError extends Error {
    readonly code = "IMPORT_IDEMPOTENCY_CONFLICT";

    constructor() {
        super("Idempotency key was reused for a different import request");
        this.name = "ImportIdempotencyConflictError";
    }
}
