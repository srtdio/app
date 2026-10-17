import type { Page, Route } from '@playwright/test';

// Route overrides for the workspace storage and free-plan limit specs. Each is
// registered after installHarnessNetwork, so it wins over the harness handler;
// a preflight falls back to the harness, which answers it with CORS.

const MiB = 1024 * 1024;
export const WARN_AT_BYTES = 800 * MiB;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
};

async function json(route: Route, status: number, body: unknown): Promise<void> {
  if (route.request().method() === 'OPTIONS') {
    await route.fallback();
    return;
  }
  await route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The harness user is not a platform operator: owning one workspace blocks create. */
export async function routeNotOperator(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/platform_operators/, (route) => json(route, 200, []));
}

/** The asset-upload Worker's GET /usage at this many MB used. */
export async function routeUsage(page: Page, usedMb: number): Promise<void> {
  const usedBytes = usedMb * MiB;
  await page.route(/^https:\/\/asset-upload\.harness\.test\/usage/, (route) =>
    json(route, 200, {
      usedBytes,
      warnAtBytes: WARN_AT_BYTES,
      warn: usedBytes >= WARN_AT_BYTES,
      exempt: false,
    }),
  );
}

/** Every upload POST to the asset-upload Worker answers 413 workspace_full. */
export async function routeUploadFull(page: Page): Promise<void> {
  await page.route(/^https:\/\/asset-upload\.harness\.test\/(?!usage)/, (route) =>
    json(route, 413, { error: { code: 'workspace_full', message: 'This workspace is full.' } }),
  );
}

/** The workspace_storage RPC's one row, sizes in MB. */
export async function routeWorkspaceStorage(
  page: Page,
  mb: { used: number; library: number; chat: number; voice: number; deleted: number },
): Promise<void> {
  await page.route(/\/rest\/v1\/rpc\/workspace_storage/, (route) =>
    json(route, 200, [
      {
        bytes_used: mb.used * MiB,
        library_bytes: mb.library * MiB,
        chat_bytes: mb.chat * MiB,
        voice_bytes: mb.voice * MiB,
        deleted_bytes: mb.deleted * MiB,
      },
    ]),
  );
}

/** book-call-send answers {ok:true}; returns the JSON bodies it received. */
export async function routeBookCall(page: Page): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/functions/v1/book-call-send', async (route) => {
    if (route.request().method() === 'POST') {
      bodies.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    }
    await json(route, 200, { ok: true });
  });
  return bodies;
}

/** Console errors and uncaught page errors, collected for an end-of-test check. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}
