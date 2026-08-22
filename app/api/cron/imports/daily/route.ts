import { NextResponse } from "next/server";
import { ImportRetentionService } from "@/importing/services/import-retention.service";

export const IMPORT_RETENTION_CRON_BATCH_SIZE = 100;
export const IMPORT_RETENTION_CRON_MAX_BATCHES = 20;

export async function GET(request: Request) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const cutoff = new Date();
        let batchesProcessed = 0;
        let selectedCount = 0;
        let scrubbedRunItemCount = 0;
        let purgedSessionCount = 0;
        let hasMore = true;

        while (hasMore && batchesProcessed < IMPORT_RETENTION_CRON_MAX_BATCHES) {
            const batch = await ImportRetentionService.purgeExpiredStaging({
                now: cutoff,
                limit: IMPORT_RETENTION_CRON_BATCH_SIZE,
            });
            batchesProcessed += 1;
            selectedCount += batch.selectedCount;
            scrubbedRunItemCount += batch.scrubbedRunItemCount;
            purgedSessionCount += batch.purgedSessionCount;
            hasMore = batch.hasMore;
        }

        const remainingBacklog = await ImportRetentionService.countExpiredStaging(cutoff);
        return NextResponse.json({
            ok: true,
            batchesProcessed,
            batchSize: IMPORT_RETENTION_CRON_BATCH_SIZE,
            maxBatches: IMPORT_RETENTION_CRON_MAX_BATCHES,
            selectedCount,
            scrubbedRunItemCount,
            purgedSessionCount,
            remainingBacklog,
            hasMore: remainingBacklog > 0,
            limitReached: batchesProcessed >= IMPORT_RETENTION_CRON_MAX_BATCHES && remainingBacklog > 0,
        });
    } catch (error) {
        console.error("[IMPORTS_DAILY_CRON]", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ error: "Import staging retention failed" }, { status: 500 });
    }
}
