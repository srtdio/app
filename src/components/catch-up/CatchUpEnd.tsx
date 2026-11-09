// Catch up's end screen (after the last card): the ink check circle (text-fg,
// never green), the title and how many updates the person went through, then a
// full-width Done (Main, ink). The bar above it (Back, Undo) is the screen's own.

import type { ReactElement } from 'react';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { IconCheckCircle } from '@/components/ui/icons';
import { DONE, END_TITLE, endLine } from '@/lib/catch-up/copy';

/** The end screen's check circle (48, the ink token text-fg: black in light, white in dark). */
export const END_ICON_PX = 48;

export function CatchUpEnd(props: { wentThrough: number; onDone: () => void }): ReactElement {
  return (
    <div data-catch-up-end="" className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center">
        <span data-catch-up-end-check="" className="text-fg">
          <IconCheckCircle size={END_ICON_PX} />
        </span>
        <Text role="display" as="h2">
          {END_TITLE}
        </Text>
        <Text role="body" as="p" data-catch-up-end-line="" className="text-fg-2">
          {endLine(props.wentThrough)}
        </Text>
      </div>
      <Button
        type="button"
        variant="primary"
        className="w-full md:w-auto"
        data-catch-up-done=""
        onClick={props.onDone}
      >
        {DONE}
      </Button>
    </div>
  );
}
