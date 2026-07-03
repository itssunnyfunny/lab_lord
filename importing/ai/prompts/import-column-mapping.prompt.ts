import { IMPORT_TARGET_FIELDS, type ParsedImportRow } from "@/importing/contracts/import-session.contract";

export function buildImportColumnMappingPrompt(input: {
    branchContext: unknown;
    sourceProfile?: unknown;
    columns: string[];
    sampleRows: ParsedImportRow[];
}) {
    return `
You are helping map messy study hall ERP import columns into a staging import.
You do not decide final truth, you never mutate data, and you must ask for confirmation when a business decision is ambiguous.
Return only strict JSON with this shape:
{
  "entityTypesDetected": ["STUDENT", "SEAT", "SHIFT", "ALLOCATION", "PAYMENT"],
  "columnMappings": [
    {
      "sourceColumn": "Mobile",
      "targetField": "student.phone",
      "confidence": 91,
      "reason": "Looks like an Indian phone number"
    }
  ],
  "questions": [
    {
      "field": "payment.period",
      "question": "Should payments use each student's joined-date cycle?",
      "options": ["USE_JOINED_AT_ANNIVERSARY", "SKIP_PAYMENTS"]
    }
  ],
  "warnings": [],
  "suggestedImportOptions": {
    "paymentHistoryMode": "START_CURRENT_JOINED_CYCLE",
    "paymentMapping": {
      "paidValues": ["paid", "yes"],
      "unpaidValues": ["due", "pending"],
      "waivedValues": ["waived"],
      "unclearValues": ["maybe"],
      "confirmed": false
    }
  },
  "analysisNotes": [
    "The file appears to include student and payment status data."
  ]
}

Supported target fields:
${IMPORT_TARGET_FIELDS.join("\n")}

Branch context:
${JSON.stringify(input.branchContext, null, 2)}

Source profile:
${JSON.stringify(input.sourceProfile ?? null, null, 2)}

Uploaded columns:
${JSON.stringify(input.columns)}

Sample rows:
${JSON.stringify(input.sampleRows.slice(0, 8), null, 2)}

Rules:
- Map every uploaded column exactly once. Use "ignore" when the column should not be imported.
- Prefer existing branch seats, shifts, and multi-shifts when names are close.
- Payment cycles must follow each student's joined date; do not suggest calendar-month billing.
- Do not set createUnknownSeats, createUnknownShifts, or createUnknownMultiShifts.
- If paid/unpaid values are present, guess paymentMapping but keep confirmed false.
- Use questions only for operator decisions that cannot be safely inferred. Prefer these option tokens when relevant:
  - YES_CREATE_SEATS or SKIP_UNKNOWN_SEAT_ALLOCATION
  - CREATE_SHIFT or SKIP_UNKNOWN_SHIFT_ALLOCATION
  - CREATE_MULTI_SHIFT or SKIP_UNKNOWN_MULTI_SHIFT_ALLOCATION
  - SKIP_ALLOCATIONS when seat/shift links should be handled manually later
  - USE_JOINED_AT_ANNIVERSARY or SKIP_PAYMENTS
  - GENERATE_DUE, IMPORT_PAID_UNPAID, or SKIP_PAYMENTS
  - START_CURRENT_JOINED_CYCLE, FROM_JOINED_MARK_PAID, FROM_JOINED_MARK_DUE, or FROM_JOINED_PAID_THROUGH_PREVIOUS
- Questions should be short, answerable, and only for decisions the operator must confirm.
`;
}
