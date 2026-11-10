import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Text } from '@/components/ui/Text';
import { GUTTER } from '@/components/ui/layout';
import { AWKWARD, STATES, type Moment } from './register';

// The gallery page frame: a titled page with two sections, "States" and
// "Awkward cases", each a column of labelled cells. Every cell renders the
// real part from src/components/ui with fixture props only; the frame itself
// uses ui/Text and layout.ts, no style value of its own.

export interface GalleryCell {
  /** A register moment: the data-gallery-cell id the guard matches. */
  id: Moment;
  render: () => ReactNode;
}

/** One cell. The guard (src/__tests__/gallery-register.test.ts) reads cell('<id>' from the page source. */
export const cell = (id: Moment, render: () => ReactNode): GalleryCell => ({ id, render });

/** What every page module exports: the part's name and its cells. */
export interface GalleryModule {
  part: string;
  cells: readonly GalleryCell[];
}

function Section({ title, cells }: { title: string; cells: readonly GalleryCell[] }) {
  if (cells.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <Text role="section" as="h2">
        {title}
      </Text>
      {cells.map((c) => (
        <div key={c.id} data-gallery-cell={c.id} className="flex w-full min-w-0 flex-col gap-2">
          <Text role="meta">{c.id}</Text>
          <div className={c.id === 'narrow-320' ? 'w-80 max-w-full' : 'w-full'}>{c.render()}</div>
        </div>
      ))}
    </section>
  );
}

export function GalleryPage({ part, cells }: GalleryModule) {
  const states = new Set<Moment>(STATES);
  const awkward = new Set<Moment>(AWKWARD);
  return (
    <main
      data-gallery={part}
      className={cn('flex min-h-screen flex-col gap-6 bg-panel py-6 text-fg', GUTTER)}
    >
      <Text role="title" as="h1">
        {part}
      </Text>
      <Section title="States" cells={cells.filter((c) => states.has(c.id))} />
      <Section title="Awkward cases" cells={cells.filter((c) => awkward.has(c.id))} />
    </main>
  );
}
