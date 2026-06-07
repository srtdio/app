import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/shell/PageHead';
import { IconChat, IconPlus } from '@/components/ui/icons';

export function ChatPage() {
  return (
    <>
      <PageHead
        title="Chat"
        actions={
          <Button variant="primary">
            <IconPlus size={16} />
            New chat
          </Button>
        }
      />

      <EmptyState
        icon={<IconChat size={24} />}
        title="No conversations yet"
        description="Start a chat to message your team."
        action={
          <Button variant="primary">
            <IconPlus size={16} />
            New chat
          </Button>
        }
      />
    </>
  );
}
