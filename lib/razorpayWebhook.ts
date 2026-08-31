export const MAX_RAZORPAY_WEBHOOK_BYTES = 512 * 1024;

export class RazorpayWebhookPayloadTooLargeError extends Error {
  constructor() {
    super("Razorpay webhook payload is too large");
    this.name = "RazorpayWebhookPayloadTooLargeError";
  }
}

export class RazorpayWebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayWebhookValidationError";
  }
}

export async function readBoundedRazorpayWebhookBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_RAZORPAY_WEBHOOK_BYTES
  ) {
    throw new RazorpayWebhookPayloadTooLargeError();
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RAZORPAY_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new RazorpayWebhookPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
}
