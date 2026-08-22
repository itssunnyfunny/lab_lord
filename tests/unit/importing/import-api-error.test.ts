import { describe, expect, it } from "vitest";
import { toImportApiError } from "@/importing/http/import-api-error";
import { ImportRequestError } from "@/importing/http/import-request";

describe("import API error policy", () => {
  it("returns a generic response for foreign and nonexistent identifiers", () => {
    expect(toImportApiError(new Error("Student does not belong to this branch"))).toEqual({
      status: 404,
      body: { error: "Import resource not found.", code: "IMPORT_NOT_FOUND" },
    });
    expect(toImportApiError(new Error("Import session not found"))).toEqual({
      status: 404,
      body: { error: "Import resource not found.", code: "IMPORT_NOT_FOUND" },
    });
    expect(toImportApiError(new Error("Import session is archived"))).toEqual({
      status: 404,
      body: { error: "Import resource not found.", code: "IMPORT_NOT_FOUND" },
    });
  });

  it("preserves typed request bounds without exposing internals", () => {
    const response = toImportApiError(new ImportRequestError("Too large", {
      code: "IMPORT_REQUEST_TOO_LARGE",
      status: 413,
    }));
    expect(response).toEqual({
      status: 413,
      body: { error: "Too large", code: "IMPORT_REQUEST_TOO_LARGE" },
    });
  });

  it("maps stale writes to a stable 409 contract", () => {
    const error = Object.assign(new Error("details must stay server-side"), {
      code: "IMPORT_REVISION_CONFLICT",
    });
    expect(toImportApiError(error)).toEqual({
      status: 409,
      body: {
        error: "This import changed in another tab. Refresh before saving again.",
        code: "IMPORT_REVISION_CONFLICT",
      },
    });
  });

  it("does not return unknown exception messages", () => {
    expect(toImportApiError(new Error("select * from secrets"), "Could not save import.")).toEqual({
      status: 400,
      body: { error: "Could not save import." },
    });
  });
});
