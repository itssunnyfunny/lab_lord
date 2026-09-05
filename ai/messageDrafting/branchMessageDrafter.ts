import { claimGeneration, publishGeneration, releaseGeneration } from "@/ai/generationLease";
import { getOverduePayments } from "@/analytics/payment.analytics";
import {
    buildMessageDraftAction,
    includedMessageFields,
    MESSAGE_DRAFT_ACTION_PREFIX,
    MESSAGE_REGENERATION_COOLDOWN_MS,
    normalizeMessageInclude,
    parseMessageLanguage,
    parseReminderTone,
    type MessageDraftInclude,
} from "@/lib/messageDrafts";
import { prisma } from "@/lib/prisma";
import type { MessageLanguage, ReminderTone } from "@/types/settings";
import { format } from "date-fns";
import { callGemini } from "../llm/gemini.client";

export interface OverdueMessageDraft {
    studentId: string;
    studentName: string;
    phone: string | null;
    dueDate: string;
    amount: number;
    daysOverdue: number;
    paymentCount: number;
    language: MessageLanguage;
    tone: ReminderTone;
    include: MessageDraftInclude;
    message: string;
    createdAt?: string;
    isOutdated?: boolean;
}

export interface DraftOverdueMessagesOptions {
    language?: MessageLanguage;
    tone?: ReminderTone;
    include?: unknown;
    regenerateStudentIds?: string[];
    allowGeneration?: boolean;
    generateMissing?: boolean;
    now?: Date;
}

export interface DraftOverdueMessagesResult {
    language: MessageLanguage;
    tone: ReminderTone;
    include: MessageDraftInclude;
    action: string;
    items: OverdueMessageDraft[];
    meta: {
        cachedCount: number;
        generatedCount: number;
        pendingGenerationCount: number;
        selectedRegenerationCount: number;
        rateLimited: boolean;
        nextAllowedCallAt: string;
        cooldownSeconds: number;
    };
}

interface MessageTarget {
    studentId: string;
    studentName: string;
    phone: string | null;
    dueDate: Date;
    amount: number;
    daysOverdue: number;
    paymentCount: number;
}

type GeneratedMessage = {
    studentId: string;
    message: string;
};

function uniqueStrings(values: string[] | undefined) {
    return new Set((values ?? []).filter(value => typeof value === "string" && value.trim().length > 0));
}

function formatMoney(amount: number) {
    return `Rs ${amount.toLocaleString("en-IN")}`;
}

function formatDueDate(date: Date) {
    return format(date, "dd MMM yyyy");
}

function buildTargets(payments: Awaited<ReturnType<typeof getOverduePayments>>["payments"]): MessageTarget[] {
    const byStudent = new Map<string, MessageTarget>();

    for (const payment of payments) {
        const existing = byStudent.get(payment.studentId);
        if (!existing) {
            byStudent.set(payment.studentId, {
                studentId: payment.studentId,
                studentName: payment.studentName,
                phone: payment.phone,
                dueDate: payment.dueDate,
                amount: payment.amount,
                daysOverdue: payment.daysOverdue,
                paymentCount: 1,
            });
            continue;
        }

        existing.amount += payment.amount;
        existing.paymentCount += 1;
        existing.daysOverdue = Math.max(existing.daysOverdue, payment.daysOverdue);
        if (payment.dueDate.getTime() < existing.dueDate.getTime()) {
            existing.dueDate = payment.dueDate;
        }
    }

    return Array.from(byStudent.values()).sort((left, right) => {
        const overdueDiff = right.daysOverdue - left.daysOverdue;
        if (overdueDiff !== 0) return overdueDiff;
        return right.amount - left.amount;
    });
}

function targetPayload(targets: MessageTarget[]) {
    return targets.map(target => ({
        studentId: target.studentId,
        name: target.studentName,
        oldestDueDate: formatDueDate(target.dueDate),
        totalDue: formatMoney(target.amount),
        pendingPayments: target.paymentCount,
        daysOverdue: target.daysOverdue,
    }));
}

function toneInstruction(tone: ReminderTone) {
    if (tone === "friendly") {
        return "warm, simple, conversational, and encouraging";
    }
    if (tone === "firm") {
        return "direct and clear about pending payment, while still respectful";
    }
    return "polite, respectful, and professional";
}

