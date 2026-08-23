import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const authStatePath = process.env.PLAYWRIGHT_OWNER_AUTH_STATE;
const branchId = process.env.PLAYWRIGHT_OWNER_BRANCH_ID;
const hasAuthenticatedBranch = Boolean(authStatePath && fs.existsSync(authStatePath) && branchId);
const storageState = hasAuthenticatedBranch ? authStatePath! : { cookies: [], origins: [] };
const now = "2026-08-18T10:00:00.000Z";

test.use({ storageState });
test.beforeEach(() => {
    test.skip(!hasAuthenticatedBranch, "Set PLAYWRIGHT_OWNER_AUTH_STATE and PLAYWRIGHT_OWNER_BRANCH_ID to run import onboarding coverage.");
});

function fulfillJson(route: Route, body: unknown, status = 200) {
    return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
    });
}

async function mockBranchAccess(page: Page) {
    await page.route(`**/api/branches/${branchId}/access`, route => fulfillJson(route, {
        branchId,
        branchName: "Import Test Branch",
        organizationId: "org_import_test",
        isOwner: true,
        role: "OWNER",
        permissions: {
            manage_org: true,
            manage_branch: true,
            students: true,
            seat_allocation: true,
            view_payments: true,
            generate_payments: true,
            mark_payment_paid: true,
            waive_payments: true,
            analytics: true,
            view_whatsapp: true,
            send_whatsapp: true,
            manage_whatsapp: true,
            staff_management: true,
        },
        effectivePlan: "PRO",
        entitlements: ["ADVANCED_ANALYTICS", "STAFF_MANAGEMENT", "AI_ACCESS"],
        billingExperience: {
            accessMode: "FULL_ACCESS",
            customerMessage: "",
            branch: { billingStatus: "ACTIVE" },
            viewer: { canManageBilling: true },
        },
    }));
}

async function mockRecipes(page: Page) {
    await page.route(`**/api/branches/${branchId}/import-recipes`, route => fulfillJson(route, []));
}

function analysisRun(status: string) {
    return {
        id: "run_analysis",
        importSessionId: "session_pdf",
        importPlanId: null,
        targetRevision: 0,
        kind: "ANALYSIS",
        status,
        totalItems: 0,
        completedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        skippedItems: 0,
        cancelledItems: 0,
        createdAt: now,
        updatedAt: now,
    };
}

