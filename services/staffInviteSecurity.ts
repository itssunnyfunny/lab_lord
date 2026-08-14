import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { Prisma } from "@/app/generated/prisma/client";

const INVITE_TOKEN_VERSION = "v2";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || normalized.length > 160 || !EMAIL_PATTERN.test(normalized)) {
        throw new Error("Invite email must be a valid email address.");
    }
    return normalized;
}

function hashEmail(email: string) {
    return createHash("sha256").update(email).digest("base64url");
}

export function createStaffInviteToken(invitedEmail: string) {
    const emailHash = hashEmail(normalizeEmail(invitedEmail));
    return `${INVITE_TOKEN_VERSION}.${emailHash}.${randomBytes(32).toString("base64url")}`;
}

export function getStaffInviteEmailHash(token: string) {
    const [version, emailHash, secret, ...extra] = token.split(".");
    if (
        version !== INVITE_TOKEN_VERSION
        || !emailHash
        || !secret
        || extra.length > 0
        || emailHash.length !== 43
        || secret.length !== 43
        || !/^[A-Za-z0-9_-]+$/.test(emailHash)
        || !/^[A-Za-z0-9_-]+$/.test(secret)
    ) {
        return null;
    }
    return emailHash;
}

export function staffInviteEmailMatchesHash(email: string, expectedHash: string) {
    const actual = Buffer.from(hashEmail(normalizeEmail(email)));
    const expected = Buffer.from(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getStaffInviteTokenEmailPrefix(email: string) {
    return `${INVITE_TOKEN_VERSION}.${hashEmail(normalizeEmail(email))}.`;
}

export async function lockStaffInviteBranch(
    tx: Prisma.TransactionClient,
    branchId: string
) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Branch" WHERE "id" = ${branchId} FOR UPDATE
    `;
    if (locked.length === 0) {
        throw new Error("Branch not found");
    }
}
