import { supabase } from '@/lib/supabase';

void supabase;

export default function App() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-2 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50">
      <span>Sorted v2</span>
      <span className="text-sm text-zinc-500 dark:text-zinc-400">DB: connected</span>
    </main>
  );
}