function reviewDetail(goal: "STUDENTS" | "FULL" = "STUDENTS") {
    const attention = Array.from({ length: 7 }, (_, index) => ({
        code: `ISSUE_${index + 1}`,
        label: `Issue ${index + 1}`,
        severity: "warning",
        count: 1,
        message: `Review issue ${index + 1}.`,
        action: "Review the affected row.",
        fields: ["student.name"],
        sampleRowNumbers: [2],
    }));
    const paymentOptions = goal === "FULL" ? {
        paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
        paymentAction: "GENERATE_DUE",
        paymentHistoryMode: "FROM_JOINED_MARK_DUE",
    } : {};
    return {
        id: "session_review",
        status: "NEEDS_INFO",
        engineVersion: 2,
        goal,
        sourceType: "CSV",
        fileName: "students.csv",
        draftRevision: 2,
        activeEvaluationRevision: 2,
        updatedAt: now,
        fileMeta: {
            parser: {
                headers: [
                    { index: 0, original: "Name", column: "column_1: Name", wasBlank: false },
                    { index: 1, original: "Phone", column: "column_2: Phone", wasBlank: false },
                ],
            },
        },
        mapping: {
            entityTypesDetected: goal === "FULL" ? ["STUDENT", "PAYMENT"] : ["STUDENT"],
            columnMappings: [
                { sourceColumn: "column_1: Name", targetField: "student.name", confidence: 100, source: "MANUAL", needsReview: false },
                { sourceColumn: "column_2: Phone", targetField: "student.phone", confidence: 100, source: "MANUAL", needsReview: false },
            ],
            importOptions: paymentOptions,
            warnings: [],
            usedFallback: false,
            analysis: {
                sourceProfile: {
                    rowCount: 1,
                    columnCount: 2,
                    emptyCellRate: 0,
                    highSignalColumns: ["column_1: Name", "column_2: Phone"],
                    lowSignalColumns: [],
                    columns: [
                        { column: "column_1: Name", inferredType: "text", blankRatio: 0, uniqueRatio: 1, sampleValues: ["Asha"] },
                        { column: "column_2: Phone", inferredType: "phone", blankRatio: 0, uniqueRatio: 1, sampleValues: ["98••••••10"] },
                    ],
                },
                attention,
                pipeline: [],
                detectedPaymentValues: [],
            },
        },
        summary: {
            totalRows: 1,
            readyRows: 0,
            needsReviewRows: 1,
            blockedRows: 0,
            warningRows: 0,
            duplicateRows: 0,
            conflictRows: 0,
            skippedRows: 0,
            readinessScore: 0,
            openQuestions: 1,
            detectedEntityCounts: goal === "FULL" ? { STUDENT: 1, PAYMENT: 1 } : { STUDENT: 1 },
            attention,
        },
        rows: [{
            id: "row_1",
            rowNumber: 2,
            rawData: { "column_1: Name": "Asha", "column_2: Phone": "9876543210" },
            mappedData: null,
            normalizedData: { student: { name: "Asha", phone: "9876543210", joinedAt: "2026-08-01", monthlyFee: 1000 } },
            status: "NEEDS_REVIEW",
            issues: [],
            warnings: [{ code: "ISSUE_7", message: "Review issue 7.", severity: "warning", field: "student.name" }],
            confidence: 80,
            skipped: false,
        }],
        rowPage: {
            filter: "attention",
            issueCode: null,
            limit: 120,
            cursor: null,
            nextCursor: null,
            hasMore: false,
            totalRows: 1,
            filteredRows: 1,
            returnedRows: 1,
        },
        branchContext: { seats: [], shifts: [], multiShifts: [], defaultFee: 0, defaultAdmissionFee: 0 },
        questions: [{
            id: "question_1",
            rowId: null,
            field: "student.name",
            question: "How should ambiguous names be handled?",
            options: ["KEEP_SOURCE"],
            status: "OPEN",
        }],
        commits: [],
        latestRun: null,
    };
}

test("goal chooser stays short and workbook review accepts any header row", async ({ page }) => {
    await mockBranchAccess(page);
    let postCount = 0;
    let submittedHeaderRow: string | null = null;
    await page.route(`**/api/branches/${branchId}/import-sessions`, async route => {
        if (route.request().method() === "GET") return fulfillJson(route, []);
        postCount += 1;
        if (postCount > 1) {
            const multipart = route.request().postData() ?? "";
            submittedHeaderRow = /name="headerRow"\r?\n\r?\n8(?:\r?\n|--)/.test(multipart) ? "8" : null;
        }
        return fulfillJson(route, {
            error: "Select the worksheet and header row before importing.",
            code: "IMPORT_WORKBOOK_SELECTION_REQUIRED",
            workbook: {
                format: "XLSX",
                sheets: [{
                    name: "Students",
                    populatedRows: 20,
                    columnCount: 4,
                    suggestedHeaderRow: 1,
                    headerCandidates: [{ rowNumber: 1, values: ["Report title"], filledCells: 1 }],
                }],
            },
        }, 422);
    });

    await page.goto(`/branch/${branchId}/onboarding/import`);
    await expect(page.getByRole("heading", { name: "Import assistant" })).toBeVisible();

    const allocationsGoal = page.locator('button[aria-pressed]').filter({ hasText: "Students + seats" });
    await allocationsGoal.click();
    await expect(page.getByRole("button", { name: /Upload and review students \+ seats/i })).toBeVisible();

    const fullGoal = page.locator('button[aria-pressed]').filter({ hasText: "Full import" });
    await fullGoal.click();
    await expect(page.getByRole("button", { name: /Upload and review full import/i })).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
        name: "students.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from("browser-workbook-fixture"),
    });
    await page.getByRole("button", { name: /Upload and review full import/i }).click();

    await expect(page.getByRole("group", { name: "Choose worksheet headings" })).toBeVisible();
    const manualHeader = page.getByRole("spinbutton", { name: "Header row number" });
    await manualHeader.fill("8");
    await expect(manualHeader).toHaveValue("8");
    await expect(page.getByRole("button", { name: "Continue with selected worksheet" })).toBeEnabled();
    await page.getByRole("button", { name: "Continue with selected worksheet" }).click();
    await expect.poll(() => submittedHeaderRow).toBe("8");

    await page.getByRole("button", { name: "Paste table" }).click();
    const paste = page.getByRole("textbox", { name: /Paste rows with a header/i });
    await paste.evaluate(element => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(element, "\\".repeat(2_240_000));
        element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.getByRole("button", { name: /Upload and review full import/i }).click();
    await expect(page.getByRole("alert")).toContainText("exceed the 4.25 MiB request limit");
    expect(postCount).toBe(2);
});

