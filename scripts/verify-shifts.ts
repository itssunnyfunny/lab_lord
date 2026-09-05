import { Prisma, PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const prisma = new PrismaClient({
    adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL!,
    })
});

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

// Inline Logic from SeatAllocationService
async function assignSeat(
    userId: string,
    seatId: string,
    studentId: string,
    shiftId: string
) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. Fetch entities
        const seat = await tx.seat.findUnique({
            where: { id: seatId },
            include: { branch: { include: { organization: true } } }
        });
        const student = await tx.student.findUnique({ where: { id: studentId } });
        const shift = await tx.shift.findUnique({ where: { id: shiftId } });

        if (!seat) throw new Error("Seat not found");
        if (!student) throw new Error("Student not found");
        if (!shift) throw new Error("Shift not found");

        // 2. Validate Ownership
        if (seat.branch.organization.ownerId !== userId) {
            throw new Error("Unauthorized: You do not own this seat's branch");
        }

        const branchId = seat.branchId;

        // 3. Validate "Same Branch" Rule
        if (
            student.branchId !== branchId ||
            shift.branchId !== branchId
        ) {
            throw new Error("Seat, Student, and Shift must belong to the same branch");
        }

        // 4. Validate "Student must be ACTIVE" Rule
        if (student.status !== "ACTIVE") {
            throw new Error("Only ACTIVE students can be assigned a seat");
        }

        // 5. Validate Seat Conflicts (Reserved vs Timed)
        // Fetch all active allocations for this seat to check for conflicts
        const seatAllocations = await tx.seatAllocation.findMany({
            where: { seatId, endDate: null },
            include: { shift: true },
        });

        // Rule: If target shift is RESERVED, seat must be completely empty
        if (shift.isReserved) {
            if (seatAllocations.length > 0) {
                throw new Error("Cannot allocate RESERVED shift. Seat is already assigned in other shifts.");
            }
        } else {
            // Rule: If target shift is TIMED, seat must not be RESERVED
            const hasReservedAllocation = seatAllocations.some((a) => a.shift.isReserved);
            if (hasReservedAllocation) {
                throw new Error("Cannot allocate in this shift. Seat is explicitly RESERVED.");
            }

            // Rule: Seat cannot be allocated twice in the SAME shift
            const sameShiftAllocation = seatAllocations.find((a) => a.shiftId === shiftId);
            if (sameShiftAllocation) {
                throw new Error("Seat is already assigned in this shift");
            }
        }

        // 6. Validate Student Conflicts (One seat per shift)
        const studentAllocations = await tx.seatAllocation.findFirst({
            where: {
                studentId,
                shiftId,
                endDate: null,
            },
        });

        if (studentAllocations) {
            throw new Error("Student already has a seat in this shift.");
        }

        // 7. Create Allocation
        return tx.seatAllocation.create({
            data: {
                branchId,
                seatId,
                studentId,
                shiftId,
            },
        });
    });
}

async function main() {
    console.log("Starting verification...");

    // 1. Setup Test Data
    const ownerEmail = `test-shifts-${Date.now()}@example.com`;
    const user = await prisma.user.create({
        data: {
            email: ownerEmail,
            name: "Test User",
        },
    });

    const org = await prisma.organization.create({
        data: {
            name: "Test Org Shifts",
            ownerId: user.id,
        },
    });

    const branch = await prisma.branch.create({
        data: {
            name: "Shift Test Branch",
            organizationId: org.id,
        },
    });

    // Manually ensure shifts (since we can't call BranchService)
    const defaults = [
        { name: "Morning", startTime: "06:00", endTime: "12:00", isReserved: false },
        { name: "Evening", startTime: "16:00", endTime: "22:00", isReserved: false },
        { name: "Reserved", startTime: null, endTime: null, isReserved: true },
    ];

    for (const def of defaults) {
        await prisma.shift.create({
            data: {
                branchId: branch.id,
                name: def.name,
                startTime: def.startTime,
                endTime: def.endTime,
                isReserved: def.isReserved,
            },
        });
    }

    // Verify Shifts exist
    const shifts = await prisma.shift.findMany({ where: { branchId: branch.id } });
    const morning = shifts.find(s => s.name === "Morning")!;
    const evening = shifts.find(s => s.name === "Evening")!;
    const reserved = shifts.find(s => s.name === "Reserved")!;

    // Create Students and Seats
    const seatA1 = await prisma.seat.create({ data: { branchId: branch.id, label: "A1" } });
    const seatB1 = await prisma.seat.create({ data: { branchId: branch.id, label: "B1" } });
    const student1 = await prisma.student.create({ data: { branchId: branch.id, name: "Student 1", status: "ACTIVE" } });
    const student2 = await prisma.student.create({ data: { branchId: branch.id, name: "Student 2", status: "ACTIVE" } });

    // Testing Logic
    console.log("Testing Conflict Rules...");

    // Rule 1: Allocate A1 to Morning (Success)
    console.log("Allocating A1 to Morning...");
    await assignSeat(user.id, seatA1.id, student1.id, morning.id);
    console.log("✅ Success");

    // Rule 1b: Try A1 to Morning again (Fail)
    console.log("Trying A1 to Morning again (Expected Fail)...");
    try {
        await assignSeat(user.id, seatA1.id, student2.id, morning.id);
        throw new Error("❌ Failed: Should have thrown error");
    } catch (e: unknown) {
        const message = errorMessage(e);
        if (message.includes("already assigned")) console.log("✅ Catching dupe: OK");
        else throw e;
    }

    // Rule 2a: Try A1 to Reserved (Fail - taken in Morning)
    console.log("Trying A1 to Reserved (Expected Fail)...");
    try {
        await assignSeat(user.id, seatA1.id, student2.id, reserved.id);
        throw new Error("❌ Failed: Should have thrown error");
    } catch (e: unknown) {
        const message = errorMessage(e);
        if (message.includes("assigned in other shifts")) console.log("✅ Catching timed conflict: OK");
        else throw e;
    }

    // Rule 2b: Allocate B1 to Reserved (Success)
    console.log("Allocating B1 to Reserved...");
    await assignSeat(user.id, seatB1.id, student2.id, reserved.id);
    console.log("✅ Success");

    // Rule 2c: Try B1 to Evening (Fail - reserved)
    console.log("Trying B1 to Evening (Expected Fail)...");
    try {
        await assignSeat(user.id, seatB1.id, student1.id, evening.id);
        throw new Error("❌ Failed: Should have thrown error");
    } catch (e: unknown) {
        const message = errorMessage(e);
        if (message.includes("explicitly RESERVED")) console.log("✅ Catching reserved conflict: OK");
        else throw e;
    }

    console.log("ALL TESTS PASSED 🎉");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
