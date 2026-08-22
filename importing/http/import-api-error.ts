import { ImportParserError, ImportValidationError } from "@/importing/utils/import-errors";
import { ImportRequestError } from "@/importing/http/import-request";
import {
  ImportMutationLimitConfigurationError,
  ImportV2DisabledError,
} from "@/lib/importFeature";

export type ImportApiErrorPayload = {
  status: number;
  body: {
    error: string;
    code?: string;
  };
};

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function toImportApiError(
  error: unknown,
  fallback = "Import request failed.",
): ImportApiErrorPayload {
  if (error instanceof ImportRequestError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    };
  }
  if (error instanceof ImportParserError || error instanceof ImportValidationError) {
    return {
      status: error.message.includes("4 MiB") ? 413 : 400,
      body: { error: error.message, code: "INVALID_IMPORT_SOURCE" },
    };
  }
  if (error instanceof ImportV2DisabledError) {
    return { status: 503, body: { error: error.message, code: error.code } };
  }
  if (error instanceof ImportMutationLimitConfigurationError) {
    return {
      status: 503,
      body: {
        error: "Import execution is not configured for this environment.",
        code: error.code,
      },
    };
  }

  const code = errorCode(error);
  if (code === "IMPORT_REVISION_CONFLICT" || code === "IMPORT_IDEMPOTENCY_CONFLICT") {
    return {
      status: 409,
      body: {
        error: code === "IMPORT_REVISION_CONFLICT"
          ? "This import changed in another tab. Refresh before saving again."
          : "This idempotency key was already used for a different import request.",
        code,
      },
    };
  }

  const message = error instanceof Error ? error.message : "";
  if (/not found|unauthori[sz]ed|does not belong|is archived/i.test(message)) {
    return {
      status: 404,
      body: { error: "Import resource not found.", code: "IMPORT_NOT_FOUND" },
    };
  }
  if (/permission|read-only|writable|entitlement|subscription/i.test(message)) {
    return {
      status: 403,
      body: { error: "This import action is not available for the current branch.", code: "IMPORT_FORBIDDEN" },
    };
  }

  return { status: 400, body: { error: fallback, ...(code ? { code } : {}) } };
}
