export const MAX_IMPORT_REQUEST_BYTES = Math.floor(4.25 * 1024 * 1024);

export class ImportRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status?: number }) {
    super(message);
    this.name = "ImportRequestError";
    this.code = options.code;
    this.status = options.status ?? 400;
  }
}

function assertByteLength(byteLength: number) {
  if (byteLength > MAX_IMPORT_REQUEST_BYTES) {
    throw new ImportRequestError("Import request is larger than the 4.25 MiB request limit.", {
      code: "IMPORT_REQUEST_TOO_LARGE",
      status: 413,
    });
  }
}

async function readBoundedImportBody(request: Request) {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMPORT_REQUEST_BYTES) {
        assertByteLength(totalBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

export function assertImportContentLength(request: Request) {
  const raw = request.headers.get("content-length");
  if (!raw) return;
  if (!/^\d+$/.test(raw)) {
    throw new ImportRequestError("Import request Content-Length is invalid.", {
      code: "INVALID_CONTENT_LENGTH",
    });
  }
  assertByteLength(Number(raw));
}

export async function readImportJson<T = unknown>(request: Request): Promise<T> {
  assertImportContentLength(request);
  const text = await request.text();
  assertByteLength(Buffer.byteLength(text, "utf8"));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ImportRequestError("Import request must contain valid JSON.", {
      code: "INVALID_IMPORT_JSON",
    });
  }
}

export function parseExpectedImportRevision(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ImportRequestError("Expected import revision must be a non-negative integer.", {
      code: "INVALID_IMPORT_REVISION",
    });
  }
  return value;
}

export function assertDecodedImportRequestSize(input: {
  fileBytes?: number;
  fields?: Iterable<string>;
}) {
  let bytes = input.fileBytes ?? 0;
  for (const field of input.fields ?? []) bytes += Buffer.byteLength(field, "utf8");
  assertByteLength(bytes);
}

export function assertDecodedImportFormDataSize(form: FormData) {
  let bytes = 0;
  for (const [fieldName, value] of form.entries()) {
    bytes += Buffer.byteLength(fieldName, "utf8");
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value, "utf8");
    } else {
      bytes += value.size;
      bytes += Buffer.byteLength(value.name, "utf8");
      bytes += Buffer.byteLength(value.type, "utf8");
    }
    assertByteLength(bytes);
  }
}

export async function readImportFormData(request: Request) {
  assertImportContentLength(request);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new ImportRequestError("Import request must contain multipart form data.", {
      code: "INVALID_IMPORT_MULTIPART",
    });
  }

  const rawBody = await readBoundedImportBody(request);
  let form: FormData;
  try {
    form = await new Response(rawBody, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new ImportRequestError("Import request must contain valid multipart form data.", {
      code: "INVALID_IMPORT_MULTIPART",
    });
  }
  assertDecodedImportFormDataSize(form);
  return form;
}

export function assertExactlyOneImportSource(input: {
  hasFile: boolean;
  hasPaste: boolean;
}) {
  if (input.hasFile === input.hasPaste) {
    throw new ImportRequestError("Choose exactly one import source: a file or a pasted table.", {
      code: "IMPORT_SOURCE_REQUIRED",
    });
  }
}