test("a persisted PDF waiting state resumes after reload and requires confirmation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBranchAccess(page);
    await mockRecipes(page);
    let confirmed = false;
    await page.route(`**/api/branches/${branchId}/import-sessions`, async route => {
        if (route.request().method() === "GET") {
            return fulfillJson(route, [{
                id: "session_pdf",
                branchId,
                sourceType: "PDF",
                fileName: "register.pdf",
                status: "UPLOADED",
                engineVersion: 2,
                goal: "STUDENTS",
                draftRevision: 0,
                activeEvaluationRevision: null,
                archivedAt: null,
                updatedAt: now,
                summary: { totalRows: 1, readinessScore: 0 },
            }]);
        }
        return fulfillJson(route, {
            sessionId: "session_pdf",
            runId: "run_analysis",
            status: "WAITING_FOR_USER",
            requiresPdfConfirmation: true,
            extractionPreview: [{ "column_1: Name": "Asha" }],
        }, 202);
    });
    await page.route(`**/api/branches/${branchId}/import-sessions/session_pdf?**`, route => {
        const rowFilter = new URL(route.request().url()).searchParams.get("rowFilter") ?? "all";
        return fulfillJson(route, {
            ...reviewDetail("STUDENTS"),
            id: "session_pdf",
            status: "UPLOADED",
            sourceType: "PDF",
            fileName: "register.pdf",
            draftRevision: 0,
            activeEvaluationRevision: null,
            sourceConfiguration: { pdfConfirmed: false },
            extractionPreview: [{
                rowNumber: 2,
                rawData: { "column_1: Name": "Asha", "column_2: Phone": "9876543210" },
            }],
            mapping: null,
            questions: [],
            summary: { ...reviewDetail("STUDENTS").summary, attention: [], openQuestions: 0 },
            // Real unanalysed PDF rows are PENDING, so an attention page is empty.
            rows: [],
            rowPage: {
                filter: rowFilter,
                issueCode: null,
                limit: 120,
                cursor: null,
                nextCursor: null,
                hasMore: false,
                totalRows: 1,
                filteredRows: 0,
                returnedRows: 0,
            },
            latestRun: analysisRun("WAITING_FOR_USER"),
        });
    });
    await page.route(`**/api/branches/${branchId}/import-runs/run_analysis`, route => fulfillJson(route, analysisRun(confirmed ? "RUNNING" : "WAITING_FOR_USER")));
    await page.route(`**/api/branches/${branchId}/import-sessions/session_pdf/analyze`, async route => {
        expect(await route.request().postDataJSON()).toEqual({ confirmPdfExtraction: true });
        confirmed = true;
        return fulfillJson(route, { runId: "run_analysis", status: "RUNNING" }, 202);
    });

    await page.goto(`/branch/${branchId}/onboarding/import`);
    await page.locator('input[type="file"]').setInputFiles({ name: "register.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-browser") });
    await page.getByRole("button", { name: /Upload and review students/i }).click();
    await expect(page.getByRole("heading", { name: "Review PDF extraction" })).toBeVisible();

    await page.reload();
    const resume = page.getByRole("button", { name: "Resume register.pdf" });
    await resume.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Review PDF extraction" })).toBeVisible();
    await expect(page.getByLabel("PDF extraction review")).toBeFocused();
    await expect(page.getByRole("table", { name: "Persisted extracted PDF sample rows" })).toContainText("Asha");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("checkbox", { name: /I reviewed the sample/ })).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Confirm and analyze PDF" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("PDF extraction confirmed. Analysis is running in the background.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("attention groups, all-affected bulk actions, hidden goal fields, and dirty guards work accessibly", async ({ page }) => {
    await mockBranchAccess(page);
    let bulkPayload: unknown = null;
    let mappingSaveCount = 0;
    const issueRequests: Array<string | null> = [];
    await page.route(`**/api/branches/${branchId}/import-recipes`, route => fulfillJson(route, [{
        id: "recipe_1",
        name: "Reviewed student register",
        revision: 1,
        goal: "STUDENTS",
        sourceType: "CSV",
        sourceFingerprint: "fingerprint",
        sourceColumns: ["column 1 name", "column 2 phone"],
        entityTypes: ["STUDENT"],
        columnMappings: [
            { sourceColumn: "column 1 name", targetField: "student.name" },
            { sourceColumn: "column 2 phone", targetField: "ignore" },
        ],
        useCount: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
    }]));
    await page.route(`**/api/branches/${branchId}/import-sessions/session_review?**`, route => {
        const issueCode = new URL(route.request().url()).searchParams.get("issueCode");
        issueRequests.push(issueCode);
        const detail = reviewDetail("STUDENTS");
        return fulfillJson(route, {
            ...detail,
            rowPage: { ...detail.rowPage, issueCode },
        });
    });
    await page.route(`**/api/branches/${branchId}/import-sessions/session_review/mapping`, route => {
        mappingSaveCount += 1;
        return fulfillJson(route, reviewDetail("STUDENTS"));
    });
    await page.route(`**/api/branches/${branchId}/import-sessions/session_review/rows/preview`, route => fulfillJson(route, {
        rowId: "row_1",
        rowNumber: 2,
        status: "NEEDS_REVIEW",
        normalizedData: reviewDetail("STUDENTS").rows[0].normalizedData,
        issues: [],
        warnings: reviewDetail("STUDENTS").rows[0].warnings,
        paymentPreview: { enabled: false, amount: null, amountSource: "NONE", message: "Payments skipped.", blockers: [] },
        suggestedFixes: [],
    }));
    await page.route(`**/api/branches/${branchId}/import-sessions/session_review/rows`, async route => {
        bulkPayload = await route.request().postDataJSON();
        return fulfillJson(route, reviewDetail("STUDENTS"));
    });

    await page.goto(`/branch/${branchId}/onboarding/import/session_review?goal=STUDENTS`);
    await expect(page.getByText("Issue 7", { exact: true })).toBeVisible();

    await page.getByLabel("Custom answer for How should ambiguous names be handled?").fill("Keep the source spelling");
    await page.getByText("Issue 7", { exact: true }).click();
    const discardDialog = page.getByRole("dialog", { name: "Discard unsaved import changes?" });
    await expect(discardDialog).toContainText("custom decision answer");
    await discardDialog.getByRole("button", { name: "Discard and continue" }).click();
    await expect.poll(() => issueRequests).toContain("ISSUE_7");

    await page.getByRole("button", { name: "Skip all 1 affected" }).click();
    await expect.poll(() => bulkPayload).toMatchObject({
        expectedRevision: 2,
        bulkAction: { action: "SKIP", issueCode: "ISSUE_7" },
    });

    await page.getByRole("button", { name: /^Columns/ }).click();
    await expect(page.getByText("Student status is not imported; every new student starts active.", { exact: false })).toBeVisible();
    const fieldSelect = page.getByRole("combobox", { name: /ERP field for A · Name/ });
    await fieldSelect.click();
    await expect(page.getByText("Payments", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await expect(page.getByText("Reviewed student register", { exact: true })).toBeVisible();
    const phoneField = page.getByRole("combobox", { name: /ERP field for B · Phone/ });
    await expect(phoneField).toContainText("Phone number");
    expect(mappingSaveCount).toBe(0);
    await page.getByRole("button", { name: "Use recipe, then review" }).click();
    await expect(phoneField).toContainText("Do not import this column");
    expect(mappingSaveCount).toBe(0);
    await expect(page.getByRole("button", { name: "Confirm columns" })).toBeEnabled();

    const axe = await new AxeBuilder({ page }).include("main").analyze();
    expect(
        axe.violations.filter(item => item.impact === "critical" || item.impact === "serious"),
        axe.violations.map(item => `${item.id}: ${item.help}`).join("\n")
    ).toEqual([]);
});

test("review shows exact aggregate payment totals and background progress uses live semantics", async ({ page }) => {
    await mockBranchAccess(page);
    await mockRecipes(page);
    const detail = {
        ...reviewDetail("FULL"),
        status: "READY_TO_COMMIT",
        summary: {
            ...reviewDetail("FULL").summary,
            readyRows: 1,
            needsReviewRows: 0,
            warningRows: 0,
            readinessScore: 100,
            openQuestions: 0,
            attention: [],
        },
        questions: [],
        rows: [],
        rowPage: { filter: "attention", limit: 120, cursor: null, nextCursor: null, hasMore: false, totalRows: 1, filteredRows: 0, returnedRows: 0 },
    };
    await page.route(`**/api/branches/${branchId}/import-sessions/session_review?**`, route => fulfillJson(route, detail));
    await page.route(`**/api/branches/${branchId}/import-sessions/session_review/plans`, route => fulfillJson(route, {
        id: "plan_1",
        revision: 2,
        readinessPolicy: "READY_ROWS_ONLY",
        planVersion: "plan-hash-1",
        canRun: true,
        totalRows: 1,
        readyRows: 1,
        blockedRows: 0,
        warningRows: 0,
        skippedRows: 0,
        checks: [{ code: "READY_ROWS", status: "pass", count: 1, message: "One row is ready." }],
        summary: {
            totalRows: 1,
            readyRows: 1,
            blockedRows: 0,
            warningRows: 0,
            skippedRows: 0,
            requiredPermissions: ["students", "generate_payments"],
            mutations: {
                total: 7,
                configuration: 0,
                students: 1,
                allocations: 0,
                paymentCycles: 6,
                affectedRows: { students: 1, allocations: 0, payments: 1, configuration: 0 },
                payments: {
                    historical: { DUE: 1, PAID: 2, WAIVED: 1 },
                    current: { DUE: 1, PAID: 0, WAIVED: 1 },
                },
                paymentBreakdown: [{
                    rowId: "row_1",
                    rowNumber: 2,
                    studentName: "Asha",
                    historical: { DUE: 1, PAID: 2, WAIVED: 1 },
                    current: { DUE: 1, PAID: 0, WAIVED: 1 },
                    total: 6,
                }],
            },
        },
        requiredPermissions: ["students", "generate_payments"],
        paymentDetails: { totalCycles: 6, affectedStudents: 1, maxPageSize: 100 },
        configurationApproval: { required: false, approved: false, affectedRows: 0 },
        createdAt: now,
    }, 201));
    await page.route(`**/api/branches/${branchId}/import-sessions/session_review/plans/plan_1/payments?**`, route => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor");
        const firstPage = [
            { itemKey: "cycle_1", bucket: "historical", status: "DUE", referenceId: "TX-HIST-1" },
            { itemKey: "cycle_2", bucket: "historical", status: "PAID", method: "UPI", referenceId: "TX-HIST-2" },
            { itemKey: "cycle_3", bucket: "historical", status: "WAIVED" },
        ];
        const secondPage = [
            { itemKey: "cycle_4", bucket: "historical", status: "PAID", method: "CASH" },
            { itemKey: "cycle_5", bucket: "current", status: "DUE", referenceId: "TX-CURRENT" },
            { itemKey: "cycle_6", bucket: "current", status: "WAIVED" },
        ];
        const cycles = (cursor ? secondPage : firstPage).map((cycle, index) => ({
            ...cycle,
            rowId: "row_1",
            rowNumber: 2,
            studentName: "Asha",
            periodStart: `2026-0${index + (cursor ? 4 : 1)}-01`,
            periodEnd: `2026-0${index + (cursor ? 4 : 1)}-28`,
            dueDate: `2026-0${index + (cursor ? 4 : 1)}-05`,
            amount: 1000,
        }));
        return fulfillJson(route, {
            planId: "plan_1",
            revision: 2,
            planVersion: "plan-hash-1",
            totalCycles: 6,
            affectedStudents: 1,
            cycles,
            page: {
                limit: 3,
                cursor,
                nextCursor: cursor ? null : "cycle_3",
                hasMore: !cursor,
                returnedCycles: cycles.length,
            },
        });
    });

    await page.goto(`/branch/${branchId}/onboarding/import/session_review?goal=FULL`);
    await page.getByRole("button", { name: "Build reviewed plan" }).click();
    await expect(page.getByText("Exact payment totals")).toBeVisible();
    for (const label of ["Historical due", "Historical paid", "Historical waived", "Current due", "Current paid", "Current waived"]) {
        await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await page.getByText(/Payment history by student/).click();
    const exactPayments = page.getByRole("table", { name: "Exact immutable payment cycle records in this reviewed import plan" });
    await expect(exactPayments).toContainText("TX-HIST-1");
    await expect(exactPayments).toContainText("₹1,000");
    await page.getByRole("button", { name: "Next exact records" }).click();
    await expect(exactPayments).toContainText("TX-CURRENT");
    await expect(page.getByRole("progressbar", { name: "Import readiness" })).toHaveAttribute("aria-valuenow", "100");
    await expect(page.getByRole("button", { name: /Import 1 ready row/ })).toBeEnabled();
});

test("completed issues expose both exports and recipe saving requires an explicit submit", async ({ page }) => {
    await mockBranchAccess(page);
    let recipePosts = 0;
    const completedRun = {
        id: "run_issues",
        importSessionId: "session_issues",
        importPlanId: "plan_issues",
        targetRevision: 2,
        kind: "COMMIT",
        status: "COMPLETED_WITH_ISSUES",
        totalItems: 5,
        completedItems: 5,
        succeededItems: 3,
        failedItems: 2,
        skippedItems: 0,
        cancelledItems: 0,
        createdAt: now,
        updatedAt: now,
    };
    await page.route(`**/api/branches/${branchId}/import-recipes`, async route => {
        if (route.request().method() === "GET") return fulfillJson(route, []);
        recipePosts += 1;
        return fulfillJson(route, {
            id: "recipe_saved",
            name: "Confirmed import recipe",
            revision: 1,
            goal: "STUDENTS",
            sourceType: "CSV",
            sourceFingerprint: "saved",
            sourceColumns: ["column 1 name", "column 2 phone"],
            entityTypes: ["STUDENT"],
            columnMappings: [],
            useCount: 0,
            lastUsedAt: null,
            createdAt: now,
            updatedAt: now,
        }, 201);
    });
    await page.route(`**/api/branches/${branchId}/import-sessions/session_issues?**`, route => fulfillJson(route, {
        ...reviewDetail("STUDENTS"),
        id: "session_issues",
        status: "PARTIAL",
        questions: [],
        summary: { ...reviewDetail("STUDENTS").summary, attention: [], openQuestions: 0 },
        rows: [],
        latestRun: completedRun,
    }));
    await page.route(`**/api/branches/${branchId}/import-runs/run_issues`, route => fulfillJson(route, completedRun));

    await page.goto(`/branch/${branchId}/onboarding/import/session_issues?goal=STUDENTS`);
    await expect(page.getByText("Import finished with issues", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download error CSV" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download error XLSX" })).toBeVisible();

    await page.getByLabel("Recipe name").fill("Confirmed import recipe");
    expect(recipePosts).toBe(0);
    await page.getByRole("button", { name: "Save recipe" }).click();
    await expect.poll(() => recipePosts).toBe(1);
    await expect(page.getByText("Recipe saved", { exact: true })).toBeVisible();
});

test("reopening an unattached retrying import reconnects once, restores progress, and supports cancellation", async ({ page }) => {
    await mockBranchAccess(page);
    await mockRecipes(page);
    let cancelled = false;
    let resumed = false;
    let resumeAttempts = 0;
    const runningRun = {
        id: "run_commit",
        importSessionId: "session_running",
        importPlanId: "plan_running",
        targetRevision: 2,
        kind: "COMMIT",
        status: "RETRYABLE_FAILURE",
        totalItems: 10,
        completedItems: 4,
        succeededItems: 3,
        failedItems: 1,
        skippedItems: 0,
        cancelledItems: 0,
        createdAt: now,
        updatedAt: now,
        workflowAttached: false,
        dispatchRequired: true,
    };
    await page.route(`**/api/branches/${branchId}/import-sessions/session_running?**`, route => fulfillJson(route, {
        ...reviewDetail("STUDENTS"),
        id: "session_running",
        status: "COMMITTING",
        questions: [],
        summary: { ...reviewDetail("STUDENTS").summary, attention: [], openQuestions: 0 },
        latestRun: runningRun,
    }));
    await page.route(`**/api/branches/${branchId}/import-runs/run_commit`, route => fulfillJson(route, {
        ...runningRun,
        status: cancelled ? "CANCEL_REQUESTED" : resumed ? "RUNNING" : "RETRYABLE_FAILURE",
        workflowAttached: resumed,
        dispatchRequired: !resumed,
    }));
    await page.route(`**/api/branches/${branchId}/import-runs/run_commit/resume`, route => {
        resumeAttempts += 1;
        resumed = true;
        return fulfillJson(route, {
            runId: "run_commit",
            status: "RUNNING",
            dispatchPending: false,
            workflowAttached: true,
            dispatchRequired: false,
        }, 202);
    });
    await page.route(`**/api/branches/${branchId}/import-runs/run_commit/cancel`, route => {
        cancelled = true;
        return fulfillJson(route, { runId: "run_commit", status: "CANCEL_REQUESTED" }, 202);
    });

    await page.goto(`/branch/${branchId}/onboarding/import/session_running?goal=STUDENTS`);
    const progress = page.getByRole("progressbar", { name: "Background import progress" });
    await expect(progress).toHaveAttribute("aria-valuenow", "40");
    await expect(page.getByText("Background processing reconnected. Progress is refreshing.")).toBeVisible();
    expect(resumeAttempts).toBe(1);
    await expect(page.getByRole("status").filter({ hasText: "Import is running in the background" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel import" }).click();
    await expect(page.getByText("Cancellation requested. Work already completed remains saved.")).toBeVisible();
});
