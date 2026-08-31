import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  rateLimit: vi.fn(),
  getSafety: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  healthRun: vi.fn(),
  maintenanceRun: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/whatsappRoute", () => ({
  whatsAppRateLimitResponse: mocks.rateLimit,
}));
vi.mock("@/services/whatsappSenderSafety.service", () => ({
  WhatsAppSenderSafetyService: {
    getForOwner: mocks.getSafety,
    pauseByOwner: mocks.pause,
    resumeByOwner: mocks.resume,
  },
}));
vi.mock("@/services/whatsappHealth.service", () => ({
  WhatsAppHealthService: { run: mocks.healthRun },
}));
vi.mock("@/services/whatsappMaintenance.service", () => ({
  WhatsAppMaintenanceService: { run: mocks.maintenanceRun },
}));

import { GET as getSafety } from "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/safety/route";
import { POST as pauseSender } from "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/pause/route";
import { POST as resumeSender } from "@/app/api/organizations/[orgId]/whatsapp/senders/[senderId]/resume/route";
import {
  GET as healthGet,
  POST as healthPost,
} from "@/app/api/cron/whatsapp/health/route";
import { GET as maintenanceGet } from "@/app/api/cron/whatsapp/maintenance/route";

const originalCronSecret = process.env.CRON_SECRET;
const senderParams = {
  params: Promise.resolve({ orgId: "org_1", senderId: "sender_1" }),
};

function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("WhatsApp operations routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-test-secret";
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1" });
    mocks.rateLimit.mockReturnValue(null);
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it("returns owner-scoped sender readiness without exposing provider credentials", async () => {
    mocks.getSafety.mockResolvedValue({
      senderLabel: "Test sender",
      paused: false,
      resumeEligible: false,
      resumeBlockers: [],
    });
    const response = await getSafety(
      new Request("http://localhost/api/organizations/org_1/whatsapp/senders/sender_1/safety"),
      senderParams
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      senderLabel: "Test sender",
      paused: false,
      resumeEligible: false,
      resumeBlockers: [],
    });
    expect(mocks.getSafety).toHaveBeenCalledWith({
      actorUserId: "owner_1",
      organizationId: "org_1",
      senderId: "sender_1",
    });
  });

  it("requires an exact owner confirmation for pause and resume", async () => {
    const invalidPause = await pauseSender(
      post("/api/organizations/org_1/whatsapp/senders/sender_1/pause", {
        confirmation: false,
      }),
      senderParams
    );
    const invalidResume = await resumeSender(
      post("/api/organizations/org_1/whatsapp/senders/sender_1/resume", {}),
      senderParams
    );
    expect(invalidPause.status).toBe(400);
    expect(invalidResume.status).toBe(400);
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("returns bounded pause and resume response contracts", async () => {
    mocks.pause.mockResolvedValue({
      changed: true,
      pausePending: false,
      state: {
        pausedAt: new Date("2026-08-24T10:00:00.000Z"),
        pauseRequestedAt: null,
        pauseReason: "OWNER_PAUSED",
        pauseRevision: 1,
      },
    });
    mocks.resume.mockResolvedValue({
      changed: true,
      state: { pausedAt: null, pauseRequestedAt: null, pauseRevision: 2 },
    });
    const paused = await pauseSender(
      post("/api/organizations/org_1/whatsapp/senders/sender_1/pause", { confirmation: true }),
      senderParams
    );
    const resumed = await resumeSender(
      post("/api/organizations/org_1/whatsapp/senders/sender_1/resume", { confirmation: true }),
      senderParams
    );
    await expect(paused.json()).resolves.toEqual({
      changed: true,
      paused: true,
      pausePending: false,
      pauseReason: "OWNER_PAUSED",
      pauseRequestedAt: null,
      pauseRevision: 1,
    });
    await expect(resumed.json()).resolves.toEqual({
      changed: true,
      paused: false,
      pausePending: false,
      pauseRevision: 2,
      unknownRetried: false,
    });
  });

  it("rejects every health or maintenance invocation without the exact cron secret", async () => {
    const health = await healthGet(new Request(
      "http://localhost/api/cron/whatsapp/health",
      { headers: { authorization: "Bearer wrong" } }
    ));
    const maintenance = await maintenanceGet(new Request(
      "http://localhost/api/cron/whatsapp/maintenance"
    ));
    expect(health.status).toBe(401);
    expect(maintenance.status).toBe(401);
    expect(mocks.healthRun).not.toHaveBeenCalled();
    expect(mocks.maintenanceRun).not.toHaveBeenCalled();
  });

  it("uses a hashed request invocation ID and delegates authenticated cron work", async () => {
    mocks.healthRun.mockResolvedValue({
      held: false,
      replayed: false,
      status: "SUCCEEDED",
      counts: { sendersClaimed: 1 },
    });
    const response = await healthPost(new Request(
      "http://localhost/api/cron/whatsapp/health",
      {
        method: "POST",
        headers: {
          authorization: "Bearer cron-test-secret",
          "x-vercel-id": "iad1::request-evidence",
        },
      }
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      held: false,
      replayed: false,
      status: "SUCCEEDED",
      counts: { sendersClaimed: 1 },
    });
    expect(mocks.healthRun).toHaveBeenCalledWith({
      invocationId: expect.stringMatching(/^health:[a-f0-9]{64}$/),
    });
  });
});
