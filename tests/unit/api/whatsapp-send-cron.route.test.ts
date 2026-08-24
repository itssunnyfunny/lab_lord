import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/services/whatsappDispatcher.service", () => ({
  WhatsAppDispatcherService: { run: mocks.run },
}));

describe("WhatsApp dispatcher cron route", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it.each(["GET", "POST"] as const)("rejects missing or wrong secrets for %s", async method => {
    const route = await import("@/app/api/cron/whatsapp/send/route");
    delete process.env.CRON_SECRET;
    expect((await route[method](new Request("http://test.local/api/cron/whatsapp/send"))).status)
      .toBe(401);
    process.env.CRON_SECRET = "cron-test-secret";
    expect((await route[method](new Request("http://test.local/api/cron/whatsapp/send", {
      method,
      headers: { authorization: "Bearer wrong" },
    }))).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("returns only the bounded dispatcher summary when authorized", async () => {
    mocks.run.mockResolvedValue({
      held: false,
      messagesClaimed: 2,
      messagesAccepted: 1,
      messagesRetried: 1,
      messagesFailed: 0,
      messagesUnknown: 0,
      messagesSuppressed: 0,
      backlogRemaining: 3,
    });
    const { GET } = await import("@/app/api/cron/whatsapp/send/route");
    const response = await GET(new Request("http://test.local/api/cron/whatsapp/send", {
      headers: { authorization: "Bearer cron-test-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messagesAccepted: 1, backlogRemaining: 3 });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
