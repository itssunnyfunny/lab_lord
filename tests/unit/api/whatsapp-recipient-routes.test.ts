import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  rateLimitResponse: vi.fn(),
  associate: vi.fn(),
  associateBulk: vi.fn(),
  disable: vi.fn(),
  getForStudent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/whatsappRoute", () => ({
  whatsAppRateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/services/whatsappRecipient.service", async importOriginal => {
  const actual = await importOriginal<
    typeof import("@/services/whatsappRecipient.service")
  >();
  return {
    ...actual,
    WhatsAppRecipientService: {
      associate: mocks.associate,
      associateBulk: mocks.associateBulk,
      disable: mocks.disable,
      getForStudent: mocks.getForStudent,
    },
  };
});

const branchContext = { params: Promise.resolve({ branchId: "branch_1" }) };
const recipientContext = {
  params: Promise.resolve({ branchId: "branch_1", recipientId: "recipient_1" }),
};
const studentContext = {
  params: Promise.resolve({ branchId: "branch_1", studentId: "student_1" }),
};

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://app.example.test${path}`, {
    ...init,
    headers: {
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: "user_1" });
  mocks.rateLimitResponse.mockReturnValue(null);
  mocks.associate.mockResolvedValue({
    recipient: { id: "recipient_1", studentId: "student_1", status: "ACTIVE" },
    changed: true,
  });
  mocks.associateBulk.mockResolvedValue({
    requestedCount: 1,
    associatedCount: 1,
    unchangedCount: 0,
    skipped: [],
  });
  mocks.disable.mockResolvedValue({
    recipientId: "recipient_1",
    changed: true,
    disabledCount: 1,
    cancelledMessageCount: 2,
  });
  mocks.getForStudent.mockResolvedValue({
    studentId: "student_1",
    studentStatus: "ACTIVE",
    maskedPhone: "••••••4321",
    studentMaskedPhone: "••••••4321",
    assignedSender: {
      id: "sender_1",
      status: "ACTIVE",
      verifiedName: "Central Study Hall",
      maskedPhone: "••••••1234",
    },
    recipient: {
      id: "recipient_1",
      studentId: "student_1",
      relationship: "GUARDIAN",
      status: "ACTIVE",
      consentStatus: "OPTED_IN",
      consentType: "OPERATIONAL",
      policyVersion: "operational-collections-v1",
      maskedPhone: "••••••4321",
      phoneMatchesCurrentStudent: true,
      consentSource: "IN_PERSON",
      consentRecordedAt: "2026-08-20T10:00:00.000Z",
      verifiedAt: "2026-08-20T10:00:00.000Z",
      staleAt: null,
      disabledAt: null,
    },
  });
});

describe("WhatsApp recipient route boundary", () => {
  it("authenticates before parsing recipient mutation bodies", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const { POST } = await import(
      "@/app/api/branches/[branchId]/whatsapp/recipients/route"
    );
    const response = await POST(
      request("/api/branches/branch_1/whatsapp/recipients", {
        method: "POST",
        body: "not-json",
      }),
      branchContext
    );

    expect(response.status).toBe(401);
    expect(mocks.associate).not.toHaveBeenCalled();
  });

  it("accepts only a student, relationship, and exact attestation", async () => {
    const { POST } = await import(
      "@/app/api/branches/[branchId]/whatsapp/recipients/route"
    );
    const response = await POST(
      request("/api/branches/branch_1/whatsapp/recipients", {
        method: "POST",
        body: JSON.stringify({
          studentId: "student_1",
          relationship: "GUARDIAN",
          attestation: true,
        }),
      }),
      branchContext
    );

    expect(response.status).toBe(200);
    expect(mocks.associate).toHaveBeenCalledWith({
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
      relationship: "GUARDIAN",
      attestation: true,
    });
    expect(JSON.stringify(await response.json())).not.toMatch(/phone|sender/i);
  });

  it("rejects a forged phone field and over-limit bulk before service work", async () => {
    const [{ POST: associate }, { POST: associateBulk }] = await Promise.all([
      import("@/app/api/branches/[branchId]/whatsapp/recipients/route"),
      import("@/app/api/branches/[branchId]/whatsapp/recipients/bulk/route"),
    ]);
    const forged = await associate(
      request("/api/branches/branch_1/whatsapp/recipients", {
        method: "POST",
        body: JSON.stringify({
          studentId: "student_1",
          relationship: "SELF",
          attestation: true,
          phone: "+919999999999",
        }),
      }),
      branchContext
    );
    const overLimit = await associateBulk(
      request("/api/branches/branch_1/whatsapp/recipients/bulk", {
        method: "POST",
        body: JSON.stringify({
          attestation: true,
          recipients: Array.from({ length: 101 }, (_, index) => ({
            studentId: `student_${index}`,
            relationship: "SELF",
          })),
        }),
      }),
      branchContext
    );

    expect(forged.status).toBe(400);
    expect(overLimit.status).toBe(400);
    expect(mocks.associate).not.toHaveBeenCalled();
    expect(mocks.associateBulk).not.toHaveBeenCalled();
  });

  it("disables only the authenticated branch-scoped association ID", async () => {
    const { DELETE } = await import(
      "@/app/api/branches/[branchId]/whatsapp/recipients/[recipientId]/route"
    );
    const response = await DELETE(
      request("/api/branches/branch_1/whatsapp/recipients/recipient_1", {
        method: "DELETE",
      }),
      recipientContext
    );

    expect(response.status).toBe(200);
    expect(mocks.disable).toHaveBeenCalledWith({
      actorUserId: "user_1",
      branchId: "branch_1",
      recipientId: "recipient_1",
    });
  });

  it("reads only the tenant-scoped masked recipient and consent projection", async () => {
    const { GET } = await import(
      "@/app/api/branches/[branchId]/whatsapp/recipients/student/[studentId]/route"
    );
    const response = await GET(
      request("/api/branches/branch_1/whatsapp/recipients/student/student_1"),
      studentContext
    );

    expect(response.status).toBe(200);
    expect(mocks.getForStudent).toHaveBeenCalledWith({
      actorUserId: "user_1",
      branchId: "branch_1",
      studentId: "student_1",
    });
    const body = await response.json();
    expect(body).toMatchObject({
      maskedPhone: "••••••4321",
      studentMaskedPhone: "••••••4321",
      assignedSender: { verifiedName: "Central Study Hall", maskedPhone: "••••••1234" },
      recipient: {
        consentStatus: "OPTED_IN",
        relationship: "GUARDIAN",
        consentSource: "IN_PERSON",
        phoneMatchesCurrentStudent: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("+91987654321");
  });

  it("authenticates the recipient status read before service work", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const { GET } = await import(
      "@/app/api/branches/[branchId]/whatsapp/recipients/student/[studentId]/route"
    );

    const response = await GET(
      request("/api/branches/branch_1/whatsapp/recipients/student/student_1"),
      studentContext
    );

    expect(response.status).toBe(401);
    expect(mocks.getForStudent).not.toHaveBeenCalled();
  });
});
