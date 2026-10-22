import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// Voice note playback: a tap on play starts the note (the control turns into
// pause and the photo slot into the speed pill); a note whose bytes no browser
// can decode retries once, then shows "Can't play here." and "Read the
// transcript" opens the transcript in the bubble; a note whose bytes never
// arrive fails on the 10s watchdog (twice, with the retry) and shows the same
// row. Tagged @theme and @desktop so
// it runs on iphone-webkit, iphone-webkit-light and desktop-webkit. Linux
// WebKit approximates iOS WebKit; it is not iOS.

async function openVoiceNote(page: Page): Promise<Locator> {
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const note = page.locator('[data-voice-note]').first();
  await note.scrollIntoViewIfNeeded();
  await expect(note).toBeVisible();
  return note;
}

test('voice note: tap play starts playback @theme @desktop', async ({ page }) => {
  await installHarnessNetwork(page);
  const note = await openVoiceNote(page);
  await note.getByRole('button', { name: 'Play voice note' }).click();
  await expect(note.getByRole('button', { name: 'Pause voice note' })).toBeVisible();
  await expect(note.locator('[data-voice-speed]')).toHaveText('1×');
  await expect(note.locator('[data-voice-error]')).toHaveCount(0);
});

test("voice note: a note that can't play offers the transcript @theme @desktop", async ({
  page,
}) => {
  await installHarnessNetwork(page, {
    voiceAudio: 'invalid',
    voiceTranscript: 'See you at the shoot tomorrow',
  });
  const note = await openVoiceNote(page);
  await note.getByRole('button', { name: 'Play voice note' }).click();
  const error = note.locator('[data-voice-error]');
  await expect(error).toContainText("Can't play here.");
  await error.getByRole('button', { name: 'Read the transcript' }).click();
  await expect(note.locator('[data-voice-transcript="open"]')).toContainText(
    'See you at the shoot tomorrow',
  );
  await expect(error).toHaveCount(0);
  await expect(note.getByRole('button', { name: 'Hide text' })).toBeVisible();
});

test("voice note: a note whose bytes never arrive shows Can't play here @theme @desktop", async ({
  page,
}) => {
  // Two 10s watchdog runs (the attempt and its retry) plus the presigns.
  test.setTimeout(90_000);
  await installHarnessNetwork(page, { voiceAudio: 'stall' });
  const note = await openVoiceNote(page);
  await note.getByRole('button', { name: 'Play voice note' }).click();
  await expect(note.locator('[data-voice-error]')).toContainText("Can't play here.", {
    timeout: 45_000,
  });
  await expect(note.getByRole('button', { name: 'Play voice note' })).toBeVisible();
});