function languageInstruction(language: MessageLanguage) {
    if (language === "hi") {
        return [
            "Write in natural everyday Hinglish/Roman Hindi for Indian WhatsApp messages.",
            "Avoid formal textbook Hindi words like priya, bhugtan, kripya, sheeghra, or jama karein.",
            "Prefer normal words like fee, pending, clear, aaj, kal, please, and desk.",
        ].join(" ");
    }

    return "Write in clear everyday English.";
}

function fieldInstruction(include: MessageDraftInclude) {
    const selected = includedMessageFields(include);
    const excluded = (["name", "date", "fee"] as const).filter(field => !include[field]);

    return [
        `Required data fields in every message: ${selected.join(", ")}.`,
        excluded.length > 0 ? `Do not mention excluded fields: ${excluded.join(", ")}.` : "All available fields may be used.",
        "The fee field means the rupee amount due. The date field means the oldest due date.",
    ].join(" ");
}

function buildPrompt(targets: MessageTarget[], language: MessageLanguage, tone: ReminderTone, include: MessageDraftInclude) {
    return `
You are writing payment follow-up messages for a study hall manager.
${languageInstruction(language)}
Tone: ${toneInstruction(tone)}.
${fieldInstruction(include)}
Keep every message under 28 words.
Do not add threats, discounts, emojis, URLs, markdown, or signatures.
Use only the facts provided for each student.
Output ONLY a JSON array shaped like: [{ "studentId": "...", "message": "..." }]

Students:
${JSON.stringify(targetPayload(targets))}
`;
}

function parseGeneratedMessages(response: string | null): GeneratedMessage[] {
    if (!response) return [];

    const clean = response.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean) as unknown;

    if (Array.isArray(parsed)) {
        return parsed.filter((item): item is GeneratedMessage =>
            Boolean(
                item &&
                typeof item === "object" &&
                typeof (item as GeneratedMessage).studentId === "string" &&
                typeof (item as GeneratedMessage).message === "string"
            )
        );
    }

    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages)) {
        return ((parsed as { messages: unknown[] }).messages).filter((item): item is GeneratedMessage =>
            Boolean(
                item &&
                typeof item === "object" &&
                typeof (item as GeneratedMessage).studentId === "string" &&
                typeof (item as GeneratedMessage).message === "string"
            )
        );
    }

    return [];
}

function buildFallbackMessage(
    target: MessageTarget,
    language: MessageLanguage,
    tone: ReminderTone,
    include: MessageDraftInclude
) {
    const greeting = include.name ? `Hi ${target.studentName}, ` : "Hi, ";
    const amount = include.fee ? `${formatMoney(target.amount)} ` : "";
    const date = include.date ? `${formatDueDate(target.dueDate)} wali ` : "";

    if (language === "hi") {
        const subject = `${date}${amount}fee`.replace(/\s+/g, " ").trim();
        if (tone === "friendly") {
            return `${greeting}quick reminder, ${subject} pending hai. Time mile to clear kar dena.`;
        }
        if (tone === "firm") {
            return `${greeting}${subject} pending hai. Aaj clear kar dena ya desk se baat kar lena.`;
        }
        return `${greeting}${subject} pending hai. Please clear kar dena.`;
    }

    const subject = include.fee ? `your fee of ${formatMoney(target.amount)}` : "your fee";
    const dateText = include.date ? ` due on ${formatDueDate(target.dueDate)}` : "";

    if (tone === "friendly") {
        return `${greeting}quick reminder, ${subject}${dateText} is still pending. Please clear it when you can.`;
    }
    if (tone === "firm") {
        return `${greeting}${subject}${dateText} is pending. Please clear it today or contact the desk.`;
    }
    return `${greeting}${subject}${dateText} is pending. Please clear it at your earliest.`;
}

