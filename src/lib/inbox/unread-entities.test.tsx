// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { resetSessionReads } from '@/lib/session-read';
import {
  entityKey,
  mapUnreadEntities,
  markEntityReadOnOpen,
  planItemsUnreadTotal,
  resetUnreadEntitiesForTest,
  unreadCommentsLabel,
  useEntityUnread,
  usePlanItemsUnreadTotal,
  useUnreadEntitiesSync,
} from '@/lib/inbox/unread-entities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { entity_type: string; entity_id: string; unread: number };

function answer(rows: Row[]): void {
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'inbox_unread_entity_counts'
        ? { data: rows, error: null }
        : { data: null, error: null },
    ),
  );
}

/** The driver plus two readers, painted as text the tests read back. */
function Harness(props: { ws: string; withSync?: boolean }): ReactElement {
  return (
    <>
      {props.withSync === false ? null : <Sync ws={props.ws} />}
      <Readout />
    </>
  );
}

function Sync(props: { ws: string }): null {
  useUnreadEntitiesSync('user-1', props.ws);
  return null;
}

function Readout(): ReactElement {
  const post = useEntityUnread('post', 'p1');
  const item = useEntityUnread('plan_item', 'i1');
  const plan = usePlanItemsUnreadTotal();
  return <output>{`${post}|${item}|${plan}`}</output>;
}

let host: HTMLDivElement;
let root: Root;

function mount(ws: string, withSync = true): void {
  act(() => root.render(<Harness ws={ws} withSync={withSync} />));
}

function shown(): string {
  return host.querySelector('output')?.textContent ?? '';
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function calls(fn: string): unknown[][] {
  return rpc.mock.calls.filter((call) => call[0] === fn);
}

beforeEach(() => {
  rpc.mockReset();
  resetSessionReads();
  resetUnreadEntitiesForTest();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetUnreadEntitiesForTest();
});

describe('pure helpers', () => {
  it('maps rows to keyed counts, dropping unknown types, blank ids and zeros', () => {
    expect(
      mapUnreadEntities([
        { entity_type: 'post', entity_id: 'p1', unread: 3 },
        { entity_type: 'plan_item', entity_id: 'i1', unread: '2' },
        { entity_type: 'brief', entity_id: 'b1', unread: 4 },
        { entity_type: 'post', entity_id: '', unread: 1 },
        { entity_type: 'post', entity_id: 'p2', unread: 0 },
      ]),
    ).toEqual({ 'post:p1': 3, 'plan_item:i1': 2 });
    expect(mapUnreadEntities(null)).toEqual({});
  });

  it('sums only plan items for the Plan nav badge', () => {
    expect(planItemsUnreadTotal({ 'post:p1': 5, 'plan_item:a': 2, 'plan_item:b': 3 })).toBe(5);
    expect(entityKey('plan_item', 'x')).toBe('plan_item:x');
  });

  it('names the marker in words', () => {
    expect(unreadCommentsLabel(1)).toBe('1 unread comment');
    expect(unreadCommentsLabel(4)).toBe('4 unread comments');
  });
});

describe('the shared store', () => {
  it('reads once after mount and feeds every reader', async () => {
    answer([
      { entity_type: 'post', entity_id: 'p1', unread: 3 },
      { entity_type: 'plan_item', entity_id: 'i1', unread: 2 },
    ]);
    mount('ws-1');
    await settle();
    expect(shown()).toBe('3|2|2');
    expect(calls('inbox_unread_entity_counts')).toHaveLength(1);
    expect(calls('inbox_unread_entity_counts')[0]?.[1]).toMatchObject({ p_workspace_id: 'ws-1' });
  });

  it('reads 0 with no driver mounted and makes no call', () => {
    mount('ws-1', false);
    expect(shown()).toBe('0|0|0');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('re-reads on an inbox change', async () => {
    answer([{ entity_type: 'post', entity_id: 'p1', unread: 3 }]);
    mount('ws-1');
    await settle();
    answer([]);
    act(() => {
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
    });
    await settle();
    expect(calls('inbox_unread_entity_counts')).toHaveLength(2);
    expect(shown()).toBe('0|0|0');
  });

  it('a workspace switch never shows the old workspace counts', async () => {
    answer([{ entity_type: 'post', entity_id: 'p1', unread: 3 }]);
    mount('ws-1');
    await settle();
    expect(shown()).toBe('3|0|0');
    rpc.mockImplementation(() => new Promise(() => {}));
    mount('ws-2');
    expect(shown()).toBe('0|0|0');
  });

  it('opening an entity clears its marker at once and calls the proc once', async () => {
    answer([{ entity_type: 'post', entity_id: 'p1', unread: 3 }]);
    mount('ws-1');
    await settle();
    act(() => markEntityReadOnOpen('post', 'p1'));
    expect(shown()).toBe('0|0|0');
    const marks = calls('inbox_mark_entity_read');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.[1]).toMatchObject({
      p_workspace_id: 'ws-1',
      p_entity_type: 'post',
      p_entity_id: 'p1',
    });
  });

  it('opening an entity with no unread comments calls nothing', async () => {
    answer([{ entity_type: 'post', entity_id: 'p1', unread: 3 }]);
    mount('ws-1');
    await settle();
    act(() => markEntityReadOnOpen('post', 'other'));
    await settle();
    expect(calls('inbox_mark_entity_read')).toHaveLength(0);
  });

  it('a failed mark restores the count quietly', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'inbox_unread_entity_counts'
          ? { data: [{ entity_type: 'plan_item', entity_id: 'i1', unread: 2 }], error: null }
          : { data: null, error: { message: 'boom' } },
      ),
    );
    mount('ws-1');
    await settle();
    act(() => markEntityReadOnOpen('plan_item', 'i1'));
    expect(shown()).toBe('0|0|0');
    await settle();
    expect(shown()).toBe('0|2|2');
  });
});
