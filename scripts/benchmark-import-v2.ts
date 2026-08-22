import { performance } from "node:perf_hooks";
import type {
  ImportMappingState,
  ImportNormalizedRow,
} from "../importing/contracts/import-session.contract";
import { parsePastedTable } from "../importing/parsers/pasted-table.parser";
import { compileImportPlanSnapshot } from "../importing/utils/import-plan-compiler";

const AS_OF = new Date("2026-08-22T00:00:00.000Z");
const ROW_COUNTS = [100, 500, 2_000] as const;
const ITERATIONS = 7;
const BENCHMARK_MUTATION_CEILING = 250_000;

type Scenario = {
  id: string;
  goal: "STUDENTS" | "STUDENTS_ALLOCATIONS" | "FULL";
  joinedAt: string;
  allocation: boolean;
  approvedConfiguration: boolean;
  paymentHistoryMode?:
    | "START_CURRENT_JOINED_CYCLE"
    | "FROM_JOINED_MARK_DUE";
};

const SCENARIOS: Scenario[] = [
  {
    id: "students-only",
    goal: "STUDENTS",
    joinedAt: "2026-07-05T00:00:00.000Z",
    allocation: false,
    approvedConfiguration: false,
  },
  {
    id: "existing-allocation",
    goal: "STUDENTS_ALLOCATIONS",
    joinedAt: "2026-07-05T00:00:00.000Z",
    allocation: true,
    approvedConfiguration: false,
  },
  {
    id: "approved-configuration-allocation",
    goal: "STUDENTS_ALLOCATIONS",
    joinedAt: "2026-07-05T00:00:00.000Z",
    allocation: true,
    approvedConfiguration: true,
  },
  {
    id: "current-payment",
    goal: "FULL",
    joinedAt: "2026-07-05T00:00:00.000Z",
    allocation: false,
    approvedConfiguration: false,
    paymentHistoryMode: "START_CURRENT_JOINED_CYCLE",
  },
  {
    id: "historical-payment-12-months",
    goal: "FULL",
    joinedAt: "2025-08-05T00:00:00.000Z",
    allocation: false,
    approvedConfiguration: false,
    paymentHistoryMode: "FROM_JOINED_MARK_DUE",
  },
  {
    id: "historical-payment-24-months",
    goal: "FULL",
    joinedAt: "2024-08-05T00:00:00.000Z",
    allocation: false,
    approvedConfiguration: false,
    paymentHistoryMode: "FROM_JOINED_MARK_DUE",
  },
];

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[index].toFixed(2));
}

function measurements(values: number[]) {
  return {
    min: Number(Math.min(...values).toFixed(2)),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Number(Math.max(...values).toFixed(2)),
  };
}

function sourceFor(rowCount: number, scenario: Scenario) {
  const headers = ["Student Name", "Phone", "Joined Date", "Monthly Fee"];
  if (scenario.allocation) headers.push("Seat", "Shift");
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const values = [
      `Synthetic Student ${index + 1}`,
      String(9_000_000_000 + index),
      scenario.joinedAt.slice(0, 10),
      "1200",
    ];
    if (scenario.allocation) values.push(`S-${index + 1}`, "Morning");
    return values.join("\t");
  });
  return [headers.join("\t"), ...rows].join("\n");
}

function mappingFor(scenario: Scenario): ImportMappingState {
  const paymentEnabled = Boolean(scenario.paymentHistoryMode);
  return {
    entityTypesDetected: [
      "STUDENT",
      ...(scenario.allocation ? ["ALLOCATION" as const] : []),
      ...(paymentEnabled ? ["PAYMENT" as const] : []),
    ],
    columnMappings: [
      { sourceColumn: "Student Name", targetField: "student.name", confidence: 100, source: "DETERMINISTIC" },
      { sourceColumn: "Phone", targetField: "student.phone", confidence: 100, source: "DETERMINISTIC" },
      { sourceColumn: "Joined Date", targetField: "student.joinedAt", confidence: 100, source: "DETERMINISTIC" },
      { sourceColumn: "Monthly Fee", targetField: "student.monthlyFee", confidence: 100, source: "DETERMINISTIC" },
      ...(scenario.allocation
        ? [
            { sourceColumn: "Seat", targetField: "allocation.seatLabel" as const, confidence: 100, source: "DETERMINISTIC" as const },
            { sourceColumn: "Shift", targetField: "allocation.shiftName" as const, confidence: 100, source: "DETERMINISTIC" as const },
          ]
        : []),
    ],
    questions: [],
    warnings: [],
    importOptions: paymentEnabled
      ? {
          paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
          paymentAction: "GENERATE_DUE",
          paymentHistoryMode: scenario.paymentHistoryMode,
          ...(scenario.approvedConfiguration
            ? {
                createUnknownSeats: true,
                createUnknownShifts: true,
                configurationBatchApproved: true,
              }
            : {}),
        }
      : {
          paymentCycle: "SKIP_PAYMENTS",
          paymentAction: "SKIP_PAYMENTS",
          ...(scenario.approvedConfiguration
            ? {
                createUnknownSeats: true,
                createUnknownShifts: true,
                configurationBatchApproved: true,
              }
            : {}),
        },
  };
}

