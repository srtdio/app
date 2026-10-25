import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { buildWorld } from '../fixtures/chat-data';
import { ONBOARDING_NOW, ONBOARDING_SCREENS, signOut } from '../visual/onboarding-steps';

// PR C before/after captures of the onboarding screens. Not a test: every
// screen is walked by the same walker the visual lock uses
// (e2e/visual/onboarding-steps.ts), so a clean run proves each walker reaches
// its screen. The page clock is pinned to ONBOARDING_NOW and the world built at
// that instant, as in screens.spec.ts. The viewport is saved as
// <screen>__<phone|laptop>__<light|dark>.png in AUDIT_OUT; a step that cannot be
// reached still saves the closest state, plus <same name>.note.txt saying why.
// Run through e2e/audit/playwright.audit.config.ts with
// AUDIT_MATCH=capture-pr-c-onboarding.spec.ts. AUDIT_ONLY=a,b limits the run.

const OUT = process.env.AUDIT_OUT ?? path.resolve('e2e/results/audit-shots');
const ONLY = (process.env.AUDIT_ONLY ?? '').split(',').filter(Boolean);

const selected = ONBOARDING_SCREENS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));

for (const screen of selected) {
  test(screen.name, async ({ page }, info) => {
    const [device, scheme] = info.project.name.split('-');
    const file = path.join(OUT, `${screen.name}__${device}__${scheme}`);
    mkdirSync(OUT, { recursive: true });
    await page.clock.setFixedTime(ONBOARDING_NOW);
    await page.routeWebSocket(
      (url) => url.protocol === 'ws:' && url.hostname === 'localhost',
      () => undefined,
    );
    const network = await installHarnessNetwork(page);
    Object.assign(network.world, buildWorld(ONBOARDING_NOW));
    if (screen.signedOut === true) await signOut(page);
    await screen.prepare?.(network, page, ONBOARDING_NOW);
    let note: string | null = null;
    try {
      await page.goto(screen.url);
      await screen.steps(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
    } catch (error) {
      note = error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : String(error);
    }
    // The visual lock fails on any request the fixtures block: say so here too.
    if (note === null && network.blocked.length > 0) {
      note = `blocked non-fixture requests: ${network.blocked.join(', ')}`;
    }
    await page.screenshot({ path: `${file}.png`, animations: 'disabled', caret: 'hide' });
    if (note !== null) writeFileSync(`${file}.note.txt`, `${note}\n`);
  });
}
