import { describe, expect, it } from "vitest";
import {
  assertDecodedImportFormDataSize,
  assertDecodedImportRequestSize,
  assertExactlyOneImportSource,
  assertImportContentLength,
  ImportRequestError,
  MAX_IMPORT_REQUEST_BYTES,
  readImportFormData,
  readImportJson,
} from "@/importing/http/import-request";

describe("import request boundaries", () => {
  it("rejects an oversized declared request before body parsing", () => {
    const request = new Request("http://test.local/import", {
      headers: { "content-length": String(MAX_IMPORT_REQUEST_BYTES + 1) },
    });
    expect(() => assertImportContentLength(request)).toThrow(ImportRequestError);
  });

  it("rechecks decoded JSON bytes", async () => {
    const body = JSON.stringify({ pastedTable: "x".repeat(MAX_IMPORT_REQUEST_BYTES) });
    const request = new Request("http://test.local/import", { method: "POST", body });
    await expect(readImportJson(request)).rejects.toMatchObject({
      code: "IMPORT_REQUEST_TOO_LARGE",
      status: 413,
    });
  });

  it("requires file and paste sources to be mutually exclusive", () => {
    expect(() => assertExactlyOneImportSource({ hasFile: true, hasPaste: true }))
      .toThrow("Choose exactly one import source");
    expect(() => assertExactlyOneImportSource({ hasFile: false, hasPaste: false }))
      .toThrow("Choose exactly one import source");
    expect(() => assertExactlyOneImportSource({ hasFile: true, hasPaste: false }))
      .not.toThrow();
  });

  it("bounds decoded multipart fields as well as the file", () => {
    expect(() => assertDecodedImportRequestSize({
      fileBytes: MAX_IMPORT_REQUEST_BYTES,
      fields: ["extra"],
    })).toThrow(ImportRequestError);
  });

  it("counts unknown string and file entries in the decoded multipart budget", () => {
    const unknownString = new FormData();
    unknownString.set("unrecognized", "x".repeat(MAX_IMPORT_REQUEST_BYTES));
    expect(() => assertDecodedImportFormDataSize(unknownString)).toThrow(ImportRequestError);

    const unknownFile = new FormData();
    unknownFile.set("unrecognizedFile", new File([
      new Uint8Array(MAX_IMPORT_REQUEST_BYTES),
    ], "payload.bin", { type: "application/octet-stream" }));
    expect(() => assertDecodedImportFormDataSize(unknownFile)).toThrow(ImportRequestError);
  });

  it("bounds the raw multipart envelope even when decoded entries fit", async () => {
    const form = new FormData();
    form.set("x", "a".repeat(MAX_IMPORT_REQUEST_BYTES - 2));
    expect(() => assertDecodedImportFormDataSize(form)).not.toThrow();

    const request = new Request("http://test.local/import", {
      method: "POST",
      headers: { "content-length": "1" },
      body: form,
    });
    await expect(readImportFormData(request)).rejects.toMatchObject({
      code: "IMPORT_REQUEST_TOO_LARGE",
      status: 413,
    });
  });
});
