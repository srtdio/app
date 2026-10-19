// X4 test helpers: a task and a fake UseChatTasks the sheet can render.
import { vi } from 'vitest';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import type { ChatTask } from '@/lib/chat/tasks';

export function x4Task(over: Partial<ChatTask>): ChatTask {
  const now = new Date().toISOString();
  return {
    id: 't1',
    channelId: 'c1',
    number: 3,
    title: 'Reel cut',
    note: null,
    side: 'agency',
    status: 'todo',
    priority: 2,
    dueAt: null,
    dueSetBy: null,
    dueSetAt: null,
    duePassedAt: null,
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
    pending: [],
    failed: new Map(),
    hiddenIds: new Set(),
    nameOf: () => 'You',
    refetch: vi.fn(),
    ensureEventsSince: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(async () => true),
    save: vi.fn(),
    retryField: vi.fn(),
    remove: vi.fn(),
    loadTask: vi.fn(),
    retryCreate: vi.fn(),
    removeCreate: vi.fn(),
    ...over,
  };
}

/** Type into a controlled input the way React hears it. */
export function x4Type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
