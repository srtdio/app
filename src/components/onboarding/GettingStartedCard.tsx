// Chat home's "Get <workspace> going" checklist for the workspace's owner and
// admins. It opens part-done (creating the workspace counts), ticks itself from
// live counts, and goes away once every item is done or the person hides it.
// Hiding is a per-device convenience (localStorage), not shared state.

import { useEffect, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { gettingStartedItems, type GettingStartedFacts } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';

const HIDE_KEY = 'sorted-getting-started-hidden:';

function readHidden(workspaceId: string): boolean {
  try {
    return localStorage.getItem(HIDE_KEY + workspaceId) === '1';
  } catch {
    return false;
  }
}

function writeHidden(workspaceId: string): void {
  try {
    localStorage.setItem(HIDE_KEY + workspaceId, '1');
  } catch {
    // Storage blocked: the card simply hides for this session.
  }
}

interface Loaded {
  manager: boolean;
  facts: GettingStartedFacts;
}

async function loadFacts(workspaceId: string, userId: string): Promise<Loaded> {
  const [me, posts, clients, assets] = await Promise.all([
    supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .eq('active', true)
      .maybeSingle(),
    supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .neq('stage', 'draft'),
    supabase
      .from('workspace_members')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('role', 'client')
      .is('removed_at', null),
    supabase
      .from('assets')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);
  const role = me.data?.role;
  return {
    manager: role === 'owner' || role === 'admin',
    facts: {
      postsSent: posts.count ?? 0,
      clientsInvited: clients.count ?? 0,
      assets: assets.count ?? 0,
    },
  };
}

export function GettingStartedCard({
  workspaceId,
  workspaceName,
  userId,
}: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
}): ReactElement | null {
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(() => readHidden(workspaceId));
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    setHidden(readHidden(workspaceId));
    setLoaded(null);
    let cancelled = false;
    void loadFacts(workspaceId, userId).then((result) => {
      if (!cancelled) setLoaded(result);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId]);

  if (hidden || loaded === null || !loaded.manager) return null;
  const items = gettingStartedItems(loaded.facts);
  const done = items.filter((item) => item.done).length;
  if (done === items.length) return null;

  return (
    <section
      aria-label={`Get ${workspaceName} going`}
      className="mx-3 mb-1 mt-3 rounded-2xl border border-border bg-panel px-4 pb-2 pt-3.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-fg [text-wrap:balance]">
            Get {workspaceName} going
          </h2>
          <p className="mt-0.5 font-mono text-[11px] text-fg-3">
            {done} of {items.length} done
          </p>
        </div>
        <button
          type="button"
          aria-label="Hide checklist"
          onClick={() => {
            writeHidden(workspaceId);
            setHidden(true);
          }}
          className="-mr-2 -mt-1.5 grid h-11 w-11 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="mb-1 mt-2 h-1 overflow-hidden rounded-full bg-panel-3">
        <span
          className="block h-full rounded-full bg-good transition-[width] motion-reduce:transition-none"
          style={{ width: `${Math.round((done / items.length) * 100)}%` }}
        />
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              disabled={item.done}
              onClick={() => navigate(item.to)}
              className="flex min-h-[52px] w-full items-center gap-3 text-left disabled:cursor-default"
            >
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border-[1.7px]',
                  item.done ? 'border-good bg-good text-white' : 'border-border-strong',
                )}
              >
                {item.done ? (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-[15px] font-semibold',
                    item.done ? 'text-fg-3' : 'text-fg',
                  )}
                >
                  {item.title}
                </span>
                {!item.done && item.hint !== '' ? (
                  <span className="block text-[13px] text-fg-2">{item.hint}</span>
                ) : null}
              </span>
              {!item.done ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 text-fg-3"
                  aria-hidden="true"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
