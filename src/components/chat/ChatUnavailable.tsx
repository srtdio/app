import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconChat } from '@/components/ui/icons';
import { useChat } from '@/lib/chat/chat-context';

/**
 * The unavailable panel as a pure view, so the Retry wiring is unit-testable
 * without a provider. All colours are design tokens (light/dark parity) and the
 * Retry control is a 44px-tall button.
 */
export function chatUnavailableView(props: { onRetry: () => void }): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center min-h-[320px]">
      <div className="flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border border-border bg-panel-2 text-fg-3">
        <IconChat size={24} />
      </div>
      <div className="text-[15px] font-semibold text-fg">Chat unavailable</div>
      <div className="max-w-[320px] text-sm text-fg-3">
        We could not connect to chat right now. The rest of Sorted keeps working.
      </div>
      <Button variant="primary" size="lg" className="mt-2 min-w-[120px]" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Shown when the chat connection is unavailable: the availability gate is
 * closed (missing config, no session), signout, or the controller's retry loop
 * gave up after ten consecutive failures. The connection layer collapses every
 * failure to this state and never throws, so the rest of the app is unaffected;
 * Retry restarts the loop from a clean backoff.
 */
export function ChatUnavailable(): ReactElement {
  const { retry } = useChat();
  return chatUnavailableView({ onRetry: retry });
}