function draftFromRecord(
    target: MessageTarget,
    message: string,
    language: MessageLanguage,
    tone: ReminderTone,
    include: MessageDraftInclude,
    createdAt?: Date,
    isOutdated = false
): OverdueMessageDraft {
    return {
        studentId: target.studentId,
        studentName: target.studentName,
        phone: target.phone,
        dueDate: target.dueDate.toISOString(),
        amount: target.amount,
        daysOverdue: target.daysOverdue,
        paymentCount: target.paymentCount,
        language,
        tone,
        include,
        message,
        createdAt: createdAt?.toISOString(),
        isOutdated,
    };
}

async function getLastMessageGeneratedAt(branchId: string) {
    const latest = await prisma.messageDraft.findFirst({
        where: {
            branchId,
            action: { startsWith: MESSAGE_DRAFT_ACTION_PREFIX },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
    });

    return latest?.createdAt ?? null;
}

export async function draftOverdueMessages(
    branchId: string,
    optionsOrLanguage: DraftOverdueMessagesOptions | MessageLanguage = {}
): Promise<DraftOverdueMessagesResult> {
    const options = typeof optionsOrLanguage === "string"
        ? { language: optionsOrLanguage }
        : optionsOrLanguage;
    const now = options.now ?? new Date();
    const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: {
            defaultMessageLanguage: true,
            reminderTone: true,
            aiEnabled: true,
        },
    });

    if (!branch) throw new Error("Branch not found");
    if (!branch.aiEnabled) throw new Error("AI is disabled for this branch");

    const fallbackLanguage = branch.defaultMessageLanguage === "hi" ? "hi" : "en";
    const language = parseMessageLanguage(options.language, fallbackLanguage);
    const tone = parseReminderTone(options.tone, parseReminderTone(branch.reminderTone));
    const include = normalizeMessageInclude(options.include);
    const action = buildMessageDraftAction(tone, include);
    const selectedRegenerationIds = uniqueStrings(options.regenerateStudentIds);
    const allowGeneration = options.allowGeneration ?? true;
    const generateMissing = options.generateMissing ?? true;

    const overdueResult = await getOverduePayments(branchId);
    const targets = buildTargets(overdueResult.payments);
    const targetIds = targets.map(target => target.studentId);

    if (targets.length === 0) {
        return {
            language,
            tone,
            include,
            action,
            items: [],
            meta: {
                cachedCount: 0,
                generatedCount: 0,
                pendingGenerationCount: 0,
                selectedRegenerationCount: 0,
                rateLimited: false,
                nextAllowedCallAt: now.toISOString(),
                cooldownSeconds: MESSAGE_REGENERATION_COOLDOWN_MS / 1000,
            },
        };
    }

    const [existingDrafts, studentRows, lastGeneratedAt, generationLease] = await Promise.all([
        prisma.messageDraft.findMany({
            where: {
                branchId,
                action,
                language,
                studentId: { in: targetIds },
            },
            orderBy: { createdAt: "desc" },
        }),
        prisma.student.findMany({
            where: {
                branchId,
                id: { in: targetIds },
            },
            select: {
                id: true,
                updatedAt: true,
            },
        }),
        getLastMessageGeneratedAt(branchId),
        prisma.branchGenerationLease.findUnique({ where: { branchId_kind: { branchId, kind: "DRAFTS" } } }),
    ]);

    const latestDraftByStudentId = new Map<string, (typeof existingDrafts)[number]>();
    for (const draft of existingDrafts) {
        if (draft.studentId && !latestDraftByStudentId.has(draft.studentId)) {
            latestDraftByStudentId.set(draft.studentId, draft);
        }
    }

    const studentUpdatedAtById = new Map(studentRows.map(student => [student.id, student.updatedAt]));
    const resultsByStudentId = new Map<string, OverdueMessageDraft>();
    const generationTargets: MessageTarget[] = [];
    let selectedRegenerationCount = 0;

    for (const target of targets) {
        const existing = latestDraftByStudentId.get(target.studentId);
        const isSelectedForRegeneration = selectedRegenerationIds.has(target.studentId);

        if (existing && !isSelectedForRegeneration) {
            const studentUpdatedAt = studentUpdatedAtById.get(target.studentId);
            resultsByStudentId.set(
                target.studentId,
                draftFromRecord(
                    target,
                    existing.message,
                    language,
                    tone,
                    include,
                    existing.createdAt,
                    studentUpdatedAt ? studentUpdatedAt > existing.createdAt : false
                )
            );
            continue;
        }

        if (isSelectedForRegeneration) {
            selectedRegenerationCount += 1;
        }
        if (allowGeneration && (isSelectedForRegeneration || (!existing && generateMissing))) {
            generationTargets.push(target);
        } else {
            resultsByStudentId.set(
                target.studentId,
                draftFromRecord(
                    target,
                    existing?.message ?? "",
                    language,
                    tone,
                    include,
                    existing?.createdAt,
                    existing ? (studentUpdatedAtById.get(target.studentId) ?? new Date(0)) > existing.createdAt : false
                )
            );
        }
    }

    // GET and POST both expose admission cooldown, including failed publications.
    const cooldownUntil = new Date(Math.max(now.getTime(),
        lastGeneratedAt ? lastGeneratedAt.getTime() + MESSAGE_REGENERATION_COOLDOWN_MS : 0,
        generationLease ? generationLease.lastStartedAt.getTime() + MESSAGE_REGENERATION_COOLDOWN_MS : 0,
        generationLease?.token ? generationLease.leaseUntil?.getTime() ?? 0 : 0));
    const regenerationCoolingDown = cooldownUntil.getTime() > now.getTime();
    let rateLimited = generationTargets.length > 0 && regenerationCoolingDown;
    let generatedCount = 0;
    let admissionRetryAt: Date | null = null;

    if (!rateLimited && generationTargets.length > 0) {
        const token = await claimGeneration(branchId, "DRAFTS", MESSAGE_REGENERATION_COOLDOWN_MS, now);
        if (!token) {
            rateLimited = true;
            const lease = await prisma.branchGenerationLease.findUnique({ where: { branchId_kind: { branchId, kind: "DRAFTS" } } });
            admissionRetryAt = new Date(Math.max(now.getTime(),
                lease ? lease.lastStartedAt.getTime() + MESSAGE_REGENERATION_COOLDOWN_MS : 0,
                lease?.token ? lease.leaseUntil?.getTime() ?? 0 : 0));
        } else try {
            const generatedByStudentId = new Map<string, string>();
            try {
                const aiResponse = await callGemini(buildPrompt(generationTargets, language, tone, include));
                for (const item of parseGeneratedMessages(aiResponse)) generatedByStudentId.set(item.studentId, item.message.trim());
            } catch (error) {
                console.error("[Messages] Gemini response could not be parsed, using fallback", error);
            }
            const created = await publishGeneration(branchId, "DRAFTS", token, async tx => {
                const records = [];
                for (const target of generationTargets) {
                    const message = generatedByStudentId.get(target.studentId) || buildFallbackMessage(target, language, tone, include);
                    await tx.messageDraft.deleteMany({ where: { branchId, studentId: target.studentId, action, language } });
                    records.push(await tx.messageDraft.create({ data: { branchId, studentId: target.studentId, action, language, message } }));
                }
                return records;
            });
            for (let i = 0; i < generationTargets.length; i++) {
                const target = generationTargets[i], record = created[i];
                resultsByStudentId.set(target.studentId, draftFromRecord(target, record.message, language, tone, include, record.createdAt, false));
            }
            generatedCount = generationTargets.length;
        } finally {
            await releaseGeneration(branchId, "DRAFTS", token);
        }
    }

    const items = targets
        .map(target => resultsByStudentId.get(target.studentId))
        .filter((draft): draft is OverdueMessageDraft => Boolean(draft));
    const nextAllowedCallAt = admissionRetryAt ?? (generatedCount > 0
        ? new Date(now.getTime() + MESSAGE_REGENERATION_COOLDOWN_MS)
        : regenerationCoolingDown
            ? cooldownUntil
            : now);

    return {
        language,
        tone,
        include,
        action,
        items,
        meta: {
            cachedCount: Math.max(0, items.length - generatedCount),
            generatedCount,
            pendingGenerationCount: rateLimited ? generationTargets.length : 0,
            selectedRegenerationCount,
            rateLimited,
            nextAllowedCallAt: nextAllowedCallAt.toISOString(),
            cooldownSeconds: MESSAGE_REGENERATION_COOLDOWN_MS / 1000,
        },
    };
}
