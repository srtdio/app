import { supabase } from '@/lib/supabase';

void supabase;

export default function App() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-2 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <span>Sorted v2</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">DB: connected</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">Edge: Cloudflare</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">Errors: Sentry</span>
      {import.meta.env.DEV && (
        <button
          type="button"
          onClick={() => {
            throw new Error('Sentry test error from button');
          }}
          className="mt-2 min-h-[44px] min-w-[44px] rounded border border-zinc-300 px-3 text-sm text-zinc-900 dark:border-zinc-700 dark:text-zinc-50"
        >
          Test Sentry
        </button>
      )}
    </main>
  );
}
