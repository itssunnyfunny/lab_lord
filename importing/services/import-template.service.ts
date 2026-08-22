import { prisma } from "@/lib/prisma";
import { StaffService } from "@/services/staff.service";
import type { ImportGoal } from "@/app/generated/prisma/enums";

export type ImportTemplateFormat = "csv" | "xlsx";

type TemplateColumn = {
  header: string;
  example: string;
};

function csvCell(value: string) {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function spreadsheetText(value: string) {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function safeFilePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "branch";
}

function columnsForGoal(input: {
  goal: ImportGoal;
  seatLabel?: string;
  shiftName?: string;
  multiShiftName?: string;
}): TemplateColumn[] {
  const columns: TemplateColumn[] = [
    { header: "Student name", example: "Asha Sharma" },
    { header: "Phone", example: "9876543210" },
    { header: "Joined date", example: "15/08/2026" },
    { header: "Monthly fee", example: "1500" },
  ];

  if (input.goal !== "STUDENTS") {
    columns.push(
      { header: "Seat", example: input.seatLabel ?? "A-01" },
      { header: "Shift", example: input.shiftName ?? "Morning" },
      { header: "Multi-shift", example: input.multiShiftName ?? "" },
    );
  }

  if (input.goal === "FULL") {
    columns.push(
      { header: "Payment amount", example: "1500" },
      { header: "Payment status", example: "DUE" },
      { header: "Payment method", example: "CASH" },
      { header: "Payment reference", example: "" },
    );
  }

  return columns;
}

export class ImportTemplateService {
  static async buildTemplate(
    userId: string,
    branchId: string,
    goal: ImportGoal,
    format: ImportTemplateFormat,
  ) {
    await StaffService.authorize(userId, branchId, "students");
    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        name: true,
        seats: { select: { label: true }, orderBy: { label: "asc" } },
        shifts: {
          where: { status: "ACTIVE" },
          select: { name: true },
          orderBy: { name: "asc" },
        },
        multiShifts: {
          select: { name: true },
          orderBy: { name: "asc" },
        },
      },
    });
    if (!branch) throw new Error("Import resource not found");

    const columns = columnsForGoal({
      goal,
      seatLabel: branch.seats[0]?.label,
      shiftName: branch.shifts[0]?.name,
      multiShiftName: branch.multiShifts[0]?.name,
    });
    const baseName = `${safeFilePart(branch.name)}-${goal.toLowerCase().replaceAll("_", "-")}-import-template`;

    if (format === "csv") {
      const lines = [
        columns.map(column => csvCell(column.header)).join(","),
        columns.map(column => csvCell(column.example)).join(","),
      ];
      return {
        fileName: `${baseName}.csv`,
        contentType: "text/csv; charset=utf-8",
        body: Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8"),
      };
    }

    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        columns.map(column => column.header),
        columns.map(column => spreadsheetText(column.example)),
      ]),
      "Import data",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Import goal", goal],
        ["Maximum source size", "4 MiB"],
        ["Maximum rows", "2,000"],
        ["Maximum columns", "64"],
        ["Accepted dates", "DD/MM/YYYY (Indian) or YYYY-MM-DD (ISO)"],
        ["Money", "Whole INR amounts only, for example 1500"],
        ["Student status", "Imported students always start active"],
        ["Allocation start", "Allocations start when the approved plan is applied"],
        ["Payment history", "Chosen during review using joined-date anniversary policies"],
      ]),
      "Instructions",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Current seats", "Current shifts", "Current multi-shifts"],
        ...Array.from({
          length: Math.max(branch.seats.length, branch.shifts.length, branch.multiShifts.length, 1),
        }, (_, index) => [
          spreadsheetText(branch.seats[index]?.label ?? ""),
          spreadsheetText(branch.shifts[index]?.name ?? ""),
          spreadsheetText(branch.multiShifts[index]?.name ?? ""),
        ]),
      ]),
      "Accepted values",
    );

    return {
      fileName: `${baseName}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })),
    };
  }
}
