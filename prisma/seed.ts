import {
    PrismaClient,
    PaymentStatus,
    PaymentType,
    StudentStatus,
    StaffRole,
} from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { addMonths, subMonths, startOfDay } from "date-fns";
import * as fs from "fs";
import "dotenv/config";

// ─── DB CONNECTION (unchanged) ────────────────────────────────────────────────
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const logStream = fs.createWriteStream("seed.log", { flags: "w" });
function log(msg: string) {
    console.log(msg);
    logStream.write(msg + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: anchor-based monthly payments
// Generates MONTHLY payments from joinedAt + 1 month up to today.
// overrides = { 0: PAID } means "first due month is PAID" (0-indexed).
// Months not in overrides default to DUE.
// ─────────────────────────────────────────────────────────────────────────────
async function generateMonthlyPayments(
    branchId: string,
    studentId: string,
    joinedAt: Date,
    monthlyFee: number,
    overrides: Record<number, PaymentStatus> = {}
): Promise<number> {
    const today = startOfDay(new Date());
    const records: {
        branchId: string;
        studentId: string;
        amount: number;
        status: PaymentStatus;
        type: PaymentType;
        periodStart: Date;
        periodEnd: Date;
        dueDate: Date;
        paidAt: Date | null;
    }[] = [];

    let month = 1;
    while (true) {
        const dueDate = addMonths(joinedAt, month);
        if (dueDate > today) break;

        const status = overrides[month - 1] ?? PaymentStatus.DUE;
        records.push({
            branchId,
            studentId,
            amount: monthlyFee,
            status,
            type: PaymentType.MONTHLY,
            periodStart: addMonths(joinedAt, month - 1),
            periodEnd: dueDate,
            dueDate,
            paidAt: status === PaymentStatus.PAID ? dueDate : null,
        });
        month++;
    }

    if (records.length > 0) {
        await prisma.payment.createMany({ data: records, skipDuplicates: true });
    }
    return records.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    log("🧹 Cleaning up existing data...");

    await prisma.messageDraft.deleteMany();
    await prisma.branchAIReport.deleteMany();
    await prisma.paymentResolutionEvent.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.seatAllocation.deleteMany();
    await prisma.student.deleteMany();
    await prisma.seat.deleteMany();
    await prisma.shift.deleteMany();
    await prisma.staff.deleteMany();
    await prisma.branch.deleteMany();
    await prisma.organization.deleteMany();
    await prisma.user.deleteMany();

    // ── USERS ──────────────────────────────────────────────────────────────────
    log("👤 Creating users...");

    const alice = await prisma.user.create({
        data: { email: "alice@lablord.com", name: "Alice Owner" },
    });
    const bob = await prisma.user.create({
        data: { email: "bob@lablord.com", name: "Bob Manager" },
    });
    const carol = await prisma.user.create({
        data: { email: "carol@lablord.com", name: "Carol Manager" },
    });
    const dave = await prisma.user.create({
        data: { email: "dave@lablord.com", name: "Dave Staff" },
    });

    // ── ALICE'S ORG ────────────────────────────────────────────────────────────
    log("🏢 Creating Alice EduCorp...");

    const aliceOrg = await prisma.organization.create({
        data: {
            id: "org_alice",
            name: "Alice EduCorp",
            ownerId: alice.id,
            businessType: "Study Hall",
        },
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // PRIMARY BRANCH — Uptown Study Hall  ← The main one with all test scenarios
    // ══════════════════════════════════════════════════════════════════════════════
    log("🏫 Setting up Uptown Study Hall (PRIMARY test branch)...");

    const uptown = await prisma.branch.create({
        data: {
            id: "branch_uptown",
            name: "Uptown Study Hall",
            city: "Delhi",
            organizationId: aliceOrg.id,
            defaultFee: 1200,
        },
    });

    // Staff: Bob = MANAGER, Carol = MANAGER, Dave = STAFF
    // Tests: PERMISSION_MATRIX, listStaff page, role-based access
    await prisma.staff.createMany({
        data: [
            { userId: bob.id, branchId: uptown.id, role: StaffRole.MANAGER },
            { userId: carol.id, branchId: uptown.id, role: StaffRole.MANAGER },
            { userId: dave.id, branchId: uptown.id, role: StaffRole.STAFF },
        ],
    });

    // Shifts: 3 timed + 1 RESERVED (Full Day)
    // Tests: reserved-shift conflict rules, per-shift occupancy in analytics
    const [shiftMorning, shiftAfternoon, shiftEvening, shiftFullDay] =
        await Promise.all([
            prisma.shift.create({ data: { branchId: uptown.id, name: "Morning", startTime: "06:00", endTime: "11:59", price: 1000, isReserved: false } }),
            prisma.shift.create({ data: { branchId: uptown.id, name: "Afternoon", startTime: "12:00", endTime: "16:59", price: 1000, isReserved: false } }),
            prisma.shift.create({ data: { branchId: uptown.id, name: "Evening", startTime: "17:00", endTime: "22:00", price: 1000, isReserved: false } }),
            prisma.shift.create({ data: { branchId: uptown.id, name: "Full Day", startTime: "06:00", endTime: "22:00", price: 2000, isReserved: true } }),
        ]);

    // Seats: U-01 to U-20
    const seats = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
            prisma.seat.create({
                data: { branchId: uptown.id, label: `U-${String(i + 1).padStart(2, "0")}` },
            })
        )
    );

    const today = new Date();

    // ────────────────────────────────────────────────────────────────────────────
    // ACTIVE STUDENTS WITH PAYMENT HISTORY
    // Key: join 3-6 months ago so generateMonthlyPayments produces real rows.
    // ────────────────────────────────────────────────────────────────────────────

    // S01 — Good payer, Morning, joined 5 months ago, all PAID except last month DUE
    // Tests: ADMISSION + MONTHLY mix, long PAID history
    const s01At = subMonths(today, 5);
    const s01 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Aarav Sharma", phone: "9800000001", status: StudentStatus.ACTIVE, monthlyFee: 1200, joinedAt: s01At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[0].id, studentId: s01.id, shiftId: shiftMorning.id, startDate: s01At } });
    // Admission fee — paid on day of joining
    await prisma.payment.create({ data: { branchId: uptown.id, studentId: s01.id, amount: 500, status: PaymentStatus.PAID, type: PaymentType.ADMISSION, dueDate: s01At, periodStart: s01At, periodEnd: s01At, paidAt: s01At } });
    // Months: 0,1,2,3 = PAID, month 4 = DUE (current)
    await generateMonthlyPayments(uptown.id, s01.id, s01At, 1200, {
        0: PaymentStatus.PAID, 1: PaymentStatus.PAID, 2: PaymentStatus.PAID, 3: PaymentStatus.PAID,
    });

    // S02 — Two shifts (Morning + Afternoon), joined 4 months ago, all PAID
    // Tests: multi-shift allocation per-shift occupancy breakdown
    const s02At = subMonths(today, 4);
    const s02 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Priya Verma", phone: "9800000002", status: StudentStatus.ACTIVE, monthlyFee: 2000, joinedAt: s02At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[1].id, studentId: s02.id, shiftId: shiftMorning.id, startDate: s02At } });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[1].id, studentId: s02.id, shiftId: shiftAfternoon.id, startDate: s02At } });
    await generateMonthlyPayments(uptown.id, s02.id, s02At, 2000, {
        0: PaymentStatus.PAID, 1: PaymentStatus.PAID, 2: PaymentStatus.PAID, 3: PaymentStatus.PAID,
    });

    // S03 — Fully overdue (3 months DUE), Evening, joined 4 months ago
    // Tests: overdue list, AI report, message draft
    const s03At = subMonths(today, 4);
    const s03 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Rahul Patel", phone: "9800000003", status: StudentStatus.ACTIVE, monthlyFee: 1200, joinedAt: s03At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[2].id, studentId: s03.id, shiftId: shiftEvening.id, startDate: s03At } });
    // Only first month paid, rest DUE
    await generateMonthlyPayments(uptown.id, s03.id, s03At, 1200, {
        0: PaymentStatus.PAID,
    });

    // S04 — RESERVED Full-Day shift, joined 3 months ago
    // Tests: reserved-shift conflict rule (seat must be fully empty)
    const s04At = subMonths(today, 3);
    const s04 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Sneha Joshi", phone: "9800000004", status: StudentStatus.ACTIVE, monthlyFee: 2000, joinedAt: s04At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[3].id, studentId: s04.id, shiftId: shiftFullDay.id, startDate: s04At } });
    await generateMonthlyPayments(uptown.id, s04.id, s04At, 2000, {
        0: PaymentStatus.PAID, 1: PaymentStatus.PAID,
    });

    // S05 — Active but NO seat (unallocated), joined 3 months ago
    // Tests: student list vs allocations list mismatch, empty seat state
    const s05At = subMonths(today, 3);
    const s05 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Vikram Das", phone: "9800000005", status: StudentStatus.ACTIVE, monthlyFee: 1200, joinedAt: s05At },
    });
    // 2 months paid, 1 month DUE
    await generateMonthlyPayments(uptown.id, s05.id, s05At, 1200, {
        0: PaymentStatus.PAID, 1: PaymentStatus.PAID,
    });

    // S06 — One missed payment then resumed paying
    // Tests: mixed PAID/DUE history mid-stream
    const s06At = subMonths(today, 5);
    const s06 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Kavita Singh", phone: "9800000006", status: StudentStatus.ACTIVE, monthlyFee: 1200, joinedAt: s06At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[4].id, studentId: s06.id, shiftId: shiftAfternoon.id, startDate: s06At } });
    // 0=PAID, 1=DUE (skipped), 2=PAID, 3=PAID, 4=DUE
    await generateMonthlyPayments(uptown.id, s06.id, s06At, 1200, {
        0: PaymentStatus.PAID, 2: PaymentStatus.PAID, 3: PaymentStatus.PAID,
    });

    // S07 — New student, joined 2 months ago, 1 month DUE (just starting out)
    const s07At = subMonths(today, 2);
    const s07 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Manish Gupta", phone: "9800000007", status: StudentStatus.ACTIVE, monthlyFee: 1000, joinedAt: s07At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[5].id, studentId: s07.id, shiftId: shiftMorning.id, startDate: s07At } });
    // Only first month, DUE
    await generateMonthlyPayments(uptown.id, s07.id, s07At, 1000, {});

    // S08 — Evening shift, joined 3 months ago, 2 PAID + 1 DUE
    const s08At = subMonths(today, 3);
    const s08 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Deepa Nair", phone: "9800000008", status: StudentStatus.ACTIVE, monthlyFee: 1200, joinedAt: s08At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[6].id, studentId: s08.id, shiftId: shiftEvening.id, startDate: s08At } });
    await generateMonthlyPayments(uptown.id, s08.id, s08At, 1200, {
        0: PaymentStatus.PAID, 1: PaymentStatus.PAID,
    });

    // ────────────────────────────────────────────────────────────────────────────
    // INACTIVE STUDENTS — 3 resolution paths
    // ────────────────────────────────────────────────────────────────────────────

    // S09 — INACTIVE | WAIVED dues (owner chose to forgive)
    // Tests: WAIVED status filter, ended allocation, inactivation dialog path 1
    const s09At = subMonths(today, 5);
    const s09EndDate = subMonths(today, 1);
    const s09 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Naina Roy", phone: "9800000009", status: StudentStatus.INACTIVE, monthlyFee: 1200, joinedAt: s09At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[7].id, studentId: s09.id, shiftId: shiftMorning.id, startDate: s09At, endDate: s09EndDate } });
    // 2 PAID, then inactivated and remaining 2 months WAIVED
    await prisma.payment.createMany({
        data: [
            { branchId: uptown.id, studentId: s09.id, amount: 1200, status: PaymentStatus.PAID, type: PaymentType.MONTHLY, dueDate: addMonths(s09At, 1), periodStart: s09At, periodEnd: addMonths(s09At, 1), paidAt: addMonths(s09At, 1) },
            { branchId: uptown.id, studentId: s09.id, amount: 1200, status: PaymentStatus.PAID, type: PaymentType.MONTHLY, dueDate: addMonths(s09At, 2), periodStart: addMonths(s09At, 1), periodEnd: addMonths(s09At, 2), paidAt: addMonths(s09At, 2) },
            { branchId: uptown.id, studentId: s09.id, amount: 1200, status: PaymentStatus.WAIVED, type: PaymentType.MONTHLY, dueDate: addMonths(s09At, 3), periodStart: addMonths(s09At, 2), periodEnd: addMonths(s09At, 3), paidAt: null },
            { branchId: uptown.id, studentId: s09.id, amount: 1200, status: PaymentStatus.WAIVED, type: PaymentType.MONTHLY, dueDate: addMonths(s09At, 4), periodStart: addMonths(s09At, 3), periodEnd: addMonths(s09At, 4), paidAt: null },
        ],
    });

    // S10 — INACTIVE | PAID dues (clean exit — owner paid them off)
    // Tests: inactivation dialog path 2, INACTIVE + all-PAID history
    const s10At = subMonths(today, 4);
    const s10EndDate = subMonths(today, 1);
    const s10 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Arjun Mehta", phone: "9800000010", status: StudentStatus.INACTIVE, monthlyFee: 1200, joinedAt: s10At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[8].id, studentId: s10.id, shiftId: shiftAfternoon.id, startDate: s10At, endDate: s10EndDate } });
    await generateMonthlyPayments(uptown.id, s10.id, s10At, 1200, {
        0: PaymentStatus.PAID, 1: PaymentStatus.PAID, 2: PaymentStatus.PAID, 3: PaymentStatus.PAID,
    });

    // S11 — INACTIVE | KEEP (dues remain DUE — bad debt in system)
    // Tests: inactivation dialog path 3, DUE rows surviving inactivation
    const s11At = subMonths(today, 6);
    const s11EndDate = subMonths(today, 1);
    const s11 = await prisma.student.create({
        data: { branchId: uptown.id, name: "Meena Shah", phone: "9800000011", status: StudentStatus.INACTIVE, monthlyFee: 1200, joinedAt: s11At },
    });
    await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[9].id, studentId: s11.id, shiftId: shiftEvening.id, startDate: s11At, endDate: s11EndDate } });
    // Only first 2 months PAID, left with 3 months DUE
    await generateMonthlyPayments(uptown.id, s11.id, s11At, 1200, {
        0: PaymentStatus.PAID, 1: PaymentStatus.PAID,
    });

    // ────────────────────────────────────────────────────────────────────────────
    // EXTRA ACTIVE STUDENTS — spread across shifts for analytics occupancy chart
    // ────────────────────────────────────────────────────────────────────────────
    const extraStudents = [
        { name: "Ravi Kumar", phone: "9800000012", fee: 1000, seatIdx: 10, shift: shiftMorning, monthsAgo: 3, paid: [0, 1] },
        { name: "Sunita Rao", phone: "9800000013", fee: 1200, seatIdx: 11, shift: shiftMorning, monthsAgo: 4, paid: [0, 1, 2] },
        { name: "Ajay Patel", phone: "9800000014", fee: 1000, seatIdx: 12, shift: shiftAfternoon, monthsAgo: 3, paid: [0] },
        { name: "Rekha Jain", phone: "9800000015", fee: 1200, seatIdx: 13, shift: shiftAfternoon, monthsAgo: 5, paid: [0, 1, 2, 3] },
    ];

    for (const cfg of extraStudents) {
        const joinedAt = subMonths(today, cfg.monthsAgo);
        const s = await prisma.student.create({
            data: { branchId: uptown.id, name: cfg.name, phone: cfg.phone, status: StudentStatus.ACTIVE, monthlyFee: cfg.fee, joinedAt },
        });
        await prisma.seatAllocation.create({ data: { branchId: uptown.id, seatId: seats[cfg.seatIdx].id, studentId: s.id, shiftId: cfg.shift.id, startDate: joinedAt } });
        const overrides: Record<number, PaymentStatus> = {};
        cfg.paid.forEach((i) => { overrides[i] = PaymentStatus.PAID; });
        await generateMonthlyPayments(uptown.id, s.id, joinedAt, cfg.fee, overrides);
    }

    // ── AI DATA ────────────────────────────────────────────────────────────────
    log("🤖 Seeding AI report and message drafts...");

    await prisma.branchAIReport.create({
        data: {
            branchId: uptown.id,
            data: {
                summary: "Uptown Study Hall: 12 active students, 3 inactive. 3 students are overdue. Full Day (Reserved) shift is at 100% capacity. Evening shift has room for 14 more.",
                insights: [
                    "Rahul Patel (S03) is 3 months overdue — highest risk.",
                    "Kavita Singh (S06) missed one month mid-term but has since resumed paying.",
                    "Meena Shah left with ₹3,600 in unresolved DUE payments — flagged as bad debt.",
                    "Full Day (Reserved) shift is at 100% capacity (1/1 seats).",
                    "Morning shift is 25% occupied — room for 15 more students.",
                    "Consider a targeted Re-Admission offer for inactive students.",
                ],
                riskAlerts: [
                    { studentName: "Rahul Patel", reason: "3 consecutive months overdue", severity: "HIGH" },
                    { studentName: "Meena Shah", reason: "Inactive — left with DUE payments", severity: "MEDIUM" },
                    { studentName: "Kavita Singh", reason: "Payment gap detected (month 2 unpaid)", severity: "LOW" },
                ],
                generatedAt: new Date().toISOString(),
            },
        },
    });

    await prisma.messageDraft.createMany({
        data: [
            {
                branchId: uptown.id,
                studentId: s03.id,
                action: "OVERDUE_PAYMENT_FOLLOWUP",
                language: "en",
                message: "Hi Rahul, your study hall fees for the past 3 months are pending. Please clear them at the earliest to continue your seat. Thank you — Uptown Study Hall Team.",
            },
            {
                branchId: uptown.id,
                studentId: s11.id,
                action: "OVERDUE_PAYMENT_FOLLOWUP",
                language: "hi",
                message: "नमस्ते मीना, आपके 3 महीनों की फीस अभी भी बाकी है। कृपया जल्द से जल्द शाखा से संपर्क करें या भुगतान करें। धन्यवाद।",
            },
        ],
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // SECONDARY BRANCH — Downtown Library (simpler, for org multi-branch view)
    // ══════════════════════════════════════════════════════════════════════════════
    log("🏫 Setting up Downtown Library (secondary branch)...");

    const downtown = await prisma.branch.create({
        data: {
            id: "branch_downtown",
            name: "Downtown Library",
            city: "Mumbai",
            organizationId: aliceOrg.id,
            defaultFee: 1000,
        },
    });

    const dtMorning = await prisma.shift.create({ data: { branchId: downtown.id, name: "Morning", startTime: "07:00", endTime: "13:00", price: 900 } });
    const dtEvening = await prisma.shift.create({ data: { branchId: downtown.id, name: "Evening", startTime: "17:00", endTime: "22:00", price: 900 } });

    const dtSeats = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
            prisma.seat.create({ data: { branchId: downtown.id, label: `D-${String(i + 1).padStart(2, "0")}` } })
        )
    );

    const dtStudentsData = [
        { name: "Ishan Kapoor", phone: "9700000001", fee: 1000, seatIdx: 0, shift: dtMorning, monthsAgo: 4, paid: [0, 1, 2] },
        { name: "Pooja Tiwari", phone: "9700000002", fee: 1000, seatIdx: 1, shift: dtEvening, monthsAgo: 3, paid: [0, 1] },
        { name: "Nikhil Yadav", phone: "9700000003", fee: 1000, seatIdx: 2, shift: dtMorning, monthsAgo: 3, paid: [0] },
        { name: "Ananya Nair", phone: "9700000004", fee: 1000, seatIdx: 3, shift: dtEvening, monthsAgo: 5, paid: [0, 1, 2, 3] },
        { name: "Rohan Desai", phone: "9700000005", fee: 900, seatIdx: 4, shift: dtMorning, monthsAgo: 2, paid: [] },
        { name: "Simran Kaur", phone: "9700000006", fee: 1000, seatIdx: 5, shift: dtEvening, monthsAgo: 4, paid: [0, 1] },
        { name: "Dev Malhotra", phone: "9700000007", fee: 1000, seatIdx: 6, shift: dtMorning, monthsAgo: 3, paid: [0, 1, 2] },
    ];

    for (const cfg of dtStudentsData) {
        const joinedAt = subMonths(today, cfg.monthsAgo);
        const s = await prisma.student.create({
            data: { branchId: downtown.id, name: cfg.name, phone: cfg.phone, status: StudentStatus.ACTIVE, monthlyFee: cfg.fee, joinedAt },
        });
        await prisma.seatAllocation.create({ data: { branchId: downtown.id, seatId: dtSeats[cfg.seatIdx].id, studentId: s.id, shiftId: cfg.shift.id, startDate: joinedAt } });
        const overrides: Record<number, PaymentStatus> = {};
        cfg.paid.forEach((i) => { overrides[i] = PaymentStatus.PAID; });
        await generateMonthlyPayments(downtown.id, s.id, joinedAt, cfg.fee, overrides);
    }

    // ── BOB'S OWN ORG ──────────────────────────────────────────────────────────
    log("🏢 Creating Bob's Coaching (separate org)...");

    const bobOrg = await prisma.organization.create({
        data: { id: "org_bob", name: "Bob's Coaching", ownerId: bob.id, businessType: "Coaching" },
    });
    const bobBranch = await prisma.branch.create({
        data: { name: "Main Campus", city: "Pune", organizationId: bobOrg.id, defaultFee: 800 },
    });
    await prisma.shift.create({ data: { branchId: bobBranch.id, name: "Morning", startTime: "08:00", endTime: "14:00", price: 700 } });
    await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
            prisma.seat.create({ data: { branchId: bobBranch.id, label: `C-${i + 1}` } })
        )
    );

    // ── DONE ───────────────────────────────────────────────────────────────────
    log("\n✅ Seed complete!\n");

    const branches = await prisma.branch.findMany({ include: { organization: true } });
    log("🔗 Branch URLs:");
    branches.forEach((b) => {
        log(`   ${b.name} (${b.organization.name}) → http://localhost:3000/branch/${b.id}`);
    });

    log("\n👤 Users:");
    log("   alice@lablord.com  — Owner of EduCorp (Uptown Study Hall + Downtown Library)");
    log("   bob@lablord.com    — Owner of Bob's Coaching + MANAGER on Uptown Study Hall");
    log("   carol@lablord.com  — MANAGER on Uptown Study Hall");
    log("   dave@lablord.com   — STAFF on Uptown Study Hall");

    log("\n📋 Uptown Study Hall — Test Scenarios:");
    log("   S01 Aarav Sharma  → ACTIVE | Morning | 4x PAID + 1x DUE | ADMISSION fee");
    log("   S02 Priya Verma   → ACTIVE | Morning + Afternoon (2 shifts) | all PAID");
    log("   S03 Rahul Patel   → ACTIVE | Evening | OVERDUE (3 months DUE)");
    log("   S04 Sneha Joshi   → ACTIVE | Full Day RESERVED shift");
    log("   S05 Vikram Das    → ACTIVE | NO seat allocated");
    log("   S06 Kavita Singh  → ACTIVE | Gap in payments (missed month 2)");
    log("   S07 Manish Gupta  → ACTIVE | New student — 1 month DUE");
    log("   S08 Deepa Nair    → ACTIVE | Evening | 2x PAID + 1x DUE");
    log("   S09 Naina Roy     → INACTIVE | WAIVED dues | ended allocation");
    log("   S10 Arjun Mehta   → INACTIVE | PAID dues (clean exit) | ended allocation");
    log("   S11 Meena Shah    → INACTIVE | KEEP (3x DUE remain as bad debt)");
    log("   S12–S15           → ACTIVE | spread Morning/Afternoon/Evening for analytics");
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
