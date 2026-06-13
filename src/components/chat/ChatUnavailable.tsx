import type { ReactElement } from 'react';
import { IconChat } from '@/components/ui/icons';

/**
 * Shown when the chat connection is unavailable (missing config, no session,
 * token failure, SDK error). The connection layer collapses every failure to
 * this state and never throws, so the rest of the app is unaffected; this is
 * just a calm panel, not an error boundary.
 */
export function ChatUnavailable(): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center min-h-[320px]">
      <div className="flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border border-border bg-panel-2 text-fg-3">
        <IconChat size={24} />
      </div>
      <div className="text-[15px] font-semibold text-fg">Chat unavailable</div>
      <div className="max-w-[320px] text-sm text-fg-3">
        We could not connect to chat right now. The rest of Sorted keeps working; try again in a
        moment.
      </div>
    </div>
  );
}
