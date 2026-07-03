export type CreateStudentDto = {
    name: string;
    phone?: string;
    /** Array of shift IDs to assign at enrollment time. Requires seatId. */
    shiftIds?: string[];
    /** @deprecated use shiftIds instead. Kept for backward-compat; converted to shiftIds=[shiftId] internally. */
    shiftId?: string;
    seatId?: string;
    monthlyFee?: number;
    admissionFee?: number;
    feeLinkedShiftId?: string | null;
    feeLinkedMultiShiftId?: string | null;
};

export type CreateImportedStudentDto = {
    name: string;
    phone?: string | null;
    shiftIds?: string[];
    seatId?: string;
    monthlyFee?: number;
    admissionFee?: number;
    feeLinkedShiftId?: string | null;
    feeLinkedMultiShiftId?: string | null;
    joinedAt?: Date;
    billingStartAt?: Date | null;
};

export type UpdateStudentProfileDto = {
    name?: string;
    phone?: string;
    monthlyFee?: number;
    feeLinkedShiftId?: string | null;
    feeLinkedMultiShiftId?: string | null;
};
