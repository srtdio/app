import { IconChat } from '@/components/ui/icons';

interface ChatNoticeProps {
  variant: 'loading' | 'unavailable';
}

const COPY: Record<ChatNoticeProps['variant'], { title: string; description: string }> = {
  loading: {
    title: 'Connecting to chat',
    description: 'Hang tight while we open a secure connection.',
  },
  unavailable: {
    title: 'Chat unavailable',
    description:
      'We could not connect to chat right now. The rest of Sorted is unaffected, so try again shortly.',
  },
};

/**
 * The connecting and unavailable states for the chat surface. Pure and
 * hook-free: it renders token-class panels and never throws, so a chat outage
 * stays contained to this page.
 */
export function ChatNotice({ variant }: ChatNoticeProps) {
  const copy = COPY[variant];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-14 text-center min-h-[320px]">
      <div className="w-[54px] h-[54px] rounded-[14px] bg-panel-2 border border-border flex items-center justify-center text-fg-3 mb-1.5">
        <IconChat size={24} />
      </div>
      <div className="text-[15px] font-semibold text-fg">{copy.title}</div>
      <div className="text-fg-3 text-sm max-w-[320px]">{copy.description}</div>
    </div>
  );
}