function normalizedRows(
  parsedRows: Array<Record<string, string>>,
  scenario: Scenario
): ImportNormalizedRow[] {
  return parsedRows.map((row) => ({
    student: {
      name: row["Student Name"],
      phone: row.Phone,
      joinedAt: scenario.joinedAt,
      monthlyFee: Number(row["Monthly Fee"]),
    },
    ...(scenario.allocation
      ? {
          allocation: { seatLabel: row.Seat, shiftName: row.Shift },
          ...(scenario.approvedConfiguration
            ? {
                seat: { label: row.Seat },
                shift: { name: row.Shift, startTime: "06:00", endTime: "12:00" },
              }
            : {}),
        }
      : {}),
  }));
}

function runCase(rowCount: number, scenario: Scenario) {
  const source = sourceFor(rowCount, scenario);
  const extractionDurations: number[] = [];
  const normalizationDurations: number[] = [];
  const compilationDurations: number[] = [];
  let mutationSummary: ReturnType<typeof compileImportPlanSnapshot>["snapshot"]["mutationSummary"] | null = null;

  for (let iteration = 0; iteration <= ITERATIONS; iteration++) {
    let started = performance.now();
    const parsed = parsePastedTable(source);
    const extractionDuration = performance.now() - started;

    started = performance.now();
    const normalized = normalizedRows(parsed.rows, scenario);
    const evaluations = normalized.map((normalizedData, index) => ({
      id: `evaluation-${index + 1}`,
      rowId: `row-${index + 1}`,
      rowNumber: parsed.rowNumbers[index],
      status: "READY" as const,
      skipped: false,
      normalizedData,
      warnings: [],
    }));
    const normalizationDuration = performance.now() - started;

    started = performance.now();
    const compiled = compileImportPlanSnapshot({
      sessionId: `benchmark-${scenario.id}-${rowCount}`,
      targetRevision: 1,
      goal: scenario.goal,
      readinessPolicy: "READY_ROWS_ONLY",
      mapping: mappingFor(scenario),
      summary: null,
      hasOpenQuestions: false,
      expectedRowCount: rowCount,
      evaluations,
      asOf: AS_OF,
      maxPlannedMutations: BENCHMARK_MUTATION_CEILING,
    });
    const compilationDuration = performance.now() - started;

    if (!compiled.canRun || parsed.rows.length !== rowCount) {
      throw new Error(`Benchmark case ${scenario.id}/${rowCount} did not compile as runnable`);
    }
    mutationSummary = compiled.snapshot.mutationSummary;
    if (iteration > 0) {
      extractionDurations.push(extractionDuration);
      normalizationDurations.push(normalizationDuration);
      compilationDurations.push(compilationDuration);
    }
  }

  return {
    scenario: scenario.id,
    rows: rowCount,
    mutationItems: mutationSummary!.total,
    mutationBreakdown: {
      configuration: mutationSummary!.configuration,
      students: mutationSummary!.students,
      allocations: mutationSummary!.allocations,
      paymentCycles: mutationSummary!.paymentCycles,
    },
    boundedWorkflowSteps: Math.ceil(mutationSummary!.total / 25),
    extractionMs: measurements(extractionDurations),
    deterministicNormalizationMs: measurements(normalizationDurations),
    planCompilationMs: measurements(compilationDurations),
  };
}

const startedAt = new Date().toISOString();
const results = SCENARIOS.flatMap((scenario) =>
  ROW_COUNTS.map((rowCount) => runCase(rowCount, scenario))
);
const largestMutationCount = Math.max(...results.map((result) => result.mutationItems));

console.log(JSON.stringify({
  benchmark: "import-assistance-v2-local-compiler",
  startedAt,
  completedAt: new Date().toISOString(),
  asOf: AS_OF.toISOString(),
  iterations: ITERATIONS,
  rows: ROW_COUNTS,
  scenarios: SCENARIOS.map((scenario) => scenario.id),
  results,
  largestMutationCount,
  compileOnlyTwoTimesFloor: largestMutationCount * 2,
  releaseQualification: false,
  qualificationNote:
    "Local parser/normalizer/compiler evidence only. Production cap and SLOs still require staging-equivalent durable execution, database/runtime measurements, Workflow retries, and human approval.",
}, null, 2));
