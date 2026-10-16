import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { IconCheck } from '@/components/ui/icons';
import { fetchUnsubscribeStatus, postUnsubscribeAction } from './api';

type PageState = 'loading' | 'subscribed' | 'unsubscribed' | 'invalid';

const buttonBase =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md px-4 text-sm font-medium select-none disabled:opacity-50';
const primaryButton = `${buttonBase} bg-accent text-accent-fg hover:bg-accent-hover`;
const secondaryButton = `${buttonBase} border border-border bg-panel-2 text-fg hover:bg-panel-3`;

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-[420px] rounded-2xl border border-border bg-panel p-6">
      {children}
    </div>
  );
}

/**
 * Public catch-up email unsubscribe page (/unsubscribe?u=..&t=..).
 * Opening it never changes anything; only the button posts.
 */
export function UnsubscribePage() {
  const [params] = useSearchParams();
  const u = params.get('u') ?? '';
  const t = params.get('t') ?? '';
  const [state, setState] = useState<PageState>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (u === '' || t === '') {
      setState('invalid');
      return;
    }
    let active = true;
    setState('loading');
    void fetchUnsubscribeStatus(u, t).then((status) => {
      if (!active) return;
      if (status === null) setState('invalid');
      else setState(status.subscribed ? 'subscribed' : 'unsubscribed');
    });
    return () => {
      active = false;
    };
  }, [u, t]);

  async function submit(action: 'unsubscribe' | 'resubscribe') {
    if (busy) return;
    setBusy(true);
    const status = await postUnsubscribeAction({ u, t, action });
    if (status !== null) setState(status.subscribed ? 'subscribed' : 'unsubscribed');
    setBusy(false);
  }

  return (
    <div
      data-testid="unsubscribe-page"
      data-state={state === 'loading' ? undefined : state}
      className="grid min-h-full w-full place-items-center bg-bg px-4 py-10"
    >
      {state === 'subscribed' && (
        <Card>
          <h1 className="text-lg font-semibold tracking-tight text-fg">Stop catch-up emails?</h1>
          <div className="mt-3 space-y-3 text-sm leading-6 text-fg-2">
            <p>
              {
                "You won't get catch-ups from any of your Sorted workspaces. Everything stays in Sorted; you'll just check it yourself."
              }
            </p>
            <p>
              Invites, login links and password resets still arrive, so you never get locked out.
            </p>
          </div>
          <div className="mt-6 space-y-2">
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => void submit('unsubscribe')}
            >
              Unsubscribe
            </button>
            <Link
              to="/"
              className="inline-flex min-h-11 w-full items-center justify-center text-sm text-accent hover:underline"
            >
              Keep getting catch-ups
            </Link>
          </div>
          <p className="mt-4 text-center text-xs text-fg-3">No login needed.</p>
        </Card>
      )}
      {state === 'unsubscribed' && (
        <Card>
          <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-good-soft text-good">
            <IconCheck size={22} />
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-fg">{"You're unsubscribed"}</h1>
          <div className="mt-3 space-y-3 text-sm leading-6 text-fg-2">
            <p>No more catch-up emails from any Sorted workspace, starting now.</p>
            <p>
              {
                "Changed your mind later? Tap Unsubscribe in any old catch-up email and you'll land here to turn them back on."
              }
            </p>
          </div>
          <div className="mt-6">
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() => void submit('resubscribe')}
            >
              Turn catch-ups back on
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-fg-3">
            Invites, login links and password resets still arrive.
          </p>
        </Card>
      )}
      {state === 'invalid' && (
        <Card>
          <p className="text-sm leading-6 text-fg">{"This link isn't valid."}</p>
        </Card>
      )}
    </div>
  );
}
