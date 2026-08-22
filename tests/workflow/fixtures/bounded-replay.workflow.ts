const MAX_FIXTURE_BATCH = 25;

export async function claimFixtureBatch(remainingItems: number) {
    "use step";

    if (!Number.isInteger(remainingItems) || remainingItems < 1) {
        throw new Error("Fixture remaining item count is invalid");
    }
    return Math.min(remainingItems, MAX_FIXTURE_BATCH);
}

export async function boundedReplayFixture(totalItems: number) {
    "use workflow";

    let completedItems = 0;
    const batches: number[] = [];
    while (completedItems < totalItems) {
        const batch = await claimFixtureBatch(totalItems - completedItems);
        batches.push(batch);
        completedItems += batch;
    }
    return { totalItems, completedItems, batches };
}
