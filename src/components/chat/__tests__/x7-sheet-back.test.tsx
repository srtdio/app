// @vitest-environment jsdom
// X7 fix 6 (FT40): Forward, Schedule, Priority, Who reacted, Message info and
// Reminder are history steps, so system Back closes only the sheet and the
// chat under it stays open.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PrioritySheet } from '@/components/chat/MarksSheet';
import { SHEET_STEP_KEYS } from '@/lib/chat/sheet-steps';
import {
  HISTORY_STEP_KEYS,
  resetHistorySteps,
  stepMarkerOf,
  useHistoryStep,
} from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));
const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** A chat layer (its own step), then the Priority sheet opened over it. */
function Harness(props: { sheet: boolean; onChatBack: () => void; onSheetClose: () => void }) {
  const [chatOpen, setChatOpen] = useState(true);
  const [closed, setClosed] = useState(false);
  const sheetOpen = props.sheet && !closed;
  useHistoryStep(chatOpen, HISTORY_STEP_KEYS.threadView, () => {
    props.onChatBack();
    setChatOpen(false);
  });
  return (
    <div data-chat={chatOpen ? 'open' : 'closed'}>
      {chatOpen ? (
        <PrioritySheet
          open={sheetOpen}
          title="Mark as Pending"
          current={undefined}
          busy={false}
          onChoose={() => {}}
          onClose={() => {
            props.onSheetClose();
            setClosed(true);
          }}
        />
      ) : null}
    </div>
  );
}

beforeEach(() => resetHistorySteps());

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('X7 FT40: system Back closes only the sheet', () => {
  it('open Priority over a chat, system Back: the sheet closes, the chat stays open', async () => {
    const onChatBack = vi.fn();
    const onSheetClose = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Harness sheet={false} onChatBack={onChatBack} onSheetClose={onSheetClose} />);
    });
    await settle();
    // The sheet opens later, over the chat, as a tap would open it.
    await act(async () => {
      root?.render(<Harness sheet onChatBack={onChatBack} onSheetClose={onSheetClose} />);
    });
    await settle();
    expect(stepMarkerOf(window.history.state, SHEET_STEP_KEYS.priority)).not.toBeNull();

    await act(async () => {
      window.history.back();
      await wait(60);
    });
    expect(onSheetClose).toHaveBeenCalledTimes(1);
    expect(onChatBack).not.toHaveBeenCalled();
    expect(host.querySelector('[data-chat="open"]')).not.toBeNull();
    // The chat's own step is on top again: the next Back closes the chat.
    expect(stepMarkerOf(window.history.state, HISTORY_STEP_KEYS.threadView)).not.toBeNull();
  });

  it('Forward, Schedule, Who reacted and Reminder push their own step; Message info has one', () => {
    expect(source('../ForwardPicker.tsx')).toContain(
      'useHistoryStep(props.open && props.historyStep === true, SHEET_STEP_KEYS.forward, props.onClose)',
    );
    // The chat's own picker opts in; the Tasks sheet's nested one (X4) does not.
    expect(source('../MessageThread.tsx')).toMatch(/<ForwardPicker\s+historyStep\s/);
    expect(source('../ScheduleSheet.tsx')).toContain(
      'useHistoryStep(props.open, SHEET_STEP_KEYS.schedule, props.onClose)',
    );
    expect(source('../ReadingLayer.tsx')).toContain(
      'useHistoryStep(messageId !== null, SHEET_STEP_KEYS.whoReacted, props.onClose)',
    );
    expect(source('../ReminderSheet.tsx')).toContain(
      'useHistoryStep(props.open, SHEET_STEP_KEYS.reminder, props.onClose)',
    );
    expect(source('../MarksSheet.tsx')).toContain(
      'useHistoryStep(props.open, SHEET_STEP_KEYS.priority, props.onClose)',
    );
    expect(source('../MessageThread.tsx')).toContain('HISTORY_STEP_KEYS.readInfo');
    expect(new Set(Object.values(SHEET_STEP_KEYS)).size).toBe(5);
  });
});
