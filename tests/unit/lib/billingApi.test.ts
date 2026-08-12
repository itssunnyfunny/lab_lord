import { beforeEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/core", () => ({
  apiClient: {
    get: vi.fn(),
    post,
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { billing } from "@/lib/api/billing";

describe("billing API client", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("starts a same-plan payment-method replacement with an idempotency key", async () => {
    post.mockResolvedValue({ purpose: "REPLACEMENT" });

    await billing.changePaymentMethod("org_123", "/org/org_123/settings#billing");

    expect(post).toHaveBeenCalledWith(
      "/organizations/org_123/billing/subscription/payment-method",
      { returnPath: "/org/org_123/settings#billing" },
      { headers: { "Idempotency-Key": expect.any(String) } }
    );
  });
});
