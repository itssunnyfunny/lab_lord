import type { Page } from "@playwright/test";

/** Refresh a real saved Clerk session before server-protected navigation.
 * This never fabricates authentication or changes application middleware.
 */
export async function refreshDevelopmentSession(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => {
    const clerk = (window as unknown as { Clerk?: { loaded: boolean } }).Clerk;
    return clerk?.loaded;
  });
  await page.evaluate(async () => {
    const clerk = (window as unknown as {
      Clerk: { session?: { getToken(options: { skipCache: boolean }): Promise<string | null> } };
    }).Clerk;
    if (!clerk.session || !await clerk.session.getToken({ skipCache: true })) {
      throw new Error("Saved Clerk session is unavailable; sign in to the development instance again.");
    }
  });
}
