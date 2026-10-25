import { expect, test, type Route } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';

// Regression: leaving a page while a lazy route chunk is still loading must
// not reload the old page. WebKit rejects the aborted import with a TypeError
// ("Importing a module script failed.") before pagehide fires; the chunk
// handler used to treat that as a stale build and call location.reload(),
// which interrupted the navigation the person (or page.goto) had started.
// Now it reloads only on a proven stale chunk (HEAD 404/410 for its URL).

const BRIEFS_CHUNK = /\/src\/components\/pages\/BriefsPage\.tsx(\?|$)/;

test('a full navigation while a lazy chunk is in flight lands on its target, no reload @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);

  // Hold the Briefs page chunk so its dynamic import is in flight when we leave.
  let releaseChunk: () => void = () => {};
  const chunkGate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  await page.route(BRIEFS_CHUNK, async (route: Route) => {
    await chunkGate;
    // The navigation cancelled the request; answering it then throws.
    await route.continue().catch(() => undefined);
  });

  // Every document load of /briefs; a reload of the old page would add a second.
  const briefsLoads: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && new URL(request.url()).pathname === '/briefs') {
      briefsLoads.push(request.url());
    }
  });

  const chunkRequested = page.waitForRequest(BRIEFS_CHUNK);
  await page.goto('/briefs');
  await chunkRequested;

  // Leave while the chunk is still pending: the goto must complete on its target.
  await page.goto('/pipeline');
  releaseChunk();
  await expect(page).toHaveURL(/\/pipeline$/);

  // Give a late reload (a probe or a rejected import settling) time to fire.
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/pipeline$/);
  expect(briefsLoads, 'the old page was reloaded').toHaveLength(1);
});
