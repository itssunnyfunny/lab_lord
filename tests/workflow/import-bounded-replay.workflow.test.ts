import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { boundedReplayFixture } from "./fixtures/bounded-replay.workflow";

describe("Workflow bounded-step replay fixture", () => {
    it("replays deterministic progress across steps capped at 25 items", async () => {
        // The test bundle is intentionally rooted at tests/workflow, while the
        // Vite transform names the imported proxy from the repository root.
        Object.assign(boundedReplayFixture, {
            workflowId: "workflow//./fixtures/bounded-replay.workflow//boundedReplayFixture",
        });
        const run = await start(boundedReplayFixture, [53]);

        await expect(run.returnValue).resolves.toEqual({
            totalItems: 53,
            completedItems: 53,
            batches: [25, 25, 3],
        });
        expect(await run.status).toBe("completed");

        await expect(run.returnValue).resolves.toEqual({
            totalItems: 53,
            completedItems: 53,
            batches: [25, 25, 3],
        });
    });
});
