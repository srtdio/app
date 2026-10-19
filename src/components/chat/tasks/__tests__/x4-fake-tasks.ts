// Test helpers: a task and a fake UseChatTasks the sheet can render.
import { vi } from 'vitest';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import type { ChatTask } from '@/lib/chat/tasks';

export function x4Task(over: Partial<ChatTask>): ChatTask {
  const now = '2026-10-19T09:00:00.000Z';
  return {
    id: 't1',
    channelId: 'c1',
    number: 3,
    title: 'Reel cut',
    side: 'agency',
    status: 'todo',
    priority: 2,
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  };
}

export function x4FakeTasks(list: ChatTask[], over: Partial<UseChatTasks> = {}): UseChatTasks {
  return {
    tasks: list,
    events: [],
    lineTasks: new Map(list.map((t) => [t.id, t] as const)),
    loaded: true,
    loadState: 'ready',
    retrying: false,
    covers: () => true,
    nameOf: (id) => (id === 'me' ? 'You' : id === 'u2' ? 'Leo' : 'Member'),
    refetch: vi.fn(),
    ensureEventsSince: vi.fn(),
    saveBatch: vi.fn(async () => ({
      ok: true as const,
      createdIds: [],
      conflicts: [],
      batchId: 'b1',
    })),
    editors: [],
    setEditing: vi.fn(),
    ...over,
  };
}

/** Type into a controlled input the way React hears it. */
export function x4Type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
