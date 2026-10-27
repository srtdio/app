import type { Page } from '@playwright/test';

/**
 * The device asks to save data (navigator.connection.saveData): the chat list
 * pre-warms no chat, so the first tap on a chat is a cold open. For specs that
 * measure the cold open itself (its one bundle call, what it leaves
 * remembered, its first older page). Call before the first navigation.
 */
export async function withSaveData(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true },
    });
  });
}
